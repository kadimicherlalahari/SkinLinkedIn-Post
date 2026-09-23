import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export function loadConfig({ needTelegram = true } = {}) {
  return {
    geminiApiKey: required('GEMINI_API_KEY'),
    geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-pro',
    geminiTemperature: Number(process.env.GEMINI_TEMPERATURE ?? 0.7),
    telegramToken: needTelegram ? required('TELEGRAM_BOT_TOKEN') : null,
    allowedChatId: process.env.TELEGRAM_CHAT_ID?.trim() || null,
    voiceSkillPath: resolve(ROOT, process.env.VOICE_SKILL_PATH?.trim() || 'skills/meera-pillai-voice/SKILL.md'),
  };
}
