import { generateJSON } from '../gemini.js';
import { loadEvalSettings, loadPrompt, loadProductData, claimPromptVars, pillarList } from './settings.js';
import { scoreClaims } from './claims.js';
import { findCoverage, checkExternalClaims } from './research.js';
import { articleLine } from '../news.js';
import { out10 } from './scale.js';
import { log } from '../log.js';

export const METRIC_LABELS = {
  topic_fit: 'Topic Fit',
  concrete_anchor: 'Concrete Anchor',
  claim_safety: 'Claim Safety',
  single_takeaway: 'Single Takeaway',
  newsworthiness: 'Newsworthiness',
};

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));
const isScore = (n) => typeof n === 'number' && Number.isFinite(n);
const strOrNull = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);

function validateGateResponse(raw) {
  const s = raw?.scores ?? {};
  for (const key of ['topic_fit', 'concrete_anchor', 'single_takeaway', 'newsworthiness']) {
    if (!isScore(s[key])) throw new Error(`scores.${key} missing or not a number`);
  }
  if (typeof raw.pillar !== 'string') throw new Error('pillar missing');
  if (!isScore(raw.topic_confidence)) throw new Error('topic_confidence missing');
  if (!Array.isArray(raw.claims ?? [])) throw new Error('claims is not an array');
  return raw;
}

const pickSource = (a) => ({ title: a.title, source: a.source, date: a.date, link: a.link });

// Pure scoring/routing: model output + settings -> Stage 1 result in the spec's format.
// coverage: { query, articles } from the news search (articles are what the model saw, by index).
export function scoreGate(raw, settings, hasProductData, coverage = { query: null, articles: [] }) {
  const { weights, thresholds, newsworthinessDefault, newsworthinessWithCoverageMin } = settings.stage1;
  const claims = scoreClaims(raw.claims, { hasProductData, deductions: settings.claims.deductions });

  // Only coverage the model marked relevant counts. No relevant coverage (or RSS failed): the
  // score can't go above the default. Relevant coverage: it must end up above the default.
  const indices = Array.isArray(raw.relevant_articles) ? raw.relevant_articles : [];
  const relevant = [...new Set(indices)].map((i) => coverage.articles[i]).filter(Boolean).slice(0, settings.news?.maxArticles ?? 3);
  let news = clamp(raw.scores.newsworthiness);
  news = relevant.length ? Math.max(news, newsworthinessWithCoverageMin ?? newsworthinessDefault + 1) : Math.min(news, newsworthinessDefault);

  const scores = {
    topic_fit: clamp(raw.scores.topic_fit),
    concrete_anchor: clamp(raw.scores.concrete_anchor),
    claim_safety: claims.score,
    single_takeaway: clamp(raw.scores.single_takeaway),
    newsworthiness: news,
  };
  const composite = Math.round(Object.entries(weights).reduce((sum, [k, w]) => sum + w * scores[k], 0));
  const topicConfidence = clamp(raw.topic_confidence);
  const offTopic = topicConfidence < thresholds.minTopicConfidence;
  const decision = offTopic ? 'REJECT' : composite >= thresholds.proceed ? 'PROCEED' : composite >= thresholds.borderline ? 'BORDERLINE' : 'REJECT';

  return {
    pillar: raw.pillar.trim() || 'None',
    topic_confidence: topicConfidence,
    scores,
    composite,
    decision,
    off_topic: offTopic,
    anchor_found: strOrNull(raw.anchor_found),
    candidate_takeaway: strOrNull(raw.candidate_takeaway),
    flagged_claims: claims.flagged.map(({ claim, type, status, deduction, source }) => ({ claim, type, status, deduction, ...(source ? { source } : {}) })),
    news: { query: coverage.query, articles: relevant.map(pickSource) },
    sources: [
      ...relevant.map((a) => ({ ...pickSource(a), usedFor: 'newsworthiness' })),
      ...claims.sources.map((a) => ({ ...pickSource(a), usedFor: a.usedFor })),
    ],
    reason: strOrNull(raw.reason) ?? '',
    suggestion: strOrNull(raw.suggestion) ?? '',
  };
}

// Stage 1. Returns the evaluation, or null if the gate itself failed (caller then proceeds as before).
export async function evaluateNote(note, config) {
  try {
    const settings = loadEvalSettings();
    if (settings.enabled === false) return null;
    const productData = loadProductData(settings);
    const coverage = await findCoverage(note, config, settings);
    const prompt = loadPrompt('note-gate', {
      PILLARS: pillarList(settings),
      OFF_TOPIC: settings.offTopicExamples,
      NEWS_DEFAULT: settings.stage1.newsworthinessDefault,
      NEWS_DAYS: settings.news?.days ?? 30,
      MAX_ARTICLES: settings.news?.maxArticles ?? 3,
      ARTICLES: coverage.articles.length ? coverage.articles.map(articleLine).join('\n') : '(none found - keep newsworthiness at or below the default)',
      ...claimPromptVars(productData),
      NOTE: note,
    });
    const raw = await generateJSON(
      { apiKey: config.geminiApiKey, model: config.evalModel, temperature: settings.evalTemperature, userContent: prompt },
      validateGateResponse,
    );
    raw.claims = await checkExternalClaims(raw.claims, config, settings);
    return scoreGate(raw, settings, Boolean(productData), coverage);
  } catch (err) {
    log.error('Note gate failed, defaulting to PROCEED:', err);
    return null;
  }
}

const metricLine = (gate) => Object.entries(gate.scores).map(([k, v]) => `${METRIC_LABELS[k]} ${out10(v)}`).join(' · ');

// Telegram message for BORDERLINE / REJECT notes.
export function formatGateMessage(gate) {
  if (gate.decision === 'BORDERLINE') {
    const weakest = Object.entries(gate.scores)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 2)
      .map(([k, v]) => `${METRIC_LABELS[k]} ${out10(v)}`)
      .join(', ');
    return [
      `Note score: ${out10(gate.composite)}/10 (borderline, not generated yet)`,
      `Pillar: ${gate.pillar}`,
      `Weakest: ${weakest}`,
      `Scores: ${metricLine(gate)}`,
      `What would strengthen it: ${gate.suggestion}`,
    ].join('\n');
  }
  const reason = gate.off_topic
    ? `Off-topic for your pillars (closest: ${gate.pillar}, confidence ${out10(gate.topic_confidence)}/10). ${gate.reason}`
    : gate.reason;
  return [`Note score: ${out10(gate.composite)}/10 (not worth posting yet)`, reason, `Scores: ${metricLine(gate)}`, `Suggestion: ${gate.suggestion}`].join('\n');
}
