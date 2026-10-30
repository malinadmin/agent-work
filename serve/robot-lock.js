import { open, readFile, mkdir, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RobotRunningError extends Error {
  constructor(lock) {
    super(`有机器人正在运行中${lock.pid ? `（PID ${lock.pid}）` : ''}。可选择“强制启动”，停止旧进程并清理锁后重新启动。`);
    this.code = 'ROBOT_RUNNING'; this.pid = lock.pid;
  }
}
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
export async function readRobotLock(stateFile, alive = processAlive) {
  const path = `${stateFile}.lock`;
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let record;
  try { record = JSON.parse(raw); } catch {}
  const pid = typeof record === 'number' ? record : record?.pid;
  const valid = Number.isSafeInteger(pid) && pid > 1;
  return { path, raw, pid: valid ? pid : null, running: valid ? alive(pid) : true };
}
async function removeMatching(lock) {
  try {
    if (await readFile(lock.path, 'utf8') !== lock.raw) return false;
    await unlink(lock.path); return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function acquireRobotLock(stateFile) {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt++) {
    let handle;
    try { handle = await open(`${stateFile}.lock`, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = await readRobotLock(stateFile);
      if (!old) continue;
      if (old.running) throw new RobotRunningError(old);
      await removeMatching(old); continue;
    }
    const raw = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() });
    try { await handle.writeFile(raw); } catch (error) { await handle.close(); await unlink(`${stateFile}.lock`); throw error; }
    let released = false;
    return { async release() {
      if (released) return; released = true;
      try { await removeMatching({ path: `${stateFile}.lock`, raw }); } finally { await handle.close(); }
    } };
  }
  throw new Error('机器人锁正在变化，请稍后重试');
}
// A PID alone can be reused. Verify the executable command and project before sending signals.
export async function isRobotProcess(pid) {
  const script = resolve('serve/index.js');
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 });
    const command = stdout.trim();
    if (!/(?:^|\s)(?:\S*\/)?node(?:\s|$)/.test(command)) return false;
    if (command.endsWith(` ${script}`)) return true;
    if (!command.endsWith(' serve/index.js')) return false;
    if (process.platform === 'linux') {
      const { readlink } = await import('node:fs/promises');
      return await readlink(`/proc/${pid}/cwd`) === resolve('.');
    }
    const cwd = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 });
    return cwd.stdout.split('\n').includes(`n${resolve('.')}`);
  } catch { return false; }
}
export async function prepareRobotStart(stateFile, { force = false, alive = processAlive, verify = isRobotProcess, kill = (pid, signal) => process.kill(pid, signal), wait = delay } = {}) {
  const lock = await readRobotLock(stateFile, alive);
  if (!lock) return;
  if (!lock.running) { await removeMatching(lock); return; }
  if (!force) throw new RobotRunningError(lock);
  if (!lock.pid) {
    // Do not delete a lock which may still be in the process of being written.
    if (Date.now() - (await stat(lock.path)).mtimeMs < 5000) throw new Error('锁文件正在创建，请稍后再强制启动');
    await removeMatching(lock); return;
  }
  if (lock.pid === process.pid || !await verify(lock.pid)) throw new Error('锁文件中的进程无法确认为本项目机器人，未终止该进程。请核对进程后处理锁文件。');
  const signal = async name => {
    if (!alive(lock.pid)) return;
    if (!await verify(lock.pid)) throw new Error('原机器人进程身份已变化，请重试');
    try { kill(lock.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  await signal('SIGTERM');
  for (let i = 0; i < 50 && alive(lock.pid); i++) await wait(100);
  if (alive(lock.pid)) {
    await signal('SIGKILL');
    for (let i = 0; i < 30 && alive(lock.pid); i++) await wait(100);
  }
  if (alive(lock.pid)) throw new Error('旧机器人尚未退出，请稍后重试');
  await removeMatching(lock);
}
