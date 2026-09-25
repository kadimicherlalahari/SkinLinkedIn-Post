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
      call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, (timeout + 10) * 1000),
    sendTyping: (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}),
    // Plain text (no parse_mode) so the post arrives exactly as written and copies cleanly.
    // buttons: optional [{text, data}] shown as one row of inline buttons on the last chunk.
    // Pass html: true only for bot-generated cards (never the post - it must stay plain for copy-paste).
    async sendText(chatId, text, replyTo, buttons, { html = false } = {}) {
      const chunks = splitMessage(text);
      let sent;
      for (const [i, chunk] of chunks.entries()) {
        sent = await call('sendMessage', {
          chat_id: chatId,
          text: chunk,
          link_preview_options: { is_disabled: true },
          ...(html ? { parse_mode: 'HTML' } : {}),
          ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
          ...(buttons && i === chunks.length - 1
            ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } }
            : {}),
        });
      }
      return sent;
    },
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {}),
    // Replaces a message's text and removes its buttons.
    editText: (chatId, messageId, text) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } }).catch(() => {}),
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
