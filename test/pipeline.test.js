import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT } from '../src/config.js';
import { handleUpdate, MSG_EMPTY, MSG_FAILED } from '../src/bot.js';
import { generatePost } from '../src/generate.js';
import { cleanPost } from '../src/validate.js';
import { redact } from '../src/log.js';
import { splitMessage } from '../src/telegram.js';
import { scoreGate, formatGateMessage } from '../src/eval/gate.js';
import { ruleViolations, formatScoreBlock } from '../src/eval/quality.js';
import { scoreClaims } from '../src/eval/claims.js';
import { loadEvalSettings } from '../src/eval/settings.js';
import { createStore } from '../src/eval/store.js';
import { parseRss, isAllowed } from '../src/news.js';

const SKILL = resolve(ROOT, 'skills/meera-pillai-voice/SKILL.md');
const config = { geminiApiKey: 'test-key-123456', geminiModel: 'gemini-test', evalModel: 'gemini-eval', geminiTemperature: 0.7, allowedChatId: '42', voiceSkillPath: SKILL };
const settings = loadEvalSettings();
const POST = Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1} is a calm, precise sentence about the idea. It is also short.`.repeat(3)).join('\n\n');

const GATE_STRONG = { pillar: 'Formulation Science', topic_confidence: 90, scores: { topic_fit: 90, concrete_anchor: 90, single_takeaway: 80, newsworthiness: 75 }, anchor_found: 'cloudy at 40°C', candidate_takeaway: 'Stability testing is where formulations fail.', claims: [], reason: 'Specific lab observation.', suggestion: 'Lean on the chelator detail.' };
const GATE_WEAK = { ...GATE_STRONG, scores: { topic_fit: 60, concrete_anchor: 30, single_takeaway: 40, newsworthiness: 60 } };
const GATE_OFFTOPIC = { ...GATE_STRONG, pillar: 'None', topic_confidence: 10 };
const QUALITY_OK = { opening: { strong: true, reason: 'number' }, closing: { strong: true, reason: 'verdict' }, false_authority: [], hype_words: [], claims: [], angle: 'Why stability testing matters.', overlap: { post_id: null, new_angle: null } };

function fakeTelegram() {
  const sent = [];
  const edits = [];
  return {
    sent, edits,
    sendTyping: async () => {},
    sendText: async (chatId, text, replyTo, buttons) => { sent.push({ chatId, text, ...(buttons ? { buttons } : {}) }); return { message_id: 99 }; },
    answerCallback: async () => {},
    editText: async (chatId, messageId, text) => edits.push(text),
  };
}
const update = (text, chatId = 42) => ({ update_id: 1, message: { message_id: 7, chat: { id: chatId }, text } });
const press = (data, chatId = 42) => ({ update_id: 2, callback_query: { id: 'cb', data, message: { message_id: 99, chat: { id: chatId }, text: 'gate msg' } } });
const tmpStore = () => createStore(mkdtempSync(resolve(tmpdir(), 'lpg-')));

let realFetch, requests;
beforeEach(() => { realFetch = globalThis.fetch; requests = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const rssItem = (title, source, url, date = 'Wed, 16 Sep 2026 07:00:00 GMT') =>
  `<item><title>${title} - ${source}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(title).slice(0, 20)}</link><pubDate>${date}</pubDate><description>&lt;a href="x"&gt;${title}&lt;/a&gt;</description><source url="${url}">${source}</source></item>`;
const RSS = `<?xml version="1.0"?><rss><channel>${[
  rssItem('CDSCO flags 2 creams over excess heavy metals', 'The Hindu', 'https://www.thehindu.com'),
  rssItem('8 Niacinamide Serums To Clear Sticky Monsoon Sebum', 'femina.in', 'https://www.femina.in'),
  rssItem('Study finds niacinamide stable only above pH 5 &amp; below 40°C', 'Reuters', 'https://www.reuters.com', 'Fri, 18 Sep 2026 07:00:00 GMT'),
].join('')}</channel></rss>`;

// Routes mocked calls: Google News RSS by URL; Gemini calls by which prompt they carry.
// Each value: a response, a list (consumed in order), or an HTTP status.
function mockGemini({ gate = GATE_STRONG, quality = QUALITY_OK, post = POST, query = { query: 'niacinamide stability', skip: false }, claimcheck = { results: [] }, rss = RSS } = {}) {
  const queues = { gate: [].concat(gate), quality: [].concat(quality), post: [].concat(post), query: [].concat(query), claimcheck: [].concat(claimcheck), rss: [].concat(rss) };
  globalThis.fetch = async (url, opts = {}) => {
    let kind;
    let body = null;
    if (String(url).startsWith('https://news.google.com/rss/search')) kind = 'rss';
    else {
      body = JSON.parse(opts.body);
      const text = body.contents[0].parts[0].text;
      kind = text.startsWith('You are the editorial gate') ? 'gate'
        : text.startsWith('You are the final quality check') ? 'quality'
        : text.startsWith('You turn a raw note') ? 'query'
        : text.startsWith('You check doubtful') ? 'claimcheck'
        : 'post';
    }
    requests.push({ kind, url: String(url), opts, body });
    const q = queues[kind];
    const reply = q.length > 1 ? q.shift() : q[0];
    if (typeof reply === 'number') return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: reply });
    if (kind === 'rss') return new Response(reply);
    const out = typeof reply === 'string' ? reply : JSON.stringify(reply);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] }));
  };
}
const RESEARCH = new Set(['query', 'rss', 'claimcheck']);
// Main pipeline calls only; research calls are checked separately.
const kinds = () => requests.filter((r) => !RESEARCH.has(r.kind)).map((r) => r.kind);
const research = () => requests.filter((r) => RESEARCH.has(r.kind)).map((r) => r.kind);

const IDEAS = {
  'one-line': "Most companies don't have a hiring problem. They have a problem explaining why someone should work there.",
  'messy paragraph': 'ok so ppl keep saying customers want cheaper but honestly i think they want to not feel dumb when they buy',
  bullets: '- labels list % of actives\n- nobody lists pH\n- pH decides if active even works',
  incomplete: 'the thing about trust in DTC brands is that',
  'personal observation': "I noticed that people don't really hate complicated products. They hate products that make them feel stupid.",
};

for (const [kind, idea] of Object.entries(IDEAS)) {
  test(`${kind} idea: gate -> generate -> quality, post then score block`, async () => {
    mockGemini();
    const tg = fakeTelegram();
    await handleUpdate(update(idea), { telegram: tg, config, store: tmpStore() });

    assert.deepEqual(kinds(), ['gate', 'post', 'quality']);
    const gen = requests.find((r) => r.kind === 'post');
    assert.match(gen.url, /models\/gemini-test:generateContent$/);
    assert.match(requests.find((r) => r.kind === 'gate').url, /models\/gemini-eval:generateContent$/, 'gate uses eval model');
    assert.ok(!gen.url.includes(config.geminiApiKey), 'API key must not be in URL');
    assert.ok(gen.body.systemInstruction.parts[0].text.includes('# Meera Pillai / Skinstinct - Voice Skill'));
    const user = gen.body.contents[0].parts[0].text;
    assert.ok(user.startsWith(`RAW IDEA:\n${idea}`));
    assert.ok(user.includes('Candidate takeaway to land the ending on'), 'gate context passed to generator');

    assert.equal(tg.sent.length, 2);
    assert.deepEqual(tg.sent[0], { chatId: 42, text: POST }, 'post arrives alone');
    assert.equal(tg.sent[1].text, [
      'CONTENT SCORE: 10/10',
      'Pillar: Formulation Science',
      'Angle: Why stability testing matters.',
      'Overlap: none (no past posts yet)',
      '',
      'Note Gate: 9/10',
      '  Topic Fit 9 · Concrete Anchor 9 · Claim Safety 10 · Single Takeaway 8 · Newsworthiness 7.5',
      'Draft checks:',
      '  Opening ✓ · Closing ✓ · Voice ✓ · Sourcing ✓ · Claims 10/10',
      '',
      'Deductions: none',
      'Flags: none',
      '',
      'Sources: none (no relevant coverage for "niacinamide stability")',
    ].join('\n'));
    assert.deepEqual(research(), ['query', 'rss']);
    assert.match(requests.find((r) => r.kind === 'rss').url, /q=niacinamide%20stability%20when%3A30d&hl=en-IN&gl=IN&ceid=IN:en$/);
  });
}

test('empty / command / non-text messages get the prompt message, no LLM calls', async () => {
  mockGemini();
  for (const u of [update('   '), update('/start'), { update_id: 2, message: { message_id: 1, chat: { id: 42 }, sticker: {} } }]) {
    const tg = fakeTelegram();
    await handleUpdate(u, { telegram: tg, config, store: tmpStore() });
    assert.deepEqual(tg.sent, [{ chatId: 42, text: MSG_EMPTY }]);
  }
  assert.equal(requests.length, 0);
});

test('BORDERLINE: no generation, message with both buttons; Generate anyway runs pipeline and logs override', async () => {
  mockGemini({ gate: GATE_WEAK });
  const tg = fakeTelegram();
  const store = tmpStore();
  await handleUpdate(update('People keep asking about sunscreen.'), { telegram: tg, config, store });

  assert.deepEqual(kinds(), ['gate']);
  const msg = tg.sent[0];
  assert.match(msg.text, /borderline/);
  assert.match(msg.text, /Weakest: Concrete Anchor 3, Single Takeaway 4/);
  assert.match(msg.text, /Note score: \d(\.\d)?\/10/);
  assert.match(msg.text, /Scores: Topic Fit 6 · Concrete Anchor 3/);
  assert.deepEqual(msg.buttons.map((b) => b.text), ['Generate anyway', 'Skip']);

  await handleUpdate(press(msg.buttons[0].data), { telegram: tg, config, store });
  assert.deepEqual(kinds(), ['gate', 'post', 'quality']);
  assert.equal(tg.sent[1].text, POST);
  assert.match(tg.sent[2].text, /Note Gate: [\d.]+\/10 \(BORDERLINE, generated anyway\)/);
  assert.match(tg.edits[0], /Generating anyway/);

  // Button can't be used twice.
  await handleUpdate(press(msg.buttons[0].data), { telegram: tg, config, store });
  assert.equal(tg.sent.length, 3);
});

test('BORDERLINE Skip generates nothing', async () => {
  mockGemini({ gate: GATE_WEAK });
  const tg = fakeTelegram();
  const store = tmpStore();
  await handleUpdate(update('idea'), { telegram: tg, config, store });
  await handleUpdate(press(tg.sent[0].buttons[1].data), { telegram: tg, config, store });
  assert.deepEqual(kinds(), ['gate']);
  assert.match(tg.edits[0], /Skipped/);
});

test('off-topic note is rejected by the hard rule with only a Generate anyway button', async () => {
  mockGemini({ gate: GATE_OFFTOPIC });
  const tg = fakeTelegram();
  await handleUpdate(update('Loving the glass skin trend'), { telegram: tg, config, store: tmpStore() });
  assert.deepEqual(kinds(), ['gate']);
  assert.match(tg.sent[0].text, /not worth posting yet[\s\S]*Off-topic/);
  assert.deepEqual(tg.sent[0].buttons.map((b) => b.text), ['Generate anyway']);
});

test('gate returns invalid JSON twice -> defaults to PROCEED', async () => {
  mockGemini({ gate: 'not json' });
  const tg = fakeTelegram();
  const store = tmpStore();
  await handleUpdate(update('idea'), { telegram: tg, config, store });
  assert.deepEqual(kinds(), ['gate', 'gate', 'post', 'quality']);
  assert.equal(tg.sent[0].text, POST);
  assert.match(tg.sent[1].text, /Note Gate: n\/a/);
});

test('gate API error -> defaults to PROCEED', async () => {
  mockGemini({ gate: 400 });
  const tg = fakeTelegram();
  await handleUpdate(update('idea'), { telegram: tg, config, store: tmpStore() });
  assert.equal(tg.sent[0].text, POST);
});

test('voice violations trigger exactly one corrected regeneration; better version is sent', async () => {
  const bad = `${POST}\n\nThis is a game-changer! Let me know your thoughts.`;
  mockGemini({ post: [bad, POST] });
  const result = await generatePost('idea', config, { gate: null });
  assert.deepEqual(kinds(), ['post', 'quality', 'post', 'quality']);
  assert.equal(result.post, POST);
  assert.equal(result.quality.regenerated, true);
  assert.ok(result.quality.firstScore < result.quality.score);
  const correction = requests.filter((r) => r.kind === 'post')[1].body.contents[0].parts[0].text;
  assert.match(correction, /CORRECTIONS[\s\S]*game-changer[\s\S]*exclamation mark[\s\S]*engagement bait/);
});

test('never regenerates more than once, keeps the better-scoring draft', async () => {
  const bad = `${POST}\n\nAmazing.`;
  const worse = `${POST}\n\nAmazing, luxurious, magical!`;
  mockGemini({ post: [bad, worse] });
  const result = await generatePost('idea', config);
  assert.deepEqual(kinds(), ['post', 'quality', 'post', 'quality']);
  assert.equal(result.post, bad);
  assert.equal(result.quality.keptFirst, true);
});

test('quality model failure -> rule checks only, flagged partial', async () => {
  mockGemini({ quality: 'garbage' });
  const result = await generatePost('idea', config);
  assert.ok(result.quality.flags.includes('QUALITY_CHECK_PARTIAL'));
  assert.equal(result.post, POST);
});

test('weak opening/closing and claim flags are scored and shown in the block', async () => {
  mockGemini({
    quality: {
      opening: { strong: false, reason: 'vague observation' },
      closing: { strong: false, reason: 'asks the audience a question' },
      false_authority: [{ line: 2, text: 'We have solved stability.', reason: 'note admits a failure' }],
      hype_words: [],
      claims: [{ line: 3, claim: 'stable for 36 months at pH 3.2', type: 'internal', status: 'unverified', source: 'note', quote: 'idea' }, { line: 4, claim: 'niacinamide converts to niacin below pH 4', type: 'external', status: 'established', source: 'voice_skill', quote: 'niacinamide converts to niacin below pH 4' }],
    },
    post: [POST, POST],
  });
  const { quality } = await generatePost('idea', config);
  // false authority (-10), opening (-10), closing (-10), internal claim needs confirmation (-5)
  assert.equal(quality.score, 65);
  assert.deepEqual(quality.checks, { opening: false, closing: false, voiceIssues: 1, unsourced: 0, claimScore: 95 });
  const block = formatScoreBlock(quality, scoreGate(GATE_STRONG, settings, false));
  assert.match(block, /\[line 2\] "We have solved stability\." → false authority/);
  assert.match(block, /^CONTENT SCORE: 6\.5\/10/);
  assert.match(block, /Opening ✗ · Closing ✗ · Voice 1 issue · Sourcing ✓ · Claims 9\.5\/10/);
  assert.match(block, /\[line 1\] ".*" → weak opening: vague observation \(−1\)/);
  assert.match(block, /\[line 3\] "stable for 36 months at pH 3\.2" → internal claim needs confirmation \(−0\.5\)/);
  assert.match(block, /Flags: NEEDS_CONFIRMATION\n\nSources: none$/);
});

test('overlap: past posts are sent to the checker, recorded after sending, and shown on the card', async () => {
  const store = tmpStore();
  const tg = fakeTelegram();
  mockGemini();
  await handleUpdate(update('first idea'), { telegram: tg, config, store });
  assert.deepEqual(store.readPosts().map((p) => [p.label, p.angle]), [['post_001', 'Why stability testing matters.']]);

  mockGemini({ quality: { ...QUALITY_OK, overlap: { post_id: 'post_001', new_angle: 'Adds the chelator detail.' } } });
  await handleUpdate(update('second idea'), { telegram: tg, config, store });
  const qualityPrompt = requests.findLast((r) => r.kind === 'quality').body.contents[0].parts[0].text;
  assert.match(qualityPrompt, /\[post_001\] \(\d{4}-\d\d-\d\d, Formulation Science\) Angle: Why stability testing matters\./);
  const card = tg.sent.at(-1).text;
  assert.match(card, /Overlap: overlaps with post_001; new angle: Adds the chelator detail\./);
  assert.match(card, /Flags: OVERLAP/);
  assert.equal(store.readPosts().length, 2);

  // An id the model made up is ignored.
  mockGemini({ quality: { ...QUALITY_OK, overlap: { post_id: 'post_999', new_angle: 'x' } } });
  await handleUpdate(update('third idea'), { telegram: tg, config, store });
  assert.match(tg.sent.at(-1).text, /Overlap: none \(checked 2 past posts\)/);
});

test('parseRss + allow-list: strips " - Source", decodes entities, keeps only allowed domains', () => {
  const items = parseRss(RSS);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { title: 'CDSCO flags 2 creams over excess heavy metals', link: items[0].link, date: '2026-09-16', source: 'The Hindu', sourceUrl: 'https://www.thehindu.com' });
  assert.equal(items[2].title, 'Study finds niacinamide stable only above pH 5 & below 40°C');
  const allowed = settings.news.allowedSources;
  assert.deepEqual(items.map((a) => isAllowed(a, allowed)), [true, false, true]);
  assert.equal(isAllowed({ sourceUrl: 'https://m.economictimes.com' }, allowed), true);
  assert.equal(isAllowed({ sourceUrl: 'https://notthehindu.com' }, allowed), false);
});

test('relevant coverage raises newsworthiness, is passed to the generator and listed under Sources', async () => {
  mockGemini({ gate: { ...GATE_STRONG, relevant_articles: [1] } });
  const tg = fakeTelegram();
  const store = tmpStore();
  await handleUpdate(update('niacinamide note'), { telegram: tg, config, store });

  // Allowed results only, newest first: [0] Reuters (18 Sep), [1] The Hindu (16 Sep).
  const gatePrompt = requests.find((r) => r.kind === 'gate').body.contents[0].parts[0].text;
  assert.match(gatePrompt, /\[0\] Reuters, 2026-09-18: "Study finds niacinamide/);
  assert.match(gatePrompt, /\[1\] The Hindu, 2026-09-16/);
  assert.ok(!gatePrompt.includes('femina'), 'non-allowed source filtered out');

  const gen = requests.find((r) => r.kind === 'post').body.contents[0].parts[0].text;
  assert.match(gen, /Recent coverage from credible sources[\s\S]*The Hindu, 2026-09-16: "CDSCO flags 2 creams/);

  const card = tg.sent[1].text;
  assert.match(card, /Newsworthiness 8\b/, 'raised from 75 to the coverage minimum (80)');
  assert.match(card, /Sources:\n- The Hindu, 2026-09-16: <a href="https:\/\/news\.google\.com\/rss\/articles\/[^"]+">"CDSCO flags 2 creams over excess heavy metals"<\/a> \(recent coverage\)/);
  assert.ok(!card.includes('\n  https://'), 'no raw URLs in the HTML card');
});

test('no credible results for the specific query -> retries once with the broader fallback term', async () => {
  mockGemini({ query: { query: 'niacinamide stability', fallback: 'niacinamide', skip: false }, rss: ['<rss><channel></channel></rss>', RSS], gate: { ...GATE_STRONG, relevant_articles: [0] } });
  const tg = fakeTelegram();
  await handleUpdate(update('idea'), { telegram: tg, config, store: tmpStore() });
  const urls = requests.filter((r) => r.kind === 'rss').map((r) => decodeURIComponent(r.url.match(/q=([^&]+)/)[1]));
  assert.deepEqual(urls, ['niacinamide stability when:30d', 'niacinamide when:30d']);
  assert.match(tg.sent[1].text, /Sources:\n- Reuters/);
});

test('RSS failure or no newsworthy topic: default newsworthiness, note still proceeds', async () => {
  for (const opts of [{ rss: 500 }, { query: { query: '', skip: true } }, { query: 'garbage' }]) {
    requests = [];
    mockGemini({ ...opts, gate: { ...GATE_STRONG, scores: { ...GATE_STRONG.scores, newsworthiness: 95 }, relevant_articles: [0] } });
    const tg = fakeTelegram();
    await handleUpdate(update('idea'), { telegram: tg, config, store: tmpStore() });
    assert.equal(tg.sent[0].text, POST);
    assert.match(tg.sent[1].text, /Newsworthiness 7\.5/, 'capped at default without coverage');
  }
});

test('doubtful external claims: supported by a credible headline -> no deduction; contradicted -> -10 with source', async () => {
  const gate = {
    ...GATE_STRONG,
    claims: [
      { claim: 'niacinamide is stable only above pH 5', type: 'external', status: 'doubtful', search_query: 'niacinamide pH stability' },
      { claim: 'these creams are safe', type: 'external', status: 'doubtful', search_query: 'CDSCO creams' },
      { claim: 'our serum lasts 36 months', type: 'internal', status: 'needs_confirmation' },
    ],
  };
  mockGemini({ gate, claimcheck: { results: [{ claim: 0, verdict: 'supports', article: 0 }, { claim: 1, verdict: 'contradicts', article: 1 }] } });
  const tg = fakeTelegram();
  const store = tmpStore();
  await handleUpdate(update('note with claims'), { telegram: tg, config, store });

  // topic search + one search per doubtful EXTERNAL claim (internal never searched) + one judge call.
  assert.deepEqual(research(), ['query', 'rss', 'rss', 'rss', 'claimcheck']);
  const check = requests.find((r) => r.kind === 'claimcheck').body.contents[0].parts[0].text;
  assert.ok(!check.includes('36 months'));

  const card = tg.sent[1].text;
  // claim safety: internal -5, contradicted -10, supported 0 => 85
  assert.match(card, /Claim Safety 8\.5/);
  assert.match(card, /- Reuters, 2026-09-18: <a href="[^"]+">"Study finds niacinamide stable only above pH 5 &amp; below 40°C"<\/a> \(supports: niacinamide is stable only above pH 5\)/);
  assert.match(card, /- The Hindu, 2026-09-16: <a href="[^"]+">"CDSCO flags.*"<\/a> \(contradicts: these creams are safe\)/);

  const gen = requests.find((r) => r.kind === 'post').body.contents[0].parts[0].text;
  assert.match(gen, /do not state them as fact[\s\S]*these creams are safe \(contradicted by The Hindu/);
  assert.ok(!/do not state them as fact[\s\S]*stable only above pH 5/.test(gen), 'supported claim is not flagged to the writer');
});

test('Stage 2: contradicted claim in the draft is deducted with its source', async () => {
  mockGemini({
    quality: { ...QUALITY_OK, claims: [{ line: 2, claim: 'these creams are safe', type: 'external', status: 'doubtful', source: 'note', quote: 'idea', search_query: 'CDSCO creams' }] },
    claimcheck: { results: [{ claim: 0, verdict: 'contradicts', article: 1 }] },
  });
  const { quality } = await generatePost('idea', config);
  assert.equal(quality.score, 90);
  assert.match(formatScoreBlock(quality, null), /\[line 2\] "these creams are safe" → external claim doubtful, contradicted by The Hindu \(2026-09-16\) \(−1\)/);
});

test('credible sources only: unsourced claims are violations and trigger one rewrite; note, skill, article and news-backed claims pass', async () => {
  const draftClaims = [
    { line: 1, claim: 'the batch went cloudy at 40°C', type: 'internal', status: 'needs_confirmation', source: 'note', quote: 'serum go cloudy at 40°C' },
    { line: 2, claim: 'the base determines whether the active arrives', type: 'external', status: 'established', source: 'voice_skill', quote: 'It determines whether the active arrives.' },
    { line: 2, claim: 'CDSCO flagged two creams', type: 'external', status: 'established', source: 'article', article: 0, quote: 'CDSCO flags 2 creams' },
    { line: 2, claim: 'the model says the note says this', type: 'internal', status: 'needs_confirmation', source: 'note', quote: 'words that are not in the note' },
    { line: 3, claim: 'mercury suppresses melanin', type: 'external', status: 'established', source: 'none', search_query: 'mercury creams' },
    { line: 3, claim: 'stable only above pH 5', type: 'external', status: 'established', source: 'none', search_query: 'niacinamide pH' },
    { line: 4, claim: 'we tested 12 batches', type: 'internal', status: 'needs_confirmation', source: 'none' },
    { line: 4, claim: 'article 9 says so', type: 'external', status: 'established', source: 'article', article: 9 },
  ];
  const clean = { ...QUALITY_OK, claims: draftClaims.slice(0, 3) };
  // (the 'claimcheck' calls below index only external claims needing a check: mercury, pH 5, article 9)
  mockGemini({
    quality: [{ ...QUALITY_OK, claims: draftClaims }, clean],
    // Checked (external + unsourced): 'mercury...' [0], 'stable only above pH 5' [1], 'article 9...' [2]
    claimcheck: [{ results: [{ claim: 1, verdict: 'supports', article: 0 }] }, { results: [] }],
    post: [POST, POST],
  });
  const articles = [{ title: 'CDSCO flags 2 creams', source: 'The Hindu', date: '2026-09-16', link: 'https://news.google.com/rss/articles/a' }];
  const note = 'Saw a batch of our niacinamide serum go cloudy at 40°C in stability testing today.';
  const { quality } = await generatePost(note, config, { gate: { ...scoreGate(GATE_STRONG, settings, false), news: { query: 'x', articles } } });

  // First draft: 4 unsourced (mercury, 12 batches, bad article index, fake note quote) -> rewritten once; clean second draft kept.
  assert.deepEqual(kinds(), ['post', 'quality', 'post', 'quality']);
  const correction = requests.filter((r) => r.kind === 'post')[1].body.contents[0].parts[0].text;
  assert.match(correction, /mercury suppresses melanin": unsourced claim/);
  assert.match(correction, /we tested 12 batches": unsourced claim/);
  assert.match(correction, /article 9 says so": unsourced claim/);
  assert.match(correction, /the model says the note says this": unsourced claim/, 'quote not found in note');
  assert.ok(!/cloudy at 40°C": unsourced/.test(correction), 'quote found in note');
  assert.ok(!/active arrives": unsourced/.test(correction), 'quote found in voice skill');
  assert.ok(!/CDSCO flagged two creams": unsourced/.test(correction), 'quote found in headline');
  assert.ok(!/stable only above pH 5": unsourced/.test(correction), 'backed by a credible headline');
  assert.equal(quality.checks.unsourced, 0);
  assert.equal(quality.firstScore, 55); // 4 unsourced (-40) + internal needs confirmation (-5)
  assert.match(formatScoreBlock(quality, null), /Sourcing ✓/);
});

test('generation prompt restricts facts to the note, voice skill and listed articles', async () => {
  mockGemini();
  await generatePost('idea', config);
  const system = requests.find((r) => r.kind === 'post').body.systemInstruction.parts[0].text;
  assert.match(system, /Credible sources only\. Every factual statement[\s\S]*Do not add facts from your own general knowledge/);
});

test('scoreGate: composite, thresholds and hard topic rule come from config', () => {
  const g = scoreGate(GATE_STRONG, settings, false);
  assert.equal(g.composite, Math.round(0.25 * 90 + 0.25 * 90 + 0.25 * 100 + 0.15 * 80 + 0.1 * 75));
  assert.equal(g.decision, 'PROCEED');
  assert.equal(scoreGate(GATE_WEAK, settings, false).decision, 'BORDERLINE');
  assert.equal(scoreGate({ ...GATE_WEAK, scores: { topic_fit: 20, concrete_anchor: 10, single_takeaway: 10, newsworthiness: 20 } }, settings, false).decision, 'REJECT');
  const off = scoreGate({ ...GATE_OFFTOPIC, scores: { topic_fit: 100, concrete_anchor: 100, single_takeaway: 100, newsworthiness: 100 } }, settings, false);
  assert.equal(off.decision, 'REJECT', 'high composite cannot override topic_confidence < 50');
  assert.match(formatGateMessage(off), /Off-topic/);
});

test('claim rules: no product data -> internal needs_confirmation (-5); with data -> unverified (-20); doubtful external -10', () => {
  const d = settings.claims.deductions;
  const claims = [
    { claim: 'our serum is pH 5.5', type: 'internal', status: 'unverified' },
    { claim: 'vitamin C cures melasma', type: 'external', status: 'doubtful' },
    { claim: 'niacinamide is water-soluble', type: 'external', status: 'established' },
  ];
  const none = scoreClaims(claims, { hasProductData: false, deductions: d });
  assert.deepEqual(none.flagged.map((c) => [c.status, c.deduction]), [['needs_confirmation', 5], ['doubtful', 10]]);
  assert.equal(none.score, 85);
  const withData = scoreClaims(claims, { hasProductData: true, deductions: d });
  assert.equal(withData.flagged[0].deduction, 20);
  assert.equal(scoreClaims([{ claim: 'x', type: 'internal', status: 'unverified' }].concat(Array(10).fill({ claim: 'y', type: 'internal' })), { hasProductData: true, deductions: d }).score, 0, 'floored at 0');
});

test('ruleViolations: emoji, hashtag, !, lists, fluff and bait with line numbers', () => {
  const v = ruleViolations('Fine opening line.\n\n- a bullet\n\nThis will elevate you 🚀 #skincare\n\nWhat do you think!', settings);
  const rules = v.map((x) => `${x.line}:${x.rule}`);
  assert.ok(rules.includes('2:bulleted/numbered list'));
  assert.ok(rules.includes('3:emoji'));
  assert.ok(rules.includes('3:hashtag'));
  assert.ok(rules.includes('3:fluff/marketing word'));
  assert.ok(rules.includes('4:exclamation mark'));
  assert.ok(rules.includes('4:engagement bait / warm sign-off'));
  assert.equal(ruleViolations('Skin-loving is a label, not a claim. pH 5.5-5.8 matters.', settings).length, 1);
});

test('evaluations are logged with note, scores, decision and override', async () => {
  mockGemini({ gate: GATE_WEAK });
  const dir = mkdtempSync(resolve(tmpdir(), 'lpg-'));
  const store = createStore(dir);
  const tg = fakeTelegram();
  await handleUpdate(update('my note'), { telegram: tg, config, store });
  await handleUpdate(press(tg.sent[0].buttons[0].data), { telegram: tg, config, store });
  const events = readFileSync(resolve(dir, 'evaluations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((e) => e.type), ['gate', 'override', 'quality']);
  assert.equal(events[0].note, 'my note');
  assert.equal(events[0].decision, 'BORDERLINE');
  assert.ok(events[0].scores.concrete_anchor === 30);
  assert.equal(events[1].action, 'generate_anyway');
  assert.equal(events[2].overridden, true);
  assert.ok(new Set(events.map((e) => e.id)).size === 1, 'events joined by id');
});

test('Gemini generation failure sends friendly error, no internals', async () => {
  mockGemini({ post: 400 });
  const tg = fakeTelegram();
  await handleUpdate(update('an idea'), { telegram: tg, config, store: tmpStore() });
  assert.deepEqual(tg.sent, [{ chatId: 42, text: MSG_FAILED }]);
});

test('missing voice skill fails clearly instead of generating generically', async () => {
  mockGemini();
  await assert.rejects(generatePost('idea', { ...config, voiceSkillPath: '/nope/SKILL.md' }), /Voice skill could not be loaded/);
  assert.equal(requests.length, 0);
});

test('messages and button presses from other chats are ignored', async () => {
  mockGemini();
  const tg = fakeTelegram();
  await handleUpdate(update('idea', 999), { telegram: tg, config, store: tmpStore() });
  await handleUpdate(press('gen:abc', 999), { telegram: tg, config, store: tmpStore() });
  assert.equal(tg.sent.length, 0);
  assert.equal(requests.length, 0);
});

test('cleanPost strips preamble, markdown, em dashes', () => {
  const raw = "Here's your LinkedIn post:\n\n**The label** says 10% — it is also meaningless.\n\n\n\nSecond para.";
  assert.equal(cleanPost(raw), 'The label says 10% - it is also meaningless.\n\nSecond para.');
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
