// News research used by both evaluation stages. Everything here fails soft: on any error it
// returns "no coverage" and the caller carries on with the default behaviour.
import { generateJSON } from '../gemini.js';
import { searchNews, articleLine } from '../news.js';
import { loadPrompt } from './settings.js';
import { log } from '../log.js';

const evalRequest = (config, settings, userContent) => ({
  apiKey: config.geminiApiKey,
  model: config.evalModel,
  temperature: settings.evalTemperature,
  userContent,
});

// Stage 1 topic search: LLM picks keywords, one RSS search, allow-listed results.
export async function findCoverage(note, config, settings) {
  const news = settings.news;
  if (!news?.enabled) return { query: null, articles: [] };
  try {
    const { query, fallback, skip } = await generateJSON(evalRequest(config, settings, loadPrompt('news-query', { NOTE: note })), (r) => {
      if (typeof r?.query !== 'string') throw new Error('query missing');
      return r;
    });
    if (skip || !query.trim()) {
      log.info('News: note has no newsworthy topic to search');
      return { query: null, articles: [] };
    }
    let used = query.trim();
    let articles = await searchNews(used, news);
    // Headlines are short: if the specific query finds nothing credible, try the broader term once.
    const broad = typeof fallback === 'string' ? fallback.trim() : '';
    if (!articles.length && broad && broad.toLowerCase() !== used.toLowerCase()) {
      used = broad;
      articles = await searchNews(used, news);
    }
    return { query: used, articles };
  } catch (err) {
    log.warn(`News coverage lookup failed, using default newsworthiness: ${err.message}`);
    return { query: null, articles: [] };
  }
}

// Checks doubtful external claims against RSS headlines.
// claims: model claims; doubtful external ones may carry `search_query`.
// Returns the same claims, with `evidence: {verdict, source}` added to the ones that were checked.
// include: which claims to check (default: doubtful external claims).
const isDoubtfulExternal = (c) => c?.type === 'external' && String(c.status).toLowerCase() === 'doubtful';
export async function checkExternalClaims(claims, config, settings, include = isDoubtfulExternal) {
  const news = settings.news;
  const list = Array.isArray(claims) ? claims : [];
  const doubtful = list.filter(include).slice(0, news?.maxClaimChecks ?? 3);
  if (!news?.enabled || !doubtful.length) return list;

  try {
    // Headlines are short: if a query finds nothing credible, retry once with its first two words.
    const search = async (c) => {
      const q = String(c.search_query || c.claim).trim();
      const found = await searchNews(q, news);
      const shorter = q.split(/\s+/).slice(0, 2).join(' ');
      return found.length || shorter === q ? found : searchNews(shorter, news);
    };
    const results = await Promise.all(doubtful.map(search));
    const withHeadlines = doubtful.map((c, i) => ({ claim: c, articles: results[i] })).filter((x) => x.articles.length);
    if (!withHeadlines.length) return list;

    const block = withHeadlines
      .map((x, i) => `CLAIM ${i}: ${x.claim.claim}\nHeadlines:\n${x.articles.map(articleLine).join('\n')}`)
      .join('\n\n');
    const { results: verdicts } = await generateJSON(evalRequest(config, settings, loadPrompt('claim-check', { CLAIMS: block })), (r) => {
      if (!Array.isArray(r?.results)) throw new Error('results missing');
      return r;
    });

    for (const v of verdicts) {
      const target = withHeadlines[v?.claim];
      const article = target?.articles[v?.article];
      if (!target || !article || !['supports', 'contradicts'].includes(v.verdict)) continue;
      target.claim.evidence = { verdict: v.verdict, source: article };
    }
  } catch (err) {
    log.warn(`Claim check against news failed, keeping default deductions: ${err.message}`);
  }
  return list;
}
