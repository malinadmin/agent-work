import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findCli } from './cli.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function executable(bin) {
  return Boolean(findCli(bin));
}
export async function detectAgents(config, home = homedir()) {
  const entries = [
    ['codex', 'Codex', config.codexBin, '.codex/sessions', 'OpenAI', true],
    ['claude', 'Claude Code', 'claude', '.claude/projects', 'Anthropic', false],
    ['gemini', 'Gemini CLI', 'gemini', '.gemini/tmp', 'Google', false],
    ['deepseek', 'DeepSeek', 'deepseek', '.deepseek', 'DeepSeek', false],
    ['aider', 'Aider', 'aider', '.aider', '开源智能体', false],
    ['opencode', 'OpenCode', 'opencode', '.local/share/opencode', '开源智能体', false],
  ];
  return Promise.all(entries.map(async ([id, name, bin, folder, vendor, chat]) => {
    const cliPath = findCli(bin, { home });
    const installed = Boolean(cliPath);
    const history = await access(join(home, folder)).then(() => true, () => false);
    return { id, name, vendor, installed, cliPath, history, chat: chat && installed, historySupported: ['codex', 'claude'].includes(id) };
  }));
}
async function filesIn(root, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const groups = await Promise.all(entries.map(entry => entry.isDirectory() ? filesIn(join(root, entry.name), depth + 1)
    : entry.isFile() && entry.name.endsWith('.jsonl') ? [join(root, entry.name)] : []));
  return groups.flat();
}
export function parseRecord(event, agent) {
  if (agent === 'codex' && event.type === 'response_item' && event.payload?.type === 'message' && ['user', 'assistant'].includes(event.payload.role)) {
    const text = (event.payload.content || []).filter(x => ['input_text', 'output_text'].includes(x.type)).map(x => x.text || '').join('\n');
    if (!text || (event.payload.role === 'user' && /^(<environment_context>|<INSTRUCTIONS>|# AGENTS\.md)/.test(text.trim()))) return;
    return { role: event.payload.role, text };
  }
  if (agent === 'codex' && event.type === 'event_msg' && ['user_message', 'agent_message'].includes(event.payload?.type)) {
    return { role: event.payload.type === 'user_message' ? 'user' : 'assistant', text: event.payload.message || '' };
  }
  if (agent === 'claude' && ['user', 'assistant'].includes(event.type)) {
    const content = event.message?.content;
    const text = typeof content === 'string' ? content : (content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    if (text && !event.isMeta) return { role: event.type, text };
  }
}
export class Histories {
  constructor(home = homedir(), { codexHome = process.env.CODEX_HOME || join(home, '.codex') } = {}) { this.home = home; this.codexHome = codexHome; this.entries = new Map(); }
  async list() {
    const all = [];
    for (const [agent, folder] of [['codex', '.codex/sessions'], ['claude', '.claude/projects']]) {
      const paths = await filesIn(agent === 'codex' ? join(this.codexHome, 'sessions') : join(this.home, folder));
      const ranked = await Promise.all(paths.map(async file => ({ file, modified: (await stat(file)).mtimeMs })));
      for (const { file, modified } of ranked.sort((a, b) => b.modified - a.modified).slice(0, 80)) {
        let id, cwd = '', title = '';
        let scanned = 0;
        const input = createReadStream(file);
        const lines = createInterface({ input, crlfDelay: Infinity });
        try { for await (const line of lines) {
          scanned += Buffer.byteLength(line);
          try {
            const event = JSON.parse(line);
            if (agent === 'codex' && event.type === 'session_meta') { id = event.payload.id; cwd = event.payload.cwd || ''; }
            if (agent === 'claude') { id ||= event.sessionId; cwd ||= event.cwd || ''; }
            const message = parseRecord(event, agent);
            if (!title && message?.role === 'user') title = message.text.split('## My request:').at(-1).replace(/<[^>]*>/g, '').trim().slice(0, 70);
          } catch {}
          if ((id && title) || scanned > 2 * 1024 * 1024) break;
        } } finally { lines.close(); input.destroy(); }
        if (!id) continue;
        const key = `${agent}:${id}`;
        const entry = { key, id, agent, cwd, title: title || '未命名本地会话', modified };
        this.entries.set(key, { ...entry, file });
        all.push(entry);
      }
    }
    return all.sort((a, b) => b.modified - a.modified);
  }
  async read(key) {
    const entry = this.entries.get(key);
    if (!entry) throw new Error('会话不存在，请刷新历史记录');
    const messages = [];
    const canonicalRoles = new Set();
    const input = createReadStream(entry.file);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const event = JSON.parse(line);
          const msg = parseRecord(event, entry.agent);
          if (msg?.text) {
            const canonical = event.type !== 'response_item';
            if (canonical) canonicalRoles.add(msg.role);
            messages.push({ ...msg, canonical });
            if (messages.length > 1000) messages.shift();
          }
        } catch {}
      }
    } finally { lines.close(); input.destroy(); }
    const { file, ...metadata } = entry;
    return { ...metadata, messages: messages.filter(msg => msg.canonical || !canonicalRoles.has(msg.role)).slice(-300).map(({ canonical, ...msg }) => msg) };
  }
}
