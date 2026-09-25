// Claim-safety rules shared by Stage 1 and Stage 2. The model classifies claims;
// the deduction values always come from config, never from the model.

const STATUS_LABEL = {
  unverified: 'UNVERIFIED_CLAIM',
  needs_confirmation: 'NEEDS_CONFIRMATION',
  doubtful: 'DOUBTFUL_CLAIM',
};

// claims: [{claim, type, status, line?, evidence?}] from the model, `evidence` added by the news check.
// Returns flagged claims (with deductions), the resulting 0-100 claim score, and the news sources relied on.
export function scoreClaims(claims, { hasProductData, deductions }) {
  const flagged = [];
  const sources = [];
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!c || typeof c.claim !== 'string' || !c.claim.trim()) continue;
    const type = c.type === 'internal' ? 'internal' : 'external';
    let status = String(c.status ?? '').toLowerCase();
    let deduction = 0;
    let source = null;

    if (type === 'internal') {
      // Internal claims are never checked against news. Without reference data they can't be
      // checked at all: flag lightly, never penalise hard.
      if (!hasProductData) status = 'needs_confirmation';
      else if (status !== 'verified') status = 'unverified';
      deduction =
        status === 'needs_confirmation' ? deductions.internal_needs_confirmation
        : status === 'unverified' ? deductions.internal_unverified
        : 0;
    } else {
      status = status === 'doubtful' ? 'doubtful' : 'established';
      if (status === 'doubtful' && c.evidence?.verdict === 'supports') {
        // A credible source supports it: no deduction.
        status = 'supported';
        sources.push({ ...c.evidence.source, usedFor: `supports: ${c.claim.trim()}` });
      } else if (status === 'doubtful' && c.evidence?.verdict === 'contradicts') {
        source = c.evidence.source;
        sources.push({ ...source, usedFor: `contradicts: ${c.claim.trim()}` });
      }
      deduction = status === 'doubtful' ? deductions.external_doubtful : deductions.external_established;
    }

    if (status === 'verified' || status === 'established' || status === 'supported') continue;
    flagged.push({
      claim: c.claim.trim(),
      type,
      status,
      deduction,
      ...(source ? { source: { name: source.source, title: source.title, date: source.date, link: source.link } } : {}),
      ...(Number.isInteger(c.line) ? { line: c.line } : {}),
    });
  }
  const total = flagged.reduce((sum, c) => sum + c.deduction, 0);
  return { flagged, total, score: Math.max(0, 100 - total), sources };
}

export const claimFlag = (status) => STATUS_LABEL[status] ?? status.toUpperCase();
