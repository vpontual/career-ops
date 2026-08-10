/**
 * lib/comp-band.mjs — read the stated salary out of the posting, in CODE.
 *
 * Same lesson as geo and screen-evidence, for the fourth time: the model was
 * asked for `compLow` and it guessed. Measured 2026-08-10 over the 781 pm-track
 * records: 315 carried `compLow: null` ("not stated"), and **116 of those (37%)
 * publish a salary in plain text**. 63 of the 116 are at or above VP's $150k
 * floor. Twenty are non-AI-native roles sitting at tier 3 - below the review
 * threshold - purely because nobody parsed the number the employer printed.
 *
 * The worst single case: Spectrum's Head of Product Management prints
 * "between $263,200.00 and $393,800.00" and the model returned **1**, which is
 * below every floor and used to cap the role to tier 3.
 *
 * Two traps this handles that a naive scan does not:
 *
 *   1. INDEED ESCAPES ITS MARKDOWN. Bodies contain `\$263,200\.00`, so every
 *      pattern must run against a backslash-stripped copy. This alone is why the
 *      figure was invisible.
 *   2. A NUMBER NEAR A DOLLAR SIGN IS NOT A SALARY. "$50M Series B", "$5,000
 *      signing bonus", "$85.00 per hour", "serving $2B in transactions" are all
 *      in these bodies. So a figure counts only inside a pay CONTEXT window, and
 *      only within a plausible annual-base range.
 *
 * Ranges are read FIRST and the low end is taken, because "between X and Y" is
 * unambiguous where a bare figure is not. Falling back to the minimum qualified
 * figure is deliberate: understating a band is safe (VP's floor rule only ever
 * pays a bonus for clearing $150k), overstating it is not.
 *
 * Returns the evidence string, so a wrong read can be SEEN on the card rather
 * than inferred from a number that looks plausible.
 */

const PAY_CTX = /(base (?:pay|salary)|salary range|pay range|compensation|annual(?:ized)? (?:pay|salary)|expected pay|hiring range|target (?:base|salary)|pay scale|\bUSD\b|per year|annually|base range)/i;

const AMOUNT = String.raw`\$\s?(\d{2,3}(?:,\d{3})+(?:\.\d{2})?|\d{2,3}(?:\.\d)?\s?[kK]\b|\d{5,7}(?:\.\d{2})?)`;
const RANGE = new RegExp(`${AMOUNT}\\s*(?:-|–|—|to|and)\\s*${AMOUNT}`, 'g');
const SINGLE = new RegExp(AMOUNT, 'g');

// An annual US base for these roles. Below this is an hourly rate, a bonus or a
// stipend; above it is equity, revenue or funding.
const MIN_PLAUSIBLE = 30000;
const MAX_PLAUSIBLE = 900000;

function toNum(raw) {
  const t = String(raw).replace(/,/g, '').trim();
  if (/[kK]$/.test(t)) return Math.round(parseFloat(t) * 1000);
  const n = parseFloat(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}
const plausible = n => n != null && n >= MIN_PLAUSIBLE && n <= MAX_PLAUSIBLE;

function evidenceAround(text, idx) {
  const s = text.lastIndexOf('.', idx);
  const e = text.indexOf('.', idx + 1);
  return text.slice(s < 0 ? Math.max(0, idx - 120) : s + 1, e < 0 ? idx + 120 : e + 1).trim().slice(0, 220);
}

/** @returns {{compLow:number|null, evidence:string}} */
export function compBand(body) {
  const text = String(body || '').replace(/\\/g, '');   // trap 1
  const inCtx = (idx) => PAY_CTX.test(text.slice(Math.max(0, idx - 220), idx + 220));

  for (const m of text.matchAll(RANGE)) {               // ranges win
    if (!inCtx(m.index || 0)) continue;
    const lo = toNum(m[1]), hi = toNum(m[2]);
    if (plausible(lo) && plausible(hi) && lo <= hi) {
      return { compLow: lo, evidence: evidenceAround(text, m.index || 0) };
    }
  }
  let best = null, bestIdx = 0;
  for (const m of text.matchAll(SINGLE)) {
    const idx = m.index || 0;
    if (!inCtx(idx)) continue;                          // trap 2
    const n = toNum(m[1]);
    if (!plausible(n)) continue;
    if (best == null || n < best) { best = n; bestIdx = idx; }
  }
  return best == null
    ? { compLow: null, evidence: '' }
    : { compLow: best, evidence: evidenceAround(text, bestIdx) };
}
