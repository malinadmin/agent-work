import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStudio } from '../serve/server.js';

test('网页确认身份持久化白名单并向正在运行的机器人同步', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-authorization-'));
  const stub = join(dir, 'stream.mjs'), loader = join(dir, 'loader.mjs'), register = join(dir, 'register.mjs');
  await writeFile(stub, `
    export const TOPIC_ROBOT = 'robot';
    export class DWClient {
      registerCallbackListener(topic, callback) { this.callback = callback; }
      socketCallBackResponse() {}
      async connect() {
        this.connected = true;
        this.timer = setInterval(() => {}, 1000);
        this.callback({ headers: { messageId: 'first' }, data: JSON.stringify({ senderStaffId: 'owner-123', senderNick: 'Owner', conversationId: 'chat', msgId: 'first', msgtype: 'text', text: { content: 'hello' } }) });
      }
      disconnect() { clearInterval(this.timer); }
    }
  `);
  await writeFile(loader, `export async function resolve(s,c,n){ if(s==='dingtalk-stream')return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};return n(s,c); }`);
  await writeFile(register, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
  const settingsFile = join(dir, 'studio.json');
  await writeFile(settingsFile, JSON.stringify({ DINGTALK_CLIENT_ID: 'test', DINGTALK_CLIENT_SECRET: 'secret', DINGTALK_ALLOWED_USERS: '', DING_CODEX_BIN: process.execPath, DING_CODEX_WORKDIR: dir }));
  const config = { clientId: 'test', clientSecret: 'secret', allowedUsers: [], allowedConversations: [], codexBin: process.execPath, stateFile: join(dir, 'state.json'), workdir: dir, model: '', sandbox: 'read-only', timeout: 1000 };
  const app = await createStudio({ config, settingsFile, workspacesFile: join(dir, 'workspaces.json') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const status = async () => (await fetch(base + '/status')).json();
  async function waitFor(predicate) {
    for (let i = 0; i < 150; i++) { const value = await status(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Timed out waiting for robot state');
  }
  t.after(async () => {
    await post('/robot/stop', {});
    await waitFor(s => s.robotStatus === 'stopped');
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const originalOptions = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = `--import=${register}`;
    assert.equal((await post('/robot/start', {})).status, 200);
  } finally {
    if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalOptions;
  }
  const pending = await waitFor(s => s.robotStatus === 'running' && s.authorizationCandidates.length === 1);
  assert.equal(pending.config.allowedUsers.length, 0);
  assert.deepEqual(pending.authorizationCandidates, [{ id: 'owner-123', name: 'Owner' }]);
  assert.equal((await post('/authorization/approve', { id: 'not-observed' })).status, 400);
  assert.equal((await post('/authorization/approve', { id: 'owner-123' })).status, 200);
  assert.deepEqual((await status()).config.allowedUsers, ['owner-123']);
  assert.deepEqual((await status()).authorizationCandidates, []);
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).DINGTALK_ALLOWED_USERS, 'owner-123');
  assert.equal((await status()).robotStatus, 'running');
});
