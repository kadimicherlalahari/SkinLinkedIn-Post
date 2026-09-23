import { loadVoiceSkill } from './voiceSkill.js';
import { buildSystemInstruction, buildUserContent } from './prompt.js';
import { generateText } from './gemini.js';
import { cleanPost, validatePost } from './validate.js';
import { log } from './log.js';

const MAX_GENERATIONS = 2;

// Raw idea -> finished LinkedIn post. Throws on any failure (caller decides what the user sees).
export async function generatePost(idea, config) {
  const voiceSkill = loadVoiceSkill(config.voiceSkillPath);
  const request = {
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    temperature: config.geminiTemperature,
    systemInstruction: buildSystemInstruction(voiceSkill),
    userContent: buildUserContent(idea),
  };

  let best = null;
  for (let i = 1; i <= MAX_GENERATIONS; i++) {
    const post = cleanPost(await generateText(request));
    const check = validatePost(post);
    log.info(`Generation ${i}: ${check.words} words${check.problems.length ? `, issues: ${check.problems.join(', ')}` : ''}`);
    if (check.ok && (!best || check.problems.length < best.check.problems.length)) best = { post, check };
    if (best && best.check.problems.length === 0) break;
  }

  if (!best) throw new Error('Generated post failed validation (empty or too short)');
  if (best.check.problems.length) log.warn(`Sending post with remaining issues: ${best.check.problems.join(', ')}`);
  return best.post;
}
