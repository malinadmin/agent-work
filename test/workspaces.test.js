import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces, workspaceForDirectory } from '../serve/workspaces.js';
import { createStudio } from '../serve/server.js';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aw-workspaces-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = join(dir, 'a'), b = join(dir, 'b'); await mkdir(a); await mkdir(b);
  const config = { workdir: a, sandbox: 'read-only', model: 'model-a', clientId: '', clientSecret: '', allowedUsers: [], allowedConversations: [], timeout: 5000, stateFile: join(dir, 'state.json') };
  const file = join(dir, 'workspaces.json');
  return { dir, a, b, config, file, store: await Workspaces.load(file, config) };
}
test('旧配置迁移默认空间，模型权限分别保存，切换和重启后保留', async t => {
  const { store, config, file, b } = await fixture(t);
  assert.equal(store.current.model, 'model-a');
  await store.add({ name: '项目 B', workdir: b, model: 'model-b', sandbox: 'workspace-write' });
  const id = store.current.id; assert.equal(store.current.model, 'model-b');
  await store.select('default'); assert.equal(store.current.model, 'model-a'); assert.equal(store.current.sandbox, 'read-only');
  const reloaded = await Workspaces.load(file, config); await reloaded.select(id);
  assert.equal(reloaded.current.name, '项目 B'); assert.equal(reloaded.current.sandbox, 'workspace-write');
  await reloaded.remove('default');
  await assert.rejects(reloaded.remove(id), /至少保留/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).items.length, 1);
});
test('验证目录和重复项目，移除登记保留本地文件，嵌套项目匹配最具体空间', async t => {
  const { store, a, b } = await fixture(t);
  await assert.rejects(store.add({ workdir: a }), /已添加/);
  await assert.rejects(store.add({ workdir: join(a, 'missing') }), /不存在/);
  await assert.rejects(store.update('default', { workdir: b }), /目录固定/);
  await store.add({ workdir: b }); const id = store.current.id;
  await writeFile(join(b, 'keep.txt'), 'keep'); await store.remove(id);
  assert.equal(await readFile(join(b, 'keep.txt'), 'utf8'), 'keep');
  const items = [{ id: 'root', workdir: '/projects' }, { id: 'nested', workdir: '/projects/site' }];
  assert.equal(workspaceForDirectory('/projects/site/src', items).id, 'nested');
  assert.equal(workspaceForDirectory('/projects-other', items), null);
});
test('API 按工作空间执行并拒绝跨项目续接；忙碌时禁止切换且不影响已提交任务', async t => {
  const { dir, a, b, config, file } = await fixture(t);
  const uuid = '01900000-0000-7000-8000-000000000001';
  const histories = { entries: new Map([[`codex:${uuid}`, { cwd: a }]]), async list() { return [{ key: `codex:${uuid}`, id: uuid, cwd: a }]; } };
  let received, finish;
  const app = await createStudio({ config, histories, workspacesFile: file, settingsFile: join(dir, 'studio.json'), run: async (config, request) => {
    received = config; request.onSession(uuid); return new Promise(resolve => { finish = () => resolve({ sessionId: uuid, text: 'ok' }); });
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const added = await (await post('/api/workspaces/add', { name: 'B', workdir: b, model: 'model-b', sandbox: 'workspace-write' })).json();
  assert.equal(added.config.workdir, b); const id = added.activeId;
  const sessions = await (await fetch(base + '/api/sessions')).json(); assert.equal(sessions[0].workspaceId, 'default');
  assert.equal((await post('/api/chat', { agent: 'codex', prompt: 'bad', sessionId: uuid, workspaceId: id })).status, 400);
  assert.equal((await post('/api/chat', { agent: 'codex', prompt: 'bad', workspaceId: 'default' })).status, 400);
  assert.equal((await post('/api/chat', { agent: 'codex', prompt: 'go', workspaceId: id })).status, 202);
  assert.equal(received.workdir, b); assert.equal(received.model, 'model-b'); assert.equal(received.sandbox, 'workspace-write');
  assert.equal((await post('/api/workspaces/select', { id: 'default' })).status, 400);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post('/api/workspaces/select', { id: 'default' })).status, 200);
  const updated = await (await post('/api/config', { model: 'changed-a', sandbox: 'workspace-write' })).json();
  assert.equal(updated.model, 'changed-a');
  const switched = await (await post('/api/workspaces/select', { id })).json(); assert.equal(switched.config.model, 'model-b');
  const restarted = await Workspaces.load(file, config); assert.equal(restarted.current.id, id);
});
