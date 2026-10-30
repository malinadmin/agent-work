import http from 'node:http';
import { readFile, writeFile, mkdir, rename, realpath } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readConfig, missingConfig, isSessionId } from './config.js';
import { resolveCodexBin } from './cli.js';
import { runCodex, codexFailure } from './codex.js';
import { detectAgents, Histories } from './agents.js';
import { readModels } from './models.js';
import { Workspaces, workspaceForDirectory } from './workspaces.js';
import { prepareRobotStart, readRobotLock } from './robot-lock.js';
const exec = promisify(execFile);
const settingsPath = resolve('.data/studio.json');
const keys = { clientId: 'DINGTALK_CLIENT_ID', clientSecret: 'DINGTALK_CLIENT_SECRET', allowedUsers: 'DINGTALK_ALLOWED_USERS', allowedConversations: 'DINGTALK_ALLOWED_CONVERSATIONS', workdir: 'DING_CODEX_WORKDIR', sandbox: 'DING_CODEX_SANDBOX', model: 'DING_CODEX_MODEL' };
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('请求内容过长'); }
  return JSON.parse(text || '{}');
}
export async function createStudio({ config: initialConfig, run = runCodex, histories = new Histories(), settingsFile = settingsPath, workspacesFile = resolve('.data/workspaces.json') } = {}) {
  let saved = {};
  try { saved = JSON.parse(await readFile(settingsFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let config = initialConfig || readConfig({ ...process.env, ...saved });
  const workspaces = await Workspaces.load(workspacesFile, config);
  const sessionWorkspace = async session => workspaceForDirectory(session.cwd ? await realpath(session.cwd).catch(() => resolve(session.cwd)) : '', workspaces.data.items)?.id || null;
  const executionConfig = () => ({ ...config, codexBin: resolveCodexBin(initialConfig ? { ...process.env, DING_CODEX_BIN: config.codexBin } : { ...process.env, ...saved }), workdir: workspaces.current.workdir, model: workspaces.current.model, sandbox: workspaces.current.sandbox });
  let robot, robotStatus = 'stopped', busy = false, robotActionPending = false, configUpdating = false;
  async function mutateConfig(action) {
    if (robot || busy || robotActionPending || configUpdating) throw new Error('请等待任务结束并停止机器人后修改工作空间或配置');
    configUpdating = true;
    try {
      if (config.stateFile && (await readRobotLock(config.stateFile))?.running) throw new Error('请先停止正在运行的机器人后修改工作空间或配置');
      return await action();
    } finally { configUpdating = false; }
  }
  const jobs = new Map(), logs = [];
  function log(source, message, level = 'info') {
    let text = String(message);
    for (const secret of [config.clientSecret, config.clientId].filter(Boolean)) text = text.replaceAll(secret, '[已隐藏]');
    text = text.replace(/https:\/\/oapi\.dingtalk\.com\/\S+/g, '[钉钉地址已隐藏]');
    logs.push({ id: randomUUID(), time: new Date().toISOString(), source, level, message: text.slice(0, 2000) });
    if (logs.length > 400) logs.shift();
  }
  log('studio', '本地工作台已就绪，钉钉机器人可在配置页面启动');
  function publicConfig() { const { clientSecret, ...rest } = executionConfig(); return { ...rest, secretConfigured: Boolean(clientSecret) }; }
  async function stopRobot() {
    if (!robot) return;
    robotStatus = 'stopping';
    robot.kill('SIGTERM');
  }
  const server = http.createServer(async (req, res) => {
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const host = req.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) return json({ error: '仅允许本机访问' }, 403);
      if (req.headers.origin && !['http://127.0.0.1:5173', 'http://localhost:5173', `http://${host}`].includes(req.headers.origin)) return json({ error: '来源无效' }, 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') return json({ error: '来源无效' }, 403);
      const url = new URL(req.url, `http://${host}`), path = url.pathname;
      if (req.method === 'GET' && path === '/api/status') {
        const lock = config.stateFile ? await readRobotLock(config.stateFile) : null;
        return json({ config: publicConfig(), robotStatus, robotExternal: !robot && Boolean(lock?.running), robotActionPending, configUpdating, workspaces: workspaces.snapshot(), busy, logs, jobs: [...jobs.values()] });
      }
      if (req.method === 'GET' && path === '/api/models') return json(await readModels(executionConfig()));
      if (req.method === 'GET' && path === '/api/agents') return json(await detectAgents(executionConfig()));
      if (req.method === 'GET' && path === '/api/workspaces') return json(workspaces.snapshot());
      if (req.method === 'GET' && path === '/api/sessions') return json(await Promise.all((await histories.list()).map(async session => ({ ...session, workspaceId: await sessionWorkspace(session) }))));
      if (req.method === 'GET' && path.startsWith('/api/sessions/')) return json(await histories.read(decodeURIComponent(path.slice(14))));
      if (req.method === 'GET' && path === '/api/diff') {
        try {
          const opts = { cwd: workspaces.current.workdir, timeout: 10000, maxBuffer: 1024 * 1024 };
          const [{ stdout: diff }, { stdout: status }] = await Promise.all([exec('git', ['diff', 'HEAD', '--no-ext-diff', '--no-color'], opts), exec('git', ['status', '--short'], opts)]);
          return json({ diff: diff.slice(0, 200000), status, available: true, truncated: diff.length > 200000 });
        } catch { return json({ available: false, diff: '', status: '', reason: '当前工作目录不是 Git 仓库，或无法读取变更。' }); }
      }
      if (req.method === 'POST' && req.headers['content-type']?.split(';')[0] !== 'application/json') return json({ error: '需要 JSON 请求' }, 415);
      if (req.method === 'POST' && path.startsWith('/api/workspaces/')) {
        const data = await body(req);
        const action = path.slice('/api/workspaces/'.length);
        const result = await mutateConfig(async () => {
          if (action === 'add') return workspaces.add(data);
          if (action === 'update') return workspaces.update(data.id, data);
          if (action === 'select') return workspaces.select(data.id);
          if (action === 'remove') return workspaces.remove(data.id);
          throw new Error('工作空间操作无效');
        });
        log('studio', `工作空间已更新，当前：${workspaces.current.name}`);
        return json({ ...result, config: publicConfig() });
      }
      if (req.method === 'POST' && path === '/api/config') {
        const data = await body(req);
        return await mutateConfig(async () => {
          const next = { ...saved };
          for (const [key, env] of Object.entries(keys)) {
            if (data[key] === undefined || (key === 'clientSecret' && data[key] === '')) continue;
            if (typeof data[key] !== 'string' || /[\r\n\0]/.test(data[key])) throw new Error('配置格式无效');
            next[env] = data[key].trim();
          }
          const checked = readConfig({ ...process.env, ...next });
          const workspacePatch = Object.fromEntries(['workdir', 'model', 'sandbox'].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
          if (Object.keys(workspacePatch).length) await workspaces.validate(workspacePatch, workspaces.current);
          await mkdir(dirname(settingsFile), { recursive: true, mode: 0o700 });
          await writeFile(`${settingsFile}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
          await rename(`${settingsFile}.tmp`, settingsFile);
          if (Object.keys(workspacePatch).length) await workspaces.update(workspaces.current.id, workspacePatch);
          saved = next; config = checked;
          log('studio', '工作台配置已保存');
          return json(publicConfig());
        });
      }
      if (req.method === 'POST' && path === '/api/robot/start') {
        const data = await body(req);
        if (busy || configUpdating) throw new Error('请等待网页任务或配置保存结束后启动机器人');
        if (robotActionPending) throw new Error('机器人正在启动，请稍候');
        if (robot) throw new Error('机器人已启动或正在停止');
        const missing = missingConfig(config); if (missing.length) throw new Error(`请先填写：${missing.join(', ')}`);
        robotActionPending = true;
        try {
          await prepareRobotStart(config.stateFile, { force: data.force === true });
          if (data.force === true) log('dingtalk', '旧机器人已停止并清理锁，正在重新启动');
          const env = { ...process.env, ...saved, STATE_FILE: workspaces.current.id === 'default' ? config.stateFile : resolve(dirname(config.stateFile), 'workspaces', workspaces.current.id, 'state.json'), DING_ROBOT_LOCK_BASE: config.stateFile, DING_CODEX_SESSION_ID: workspaces.current.id === 'default' ? config.sessionId || '' : '', DING_CODEX_WORKDIR: workspaces.current.workdir, DING_CODEX_MODEL: workspaces.current.model, DING_CODEX_SANDBOX: workspaces.current.sandbox };
          robotStatus = 'starting';
          env.DING_CODEX_BIN = executionConfig().codexBin;
          robot = spawn(process.execPath, [resolve('serve/index.js')], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
          for (const [stream, level] of [[robot.stdout, 'info'], [robot.stderr, 'error']]) {
            let pending = '';
            stream.on('data', chunk => {
              pending = (pending + chunk).slice(-16000);
              const lines = pending.split('\n'); pending = lines.pop();
              for (const line of lines.filter(Boolean)) { log('dingtalk', line, level); if (line.includes('钉钉 Stream 已连接')) robotStatus = 'running'; }
            });
            stream.on('end', () => { if (pending.trim()) log('dingtalk', pending, level); });
          }
          robot.on('error', () => { log('dingtalk', '机器人进程启动失败', 'error'); });
          const child = robot;
          robot.once('close', async code => {
            // Only remove a dead process's lock; never unlink a replacement instance's lock.
            try { await prepareRobotStart(config.stateFile); }
            catch (error) { if (error.code !== 'ROBOT_RUNNING') log('dingtalk', '退出后的锁文件清理失败，请检查文件权限', 'error'); }
            log('dingtalk', `机器人已退出，退出码 ${code ?? 'signal'}；已检查并清理残留锁`);
            if (robot === child) { robot = undefined; robotStatus = 'stopped'; }
          });
          log('dingtalk', '正在启动钉钉 Stream 连接'); return json({ ok: true });
        } finally { robotActionPending = false; }
      }
      if (req.method === 'POST' && path === '/api/robot/stop') { await stopRobot(); return json({ ok: true }); }
      if (req.method === 'POST' && path === '/api/chat') {
        if (busy || robot || robotActionPending || configUpdating) throw new Error('请等待当前任务结束；网页对话前请先停止机器人，避免同时修改同一会话');
        const data = await body(req);
        if (typeof data.prompt !== 'string' || !data.prompt.trim()) throw new Error('请输入消息');
        if (data.agent !== 'codex') throw new Error('当前仅 Codex 支持直接对话');
        if (data.sessionId && !isSessionId(data.sessionId)) throw new Error('会话 ID 无效');
        if (data.sessionId && [process.env.CODEX_SESSION_ID, process.env.CODEX_THREAD_ID].includes(data.sessionId)) {
          throw new Error('该会话属于启动服务的 Codex / IDE 会话，请勿从网页同时续接。请点击“新建会话”发起独立对话；需要接管原会话时，请先停止 IDE 中的任务，再从独立终端启动服务。');
        }
        const requestedWorkspaceId = data.workspaceId || workspaces.current.id;
        if (requestedWorkspaceId !== workspaces.current.id) throw new Error('工作空间已变化，请刷新后重试');
        if (data.sessionId) {
          let entry = histories.entries.get(`codex:${data.sessionId}`);
          if (!entry) { await histories.list(); entry = histories.entries.get(`codex:${data.sessionId}`); }
          const previous = [...jobs.values()].find(job => job.sessionId === data.sessionId);
          const owner = entry ? await sessionWorkspace(entry) : previous?.workspaceId;
          if (owner !== workspaces.current.id) throw new Error('该会话不属于当前工作空间，请切换工作空间或新建会话');
        }
        if (config.stateFile && (await readRobotLock(config.stateFile))?.running) throw new Error('已有机器人正在运行，请先停止机器人后进行网页对话');
        if (busy || configUpdating || robot || robotActionPending) throw new Error('当前已有任务或配置正在处理，请重试');
        if (requestedWorkspaceId !== workspaces.current.id) throw new Error('工作空间已变化，请刷新后重试');
        const taskConfig = executionConfig();
        const job = { workspaceId: workspaces.current.id, id: randomUUID(), status: 'running', sessionId: data.sessionId, prompt: data.prompt.trim(), text: '', agent: 'codex' };
        jobs.set(job.id, job); if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
        busy = true; log('codex', '已提交本地任务');
        // Use configured workdir, never accept an arbitrary browser supplied directory.
        Promise.resolve().then(() => run(taskConfig, { prompt: job.prompt, sessionId: job.sessionId, onSession: id => { job.sessionId = id; } }))
          .then(result => { Object.assign(job, result, { status: 'completed' }); log('codex', '任务已完成'); })
          .catch(error => {
            const failure = codexFailure(error);
            job.status = 'failed'; job.errorCode = failure.code; job.text = `${failure.message}（错误类型：${failure.code}）`;
            // Only expose structured process metadata, never raw stderr or model responses.
            job.failure = {
              exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null,
              signal: /^SIG[A-Z0-9]+$/.test(error.signal || '') ? error.signal : null,
              completed: error.completed === true,
              resumed: Boolean(data.sessionId),
            };
            log('codex', `${job.text} ${JSON.stringify(job.failure)}`, 'error');
          })
          .finally(() => { busy = false; });
        return json(job, 202);
      }
      if (path.startsWith('/api/')) return json({ error: '接口不存在' }, 404);
      if (req.method !== 'GET') return json({ error: '请求方法无效' }, 405);
      const requested = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const file = resolve('dist', requested);
      if (!file.startsWith(resolve('dist') + '/')) return json({ error: '路径无效' }, 403);
      let content;
      try { content = await readFile(file); } catch { content = await readFile(resolve('dist/index.html')); }
      res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'text/html; charset=utf-8' }); res.end(content);
    } catch (error) {
      const message = error.code ? '本地文件或服务操作失败，请检查配置和文件权限' : error.message;
      if (error.code === 'ROBOT_RUNNING') return json({ error: error.message, code: error.code, pid: error.pid }, 409);
      json({ error: message }, 400);
    }
  });
  return { server, stopRobot, get busy() { return busy; } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createStudio();
  const port = Number(process.env.STUDIO_PORT || 3210);
  app.server.listen(port, '127.0.0.1', () => console.log(`AW(智能体工作台): http://127.0.0.1:${port}`));
  app.server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`后端启动失败：127.0.0.1:${port} 端口已被占用。请先在运行 pnpm start 或另一份 pnpm dev 的终端按 Ctrl+C，再重新运行 pnpm dev。`);
    } else {
      console.error(`后端启动失败：${error.message}`);
    }
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await app.stopRobot(); app.server.close();
    if (app.busy) console.log('等待当前 Codex 任务完成…');
  });
}
