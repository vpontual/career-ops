/**
 * lib/cv-coverage.mjs — does the CV we would actually SEND mention the concrete
 * things the posting asks for?
 *
 * ⚠⚠ READ THIS BEFORE CHANGING THE OUTPUT COPY. This module measures what the
 * CV *SAYS*. It is NOT, and must never be rendered as, a claim about what VP
 * *CAN DO*. lib/skill-gate.mjs already documents why that distinction is
 * load-bearing: measured on 2026-08-10, cv.md listed exactly ONE of the skills
 * VP actually has (Docker) and omitted Kubernetes even though he runs a k3s
 * cluster. Gating on CV text as evidence of ability is how "candidate cannot
 * write code or SQL" ended up on a card as though it were a fact.
 *
 * The question here is the opposite one, and CV text is the correct and only
 * source for it: a resume screen reads the document, not the candidate. "Your
 * CV does not mention SCIM" is a true, checkable, fixable statement. "You do
 * not know SCIM" is not this module's business.
 *
 * WHY IT EXISTS. Harvey's "Senior Product Manager, Command Center" scored 5 —
 * the top of the scale, meaning nothing flagged — and was rejected on
 * 2026-08-13 with no human contact, seven days after applying. Its requirements
 * name SSO, SCIM, RBAC, audit logging and access controls; the variant that was
 * sent (cv-ai-enterprise.md) contains none of those five strings. Nothing in
 * the pipeline noticed, because credential-gate and skill-gate are built to
 * BLOCK on disqualifiers and neither measures coverage of what was asked for.
 *
 * ⚠ THIS IS NOT A PREDICTOR AND MUST NOT BE SOLD AS ONE. It cannot know
 * Harvey's bar or their applicant volume. With 8 applied / 1 rejected / 0
 * positive outcomes on the tracker there is not enough outcome data to
 * calibrate anything, and tuning this against that one rejection would be
 * fitting noise. It earns its place by being independently true — a CV that
 * omits every term the posting names is worth seeing before you send it.
 *
 * PRECISION-FIRST, for the reason isUnusableHeadline() is: a false "missing"
 * both prints a wrong warning on the card and knocks a good role off tier 5.
 * A miss costs nothing but silence. Every filter below was measured against all
 * 2,255 JDs in jds/ rather than reasoned about:
 *
 *   - STOP_HEAD (see below) was worth more than every other filter combined.
 *   - The caps-line rule dropped 109 pseudo-acronyms (YOU, WHO, ARE, WHAT)
 *     harvested out of ALL-CAPS headings.
 *   - The employer's own name is dropped, which is what N26, VTEX, EBANX,
 *     WELLZ and KIPP were.
 *
 * ⚠ THE SIGNAL LIVES IN THE TAIL, so do not add a frequency floor. Measured
 * across the corpus: SQL appears in 93 postings, but SSO in 5, RBAC in 5,
 * SAML in 2 and SCIM in exactly 1. Any "common enough to matter" cutoff
 * deletes precisely the terms this module was built to catch.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

import { sections } from './jd-sections.mjs';
export { sections };

/**
 * Residual noise that survives the structural filters, by category. Everything
 * here was read off the measured corpus frequencies, not imagined.
 */
const DENY = new Set([
  // benefits, comp and payroll vocabulary
  'PTO','HSA','FSA','ESPP','VSP','OTE','USD','EAP','HRA','RRSP','LTD','STD','PEO','ADP','HRIS','WFH','401K',
  // degrees, academic and credentialing boilerplate
  'MBA','BS','BA','MS','MD','PHD','GPA','STEM','CHEA','DOE','FBS',
  // geography
  'US','USA','UK','EU','EEA','NYC','NY','NJ','CA','CT','PA','WA','SF','GA','SG','MD','EMEA','APAC','LATAM',
  // legal / EEO / filing boilerplate
  'EEO','EEOC','VEVRAA','LGPD','ADA','FLSA','FMLA',
  // exchanges and tickers (company-specific ones are dropped by name instead)
  'NASDAQ','NYSE',
  // seniority numerals and generic role/business shorthand
  'II','III','IV','PM','PMM','HR','IT','VP','CEO','CTO','CFO','COO','CHRO','CPO','GM','IC','AE','SMB','LLC','INC','FY','QBR','MBR',
  // English words that are legitimately capitalised mid-prose
  'ALL','AND','NOT','OR','THE','YOU','WHO','ARE','WHAT','WE','WORK','TIME','OFF','PAID','LEAVE','CAREER','GROWTH','STOP','ABOUT','DREAM','NOTE','PLEASE','WIN','HUMAN','SCAM','NEW','KEY','TV',
  // LinkedIn tracking tag: every Ashby posting ends "#LI-ML1" and similar
  'LI',
  // ⚠ COMPANY VALUES LISTS, the last noise class the structural filters miss.
  // A posting that prints "we live by GRIT, TRUST, CANDOR and CARE" inside a
  // section STOP_HEAD did not catch donates each word as a "requirement", and
  // Algolia's did exactly that. These are ordinary English words in caps; with
  // no system wordlist on the box (/usr/share/dict is empty) they have to be
  // enumerated. Only ever add a word here that is genuinely English — never an
  // acronym, or the tail this module exists to catch starts disappearing.
  'GRIT','TRUST','CANDOR','CARE','OWNERSHIP','CRAFT','IMPACT','FOCUS','SPEED','RIGOR','EMPATHY','HUNGRY','HUMBLE','SMART','BOLD','OPEN','CURIOUS','DRIVE','TEAM','MISSION','VALUES','VISION','GOALS','RESULTS','QUALITY','SAFETY','RESPECT','GROWN','LEAD','BUILD','SHIP','OWN','GIVE','MOVE','THINK','ACT','LEARN','GROW',
]);

/** The line a token was found on, trimmed for display as evidence. */
function lineAround(text, token) {
  const re = new RegExp(`^.*\\b${token}\\b.*$`, 'm');
  return (re.exec(text)?.[0] || '').trim().replace(/^[-*\s]+/, '').slice(0, 200);
}

/**
 * Concrete, checkable tokens the posting REQUIRES. Acronyms only: they are the
 * one class that is unambiguous to match in a CV (exact token, word-boundary,
 * case-sensitive) and they are what a keyword screen keys on. Prose phrases
 * like "enterprise admin experience" are deliberately out of scope — they
 * cannot be checked without judgement, and judgement is what makes a gate lie.
 *
 * @returns {Array<{token:string, evidence:string}>}
 */
export function requiredTokens(body, { company = '' } = {}) {
  // The employer's own name, and the initialism formed FROM that name. The
  // plain word list catches N26, VTEX, EBANX, WELLZ and KIPP; the initialism
  // catches the ones that only ever appear abbreviated — WBD in Warner Bros.
  // Discovery's postings, TFD in The Farmer's Dog's. A leading article is
  // dropped so both "TFD" and "FD" are covered.
  const words = String(company).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const companyTokens = new Set(words.filter(w => w.length >= 2));
  // Single-character fragments are dropped before initialling: "The Farmer's
  // Dog" splits to THE/FARMER/S/DOG, so a naive initialism is TFSD and the TFD
  // its postings actually use survives as a phantom requirement.
  const meaty = words.filter(w => w.length > 1);
  const initials = ws => ws.map(w => w[0]).join('');
  if (meaty.length >= 2) {
    companyTokens.add(initials(meaty));
    if (/^(THE|A|AN)$/.test(meaty[0])) companyTokens.add(initials(meaty.slice(1)));
  }
  const req = sections(body).filter(s => s.kind === 'required').map(s => s.text).join('\n');
  const found = new Map();
  for (const line of req.split('\n')) {
    // An ALL-CAPS line is a heading or a shouty banner, never a requirement
    // sentence. Without this, headings donate their own words as "acronyms".
    if (!/[a-z]/.test(line)) continue;
    const letters = line.replace(/[^A-Za-z]/g, '');
    if (!letters) continue;
    if ((line.match(/[A-Z]/g) || []).length / letters.length > 0.5) continue;
    // ⚠ MINIMUM LENGTH 3, measured. Two-letter tokens were almost entirely
    // noise (SA appeared in 36 postings, alongside CS, EE, ME, OP, PR, AD, ID,
    // MR, VQ) and the few real ones — AI, ML, UX, UI, BI, QA, CI, CD — are so
    // generic that flagging them tells VP nothing he does not know.
    for (const m of line.matchAll(/\b[A-Z][A-Z0-9]{2,5}\b/g)) {
      const t = m[0];
      if (DENY.has(t)) continue;
      if (companyTokens.has(t)) continue;          // N26, VTEX, EBANX, WELLZ, KIPP
      if (/^\d+$/.test(t)) continue;
      if (!found.has(t)) found.set(t, lineAround(req, t));
    }
  }
  return [...found].map(([token, evidence]) => ({ token, evidence }));
}

const _cvCache = new Map();
/** Read the variant that would actually be rendered (seed-pack/tailor-cv send
 *  cv-variants/cv-<variant>.md verbatim — cv.md is NOT merged into it). */
export function cvTextFor(variant) {
  const key = variant || 'ai-product';
  if (_cvCache.has(key)) return _cvCache.get(key);
  let text = '';
  for (const p of [path.join(ROOT, 'cv-variants', `cv-${key}.md`), path.join(ROOT, 'cv.md')]) {
    try { text = readFileSync(p, 'utf-8'); break; } catch {}
  }
  _cvCache.set(key, text);
  return text;
}

/** Clear the memoised CV reads. Tests only. */
export function _resetCvCache() { _cvCache.clear(); }

/**
 * @returns {{required:string[], covered:string[], missing:string[],
 *            ratio:number|null, evidence:string}}
 *   ratio is null when the posting has no detectable requirements section
 *   (47% of the corpus) — null means "not measured", never "zero coverage".
 */
export function cvCoverage(body, variant, { company = '', cvText = null } = {}) {
  const toks = requiredTokens(body, { company });
  const cv = cvText != null ? cvText : cvTextFor(variant);
  const covered = [], missing = [];
  for (const { token, evidence } of toks) {
    // Word-boundary, case-sensitive: "SSO" must not match "sso" inside a URL,
    // and must not match as a substring of "ASSOCIATE".
    (new RegExp(`\\b${token}\\b`).test(cv) ? covered : missing).push({ token, evidence });
  }
  return {
    required: toks.map(t => t.token),
    covered: covered.map(t => t.token),
    missing: missing.map(t => t.token),
    ratio: toks.length ? covered.length / toks.length : null,
    evidence: missing.map(t => `${t.token}: ${t.evidence}`).join(' | ').slice(0, 600),
  };
}

/**
 * Is the gap big enough to flag on the card? Threshold measured across the
 * corpus — see test-cv-coverage.mjs. Requires BOTH a real count of misses and a
 * majority miss, so a posting that names six acronyms and matches four does not
 * get flagged for the other two.
 */
export function coverageGap(cov, { minMissing = 2, maxRatio = 0.5 } = {}) {
  if (!cov || cov.ratio == null) return false;         // nothing measured
  if (cov.missing.length < minMissing) return false;
  return cov.ratio <= maxRatio;
}

/*
 * ⚠ FINDING NOT ACTED ON HERE, ON PURPOSE. lib/skill-gate.mjs shares two of the
 * defects fixed above: its REQUIRED_HEAD does not match "What You Have" (the
 * heading Harvey uses), and it has no STOP_HEAD, so it reads benefits blocks as
 * requirement text. Both would change live scores across the whole corpus, so
 * they are reported for VP to decide on rather than smuggled in behind an
 * unrelated feature.
 */
