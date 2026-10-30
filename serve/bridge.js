import { isSessionId } from './config.js';

const HELP = `发送文本即可与本机 Codex 对话。\n/status 查看会话\n/new 新建会话（下一条消息生效）\n/bind <会话UUID> 续接已有本地会话\n/last 获取上次执行结果\n/help 查看帮助\n群内请 @机器人；各用户会话分别保存。`;

export class Bridge {
  constructor({ config, state, run, reply, log = console.log, onUnauthorized = () => {} }) {
    Object.assign(this, { config, state, run, reply, log, onUnauthorized });
    this.tail = Promise.resolve();
    this.pending = 0;
  }
  accept(message) {
    const sender = message.senderStaffId;
    if (this.config.allowedConversations.length && !this.config.allowedConversations.includes(message.conversationId)) {
      this.log('已忽略未授权会话消息；senderStaffId:', sender || '(缺失)');
      return this.tail;
    }
    if (!sender || !this.config.allowedUsers.includes(sender)) {
      this.log('已忽略未授权消息；senderStaffId:', sender || '(缺失)');
      if (typeof sender === 'string' && sender.length <= 256 && !/[\r\n\0]/.test(sender)) {
        this.onUnauthorized({ id: sender, name: String(message.senderNick || '').replace(/[\r\n\0]/g, '').slice(0, 80) });
      }
      return this.tail;
    }
    if (!message.conversationId || !message.msgId || !message.sessionWebhook) return this.tail;
    if (this.pending >= 20) {
      throw new Error('队列已满，等待钉钉重试');
    }
    const id = JSON.stringify([message.conversationId, message.msgId]);
    if (!this.state.claim(id)) return this.tail;
    const key = JSON.stringify([message.conversationId, sender]);
    this.pending++;
    const job = this.tail.then(() => this.handle(message, key));
    this.tail = job.catch(error => {
      this.log('消息处理失败:', error.message);
    }).finally(() => { this.pending--; });
    return this.tail;
  }
  async handle(message, key) {
    if (message.msgtype !== 'text' || !message.text?.content?.trim()) {
      await this.reply(message, '当前仅支持文本消息。发送 /help 查看帮助。');
      return;
    }
    const text = message.text.content.trim();
    const session = this.state.get(key);
    if (text === '/help') return this.reply(message, HELP);
    if (text === '/status') {
      return this.reply(message, `会话：${session.id || (session.fresh ? '' : this.config.sessionId) || '尚未创建'}\n工作目录：${this.config.workdir}\n沙箱：${this.config.sandbox}\n状态：${session.status || '空闲'}`);
    }
    if (text === '/new') {
      this.state.set(key, { fresh: true });
      return this.reply(message, '已切换至新会话，发送下一条消息开始。');
    }
    if (text.startsWith('/bind')) {
      const id = text.slice(5).trim();
      if (!isSessionId(id)) return this.reply(message, '用法：/bind <Codex 会话 UUID>');
      this.state.set(key, { id });
      return this.reply(message, `已绑定会话 ${id}，下一条消息将续接该会话。请避免同时在桌面端运行同一会话。`);
    }
    if (text === '/last') return this.reply(message, session.lastReply || '尚无保存的执行结果。');
    if (text.startsWith('/')) return this.reply(message, HELP);
    const update = patch => this.state.set(key, { ...this.state.get(key), ...patch });
    update({ status: '执行中', startedAt: new Date().toISOString() });
    this.log('已接收授权任务，开始执行 Codex');
    try {
      await this.reply(message, '已收到，正在交给本机 Codex 处理。');
    } catch { this.log('进度通知未送达，继续处理并保存最终结果'); }
    let result;
    try {
      result = await this.run(this.config, {
        prompt: text,
        sessionId: session.id || (session.fresh ? undefined : this.config.sessionId) || undefined,
        onSession: id => update({ id }),
      });
    } catch (error) {
      update({ status: '失败', lastReply: error.message });
      this.log('Codex 任务执行失败');
      await this.reply(message, error.message);
      return;
    }
    update({ id: result.sessionId, status: '已完成', lastReply: result.text, finishedAt: new Date().toISOString() });
    this.log('Codex 任务已完成，正在发送钉钉回复');
    // Delivery failure must not rerun a completed Codex turn.
    await this.reply(message, result.text);
    this.log('钉钉回复已送达');
  }
}
