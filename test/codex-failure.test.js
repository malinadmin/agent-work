import test from 'node:test';
import assert from 'node:assert/strict';
import { codexFailure } from '../serve/codex.js';

test('Codex errors expose actionable categories without leaking raw diagnostics', () => {
  for (const [diagnostic, code] of [
    ['401 Unauthorized sk-secret', 'AUTH'],
    ['403 Forbidden', 'ACCESS_DENIED'],
    ['429 rate limit', 'RATE_LIMIT'],
    ['model test is not supported', 'MODEL'],
    ['session not found', 'SESSION'],
    ['stream disconnected: error sending request', 'NETWORK'],
    ['unexpected argument --test', 'CLI_ARGUMENTS'],
    ['Codex 执行超时', 'TIMEOUT'],
    ['unclassified secret-diagnostic', 'EXECUTION_FAILED'],
  ]) {
    const result = codexFailure(Object.assign(new Error('execution failed'), { diagnostic }));
    assert.equal(result.code, code);
    assert.ok(!result.message.includes('sk-secret'));
    assert.ok(!result.message.includes('secret-diagnostic'));
  }
  assert.equal(codexFailure({ code: 'ENOENT' }).code, 'CLI_NOT_FOUND');
  assert.equal(codexFailure({ code: 'EACCES' }).code, 'CLI_PERMISSION');
});
