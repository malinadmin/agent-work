import { spawnSync } from 'node:child_process';
import { readConfig, missingConfig } from './config.js';

try {
  const config = readConfig();
  const result = spawnSync(config.codexBin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error('无法运行 Codex，请设置 DING_CODEX_BIN 为 codex 的完整路径');
  console.log(`Codex：${result.stdout.trim()}`);
  console.log(`工作目录：${config.workdir}`);
  console.log(`沙箱：${config.sandbox}`);
  console.log(`初始会话：${config.sessionId || '按钉钉聊天和用户新建'}`);
  const missing = missingConfig(config);
  if (missing.length) {
    console.log(`待配置：${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('本地检查通过。运行 pnpm robot 连接钉钉；此检查不验证远程凭据和 Codex 认证有效性。');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
