import { readFileSync } from 'node:fs';

// The voice skill file is the single source of truth for how posts sound.
// It is read from disk on every generation so edits take effect without a restart.
// If it is missing or unreadable we throw - never fall back to a generic style.
export function loadVoiceSkill(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Voice skill could not be loaded from ${path}: ${err.code ?? err.message}`);
  }
  if (text.trim().length < 200) {
    throw new Error(`Voice skill at ${path} is empty or truncated (${text.trim().length} chars)`);
  }
  return text;
}
