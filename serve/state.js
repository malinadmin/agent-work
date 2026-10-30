import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class State {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8'));
      if (this.data.version !== 1 || !this.data.sessions || !Array.isArray(this.data.seen)) {
        throw new Error('状态文件格式不支持');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 1, sessions: {}, seen: [] };
    }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }
  claim(id) {
    if (this.data.seen.includes(id)) return false;
    const previous = this.data.seen;
    this.data.seen = [...previous, id].slice(-2000);
    try { this.save(); } catch (error) { this.data.seen = previous; throw error; }
    return true;
  }
  get(key) { return this.data.sessions[key] || {}; }
  set(key, value) {
    const previous = this.data.sessions[key];
    this.data.sessions[key] = value;
    try { this.save(); } catch (error) {
      if (previous === undefined) delete this.data.sessions[key];
      else this.data.sessions[key] = previous;
      throw error;
    }
  }
}
