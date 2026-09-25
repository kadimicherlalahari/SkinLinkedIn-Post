import { generatePost } from './generate.js';
import { evaluateNote, formatGateMessage } from './eval/gate.js';
import { formatScoreBlock } from './eval/quality.js';
import { loadEvalSettings } from './eval/settings.js';
import { out10 } from './eval/scale.js';
import { log } from './log.js';

export const MSG_EMPTY = "Send me an idea and I'll turn it into a LinkedIn post.";
export const MSG_FAILED = "I couldn't generate the post right now. Please try again.";

const isAllowed = (chatId, config) => !config.allowedChatId || String(chatId) === config.allowedChatId;

// Handles one Telegram update (a message or an inline-button press).
// deps: { telegram, config, store, generate?, gate? } - generate/gate are injectable for tests.
export async function handleUpdate(update, deps) {
  if (update.callback_query) return handleButton(update.callback_query, deps);

  const { telegram, config, store, gate: runGate = evaluateNote } = deps;
  const msg = update.message;
  if (!msg?.chat) return;
  const chatId = msg.chat.id;

  if (!isAllowed(chatId, config)) {
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

  // Stage 1: note worthiness gate. null = gate unavailable, proceed as before.
  const id = store.newId();
  const gate = await runGate(idea, config);
  store.logEvent({ type: 'gate', id, note: idea, gate_failed: !gate, ...(gate ?? { decision: 'PROCEED' }) });

  if (gate && gate.decision !== 'PROCEED') {
    log.info(`Chat ${chatId}: note ${gate.decision} (${out10(gate.composite)}/10)`);
    const buttons = [{ text: 'Generate anyway', data: `gen:${id}` }];
    if (gate.decision === 'BORDERLINE') buttons.push({ text: 'Skip', data: `skip:${id}` });
    let expiryDays = 7;
    try { expiryDays = loadEvalSettings().stage1.pendingExpiryDays ?? 7; } catch {}
    store.savePending(id, { chatId, replyTo: msg.message_id, note: idea, gate }, expiryDays);
    await telegram.sendText(chatId, formatGateMessage(gate), msg.message_id, buttons);
    return;
  }

  // Research (e.g. Google News RSS) will slot in here, between the gate and generation.
  await produce({ id, chatId, replyTo: msg.message_id, idea, gate }, deps);
}

async function handleButton(cq, deps) {
  const { telegram, config, store } = deps;
  const chatId = cq.message?.chat?.id;
  if (!chatId || !isAllowed(chatId, config)) {
    log.warn(`Ignoring button press from unauthorised chat ${chatId}`);
    return;
  }

  const [action, id] = String(cq.data ?? '').split(':');
  const pending = id ? store.takePending(id) : null;
  if (!pending || !['gen', 'skip'].includes(action)) {
    await telegram.answerCallback(cq.id, 'This note has already been handled or has expired.');
    return;
  }

  const generate = action === 'gen';
  store.logEvent({ type: 'override', id, action: generate ? 'generate_anyway' : 'skip', original_decision: pending.gate.decision, composite: pending.gate.composite });
  await telegram.answerCallback(cq.id, generate ? 'Generating...' : 'Skipped');
  await telegram.editText(chatId, cq.message.message_id, `${cq.message.text ?? ''}\n\n→ ${generate ? 'Generating anyway.' : 'Skipped.'}`);
  log.info(`Chat ${chatId}: note ${id} ${generate ? 'generated anyway' : 'skipped'} (was ${pending.gate.decision})`);

  if (generate) {
    await telegram.sendTyping(chatId);
    await produce({ id, chatId, replyTo: pending.replyTo, idea: pending.note, gate: pending.gate, overridden: true }, deps);
  }
}

// Generation + Stage 2, then delivery: the post alone (copy-paste clean), then the score block.
async function produce({ id, chatId, replyTo, idea, gate, overridden = false }, { telegram, config, store, generate = generatePost }) {
  const typing = setInterval(() => telegram.sendTyping(chatId), 4500);
  let result;
  try {
    result = await generate(idea, config, { gate, pastPosts: store.readPosts() });
  } catch (err) {
    log.error(`Generation failed for chat ${chatId}:`, err);
    await telegram.sendText(chatId, MSG_FAILED, replyTo);
    return;
  } finally {
    clearInterval(typing);
  }

  await telegram.sendText(chatId, result.post, replyTo);
  const label = store.addPost({ id, pillar: gate?.pillar ?? null, angle: result.quality?.angle ?? null, post: result.post });
  if (result.quality) {
    store.logEvent({ type: 'quality', id, post_label: label, overridden, angle: result.quality.angle, overlap: result.quality.overlap, score: result.quality.score, deductions: result.quality.deductions, flags: result.quality.flags, regenerated: result.quality.regenerated, first_score: result.quality.firstScore });
    await telegram.sendText(chatId, formatScoreBlock(result.quality, gate, { overridden, html: true }), undefined, undefined, { html: true });
  }
  log.info(`Chat ${chatId}: post delivered${result.quality ? ` (score ${out10(result.quality.score)}/10)` : ''} as ${label}`);
}
