import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Only expose model identifiers and display names; never return raw Codex configuration.
export async function readModels(config, { home = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  const [cache, settings] = await Promise.allSettled([
    readFile(join(home, 'models_cache.json'), 'utf8').then(JSON.parse),
    readFile(join(home, 'config.toml'), 'utf8'),
  ]);
  let defaultModel = '';
  if (settings.status === 'fulfilled') {
    const root = settings.value.split(/^\s*\[/m)[0];
    const match = root.match(/^model\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')\s*(?:#.*)?$/m);
    defaultModel = match?.[1] || match?.[2] || '';
  }
  const models = new Map();
  const add = (id, name, source) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || /[\r\n\0]/.test(id)) return;
    if (!models.has(id)) models.set(id, { id, name: typeof name === 'string' ? name.slice(0, 128) : id, source });
  };
  add(config.model, config.model, '当前配置');
  add(defaultModel, defaultModel, '本机默认');
  if (cache.status === 'fulfilled' && Array.isArray(cache.value?.models)) {
    for (const model of cache.value.models) {
      if (model.visibility !== 'hide') add(model.slug, model.display_name || model.slug, '本地模型缓存');
    }
  }
  return { models: [...models.values()], defaultModel, cacheAvailable: cache.status === 'fulfilled' && Array.isArray(cache.value?.models) };
}
