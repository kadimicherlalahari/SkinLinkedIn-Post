import { loadVoiceSkill } from './voiceSkill.js';
import { buildSystemInstruction, buildUserContent } from './prompt.js';
import { generateText } from './gemini.js';
import { cleanPost, validatePost } from './validate.js';
import { checkPost } from './eval/quality.js';
import { loadEvalSettings } from './eval/settings.js';
import { out10 } from './eval/scale.js';
import { log } from './log.js';

// Raw idea -> finished LinkedIn post. Throws on any failure (caller decides what the user sees).
// Returns { post, quality } where quality is the Stage 2 result, or null if Stage 2 was unavailable.
// gate: optional Stage 1 result, passed to the generator as extra context.
// pastPosts: previously sent posts, for Stage 2's overlap check.
export async function generatePost(idea, config, { gate = null, pastPosts = [] } = {}) {
  const voiceSkill = loadVoiceSkill(config.voiceSkillPath);
  const base = {
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    temperature: config.geminiTemperature,
    systemInstruction: buildSystemInstruction(voiceSkill),
  };
  const draft = async (opts) => cleanPost(await generateText({ ...base, userContent: buildUserContent(idea, { gate, ...opts }) }));

  const first = await draft();
  let result;
  try {
    result = await qualityPass(first, { idea, gate, voiceSkill, config, draft, pastPosts });
  } catch (err) {
    log.error('Post quality check failed, falling back to basic validation:', err);
    result = await basicPass(first, draft);
  }

  if (!validatePost(result.post).ok) throw new Error('Generated post failed validation (empty or too short)');
  return result;
}

// Stage 2: score the draft; if it has voice violations, regenerate once with corrections and keep the better one.
async function qualityPass(first, { idea, gate, voiceSkill, config, draft, pastPosts }) {
  const check = (post) => checkPost({ post, note: idea, voiceSkill, config, pastPosts, articles: gate?.news?.articles ?? [] });
  const q1 = await check(first);
  log.info(`Quality check 1: ${out10(q1.score)}/10, ${q1.voiceViolations.length} voice violations`);

  const maxRegen = loadEvalSettings().stage2.maxRegenerations ?? 1;
  if (!q1.voiceViolations.length || maxRegen < 1) return { post: first, quality: { ...q1, regenerated: false } };

  const second = await draft({ corrections: { draft: first, violations: q1.voiceViolations } });
  const q2 = await check(second);
  log.info(`Quality check 2 (after corrections): ${out10(q2.score)}/10, ${q2.voiceViolations.length} voice violations`);

  const secondIsBetter = validatePost(second).ok && q2.score >= q1.score;
  return secondIsBetter
    ? { post: second, quality: { ...q2, regenerated: true, firstScore: q1.score } }
    : { post: first, quality: { ...q1, regenerated: true, firstScore: q1.score, keptFirst: true } };
}

// Previous behaviour, used only if Stage 2 errors: regenerate once on hashtags/emoji/exclamations.
async function basicPass(first, draft) {
  let best = { post: first, check: validatePost(first) };
  if (best.check.problems.length) {
    const second = await draft();
    const check = validatePost(second);
    if (check.ok && (!best.check.ok || check.problems.length < best.check.problems.length)) best = { post: second, check };
  }
  if (best.check.problems.length) log.warn(`Sending post with remaining issues: ${best.check.problems.join(', ')}`);
  return { post: best.post, quality: null };
}
