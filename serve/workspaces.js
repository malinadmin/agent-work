import { readFile, writeFile, mkdir, rename, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function workspaceForDirectory(directory, workspaces) {
  if (!directory) return null;
  const path = resolve(directory);
  return workspaces.filter(w => path === w.workdir || path.startsWith(w.workdir.endsWith(sep) ? w.workdir : w.workdir + sep)).sort((a, b) => b.workdir.length - a.workdir.length)[0] || null;
}

export async function discoverCodexDirectories(sessions, workspaces) {
  const found = new Map();
  for (const session of sessions) {
    if (session.agent !== 'codex' || typeof session.cwd !== 'string' || !isAbsolute(session.cwd) || /[\r\n\0]/.test(session.cwd)) continue;
    try {
      const workdir = await realpath(session.cwd);
      if (found.has(workdir) || workspaces.some(w => w.workdir === workdir) || !(await stat(workdir)).isDirectory()) continue;
      found.set(workdir, { name: basename(workdir) || '工作空间', workdir });
    } catch { /* Historical directories may have been removed or become inaccessible. */ }
  }
  return [...found.values()];
}
export class Workspaces {
  constructor(file, data) { this.file = file; this.data = data; }
  static async load(file, config) {
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      data = { version: 1, activeId: 'default', items: [{ id: 'default', name: basename(config.workdir) || '默认工作空间', workdir: await realpath(config.workdir), model: config.model || '', sandbox: config.sandbox }] };
    }
    if (data.version !== 1 || !Array.isArray(data.items) || !data.items.length || !data.items.some(w => w.id === data.activeId) || data.items.some(w => !w.id || !w.name || !w.workdir || !['read-only', 'workspace-write'].includes(w.sandbox))) throw new Error('工作空间文件格式无效，请检查 .data/workspaces.json');
    return new Workspaces(file, data);
  }
  get current() { return this.data.items.find(w => w.id === this.data.activeId); }
  snapshot() { return structuredClone(this.data); }
  async commit(data) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temporary, this.file); this.data = data;
    return this.snapshot();
  }
  async validate(input, previous = {}) {
    const value = { ...previous };
    for (const key of ['name', 'workdir', 'model', 'sandbox']) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== 'string' || /[\r\n\0]/.test(input[key])) throw new Error('工作空间配置格式无效');
      value[key] = input[key].trim();
    }
    if (!value.workdir) throw new Error('请输入本地项目目录');
    try {
      value.workdir = await realpath(resolve(value.workdir));
      if (!(await stat(value.workdir)).isDirectory()) throw new Error();
    } catch { throw new Error('工作目录不存在或不是文件夹，请填写已有目录'); }
    if (previous.id && value.workdir !== previous.workdir) throw new Error('已有工作空间的目录固定，请为其他目录添加新空间');
    value.name ||= basename(value.workdir) || '工作空间';
    if (value.name.length > 60) throw new Error('工作空间名称不能超过 60 个字符');
    value.model ||= ''; value.sandbox ||= 'read-only';
    if (!['read-only', 'workspace-write'].includes(value.sandbox)) throw new Error('执行权限无效');
    if (this.data.items.some(w => w.id !== previous.id && w.workdir === value.workdir)) throw new Error('该目录已添加为工作空间');
    return value;
  }
  async add(input) {
    const item = { ...await this.validate(input), id: randomUUID() };
    return this.commit({ ...this.data, activeId: item.id, items: [...this.data.items, item] });
  }
  async update(id, input) {
    const existing = this.data.items.find(w => w.id === id);
    if (!existing) throw new Error('工作空间不存在');
    const item = await this.validate(input, existing);
    return this.commit({ ...this.data, items: this.data.items.map(w => w.id === id ? item : w) });
  }
  async select(id) {
    const item = this.data.items.find(w => w.id === id);
    if (!item) throw new Error('工作空间不存在');
    await this.validate({}, item);
    return this.commit({ ...this.data, activeId: id });
  }
  async remove(id) {
    if (!this.data.items.some(w => w.id === id)) throw new Error('工作空间不存在');
    if (this.data.items.length === 1) throw new Error('至少保留一个工作空间');
    const items = this.data.items.filter(w => w.id !== id);
    return this.commit({ ...this.data, items, activeId: this.data.activeId === id ? items[0].id : this.data.activeId });
  }
}
