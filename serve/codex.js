import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Match internal diagnostics, but expose only fixed messages: stderr may contain credentials.
export function codexFailure(error) {
  const detail = `${error.code || ''} ${error.message || ''} ${error.diagnostic || ''}`;
  const fail = (code, message) => ({ code, message });
  if (error.code === 'ENOENT') return fail('CLI_NOT_FOUND', '无法启动 Codex：CLI 或工作目录不存在，请检查智能体环境和工作空间路径。');
  if (error.code === 'EACCES') return fail('CLI_PERMISSION', '无法启动 Codex：可执行文件或工作目录没有访问权限。');
  if (/超时|timed out|timeout/i.test(detail)) return fail('TIMEOUT', 'Codex 执行超时，任务已停止。请缩小任务范围，或调整 DING_CODEX_TIMEOUT_MS。');
  if (/401|unauthorized|invalid.api.key|not logged in|authentication|token.{0,20}expired/i.test(detail)) return fail('AUTH', 'Codex 认证失败：请使用页面检测到的同一个 CLI 检查登录状态或模型服务凭据。');
  if (/403|forbidden|permission.denied/i.test(detail)) return fail('ACCESS_DENIED', 'Codex 请求被拒绝：请检查模型服务权限、账号或代理访问限制。');
  if (/429|rate.limit|quota|insufficient.credit/i.test(detail)) return fail('RATE_LIMIT', '模型服务限流或额度不足，请检查账号额度或稍后重试。');
  if (/model.{0,60}(not found|not supported|does not exist|unavailable)|unknown model/i.test(detail)) return fail('MODEL', '当前模型不可用，请切换为本机默认模型，或检查模型 ID 和服务支持范围。');
  if (/session.{0,50}(not found|locked|in use)|thread.{0,50}(not found|locked|in use)|no rollout|failed to resume|database is locked|failed to acquire.{0,40}lock/i.test(detail)) return fail('SESSION', 'Codex 会话无法续接或正在被其他客户端使用，请先新建对话测试，并避免同时运行同一会话。');
  if (/connection|connect error|dns|network|stream disconnected|error sending request|502|503|504/i.test(detail)) return fail('NETWORK', 'Codex 无法连接模型服务或连接中断，请检查服务端进程的网络、代理和模型服务地址后重试。');
  if (/unexpected argument|unrecognized.{0,20}(argument|option)|invalid value/i.test(detail)) return fail('CLI_ARGUMENTS', '当前 Codex CLI 不支持执行参数或配置，请检查 CLI 版本与本机配置。');
  return fail('EXECUTION_FAILED', 'Codex 执行失败，原因暂未识别。请用同一个 CLI 在终端测试；可能涉及本机配置或模型服务。');
}

export function codexArgs(config, sessionId) {
  // Global config overrides also apply to exec resume, whose flags differ from exec.
  const args = ['-a', 'never', 'exec', '-c', `sandbox_mode=${JSON.stringify(config.sandbox)}`];
  if (sessionId) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (config.model) args.push('--model', config.model);
  if (sessionId) args.push(sessionId);
  args.push('-');
  return args;
}

export function runCodex(config, { prompt, sessionId, onSession = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.codexBin, codexArgs(config, sessionId), {
      cwd: config.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let threadId = sessionId;
    let output = '';
    let failure = '';
    let complete = false;
    let timedOut = false;
    let callbackError;
    const messages = [];
    const stop = signal => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    };
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      forceTimer = setTimeout(() => stop('SIGKILL'), 3000);
      forceTimer.unref();
    }, config.timeout);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
        try { onSession(threadId); } catch (error) { callbackError = error; stop('SIGTERM'); }
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        messages.push(event.item.text || '');
      }
      if (event.type === 'turn.completed') complete = true;
      if (event.type === 'turn.failed') failure = event.error?.message || 'Codex turn.failed';
      if (event.type === 'error') failure = event.message || 'Codex error';
    });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (callbackError) return reject(callbackError);
      if (timedOut) return reject(new Error(`Codex 执行超时（${config.timeout / 1000} 秒），任务已停止`));
      if (code !== 0 || !complete || failure) {
        // Do not pass raw stderr to DingTalk; it may contain local credentials or paths.
        const error = new Error(`Codex 执行失败（退出码 ${code ?? 'signal'}），请在本机检查登录、网络和会话 ID`);
        error.exitCode = code;
        error.signal = signal;
        error.completed = complete;
        error.diagnostic = [failure, output].filter(Boolean).join('\n');
        return reject(error);
      }
      resolve({ sessionId: threadId, text: messages.at(-1) || 'Codex 已完成，本次没有文本回复。' });
    });
    child.stdin.end(prompt);
  });
}
