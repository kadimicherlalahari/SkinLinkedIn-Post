// Basic validation / clean-up so the reply is paste-ready.
// Only mechanical fixes here; the voice itself is the model's job.

const PREAMBLE = /^(?:sure|okay|ok|certainly|of course)?[,.!\s]*(?:here(?:'s| is)|below is)[^\n]*(?:post|draft|version)[^\n]*:\s*\n+/i;

export function cleanPost(raw) {
  let text = String(raw).replace(/\r\n/g, '\n').trim();

  // Strip a code fence wrapper, if any.
  text = text.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, '$1').trim();
  // Strip a chatty preamble line ("Here's your LinkedIn post:").
  text = text.replace(PREAMBLE, '').trim();
  // Strip wrapping quotes around the whole post.
  if (/^["“][\s\S]*["”]$/.test(text) && !text.slice(1, -1).match(/["“”]/)) text = text.slice(1, -1).trim();
  // Markdown doesn't render on LinkedIn.
  text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '');
  // Voice skill: never em dashes; use a spaced hyphen.
  text = text.replace(/\s*[—–]\s*/g, ' - ');
  // Normalise blank lines between paragraphs.
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  return text;
}

export function validatePost(text) {
  const problems = [];
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 60) problems.push(`too short (${words} words)`);
  if (/(^|\s)#[A-Za-z]\w+/.test(text)) problems.push('contains hashtags');
  if (/\p{Extended_Pictographic}/u.test(text)) problems.push('contains emoji');
  if (/!/.test(text)) problems.push('contains exclamation marks');
  return { ok: words >= 60, words, problems };
}
