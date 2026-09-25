// Google News RSS search: headlines only, filtered to an allow-list of publisher domains.
// Never throws - any failure returns [] so a note is never blocked by RSS.
import { log } from './log.js';

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

export function parseRss(xml) {
  const items = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t) => decode(item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? '');
    const source = item.match(/<source url="([^"]+)">([\s\S]*?)<\/source>/);
    const sourceName = source ? decode(source[2]) : '';
    let title = tag('title');
    // Google appends " - Publisher" to titles.
    if (sourceName && title.endsWith(` - ${sourceName}`)) title = title.slice(0, -(sourceName.length + 3)).trim();
    const pub = new Date(tag('pubDate'));
    items.push({
      title,
      link: tag('link'),
      date: Number.isNaN(pub.getTime()) ? null : pub.toISOString().slice(0, 10),
      source: sourceName,
      sourceUrl: source?.[1] ?? '',
    });
  }
  return items;
}

export function isAllowed(item, allowedDomains) {
  let host;
  try {
    host = new URL(item.sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

// news settings: { days, edition: {hl, gl, ceid}, allowedSources, maxResults, timeoutMs }
export async function searchNews(query, news) {
  if (!query?.trim()) return [];
  const q = encodeURIComponent(`${query.trim()} when:${news.days}d`);
  const { hl, gl, ceid } = news.edition;
  const url = `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(news.timeoutMs ?? 8000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkedInPostBot/1.0)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = parseRss(await res.text());
    const seen = new Set();
    const kept = all
      .filter((a) => isAllowed(a, news.allowedSources))
      .filter((a) => (seen.has(a.title.toLowerCase()) ? false : seen.add(a.title.toLowerCase())))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .slice(0, news.maxResults ?? 10);
    log.info(`News "${query}": ${all.length} results, ${kept.length} from allowed sources`);
    return kept;
  } catch (err) {
    log.warn(`News search failed for "${query}": ${err.message}`);
    return [];
  }
}

export const articleLine = (a, i) => `[${i}] ${a.source}, ${a.date ?? 'undated'}: "${a.title}"`;
