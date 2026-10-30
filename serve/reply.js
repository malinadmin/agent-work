export function splitText(text, maxBytes = 12000) {
  const parts = [];
  let part = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes && part) { parts.push(part); part = ''; bytes = 0; }
    part += char;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

export async function reply(message, text, fetchImpl = fetch) {
  const url = new URL(message.sessionWebhook);
  if (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.port || url.username || url.password) {
    throw new Error('机器人回复地址无效');
  }
  if (message.sessionWebhookExpiredTime && Number(message.sessionWebhookExpiredTime) <= Date.now()) {
    throw new Error('钉钉回复地址已过期，请发送 /last 获取结果');
  }
  for (const content of splitText(text)) {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text', text: { content },
        at: { atUserIds: [message.senderStaffId], isAtAll: false },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`钉钉回复 HTTP ${response.status}`);
    const result = await response.json();
    if (result.errcode !== 0) throw new Error(`钉钉回复失败（错误码 ${result.errcode ?? 'unknown'}）`);
  }
}
