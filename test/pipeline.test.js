import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.js';
import { handleUpdate, MSG_EMPTY, MSG_FAILED } from '../src/bot.js';
import { generatePost } from '../src/generate.js';
import { cleanPost } from '../src/validate.js';
import { redact } from '../src/log.js';
import { splitMessage } from '../src/telegram.js';

const SKILL = resolve(ROOT, 'skills/meera-pillai-voice/SKILL.md');
const config = { geminiApiKey: 'test-key-123456', geminiModel: 'gemini-test', geminiTemperature: 0.7, allowedChatId: '42', voiceSkillPath: SKILL };
const POST = Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1} is a calm, precise sentence about the idea. It is also short.`.repeat(3)).join('\n\n');

function fakeTelegram() {
  const sent = [];
  return { sent, sendTyping: async () => {}, sendText: async (chatId, text) => sent.push({ chatId, text }) };
}
const update = (text, chatId = 42) => ({ update_id: 1, message: { message_id: 7, chat: { id: chatId }, text } });

let realFetch, requests;
beforeEach(() => {
  realFetch = globalThis.fetch;
  requests = [];
});
afterEach(() => { globalThis.fetch = realFetch; });

function mockGemini(...replies) {
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, opts, body: JSON.parse(opts.body) });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: reply });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] }, finishReason: 'STOP' }] }));
  };
}

const IDEAS = {
  'one-line': "Most companies don't have a hiring problem. They have a problem explaining why someone should work there.",
  'messy paragraph': 'ok so ppl keep saying customers want cheaper but honestly i think they want to not feel dumb when they buy, like pricing pages r confusing and that is the actual problem not the price itself',
  bullets: '- labels list % of actives\n- nobody lists pH\n- pH decides if active even works\n- so % alone is kinda meaningless',
  incomplete: 'the thing about trust in DTC brands is that',
  'personal observation': "I noticed that people don't really hate complicated products. They hate products that make them feel stupid.",
};

for (const [kind, idea] of Object.entries(IDEAS)) {
  test(`${kind} idea: voice skill + idea sent to Gemini, only the post comes back`, async () => {
    mockGemini(POST);
    const tg = fakeTelegram();
    await handleUpdate(update(idea), { telegram: tg, config });

    assert.equal(requests.length, 1);
    const { url, opts, body } = requests[0];
    assert.match(url, /models\/gemini-test:generateContent$/);
    assert.ok(!url.includes(config.geminiApiKey), 'API key must not be in URL');
    assert.equal(opts.headers['x-goog-api-key'], config.geminiApiKey);
    const system = body.systemInstruction.parts[0].text;
    assert.ok(system.includes('# Meera Pillai / Skinstinct - Voice Skill'), 'voice skill loaded into prompt');
    assert.ok(system.includes('Do not invent personal experiences'));
    assert.equal(body.contents[0].parts[0].text, `RAW IDEA:\n${idea}`);

    assert.deepEqual(tg.sent, [{ chatId: 42, text: POST }]);
  });
}

test('empty / command / non-text messages get the prompt message', async () => {
  mockGemini(POST);
  for (const u of [update('   '), update('/start'), { update_id: 2, message: { message_id: 1, chat: { id: 42 }, sticker: {} } }]) {
    const tg = fakeTelegram();
    await handleUpdate(u, { telegram: tg, config });
    assert.deepEqual(tg.sent, [{ chatId: 42, text: MSG_EMPTY }]);
  }
  assert.equal(requests.length, 0);
});

test('Gemini failure sends friendly error, no internals', async () => {
  mockGemini(400);
  const tg = fakeTelegram();
  await handleUpdate(update('an idea'), { telegram: tg, config });
  assert.deepEqual(tg.sent, [{ chatId: 42, text: MSG_FAILED }]);
});

test('Gemini 503 is retried', async () => {
  mockGemini(503, POST);
  const post = await generatePost('an idea', config);
  assert.equal(post, POST);
  assert.equal(requests.length, 2);
});

test('missing voice skill fails clearly instead of generating generically', async () => {
  mockGemini(POST);
  await assert.rejects(generatePost('idea', { ...config, voiceSkillPath: '/nope/SKILL.md' }), /Voice skill could not be loaded/);
  assert.equal(requests.length, 0);
});

test('messages from other chats are ignored', async () => {
  mockGemini(POST);
  const tg = fakeTelegram();
  await handleUpdate(update('idea', 999), { telegram: tg, config });
  assert.equal(tg.sent.length, 0);
  assert.equal(requests.length, 0);
});

test('cleanPost strips preamble, markdown, em dashes', () => {
  const raw = "Here's your LinkedIn post:\n\n**The label** says 10% — it is also meaningless.\n\n\n\nSecond para.";
  assert.equal(cleanPost(raw), 'The label says 10% - it is also meaningless.\n\nSecond para.');
  assert.equal(cleanPost('```\nBody text.\n```'), 'Body text.');
});

test('redact scrubs secrets and token-shaped strings', () => {
  process.env.GEMINI_API_KEY = 'AIzaSECRETSECRET';
  assert.equal(redact('key=AIzaSECRETSECRET'), 'key=[GEMINI_API_KEY]');
  assert.equal(redact('bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'), 'bot[TELEGRAM_BOT_TOKEN]');
  delete process.env.GEMINI_API_KEY;
});

test('splitMessage respects Telegram limit', () => {
  const chunks = splitMessage(('a'.repeat(3000) + '\n\n').repeat(3), 4096);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.equal(chunks.length, 3);
});
