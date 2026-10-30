import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRobotLock, readRobotLock, prepareRobotStart } from '../serve/robot-lock.js';
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aw-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
}

test('正常停止释放锁，允许重新启动，释放可重复调用', async t => {
  const file = await setup(t);
  const lock = await acquireRobotLock(file);
  assert.equal((await readRobotLock(file)).pid, process.pid);
  await assert.rejects(acquireRobotLock(file), error => error.code === 'ROBOT_RUNNING');
  await lock.release(); await lock.release();
  assert.equal(await readRobotLock(file), null);
  const next = await acquireRobotLock(file); await next.release();
});

test('兼容旧 PID 锁，自动移除已经退出的实例留下的锁', async t => {
  const file = await setup(t);
  await writeFile(`${file}.lock`, '123456');
  assert.equal((await readRobotLock(file, () => false)).running, false);
  await prepareRobotStart(file, { alive: () => false });
  assert.equal(await readRobotLock(file), null);
});

test('启动冲突返回 PID；未明确强制启动时不发送信号也不删除锁', async t => {
  const file = await setup(t);
  await writeFile(`${file}.lock`, '123456');
  let killed = false;
  await assert.rejects(prepareRobotStart(file, { alive: () => true, kill: () => { killed = true; } }), error => error.code === 'ROBOT_RUNNING' && error.pid === 123456);
  assert.equal(killed, false); assert.equal(await readFile(`${file}.lock`, 'utf8'), '123456');
});

test('强制启动等待旧进程退出，再清理旧锁', async t => {
  const file = await setup(t); await writeFile(`${file}.lock`, '123456');
  let alive = true, waits = 0; const signals = [];
  await prepareRobotStart(file, { force: true, alive: () => alive, verify: async () => true,
    kill: (_, signal) => { signals.push(signal); }, wait: async () => { if (++waits === 2) alive = false; } });
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(waits, 2);
  assert.equal(await readRobotLock(file), null);
});

test('旧进程未响应正常停止时才强制终止', async t => {
  const file = await setup(t); await writeFile(`${file}.lock`, '123456');
  let alive = true; const signals = [];
  await prepareRobotStart(file, { force: true, alive: () => alive, verify: async () => true,
    kill: (_, signal) => { signals.push(signal); if (signal === 'SIGKILL') alive = false; }, wait: async () => {} });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(await readRobotLock(file), null);
});

test('不终止无法确认身份的进程，也不删除其锁', async t => {
  const file = await setup(t); await writeFile(`${file}.lock`, '123456');
  let killed = false;
  await assert.rejects(prepareRobotStart(file, { force: true, alive: () => true, verify: async () => false, kill: () => { killed = true; } }), /无法确认/);
  assert.equal(killed, false); assert.equal(await readFile(`${file}.lock`, 'utf8'), '123456');
});

test('旧实例退出时不删除新实例替换后的锁', async t => {
  const file = await setup(t); const lock = await acquireRobotLock(file);
  const replacement = JSON.stringify({ pid: 123456, token: 'replacement' });
  await writeFile(`${file}.lock`, replacement); await lock.release();
  assert.equal(await readFile(`${file}.lock`, 'utf8'), replacement);
});

test('损坏锁需要明确强制启动，不能删除正在创建的锁', async t => {
  const file = await setup(t); await writeFile(`${file}.lock`, '');
  await assert.rejects(prepareRobotStart(file), e => e.code === 'ROBOT_RUNNING');
  await assert.rejects(prepareRobotStart(file, { force: true }), /正在创建/);
  const old = new Date(Date.now() - 10000); await utimes(`${file}.lock`, old, old);
  await prepareRobotStart(file, { force: true }); assert.equal(await readRobotLock(file), null);
});

test('真实机器人入口在停止、连接失败和状态读取失败后均清理锁', async t => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { resolve, dirname } = await import('node:path');
  const file = await setup(t), dir = dirname(file);
  const stub = join(dir, 'stream.mjs'), loader = join(dir, 'loader.mjs'), register = join(dir, 'register.mjs');
  await writeFile(stub, `
    export const TOPIC_ROBOT='robot';
    export class DWClient {
      registerCallbackListener() {}
      async connect() {
        if (process.env.AW_TEST_CONNECT_FAIL) throw new Error('test connection failure');
        this.connected=true;this.timer=setInterval(()=>{},1000);
      }
      disconnect() { clearInterval(this.timer); }
    }
  `);
  await writeFile(loader, `export async function resolve(specifier,context,next){
    if(specifier==='dingtalk-stream') return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};
    return next(specifier,context);
  }`);
  await writeFile(register, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
  async function launch(extra = {}, stop = false) {
    const child = spawn(process.execPath, ['--import', register, resolve('serve/index.js')], {
      env: { ...process.env, DINGTALK_CLIENT_ID: 'test', DINGTALK_CLIENT_SECRET: 'test', DINGTALK_ALLOWED_USERS: 'test', DING_CODEX_BIN: process.execPath, DING_CODEX_WORKDIR: dir, DING_CODEX_SESSION_ID: '', STATE_FILE: file, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let output = '', stopping; const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      output += data;
      if (stop && output.includes('钉钉 Stream 已连接')) {
        stop = false;
        stopping = prepareRobotStart(file, { force: true }).catch(error => {
          output += `\n强制停止失败：${error.message}`; child.kill('SIGKILL');
        });
      }
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await stopping; clearTimeout(timeout); return { code, output };
  }
  const normal = await launch({}, true);
  assert.equal(normal.code, 0, normal.output); assert.match(normal.output, /锁文件已清理/);
  assert.equal(await readRobotLock(file), null);
  const failed = await launch({ AW_TEST_CONNECT_FAIL: '1' });
  assert.equal(failed.code, 1, failed.output); assert.equal(await readRobotLock(file), null);
  await writeFile(file, '{broken');
  const broken = await launch(); assert.equal(broken.code, 1, broken.output); assert.equal(await readRobotLock(file), null);
  const separate = await launch({ STATE_FILE: join(dir, 'workspace-b.json'), DING_ROBOT_LOCK_BASE: file }, true);
  assert.equal(separate.code, 0, separate.output); assert.equal(await readRobotLock(file), null);
});
