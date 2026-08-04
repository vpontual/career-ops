/**
 * track.mjs — which of VP's three searches a role belongs to, and how a score is
 * earned inside each one.
 *
 * VP runs three tracks and wants them kept separate (MISSION-nyc-job.md, decided
 * 2026-07-29). Until now only Track A existed in code: `portals.yml`'s title
 * filter is entirely PM and PMM titles, so a Business Teacher vacancy was
 * dropped before it was ever scored, and the ~30 Success Academy JDs sitting on
 * disk had no score at all. Widening the title list alone would not have helped
 * - the rubric behind the number is a Senior-PM rubric, so every teaching role
 * would come back a 1 and the tier-4 gate would still have hidden it.
 *
 * Everything here is derived from the posting text in CODE, deliberately. It
 * follows the same architecture the scorer already uses - the model reports
 * facts, policy is applied in code - and it means adding these two tracks costs
 * no prompt surface and no re-scoring. The scoring prompt is already 5,554
 * characters against a 6,000 limit, and it has silently truncated before.
 */

// ── Track detection ───────────────────────────────────────────────────────
//
// Track comes from the BOARD the role was found on, not from guessing at the
// company name. The first version pattern-matched company names for
// `foundation|institute|society|trust|charity` and `academy`, and an audit found
// it exactly backwards: Northern Trust, a bank, routed to `nonprofit` and scored
// 5 with none of Track A's gates applied, while Propel, The Trevor Project and
// DonorsChoose - the actual nonprofits portals-nonprofit.yml exists to scan -
// all routed to `pm`. Khan Academy's Director of Technology scored 5 as a
// TEACHING role.
//
// portals-teaching.yml and portals-nonprofit.yml already name every employer and
// its careers URL. The ATS board slug in that URL also appears in every JD URL
// from that board, so it is an exact, verifiable key. Same lesson as "location
// comes from the ATS record, never the model".

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function boardSlugs(file) {
  const p = path.join(ROOT, file);
  if (!existsSync(p)) return [];
  let doc;
  try { doc = yaml.load(readFileSync(p, 'utf-8')); } catch { return []; }
  // The key is `tracked_companies`. Reading `companies`/`portals` returned an
  // empty list silently, so every nonprofit board fell through to the PM rubric
  // and Track B stayed empty while looking wired.
  const list = doc?.tracked_companies || doc?.companies || doc?.portals || [];
  const out = [];
  for (const c of list) {
    const u = String(c?.careers_url || c?.api || '');
    const m = u.match(/(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/(?:v1\/boards\/)?([A-Za-z0-9_-]+)/);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

let _cache = null;
function slugSets() {
  if (!_cache) {
    _cache = {
      teaching: new Set(boardSlugs('portals-teaching.yml')),
      nonprofit: new Set(boardSlugs('portals-nonprofit.yml')),
    };
  }
  return _cache;
}

function urlSlug(url) {
  const m = String(url || '').match(/(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/([A-Za-z0-9_-]+)/);
  return m ? m[1].toLowerCase() : '';
}

const TEACHING_TITLE = /\b(teacher|teaching|instructor|educator|faculty|lecturer|adjunct|professor)\b/i;

// Roles that merely contain the word "business" inside a school. Lifted from
// fetch-olas.mjs, which learned this the hard way: every district has an
// Assistant Superintendent for Business & Operations and none of them teach.
const NOT_TEACHING = /\b(superintendent|administrator|business official|business manager|treasurer|payroll|purchasing|custodian|paraprofessional|secretary|clerk|bus driver|nurse|coach|monitor|cleaner|food service)\b/i;

// Only used to catch teaching roles that arrive from somewhere OTHER than the
// teaching boards - an Indeed scrape of a school district, say. It is never used
// to route a role to `nonprofit`, because a name is not evidence of tax status.
const SCHOOL_EMPLOYER = /\b(school district|central school|public schools?|UFSD|CSD|BOCES|charter school)\b/i;

/**
 * @param {{title?:string, company?:string, body?:string, url?:string}} jd
 * @returns {'pm'|'teaching'|'nonprofit'}
 */
export function detectTrack(jd) {
  const title = String(jd?.title || '');
  const company = String(jd?.company || '');
  const url = String(jd?.url || '');

  // A PM or PMM role stays Track A wherever it was found. Wikimedia hiring a
  // Senior Product Manager is still the PM search, scored on the PM rubric.
  const isProductRole = /\b(product manager|product marketing|product lead|head of product|director,? product|director of product|group product manager)\b/i.test(title);

  if (/olasjobs\.org/i.test(url)) return 'teaching';
  if (NOT_TEACHING.test(title)) return 'pm';
  if (TEACHING_TITLE.test(title)) return 'teaching';

  const slug = urlSlug(url);
  const sets = slugSets();
  // A school network hiring a Product Manager is still the PM search.
  if (slug && sets.teaching.has(slug)) return isProductRole ? 'pm' : 'teaching';
  // A nonprofit hiring a Product Manager is precisely what Track B IS - "bring
  // product skills somewhere with community impact" - so it must NOT fall back
  // to the PM rubric and its $150K floor, which VP said not to apply here.
  if (slug && sets.nonprofit.has(slug)) return 'nonprofit';

  if (SCHOOL_EMPLOYER.test(company) && !isProductRole) return 'teaching';

  return 'pm';
}

// ── Title filters, per track ─────────────────────────────────────────────
// Track A keeps portals.yml exactly as it is. These two only ever ADD roles that
// the PM filter would have thrown away.

const TEACHING_OK = /\b(teacher|teaching|instructor|educator|faculty|lecturer|adjunct|professor)\b/i;

// Nonprofit titles reach much wider than "Product Manager" - VP's own note names
// Director of Technology, Director of Programs, Director of Innovation and CPO
// at a foundation as in scope.
const NONPROFIT_OK = /\b(product|technology|innovation|programs?|digital|data|impact|operations)\b/i;
const NONPROFIT_SENIOR = /\b(director|head|chief|vp|vice president|lead|senior|principal|manager)\b/i;

export function titlePassesForTrack(track, title) {
  const t = String(title || '');
  if (track === 'teaching') return TEACHING_OK.test(t) && !NOT_TEACHING.test(t);
  if (track === 'nonprofit') return NONPROFIT_OK.test(t) && NONPROFIT_SENIOR.test(t);
  return false;
}

// ── Facts, read off the posting ──────────────────────────────────────────

// The phrasing NY districts actually use is "seeking qualified candidates who
// hold New York State certification in Business" - no "must", no "required".
// Without that alternative the one hard Track C gate never fired on a
// tenure-track req VP is not legally eligible for, and it scored 4 on subject
// match alone (Harrison Central, verified).
const CERT_REQUIRED = /\b(must (hold|possess|have)|required to (hold|possess)|requires?)\b[^.]{0,60}\b(certif\w+|licens\w+)\b|\b(valid|current|active)\b[^.]{0,40}\b(certification|license)\b[^.]{0,30}\brequired\b|\bcertification required\b|\b(candidates|applicants|those|who) (who )?(hold|holding|possess|possessing)\b[^.]{0,50}\bcertification\b|\bcertification in\b[^.]{0,40}\b(is )?(required|preferred|necessary)\b/i;
const CERT_AFTER_HIRE = /\b(commit(ment)? to (obtain|earn|pursu|complet)\w*|willing(ness)? to (obtain|pursue)|path(way)? to certification|certif\w+ (within|after)\b|alternative certification|transitional [ABC]\b|we (will )?(support|sponsor|pay for)\b[^.]{0,40}certif|support (you )?(in|through)\b[^.]{0,30}certif|eligib\w+ for (NYS|New York State)\b[^.]{0,30}certif)/i;
const NO_CERT_NEEDED = /\b(no (teaching )?(certification|license|experience) (is )?(required|necessary)|certification not required|bachelor'?s degree (is all|is the only)|do not need (a )?(teaching )?(certification|license))\b/i;

// His MBA plus fifteen years of product map onto business, economics and
// technology. Anything else is a subject he would be teaching cold.
//
// Matched against the TITLE ONLY. Against the body it fired on almost every
// school posting - they all mention technology or business somewhere - which
// scored an Art Teacher and a PreK Assistant Teacher at 4, level with a
// Business Teacher. The subject is in the title or it is not established.
const SUBJECT_MATCH = /\b(business|marketing|econom\w+|entrepreneur\w*|finance|financial literacy|accounting|technology|computer science|CTE|career and technical|STEM|STEAM|information technology|project management|product management|management|innovation|leadership)\b/i;

// Per-course, temporary or covering work. Real, but not income replacement, and
// VP should see that difference in the number.
const UNSTABLE = /\b(substitute|leave replacement|per diem|per-diem|part[- ]time|interim|maternity|temporary|seasonal)\b/i;

const LEADERSHIP_TITLE = /\b(director|head of|chief|vp\b|vice president)\b/i;
const PRODUCT_SCOPE = /\b(product|platform|technology|engineering|digital|data)\b/i;

export function trackFacts(track, jd) {
  const body = String(jd?.body || '');
  const title = String(jd?.title || '');
  const hay = `${title}\n${body}`;

  if (track === 'teaching') {
    return {
      certRequired: CERT_REQUIRED.test(hay),
      certAfterHire: CERT_AFTER_HIRE.test(hay),
      // Silence is the signal for the charters. Success Academy requires only a
      // bachelor's and never mentions certification at all, so testing for an
      // explicit "no certification required" scored it 3 - below the employers
      // that DO demand a certificate and merely offer to help you earn it. A NY
      // district that requires certification always says so.
      noCertNeeded: NO_CERT_NEEDED.test(hay) || !/\b(certif\w+|licens\w+)\b/i.test(hay),
      subjectMatch: SUBJECT_MATCH.test(title),
      // Adjunct teaching IS per-course and part-time by definition - the mission
      // calls CUNY adjunct the only true "start now" path while noting it is a
      // give-back track, not income replacement. Penalising it for being
      // part-time double-counts something VP already knows and accepted.
      unstable: /\b(adjunct|lecturer)\b/i.test(title)
        ? false
        : (UNSTABLE.test(title) || UNSTABLE.test(body.slice(0, 600))),
    };
  }
  if (track === 'nonprofit') {
    return {
      leadership: LEADERSHIP_TITLE.test(title),
      productScope: PRODUCT_SCOPE.test(title),
      unstable: UNSTABLE.test(title),
    };
  }
  return {};
}

// ── Policy ───────────────────────────────────────────────────────────────
// Track B and C carry a ~$60K floor, not the $150K PM floor. VP set that
// explicitly, offered with uncertainty, on 2026-07-29.
const ALT_COMP_FLOOR = 60000;

/**
 * Track C. The hard constraint is that he can teach RIGHT AWAY, completing any
 * exam or licensure on his own time. A posting that requires a certificate he
 * does not hold, with no route to earn it after hire, fails that outright - no
 * subject fit or salary offsets it.
 */
export function scoreTeaching(f) {
  if (f.geo === 'onsite-elsewhere' || f.geo === 'hybrid-elsewhere') return 1;
  if (f.certRequired && !f.certAfterHire && !f.noCertNeeded) return 1;

  let score = 3;
  if (f.noCertNeeded) score += 1;        // a true "start now" employer
  if (f.certAfterHire) score += 1;       // certify on the way, with support
  if (f.subjectMatch) score += 1;        // business / econ / tech - what he can teach
  if (f.unstable) score -= 1;            // substitute and leave-replacement work
  if (f.compLow != null && f.compLow < ALT_COMP_FLOOR) score -= 1;
  if (f.geo === 'unclear') score -= 1;

  // Tier 4 means "he should apply to this", so it is reserved for subjects he
  // can credibly stand in front of a class and teach - business, economics,
  // entrepreneurship, technology. Coney Island Prep's French and Marine Science
  // vacancies have an excellent certification route and are still jobs he cannot
  // do; without this they scored 4 on the strength of that route alone. Mirrors
  // the PM rubric's rule that a non-AI role cannot buy its way to 5.
  if (!f.subjectMatch) score = Math.min(score, 3);

  return Math.max(1, Math.min(5, score));
}

/**
 * Track B. Product skill applied somewhere with community impact. Seniority and
 * real product or technology ownership are what make one of these worth his
 * fifteen years; a coding screen is still disqualifying wherever it appears.
 */
export function scoreNonprofit(f) {
  if (f.geo === 'onsite-elsewhere' || f.geo === 'hybrid-elsewhere') return 1;
  // Same absolute rule as Track A: he cannot pass a live-coding screen, and the
  // mission says such a role is not a candidate however good the fit. Track B
  // was missing every Track A gate, which is what made a misrouted commercial
  // role able to reach 5 here.
  if (f.technicalScreen) return 1;

  let score = 3;
  if (f.leadership) score += 1;
  if (f.productScope) score += 1;
  if (f.compLow != null && f.compLow >= 120000) score += 1;
  if (f.compLow != null && f.compLow < ALT_COMP_FLOOR) score -= 1;
  if (f.unstable) score -= 1;
  if (f.geo === 'unclear') score -= 1;

  return Math.max(1, Math.min(5, score));
}
