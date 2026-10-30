import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { spawnSync } from 'node:child_process';
import { readConfig, missingConfig } from './config.js';
import { State } from './state.js';
import { Bridge } from './bridge.js';
import { runCodex } from './codex.js';
import { reply } from './reply.js';
import { acquireRobotLock } from './robot-lock.js';

async function main() {
  const config = readConfig();
  const missing = missingConfig(config);
  if (missing.length) throw new Error(`请先填写 .env：${missing.join(', ')}，再运行 pnpm doctor`);
  const codex = spawnSync(config.codexBin, ['--version'], { encoding: 'utf8', timeout: 10000, cwd: config.workdir });
  if (codex.error || codex.status !== 0) {
    throw new Error('无法启动 Codex。请将 .env 中的 DING_CODEX_BIN 设置为 codex 可执行文件的完整路径，并确认 DING_CODEX_WORKDIR 存在。');
  }
  const lock = await acquireRobotLock(process.env.DING_ROBOT_LOCK_BASE || config.stateFile);
  try {
    // Read persistent state only after owning the lock.
    const state = new State(config.stateFile);
    const client = new DWClient({ clientId: config.clientId, clientSecret: config.clientSecret, keepAlive: true, debug: false });
    let shuttingDown = false;
    const bridge = new Bridge({ config, state, run: runCodex, reply });
    client.registerCallbackListener(TOPIC_ROBOT, response => {
      if (shuttingDown) return;
      try {
        const message = JSON.parse(response.data);
        bridge.accept(message);
        client.socketCallBackResponse(response.headers.messageId, { status: 'SUCCESS' });
      } catch { console.error('消息接收或本地状态保存失败；未确认该消息'); }
    });
    let closeTask;
    const close = () => closeTask ||= (async () => {
      shuttingDown = true;
      console.log('正在等待已接收的任务完成后退出…');
      try {
        try { client.disconnect(); } catch {}
        await bridge.tail;
      } finally {
        await lock.release();
        console.log('机器人已停止，锁文件已清理');
      }
    })();
    const shutdown = () => { close().then(() => process.exit(0), error => {
      console.error(`机器人停止失败：${error.message}`); process.exit(1);
    }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      await client.connect();
      if (shuttingDown) return;
      if (!client.connected) throw new Error('Stream 尚未建立连接');
      console.log(`钉钉 Stream 已连接。Codex 工作目录：${config.workdir}；沙箱：${config.sandbox}`);
    } catch {
      await close();
      throw new Error('钉钉 Stream 连接失败，请检查应用凭据、Stream 模式和网络');
    }
  } catch (error) {
    await lock.release();
    throw error;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
