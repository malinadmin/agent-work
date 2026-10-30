import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../serve/state.js';
import { Bridge } from '../serve/bridge.js';
import { runCodex, codexArgs } from '../serve/codex.js';
import { readConfig } from '../serve/config.js';
import { reply, splitText } from '../serve/reply.js';

const uuid = '01900000-0000-7000-8000-000000000001';
function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ding-cli-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { allowedUsers: ['user1'], allowedConversations: [], workdir: dir, sandbox: 'read-only', timeout: 5000, ...overrides };
  const state = new State(join(dir, 'state.json'));
  const calls = [];
  const replies = [];
  const bridge = new Bridge({ config, state, log() {},
    run: async (_, request) => { calls.push(request); request.onSession(uuid); return { sessionId: uuid, text: '回答' }; },
    reply: async (_, text) => { replies.push(text); },
  });
  return { dir, config, state, calls, replies, bridge };
}
function message(id = 'm1', extra = {}) {
  return { msgId: id, conversationId: 'chat1', senderStaffId: 'user1', msgtype: 'text',
    text: { content: '你好' }, sessionWebhook: 'https://oapi.dingtalk.com/robot/send?session=test', ...extra };
}

test('新会话持续续接且重启后保留映射与去重记录', async t => {
  const s = setup(t);
  await s.bridge.accept(message());
  await s.bridge.accept(message('m2'));
  assert.equal(s.calls[0].sessionId, undefined);
  assert.equal(s.calls[1].sessionId, uuid);
  const loaded = new State(s.state.file);
  assert.equal(loaded.get(JSON.stringify(['chat1', 'user1'])).id, uuid);
  assert.equal(loaded.claim(JSON.stringify(['chat1', 'm1'])), false);
});

test('重复消息和未授权消息不执行 Codex', async t => {
  const s = setup(t);
  await Promise.all([s.bridge.accept(message()), s.bridge.accept(message())]);
  await s.bridge.accept(message('m3', { senderStaffId: 'other' }));
  assert.equal(s.calls.length, 1);
});

test('群聊中不同用户分别保存会话', async t => {
  const s = setup(t, { allowedUsers: ['user1', 'user2'] });
  await s.bridge.accept(message());
  await s.bridge.accept(message('m2', { senderStaffId: 'user2' }));
  assert.equal(s.calls[1].sessionId, undefined);
  assert.equal(Object.keys(s.state.data.sessions).length, 2);
});

test('空白名单只收集待确认身份，不执行、不自动认领首个发信人', async t => {
  const s = setup(t, { allowedUsers: [] });
  const candidates = [], logs = [];
  s.bridge.onUnauthorized = user => candidates.push(user);
  s.bridge.log = (...args) => logs.push(args.join(' '));
  await s.bridge.accept(message('first', { senderNick: '本人' }));
  await s.bridge.accept(message('other', { senderStaffId: 'user2' }));
  assert.deepEqual(candidates.map(user => user.id), ['user1', 'user2']);
  assert.equal(s.calls.length, 0);
  assert.equal(s.replies.length, 0);
  assert.deepEqual(s.config.allowedUsers, []);
  assert.ok(logs.some(line => line.includes('user2')));
  s.config.allowedConversations = ['allowed-chat'];
  await s.bridge.accept(message('wrong-chat'));
  assert.equal(candidates.length, 2);
  s.config.allowedConversations = [];
  s.config.allowedUsers = ['user1'];
  await s.bridge.accept(message('confirmed'));
  assert.equal(s.calls.length, 1);
});

test('会话白名单、空白名单和非文本消息', async t => {
  const s = setup(t, { allowedConversations: ['chat2'] });
  await s.bridge.accept(message());
  assert.equal(s.calls.length, 0);
  s.config.allowedConversations = [];
  s.config.allowedUsers = [];
  await s.bridge.accept(message());
  assert.equal(s.calls.length, 0);
  s.config.allowedUsers = ['user1'];
  await s.bridge.accept(message('image', { msgtype: 'image' }));
  assert.match(s.replies[0], /仅支持文本/);
});

test('/new 不会再次绑定配置中的初始会话', async t => {
  const s = setup(t, { sessionId: uuid });
  await s.bridge.accept(message());
  await s.bridge.accept(message('new', { text: { content: '/new' } }));
  await s.bridge.accept(message('m2'));
  assert.equal(s.calls[0].sessionId, uuid);
  assert.equal(s.calls[1].sessionId, undefined);
});

test('/bind 与 /last 使用已保存结果', async t => {
  const s = setup(t);
  await s.bridge.accept(message('bind', { text: { content: `/bind ${uuid}` } }));
  await s.bridge.accept(message());
  await s.bridge.accept(message('last', { text: { content: '/last' } }));
  assert.equal(s.calls[0].sessionId, uuid);
  assert.equal(s.replies.at(-1), '回答');
});

test('并发消息排队，上一条失败也不会卡住后续消息', async t => {
  const s = setup(t);
  let active = 0;
  let maximum = 0;
  let count = 0;
  s.bridge.run = async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (++count === 1) throw new Error('模拟失败');
    return { sessionId: uuid, text: '恢复成功' };
  };
  await Promise.all([s.bridge.accept(message()), s.bridge.accept(message('m2'))]);
  assert.equal(maximum, 1);
  assert.equal(count, 2);
  assert.equal(s.replies.at(-1), '恢复成功');
});

test('发送最终回复失败时保留结果且不重复调用 Codex', async t => {
  const s = setup(t);
  s.bridge.reply = async (_, text) => { if (text === '回答') throw new Error('断网'); };
  await s.bridge.accept(message());
  assert.equal(s.calls.length, 1);
  assert.equal(s.state.get(JSON.stringify(['chat1', 'user1'])).lastReply, '回答');
});

test('Codex 参数通过 stdin 传 prompt，续接显式指定会话和沙箱', () => {
  const args = codexArgs({ sandbox: 'read-only' }, uuid);
  assert.deepEqual(args.slice(0, 3), ['-a', 'never', 'exec']);
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('resume'));
  assert.equal(args.at(-2), uuid);
  assert.equal(args.at(-1), '-');
});

function fakeCodex(dir, source) {
  const file = join(dir, 'fake-codex');
  writeFileSync(file, '#!/usr/bin/env node\n' + source);
  chmodSync(file, 0o700);
  return file;
}

test('Codex 子进程解析真实 JSONL 格式，prompt 不经过 shell', async t => {
  const s = setup(t);
  s.config.codexBin = fakeCodex(s.dir, `
    let input=''; process.stdin.on('data', x => input+=x); process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'thread.started',thread_id:'${uuid}'}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}}));
      console.log(JSON.stringify({type:'turn.completed'}));
    });`);
  const prompt = '中文 `touch /tmp/never` $(echo unsafe)';
  let saved;
  const result = await runCodex(s.config, { prompt, onSession: id => { saved = id; } });
  assert.equal(saved, uuid);
  assert.equal(result.text, prompt);
});

test('Codex 超时被终止', async t => {
  const s = setup(t, { timeout: 100 });
  s.config.codexBin = fakeCodex(s.dir, 'setInterval(()=>{},1000);');
  await assert.rejects(runCodex(s.config, { prompt: 'hi' }), /超时/);
});

test('Codex 失败不向钉钉暴露 stderr', async t => {
  const s = setup(t);
  s.config.codexBin = fakeCodex(s.dir, 'console.error("secret-token");process.exit(1);');
  await assert.rejects(runCodex(s.config, { prompt: 'hi' }), error => {
    assert.ok(!error.message.includes('secret-token'));
    assert.match(error.diagnostic, /secret-token/);
    return true;
  });
});

test('中文与 emoji 按 UTF-8 字节拆分且保持原文', () => {
  const text = '你好🙂'.repeat(5000);
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(x => Buffer.byteLength(x) <= 12000));
});

test('钉钉回复校验地址、期限和业务返回值', async () => {
  await assert.rejects(reply(message('m', { sessionWebhook: 'https://example.com/' }), 'hi'), /地址无效/);
  await assert.rejects(reply(message('m', { sessionWebhookExpiredTime: 1 }), 'hi'), /已过期/);
  await assert.rejects(reply(message(), 'hi', async () => ({ ok: true, json: async () => ({ errcode: 400 }) })), /400/);
  let body;
  await reply(message(), '你好', async (_, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ errcode: 0 }) };
  });
  assert.equal(body.text.content, '你好');
  assert.deepEqual(body.at.atUserIds, ['user1']);
});

test('忽略宿主进程 CODEX_SESSION_ID 和 CODEX_SANDBOX', () => {
  const config = readConfig({ CODEX_SESSION_ID: uuid, CODEX_SANDBOX: 'seatbelt' });
  assert.equal(config.sessionId, '');
  assert.equal(config.sandbox, 'read-only');
});

test('损坏状态文件必须报错，不能静默丢失已有会话', t => {
  const s = setup(t);
  writeFileSync(s.state.file, '{broken');
  assert.throws(() => new State(s.state.file));
  assert.equal(readFileSync(s.state.file, 'utf8'), '{broken');
});

test('状态写入失败时回滚内存，允许再次接收消息', t => {
  const s = setup(t);
  const save = s.state.save;
  s.state.save = () => { throw new Error('磁盘已满'); };
  assert.throws(() => s.state.claim('retry'), /磁盘已满/);
  assert.throws(() => s.state.set('session', { id: uuid }), /磁盘已满/);
  assert.deepEqual(s.state.get('session'), {});
  s.state.save = save;
  assert.equal(s.state.claim('retry'), true);
});

test('队列满时不标记消息已接收', t => {
  const s = setup(t);
  s.bridge.pending = 20;
  assert.throws(() => s.bridge.accept(message()), /队列已满/);
  assert.equal(s.state.data.seen.length, 0);
});
