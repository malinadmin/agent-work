import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

function directories(root) {
  try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
  catch { return []; }
}

// Inspect files only: never execute shell startup files or discovered CLIs.
export function findCli(bin, { env = process.env, home = homedir(), platform = process.platform, arch = process.arch } = {}) {
  const explicitPath = isAbsolute(bin) || /[/\\]/.test(bin);
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean);
  if (!explicitPath) {
    dirs.push(join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.bun/bin'), join(home, '.volta/bin'), join(home, '.cargo/bin'), join(home, '.opencode/bin'));
    if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);
    if (env.NPM_CONFIG_PREFIX) dirs.push(join(env.NPM_CONFIG_PREFIX, 'bin'));
    const nvm = env.NVM_DIR || join(home, '.nvm');
    for (const version of directories(join(nvm, 'versions/node'))) dirs.push(join(nvm, 'versions/node', version, 'bin'));
    if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    if (platform === 'linux') dirs.push('/usr/local/bin', '/usr/bin', '/snap/bin');
  }
  const candidates = explicitPath ? [resolve(bin)] : [...new Set(dirs)].map(dir => resolve(dir, bin));
  if (!explicitPath && bin === 'codex' && platform === 'darwin') {
    candidates.push('/Applications/Codex.app/Contents/Resources/codex', join(home, 'Applications/Codex.app/Contents/Resources/codex'));
  }
  if (!explicitPath && bin === 'codex') {
    const target = `${platform === 'darwin' ? 'macos' : platform}-${arch === 'arm64' ? 'aarch64' : arch}`;
    for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.vscode-server']) {
      const root = join(home, editor, 'extensions');
      for (const extension of directories(root).filter(name => name.startsWith('openai.chatgpt-'))) {
        candidates.push(join(root, extension, 'bin', target, 'codex'));
      }
    }
  }
  return candidates.find(file => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
  }) || null;
}

export function resolveCodexBin(env = process.env, options = {}) {
  const configured = env.DING_CODEX_BIN?.trim();
  // A custom override must not silently fall back to a different installation.
  if (configured && configured !== 'codex') return findCli(configured, { ...options, env }) || configured;
  return findCli('codex', { ...options, env }) || 'codex';
}
