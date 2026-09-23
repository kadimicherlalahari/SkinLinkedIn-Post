import { generatePost } from './generate.js';
import { log } from './log.js';

export const MSG_EMPTY = "Send me an idea and I'll turn it into a LinkedIn post.";
export const MSG_FAILED = "I couldn't generate the post right now. Please try again.";

// Handles one Telegram update. Exported separately so it can be tested without the network.
export async function handleUpdate(update, { telegram, config, generate = generatePost }) {
  const msg = update.message;
  if (!msg?.chat) return;
  const chatId = msg.chat.id;

  if (config.allowedChatId && String(chatId) !== config.allowedChatId) {
    log.warn(`Ignoring message from unauthorised chat ${chatId}`);
    return;
  }

  // Text messages, or the caption on a photo/document.
  const idea = (msg.text ?? msg.caption ?? '').trim();
  if (!idea || /^\/\w+(@\w+)?$/.test(idea)) {
    // Empty, non-text (sticker, voice note...), or a bare command like /start.
    log.info(`Chat ${chatId}: empty or non-idea message`);
    await telegram.sendText(chatId, MSG_EMPTY);
    return;
  }

  log.info(`Chat ${chatId}: received idea (${idea.length} chars)`);
  await telegram.sendTyping(chatId);
  const typing = setInterval(() => telegram.sendTyping(chatId), 4500);

  let post;
  try {
    post = await generate(idea, config);
  } catch (err) {
    log.error(`Generation failed for chat ${chatId}:`, err);
    await telegram.sendText(chatId, MSG_FAILED, msg.message_id);
    return;
  } finally {
    clearInterval(typing);
  }

  await telegram.sendText(chatId, post, msg.message_id);
  log.info(`Chat ${chatId}: post delivered`);
}
