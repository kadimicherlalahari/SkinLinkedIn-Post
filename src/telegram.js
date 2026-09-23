// Minimal Telegram Bot API client (long polling, no webhook server needed).
const MAX_MESSAGE = 4096;

export function createTelegram(token) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, params, timeoutMs = 30_000) {
    let res;
    try {
      res = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Rethrow without the URL (it contains the token).
      throw new Error(`Telegram ${method} network error: ${err.name}${err.cause?.code ? ` ${err.cause.code}` : ''}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`Telegram ${method} failed: ${res.status} ${data.description ?? res.statusText}`);
      err.status = res.status;
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }

  return {
    getMe: () => call('getMe', {}),
    getUpdates: (offset, timeout = 50) =>
      call('getUpdates', { offset, timeout, allowed_updates: ['message'] }, (timeout + 10) * 1000),
    sendTyping: (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}),
    // Plain text (no parse_mode) so the post arrives exactly as written and copies cleanly.
    async sendText(chatId, text, replyTo) {
      for (const chunk of splitMessage(text)) {
        await call('sendMessage', {
          chat_id: chatId,
          text: chunk,
          link_preview_options: { is_disabled: true },
          ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        });
      }
    },
  };
}

// Split on paragraph boundaries if a post ever exceeds Telegram's limit.
export function splitMessage(text, limit = MAX_MESSAGE) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = '';
  for (const para of text.split('\n\n')) {
    const next = current ? `${current}\n\n${para}` : para;
    if (next.length <= limit) current = next;
    else {
      if (current) chunks.push(current);
      current = para;
      while (current.length > limit) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
