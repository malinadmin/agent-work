import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBranches, switchBranch } from '../serve/git.js';
import { createStudio } from '../serve/server.js';

const exec = promisify(execFile);
async function repository(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aw-git-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd: dir });
  await git('init', '--initial-branch=main');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial');
  await git('branch', 'feature/test');
  return { dir, git };
}

test('Git branch discovery and safe local switching', async t => {
  const { dir, git } = await repository(t);
  const state = await readBranches(dir);
  assert.equal(state.current, 'main');
  assert.equal(state.dirty, false);
  assert.deepEqual(state.branches.map(b => b.name), ['feature/test', 'main']);
  assert.equal((await switchBranch(dir, 'feature/test', 'main')).current, 'feature/test');
  await assert.rejects(switchBranch(dir, 'main', 'main'), /已变化/);
  await assert.rejects(switchBranch(dir, '--force', 'feature/test'), /无效/);
  await assert.rejects(switchBranch(dir, 'missing', 'feature/test'), /已存在/);
  await writeFile(join(dir, 'untracked.txt'), 'keep');
  assert.equal((await readBranches(dir)).dirty, true);
  await assert.rejects(switchBranch(dir, 'main', 'feature/test'), /未提交/);
  assert.equal((await readBranches(dir)).current, 'feature/test');
  await git('add', 'untracked.txt');
  await assert.rejects(switchBranch(dir, 'main', 'feature/test'), /未提交/);
  assert.equal((await readBranches(tmpdir())).available, false);
});

test('Git discovery handles detached HEAD and occupied worktrees', async t => {
  const { dir, git } = await repository(t);
  const worktree = join(dir, 'linked');
  await git('worktree', 'add', worktree, 'feature/test');
  assert.equal((await readBranches(dir)).branches.find(b => b.name === 'feature/test').occupied, true);
  // Ignore the nested test worktree so that occupancy, not untracked files, blocks switching.
  await writeFile(join(dir, '.git/info/exclude'), 'linked/\n');
  await assert.rejects(switchBranch(dir, 'feature/test', 'main'), /worktree/);
  await git('checkout', '--detach');
  assert.equal((await readBranches(dir)).detached, true);
  assert.equal((await switchBranch(dir, 'main', '')).current, 'main');
});

test('Web branch switching rejects stale workspaces, active tasks and robot locks', async t => {
  const { dir } = await repository(t);
  const config = { codexBin: process.execPath, workdir: dir, sandbox: 'read-only', model: '', allowedUsers: [], allowedConversations: [], stateFile: join(dir, 'state.json') };
  let finish;
  const app = await createStudio({ config, settingsFile: join(tmpdir(), `aw-missing-${Date.now()}.json`), workspacesFile: join(dir, '.git/aw-workspaces.json'), run: async () => new Promise(resolve => { finish = () => resolve({ text: 'done' }); }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const request = { branch: 'feature/test', expectedBranch: 'main', workspaceId: 'default' };
  const state = await (await fetch(base + '/git/branches')).json();
  assert.equal(state.current, 'main');
  assert.equal((await post('/git/switch', { ...request, workspaceId: 'stale' })).status, 400);
  assert.equal((await post('/chat', { agent: 'codex', prompt: 'test' })).status, 202);
  assert.equal((await post('/git/switch', request)).status, 400);
  finish(); await new Promise(resolve => setImmediate(resolve));
  await writeFile(`${config.stateFile}.lock`, String(process.pid));
  assert.equal((await post('/git/switch', request)).status, 400);
  await rm(`${config.stateFile}.lock`);
  const result = await post('/git/switch', request);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).current, 'feature/test');
});
