import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModels } from '../serve/models.js';
import { codexArgs } from '../serve/codex.js';

test('模型列表合并当前配置、本机默认与缓存，隐藏内部模型及其他配置内容', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aw-models-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), 'model = "local-default" # default\napi_key = "secret"\n[profiles.other]\nmodel = "other-profile"\n');
  await writeFile(join(home, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'cached-model', display_name: 'Cached model', base_instructions: 'private-context' },
    { slug: 'local-default', display_name: 'Duplicate' },
    { slug: 'internal', visibility: 'hide' },
    { slug: null },
  ] }));
  const result = await readModels({ model: 'custom-provider-model' }, { home });
  assert.equal(result.defaultModel, 'local-default');
  assert.deepEqual(result.models.map(m => m.id), ['custom-provider-model', 'local-default', 'cached-model']);
  assert.equal(result.cacheAvailable, true);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('private-context'));
});

test('缓存或本机配置缺失、损坏时仍可选择当前模型和自定义模型', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aw-models-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await readModels({}, { home }), { models: [], defaultModel: '', cacheAvailable: false });
  await writeFile(join(home, 'models_cache.json'), '{broken');
  const result = await readModels({ model: 'custom-model' }, { home });
  assert.equal(result.models[0].id, 'custom-model'); assert.equal(result.cacheAvailable, false);
});

test('指定模型用于新建和续接任务，沿用本机配置时不传模型覆盖参数', () => {
  for (const sessionId of [undefined, '01900000-0000-7000-8000-000000000001']) {
    const args = codexArgs({ sandbox: 'read-only', model: 'custom-provider-model' }, sessionId);
    assert.equal(args[args.indexOf('--model') + 1], 'custom-provider-model');
    assert.equal(codexArgs({ sandbox: 'read-only', model: '' }, sessionId).includes('--model'), false);
  }
});
