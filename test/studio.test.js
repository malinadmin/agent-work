import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Histories, detectAgents } from '../serve/agents.js';
import { createStudio } from '../serve/server.js';

const id = '01900000-0000-7000-8000-000000000001';
test('历史读取 Codex 和 Claude 原始记录，不接收浏览器文件路径', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ding-history-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.codex/sessions/2026/10/30'), { recursive: true });
  await mkdir(join(home, '.claude/projects/project'), { recursive: true });
  await writeFile(join(home, '.codex/sessions/2026/10/30/session.jsonl'), [
    { type: 'session_meta', payload: { id, cwd: '/project' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '分析项目' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '不能重复显示' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '项目分析结果' } },
  ].map(x => JSON.stringify(x)).join('\n'));
  await writeFile(join(home, '.claude/projects/project/session.jsonl'), [
    { type: 'user', sessionId: id, cwd: '/project', message: { content: '你好 Claude' } },
    { type: 'assistant', sessionId: id, message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: '你好' }] } },
  ].map(x => JSON.stringify(x)).join('\n'));
  const history = new Histories(home);
  const sessions = await history.list(); assert.equal(sessions.length, 2);
  assert.equal(sessions.find(s => s.agent === 'codex').title, '分析项目');
  assert.deepEqual((await history.read(`codex:${id}`)).messages.map(m => m.text), ['分析项目', '项目分析结果']);
  assert.deepEqual((await history.read(`claude:${id}`)).messages.map(m => m.text), ['你好 Claude', '你好']);
  await assert.rejects(history.read('/etc/passwd'), /会话不存在/);
  await writeFile(join(home, '.codex/sessions/2026/10/30/session.jsonl'), [
    { type: 'session_meta', payload: { id, cwd: '/project' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>本机上下文</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n## My request:\n新版会话' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '新版回复' }] } },
  ].map(x => JSON.stringify(x)).join('\n'));
  assert.equal((await history.list()).find(s => s.agent === 'codex').title, '新版会话');
  assert.equal((await history.read(`codex:${id}`)).messages.length, 2);
  assert.equal((await history.read(`codex:${id}`)).messages.at(-1).text, '新版回复');
});

test('不存在的 CLI 不声称支持对话，历史存在与 CLI 检测独立', async () => {
  const agents = await detectAgents({ codexBin: '/missing/ding-studio-codex' }, '/missing/ding-studio-home');
  assert.equal(agents.find(a => a.id === 'codex').chat, false);
  assert.equal(agents.find(a => a.id === 'deepseek').chat, false);
});

test('本地 API 隐藏密钥、阻止跨域和并发任务，保存成功会话与失败结果', async t => {
  const lockDir = await mkdtemp(join(tmpdir(), 'aw-api-lock-'));
  t.after(() => rm(lockDir, { recursive: true, force: true }));
  const config = { stateFile: join(lockDir, 'state.json'), clientId: 'test-client', clientSecret: 'test-secret', allowedUsers: ['user1'], allowedConversations: [], codexBin: 'codex', workdir: process.cwd(), sandbox: 'read-only', timeout: 1000 };
  let complete, calls = 0;
  const app = await createStudio({ config, workspacesFile: join(lockDir, 'workspaces.json'), settingsFile: join(lockDir, 'studio.json'), run: async (_, request) => {
    calls++; request.onSession(id);
    if (request.prompt === 'fail') throw new Error('secret-diagnostic');
    return new Promise(resolve => { complete = () => resolve({ sessionId: id, text: '真实模拟结果' }); });
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const get = path => fetch(base + path);
  const post = (path, data, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const status = await (await get('/api/status')).json();
  await writeFile(`${config.stateFile}.lock`, String(process.pid));
  const conflictResponse = await post('/api/robot/start', {});
  assert.equal(conflictResponse.status, 409);
  const conflict = await conflictResponse.json();
  assert.equal(conflict.code, 'ROBOT_RUNNING'); assert.equal(conflict.pid, process.pid);
  assert.equal((await (await get('/api/status')).json()).robotExternal, true);
  assert.equal((await post('/api/robot/start', { force: true })).status, 400);
  await rm(`${config.stateFile}.lock`);
  assert.equal(status.config.clientSecret, undefined); assert.equal(status.config.secretConfigured, true);
  assert.equal((await post('/api/chat', { prompt: 'hi', agent: 'codex' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/chat', { prompt: 'hi', agent: 'claude' })).status, 400);
  assert.equal((await post('/api/chat', { prompt: 'hi', agent: 'codex', sessionId: '/etc/passwd' })).status, 400);
  const first = await post('/api/chat', { prompt: 'hi', agent: 'codex' }); assert.equal(first.status, 202);
  assert.equal((await post('/api/chat', { prompt: 'again', agent: 'codex' })).status, 400);
  complete();
  await new Promise(resolve => setImmediate(resolve));
  const finished = await (await get('/api/status')).json();
  assert.equal(finished.busy, false); assert.equal(finished.jobs[0].text, '真实模拟结果'); assert.equal(finished.jobs[0].sessionId, id);
  assert.equal((await post('/api/chat', { prompt: 'fail', agent: 'codex' })).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const failed = await (await get('/api/status')).json();
  assert.equal(failed.jobs[1].status, 'failed'); assert.ok(!JSON.stringify(failed).includes('secret-diagnostic')); assert.equal(calls, 2);
});
