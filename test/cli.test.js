import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findCli, resolveCodexBin } from '../serve/cli.js';
import { readConfig } from '../serve/config.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'aw-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { home, env: { PATH: '' }, platform: 'test' };
  const add = (path, mode = 0o700) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode });
    return path;
  };
  return { home, options, add };
}

test('CLI discovery prefers PATH and falls back to local installations', t => {
  const { home, options, add } = fixture(t);
  const local = add(join(home, '.local/bin/codex'));
  assert.equal(findCli('codex', options), local);
  const path = add(join(home, 'path/codex'));
  options.env.PATH = dirname(path);
  assert.equal(findCli('codex', options), path);
  assert.equal(resolveCodexBin({ PATH: dirname(path) }, options), path);
  assert.equal(readConfig({ PATH: dirname(path) }).codexBin, path);
});

test('CLI discovery supports nvm versions, npm prefix and desktop app', t => {
  const { home, options, add } = fixture(t);
  add(join(home, '.nvm/versions/node/v9.0.0/bin/codex'));
  const newest = add(join(home, '.nvm/versions/node/v24.0.0/bin/codex'));
  assert.equal(findCli('codex', options), newest);
  const prefix = add(join(home, 'npm/bin/claude'));
  options.env.NPM_CONFIG_PREFIX = join(home, 'npm');
  assert.equal(findCli('claude', options), prefix);
  const app = add(join(home, 'Applications/Codex.app/Contents/Resources/codex'));
  assert.equal(findCli(app, options), app);
});

test('CLI discovery rejects directories and non-executable files, preserves overrides', t => {
  const { home, options, add } = fixture(t);
  add(join(home, '.local/bin/codex'), 0o600);
  mkdirSync(join(home, '.local/bin/claude'));
  assert.equal(findCli('codex', options), null);
  assert.equal(findCli('claude', options), null);
  assert.equal(resolveCodexBin({}, options), 'codex');
  add(join(home, '.volta/bin/codex'));
  const missing = join(home, 'missing/codex');
  assert.equal(findCli(missing, options), null);
  assert.equal(resolveCodexBin({ DING_CODEX_BIN: missing }, options), missing);
});

test('CLI discovery finds editor bundled Codex without inherited PATH', t => {
  const { home, options, add } = fixture(t);
  options.arch = 'arm64';
  // Use a platform fixture without system-level CLI candidates.
  options.platform = 'fixture';
  add(join(home, '.vscode/extensions/openai.chatgpt-1.0.0/bin/fixture-aarch64/codex'));
  const fixtureBin = add(join(home, '.vscode/extensions/openai.chatgpt-2.0.0/bin/fixture-aarch64/codex'));
  assert.equal(findCli('codex', options), fixtureBin);
  assert.equal(resolveCodexBin({ PATH: '' }, options), fixtureBin);
});
