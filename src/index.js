import { loadConfig } from './config.js';
import { loadVoiceSkill } from './voiceSkill.js';
import { createTelegram } from './telegram.js';
import { handleUpdate } from './bot.js';
import { log } from './log.js';

async function main() {
  const config = loadConfig();

  // Fail fast at startup if the voice skill is missing, rather than on the first message.
  const skill = loadVoiceSkill(config.voiceSkillPath);
  log.info(`Voice skill loaded: ${config.voiceSkillPath} (${skill.length} chars)`);
  log.info(`Gemini model: ${config.geminiModel}`);
  if (!config.allowedChatId) log.warn('TELEGRAM_CHAT_ID not set - the bot will answer ANY chat. Set it to restrict access.');

  const telegram = createTelegram(config.telegramToken);
  const me = await telegram.getMe();
  log.info(`Connected to Telegram as @${me.username}. Waiting for ideas...`);

  let offset;
  let backoff = 1000;
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log.info('Shutting down'); process.exit(0); });

  while (!stopping) {
    let updates;
    try {
      updates = await telegram.getUpdates(offset);
      backoff = 1000;
    } catch (err) {
      if (err.status === 401) throw new Error('Telegram rejected TELEGRAM_BOT_TOKEN (401). Check the token.');
      if (err.status === 409) log.error('Telegram 409: another instance is polling, or a webhook is set on this bot. Stop the other instance / delete the webhook.');
      else log.error('Polling error:', err);
      await new Promise((r) => setTimeout(r, (err.retryAfter ?? 0) * 1000 || backoff));
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        await handleUpdate(update, { telegram, config });
      } catch (err) {
        // Typically a failed sendMessage; log and move on so one bad update can't stall the bot.
        log.error(`Failed handling update ${update.update_id}:`, err);
      }
    }
  }
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
