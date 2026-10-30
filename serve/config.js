import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { resolveCodexBin } from './cli.js';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }

export function readConfig(env = process.env) {
  const list = value => (value || '').split(',').map(x => x.trim()).filter(Boolean);
  const config = {
    clientId: env.DINGTALK_CLIENT_ID || '',
    clientSecret: env.DINGTALK_CLIENT_SECRET || '',
    allowedUsers: list(env.DINGTALK_ALLOWED_USERS),
    allowedConversations: list(env.DINGTALK_ALLOWED_CONVERSATIONS),
    codexBin: resolveCodexBin(env),
    workdir: resolve(env.DING_CODEX_WORKDIR || '.'),
    sandbox: env.DING_CODEX_SANDBOX || 'read-only',
    model: env.DING_CODEX_MODEL || '',
    sessionId: env.DING_CODEX_SESSION_ID || '',
    timeout: Number(env.DING_CODEX_TIMEOUT_MS || 600000),
    stateFile: resolve(env.STATE_FILE || '.data/state.json'),
  };
  if (!['read-only', 'workspace-write'].includes(config.sandbox)) {
    throw new Error('DING_CODEX_SANDBOX 只能是 read-only 或 workspace-write');
  }
  if (!Number.isSafeInteger(config.timeout) || config.timeout < 1000) {
    throw new Error('DING_CODEX_TIMEOUT_MS 必须是至少 1000 的整数');
  }
  if (config.sessionId && !isSessionId(config.sessionId)) throw new Error('DING_CODEX_SESSION_ID 必须是会话 UUID');
  if (!statSync(config.workdir).isDirectory()) throw new Error('DING_CODEX_WORKDIR 必须是目录');
  return config;
}

export function isSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function missingConfig(config) {
  return [
    !config.clientId && 'DINGTALK_CLIENT_ID',
    !config.clientSecret && 'DINGTALK_CLIENT_SECRET',
  ].filter(Boolean);
}
