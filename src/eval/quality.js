import { generateJSON } from '../gemini.js';
import { loadEvalSettings, loadPrompt, loadProductData, claimPromptVars } from './settings.js';
import { scoreClaims, claimFlag } from './claims.js';
import { out10 } from './scale.js';
import { METRIC_LABELS } from './gate.js';
import { checkExternalClaims } from './research.js';
import { articleLine } from '../news.js';
import { log } from '../log.js';

// Lines = non-empty lines of the post, numbered from 1 (what Meera sees as paragraphs).
export const postLines = (post) => post.split('\n').map((l) => l.trim()).filter(Boolean);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Mechanical voice checks: exact, with line numbers, no model needed.
export function ruleViolations(post, settings) {
  const { fluffWords, engagementBait } = settings.stage2;
  const out = [];
  postLines(post).forEach((text, i) => {
    const line = i + 1;
    const add = (match, rule) => out.push({ line, text: match, rule });

    for (const m of text.matchAll(/\p{Extended_Pictographic}/gu)) add(m[0], 'emoji');
    for (const m of text.matchAll(/(?:^|\s)(#[A-Za-z]\w*)/g)) add(m[1], 'hashtag');
    if (text.includes('!')) add(text.slice(Math.max(0, text.indexOf('!') - 40), text.indexOf('!') + 1).trim(), 'exclamation mark');
    if (/^([-*•●▪]|\d+[.)])\s+/.test(text)) add(text.slice(0, 50), 'bulleted/numbered list');
    for (const w of fluffWords) {
      const m = text.match(new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`, 'i'));
      if (m) add(m[0], 'fluff/marketing word');
    }
    for (const p of engagementBait) {
      const idx = text.toLowerCase().indexOf(p.toLowerCase());
      if (idx !== -1) add(text.slice(idx, idx + p.length), 'engagement bait / warm sign-off');
    }
  });
  return out;
}

function validateQualityResponse(raw) {
  if (typeof raw?.opening?.strong !== 'boolean') throw new Error('opening.strong missing');
  if (typeof raw?.closing?.strong !== 'boolean') throw new Error('closing.strong missing');
  for (const key of ['false_authority', 'hype_words', 'claims']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`${key} is not an array`);
  }
  if (raw.overlap !== undefined && raw.overlap !== null && typeof raw.overlap !== 'object') throw new Error('overlap is not an object');
  return raw;
}

// For quote matching: lowercase, unify quotes/dashes, drop punctuation, collapse whitespace.
const normalise = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{N}%°.'\s-]/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const snippet = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);

function pastPostsText(pastPosts) {
  if (!pastPosts.length) return '(none yet)';
  return pastPosts
    .map((p) => `[${p.label}] (${p.ts.slice(0, 10)}, ${p.pillar ?? 'n/a'}) Angle: ${p.angle ?? 'n/a'}\n${snippet(p.post.replace(/\s+/g, ' '), 500)}`)
    .join('\n\n');
}

// Stage 2. Always returns a result; if the model check fails, only the mechanical checks count
// and the result is flagged QUALITY_CHECK_PARTIAL.
// pastPosts: previously sent posts ({label, ts, pillar, angle, post}), oldest first, for the overlap check.
// articles: the news articles the writer was given (from Stage 1), so claims restating them count as sourced.
export async function checkPost({ post, note, voiceSkill, config, pastPosts = [], articles = [] }) {
  const settings = loadEvalSettings();
  const recent = pastPosts.slice(-(settings.stage2.overlapLookback ?? 30)).reverse();
  const d = settings.stage2.deductions;
  const productData = loadProductData(settings);
  const lines = postLines(post);

  const violations = ruleViolations(post, settings);
  const deductions = [];
  const flags = new Set();
  let model = null;

  try {
    const prompt = loadPrompt('post-quality', {
      VOICE_SKILL: voiceSkill,
      NOTE: note,
      DRAFT: lines.map((l, i) => `[${i + 1}] ${l}`).join('\n'),
      ...claimPromptVars(productData),
      PAST_POSTS: pastPostsText(recent),
      ARTICLES: articles.length ? articles.map(articleLine).join('\n') : '(none)',
    });
    model = await generateJSON(
      { apiKey: config.geminiApiKey, model: config.evalModel, temperature: settings.evalTemperature, userContent: prompt },
      validateQualityResponse,
    );
  } catch (err) {
    log.error('Post quality model check failed; using rule checks only:', err);
    flags.add('QUALITY_CHECK_PARTIAL');
  }

  if (model) {
    for (const h of model.hype_words ?? []) {
      const dup = violations.some((v) => v.line === h.line && v.text.toLowerCase() === String(h.text).toLowerCase());
      if (!dup && h.text) violations.push({ line: h.line, text: String(h.text), rule: 'fluff/marketing word' });
    }
    for (const f of model.false_authority ?? []) {
      if (f.text) violations.push({ line: f.line, text: String(f.text), rule: `false authority (${f.reason ?? 'not supported by note'})` });
    }
  }

  for (const v of violations) deductions.push({ ...v, points: d.voiceViolation });

  if (model && !model.opening.strong) {
    deductions.push({ line: 1, text: lines[0] ?? '', rule: `weak opening: ${model.opening.reason}`, points: d.weakOpening });
  }
  if (model && !model.closing.strong) {
    deductions.push({ line: lines.length, text: lines.at(-1) ?? '', rule: `weak closing: ${model.closing.reason}`, points: d.weakClosing });
  }

  let claimScore = null;
  let unsourcedCount = null;
  const sources = [];
  if (model) {
    const modelClaims = (Array.isArray(model.claims) ? model.claims : []).filter((c) => c && typeof c.claim === 'string' && c.claim.trim());
    // Where each fact comes from. Only the note, the voice skill and the provided (allow-listed) articles count,
    // and only if the model's quote really appears in that source - the model's say-so isn't enough.
    const sourceText = { note: normalise(note), voice_skill: normalise(voiceSkill) };
    const sourceOf = (c) => {
      const src = String(c.source ?? 'none').toLowerCase();
      const quote = normalise(c.quote ?? '');
      if (quote.split(' ').length < 3 && !(src === 'note' && quote && sourceText.note.includes(quote))) return 'none';
      if (src === 'article') {
        const a = Number.isInteger(c.article) ? articles[c.article] : null;
        return a && normalise(a.title).includes(quote) ? 'article' : 'none';
      }
      return (src === 'note' || src === 'voice_skill') && sourceText[src].includes(quote) ? src : 'none';
    };
    for (const c of modelClaims) {
      c.sourcedFrom = sourceOf(c);
      if (c.sourcedFrom === 'article') sources.push({ ...articles[c.article], usedFor: `cited: ${c.claim}` });
    }

    // Unsourced external claims get one chance: a credible (allow-listed) headline that supports them.
    const needsCheck = (c) => c.type === 'external' && (c.sourcedFrom === 'none' || String(c.status).toLowerCase() === 'doubtful');
    const checked = await checkExternalClaims(modelClaims, config, settings, needsCheck);

    const unsourced = [];
    for (const c of checked) {
      if (c.sourcedFrom !== 'none') continue;
      if (c.type === 'external' && c.evidence?.verdict === 'supports') {
        c.sourcedFrom = 'news';
        if (String(c.status).toLowerCase() !== 'doubtful') sources.push({ ...c.evidence.source, usedFor: `supports: ${c.claim}` });
        continue;
      }
      unsourced.push(c);
    }
    for (const c of unsourced) {
      const by = c.evidence?.verdict === 'contradicts' ? `; contradicted by ${c.evidence.source.source} (${c.evidence.source.date ?? 'undated'})` : '';
      if (by) sources.push({ ...c.evidence.source, usedFor: `contradicts: ${c.claim}` });
      const v = { line: c.line, text: c.claim.trim(), rule: `unsourced claim: not in the note, voice skill or a credible source${by}` };
      violations.push(v);
      deductions.push({ ...v, points: d.voiceViolation });
    }
    unsourcedCount = unsourced.length;

    const claims = scoreClaims(checked.filter((c) => !unsourced.includes(c)), { hasProductData: Boolean(productData), deductions: settings.claims.deductions });
    sources.push(...claims.sources);
    claimScore = claims.score;
    for (const c of claims.flagged) {
      flags.add(claimFlag(c.status));
      const by = c.source ? `, contradicted by ${c.source.name} (${c.source.date ?? 'undated'})` : '';
      if (c.deduction) deductions.push({ line: c.line, text: c.claim, rule: `${c.type} claim ${c.status.replace('_', ' ')}${by}`, points: c.deduction });
    }
  }

  if (/\[(DATA NEEDED|CONFIRM)[^\]]*\]/i.test(post)) flags.add('DATA_PLACEHOLDER');

  // Overlap: only trust ids that are real past posts.
  let overlap = null;
  const overlapId = model?.overlap?.post_id;
  if (overlapId && recent.some((p) => p.label === overlapId)) {
    const newAngle = typeof model.overlap.new_angle === 'string' ? model.overlap.new_angle.trim() : '';
    overlap = { post: overlapId, newAngle: newAngle && newAngle.toLowerCase() !== 'none' ? newAngle : null };
    flags.add('OVERLAP');
  }

  const score = Math.max(0, 100 - deductions.reduce((s, x) => s + x.points, 0));
  return {
    score,
    deductions,
    voiceViolations: violations,
    flags: [...flags],
    angle: typeof model?.angle === 'string' && model.angle.trim() ? model.angle.trim() : null,
    overlap,
    sources: sources.map(({ title, source, date, link, usedFor }) => ({ title, source, date, link, usedFor })),
    checkedOverlap: Boolean(model),
    pastPostCount: recent.length,
    checks: model
      ? { opening: model.opening.strong, closing: model.closing.strong, voiceIssues: violations.length - unsourcedCount, unsourced: unsourcedCount, claimScore }
      : { opening: null, closing: null, voiceIssues: violations.length, unsourced: null, claimScore: null },
  };
}

const trim = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mark = (ok) => (ok === null ? 'n/a' : ok ? '✓' : '✗');

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

// The score card sent after the post. All scores out of 10.
// html: true returns Telegram HTML (source headlines become tap-through links instead of long raw URLs).
export function formatScoreBlock(quality, gate, { overridden = false, html = false } = {}) {
  const esc = html ? escapeHtml : (x) => x;
  const lines = [`CONTENT SCORE: ${out10(quality.score)}/10`, `Pillar: ${gate?.pillar ?? 'n/a'}`];

  if (quality.angle) lines.push(`Angle: ${quality.angle}`);
  if (quality.overlap) {
    lines.push(`Overlap: overlaps with ${quality.overlap.post}; ${quality.overlap.newAngle ? `new angle: ${quality.overlap.newAngle}` : 'adds nothing new'}`);
  } else if (quality.checkedOverlap) {
    lines.push(`Overlap: none${quality.pastPostCount ? ` (checked ${quality.pastPostCount} past posts)` : ' (no past posts yet)'}`);
  } else {
    lines.push('Overlap: not checked');
  }

  lines.push('');
  if (gate) {
    const metrics = Object.entries(gate.scores).map(([k, v]) => `${METRIC_LABELS[k]} ${out10(v)}`).join(' · ');
    lines.push(`Note Gate: ${out10(gate.composite)}/10${overridden ? ` (${gate.decision}, generated anyway)` : ''}`, `  ${metrics}`);
  } else {
    lines.push('Note Gate: n/a (gate unavailable)');
  }
  const c = quality.checks;
  lines.push(
    'Draft checks:',
    `  Opening ${mark(c.opening)} · Closing ${mark(c.closing)} · Voice ${c.voiceIssues ? `${c.voiceIssues} issue${c.voiceIssues > 1 ? 's' : ''}` : '✓'} · Sourcing ${c.unsourced === null || c.unsourced === undefined ? 'n/a' : c.unsourced ? `${c.unsourced} unsourced` : '✓'} · Claims ${c.claimScore === null ? 'n/a' : `${out10(c.claimScore)}/10`}`,
  );

  lines.push('');
  if (!quality.deductions.length) lines.push('Deductions: none');
  else {
    lines.push('Deductions:');
    for (const x of quality.deductions) {
      lines.push(`- ${x.line ? `[line ${x.line}] ` : ''}"${trim(x.text)}" → ${x.rule} (−${out10(x.points)})`);
    }
  }
  lines.push(`Flags: ${quality.flags.length ? quality.flags.join(', ') : 'none'}`);

  // Sources: note-gate coverage and claim checks, then anything the draft check relied on. Deduped by link.
  const seen = new Set();
  const sources = [...(gate?.sources ?? []), ...(quality.sources ?? [])].filter((a) => a.link && !seen.has(a.link) && seen.add(a.link));
  const body = lines.map(esc);
  body.push('');
  if (!sources.length) body.push(esc(`Sources: none${gate?.news?.query ? ` (no relevant coverage for "${gate.news.query}")` : ''}`));
  else {
    body.push('Sources:');
    for (const a of sources) {
      const use = a.usedFor === 'newsworthiness' ? 'recent coverage' : trim(a.usedFor, 60);
      const title = `"${trim(a.title, 100)}"`;
      body.push(
        html
          ? `- ${esc(a.source)}, ${esc(a.date ?? 'undated')}: <a href="${escapeAttr(a.link)}">${esc(title)}</a> (${esc(use)})`
          : `- ${a.source}, ${a.date ?? 'undated'}: ${title} (${use})\n  ${a.link}`,
      );
    }
  }
  return body.join('\n');
}
