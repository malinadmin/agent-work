import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (callbackError) return reject(callbackError);
      if (timedOut) return reject(new Error(`Codex 执行超时（${config.timeout / 1000} 秒），任务已停止`));
      if (code !== 0 || !complete || failure) {
        // Do not pass raw stderr to DingTalk; it may contain local credentials or paths.
        const error = new Error(`Codex 执行失败（退出码 ${code ?? 'signal'}），请在本机检查登录、网络和会话 ID`);
        error.diagnostic = failure || output;
        return reject(error);
      }
      resolve({ sessionId: threadId, text: messages.at(-1) || 'Codex 已完成，本次没有文本回复。' });
    });
    child.stdin.end(prompt);
  });
}
