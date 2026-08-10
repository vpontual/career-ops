/**
 * freshness.mjs — ONE answer to "how old is this posting, and how old is too
 * old", shared by the step that BUILDS an application pack and the step that
 * MINTS the review card.
 *
 * Those two steps disagreed, and a disagreement here does not produce a wrong
 * card - it produces a role that can NEVER become one. enqueue-review admits a
 * non-whale role for 21 days; stage-applications carried a flat 14-day default.
 * Everything in the 15-21 day band therefore passed enqueue's gate, found no
 * output/<slug>/cv.pdf, and was written to data/held-no-pack.md - a file whose
 * own instruction is "run stage-applications.mjs and re-run enqueue to promote
 * them", which cannot work, because the role is outside staging's window. It
 * sits there until it ages out of enqueue's window as well, and is never seen.
 * A trap state that a re-run cannot leave is worse than a hard failure: the
 * pipeline reports it, VP reads the remedy, and the remedy is a no-op.
 *
 * Measured 2026-08-10: 53 roles enqueue would card were outside staging's
 * default window, 10 of them with no pack at all - nine of those tier-4/5 City
 * of New York requisitions at 16-18 days (Office of the Mayor, DOT, Parks,
 * Finance, OMB, DEP). Track E makes this permanent rather than occasional: NYC
 * publishes through its own Socrata dataset on its own cadence, so a civic
 * posting is routinely already a fortnight old the first time fetch-civic sees
 * it. It is BORN in the gap and never has a young day in this system.
 *
 * Production was only accidentally correct. nightly.sh passed
 * `-e MAX_AGE_DAYS=30` to the applier container, so the flat 14 never applied
 * to the 4am run - it applied to every hand-run of the script, including the
 * one held-no-pack.md tells the reader to do. An invariant that holds only
 * because of an env override in one caller is not an invariant.
 *
 * TWO THINGS have to agree, not one:
 *
 *   1. THE CAP. The window is per-track and per-employer now (teaching 150,
 *      whale 30, evergreen 7, everything else 21). Staging had already been
 *      bitten once by copying the FLAT version of this rule - the teaching
 *      comment in stage-applications.mjs records exactly this incident at
 *      31-150 days - and the fix was another copy of another constant. Copies
 *      are the defect. maxAgeDaysFor() below is the only one.
 *
 *   2. THE AGE ITSELF. Aligning constants alone would have fixed nothing for a
 *      second class of role. enqueue has read recency as the more recent of
 *      posted/updated since 2026-08-06 - "a 20-day-old req the employer edited
 *      yesterday is being worked" - and staging still read posted only.
 *      Measured the same day: 8 roles were 6-12 days old to enqueue and 31-34
 *      days old to staging, four of them GitLab. Same trap state, different
 *      cause, and untouched by any change to the numbers.
 *
 * The invariant, written down once so it can be tested (test-recency.mjs):
 * ANYTHING ENQUEUE CAN CARD, STAGING CAN BUILD. Both import from here. Neither
 * keeps its own copy of a window or its own idea of what "old" means.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';

// ── The windows ───────────────────────────────────────────────────────────
//
// FRESHNESS — rewritten 2026-08-06 from measurement, superseding the flat
// 3-day rule, and moved here 2026-08-10 when it turned out two files were
// applying two different versions of it.
//
// The old rule came from VP on 2026-08-05, after he rejected 57 of 61 cards on
// age: "if i saw 4 or more days i just rejected it." He then superseded it on
// 2026-08-06: "freshness should be at whatever means the role is actually open
// and being considered, not just sitting there... you are supposed to become an
// expert on it and know."
//
// So it was measured. measure-req-lifespan.mjs asks the Greenhouse and Ashby
// board APIs which of 711 tracked postings are still open, giving a survival
// curve by age at first sighting:
//
//     0-3 d   97% still open        22-30 d   93%
//     4-7 d   91%                   46-60 d   67%
//     8-14 d  86%                   61-90 d   36%
//
// A posting stays open for WEEKS. The cliff is at 45-60 days, not at 3. The old
// gate was discarding roles with an ~86-93% chance of still being live - it cost
// 67 tier-4/5 roles including Brex, Vanta, Spotify, Airtable and Datadog.
//
// But being OPEN is not the same as being actively filled, which is the thing VP
// actually asked for, so the second signal is the employer's own closure
// behaviour: of their postings watched 30+ days, how many are still open?
//
//     Intercom 9%   Crusoe 20%   Harvey 24%   Ramp 25%   Anthropic 38%
//     ... these close requisitions, which means they fill them
//     Sierra 94%    Figma 75%    Decagon 64%
//     ... these do not; an old posting on that board signals nothing
//
// So the window is wide by default, and stays tight for employers whose boards
// are demonstrably evergreen. Measurements live in data/employer-closure.json
// and are refreshed by re-running measure-req-lifespan.mjs.
export const FRESH_MAX_AGE_DAYS = Number(process.env.FRESH_MAX_AGE_DAYS || 21);

// An evergreen board's old postings carry no hiring signal, so they must be
// genuinely new to be worth a review slot - or the Gemini call and the liveness
// probe that build the pack behind it.
export const EVERGREEN_MAX_AGE_DAYS = Number(process.env.EVERGREEN_MAX_AGE_DAYS || 7);
export const EVERGREEN_PCT = Number(process.env.EVERGREEN_PCT || 80);

// A whale bypasses the ordinary window and falls back to the 30-day one. VP,
// 2026-08-05: "i want fresh postings unless its a whale like anthropic." For a
// company he would drop everything for, being late is better than being absent.
// Named MAX_AGE_DAYS for compatibility with every caller and doc that already
// sets it, including rank-leads.
export const WHALE_MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 30);

// Schools hire on a school year, not a sprint: 68 of 82 teaching JDs are over
// 90 days old and a charter runs one evergreen requisition for a whole season.
// Must agree with rank-leads' TEACHING_MAX_AGE_DAYS or the scorer admits a
// school-year requisition and these gates immediately drop it again as stale.
export const TEACHING_MAX_AGE_DAYS = Number(process.env.TEACHING_MAX_AGE_DAYS || 150);

/**
 * How old is this posting, in days, by the only measure that means anything:
 * the employer's most recent activity on the requisition.
 *
 * Recomputed from the ISO date, never read straight off the `(N days ago)`
 * parenthetical. That number is frozen at the moment fetch-jds.mjs wrote the
 * file and is wrong by one day for every day since - measured 2026-08-10, 113
 * of 551 tier-4+ JDs on disk were already a day adrift. rank-leads has
 * recomputed since it was written; the gates downstream had not, so a role was
 * a different age depending on which step you asked.
 *
 * @param {{posted_at?:string|null,posted_days?:number|null,updated_at?:string|null,updated_days?:number|null}} jd
 * @returns {number|null} days, or null when the posting carries no date at all
 */
export function recencyDays(jd) {
  const days = [
    liveDays(jd?.posted_at, jd?.posted_days),
    liveDays(jd?.updated_at, jd?.updated_days),
  ].filter((d) => d != null && Number.isFinite(d));
  return days.length ? Math.min(...days) : null;
}

function liveDays(iso, frozen) {
  if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return Math.floor((Date.now() - t) / 86400000);
  }
  return frozen ?? null;
}

/**
 * The window this particular role gets. Order matters: a whale that also sits
 * on an evergreen board is still a whale.
 *
 * @param {{track?:string,company?:string}} role
 * @param {{isWhale?:(c:string)=>boolean,isEvergreen?:(c:string)=>boolean,whaleMaxAgeDays?:number}} policy
 */
export function maxAgeDaysFor(role, policy = {}) {
  const { isWhale, isEvergreen, whaleMaxAgeDays = WHALE_MAX_AGE_DAYS } = policy;
  if (role?.track === 'teaching') return TEACHING_MAX_AGE_DAYS;
  if (isWhale && isWhale(role?.company)) return whaleMaxAgeDays;
  if (isEvergreen && isEvergreen(role?.company)) return EVERGREEN_MAX_AGE_DAYS;
  return FRESH_MAX_AGE_DAYS;
}

/**
 * Read the two employer lists the windows depend on and return the closure that
 * applies them. Both files are read LIVE on every run so VP can edit whales.yml
 * and a re-measurement of employer-closure.json can take effect without a
 * rebuild or a deploy. A missing file means nobody is a whale / nobody is
 * evergreen, which fails towards the ordinary window rather than hiding roles.
 *
 * @param {string} root repo root
 */
export async function loadFreshnessPolicy(root, { whaleMaxAgeDays = WHALE_MAX_AGE_DAYS } = {}) {
  let whales = [];
  try {
    const raw = await readFile(path.join(root, 'config', 'whales.yml'), 'utf-8');
    whales = (yaml.load(raw)?.whales || []).map((w) => String(w).toLowerCase());
  } catch { /* no list is fine, everything is then held to the fresh window */ }

  let closure = {};
  try {
    const raw = await readFile(path.join(root, 'data', 'employer-closure.json'), 'utf-8');
    closure = JSON.parse(raw).employers || {};
  } catch { /* not measured yet */ }

  const isWhale = (company) => {
    const c = String(company || '').toLowerCase();
    return whales.some((w) => c.includes(w));
  };
  const isEvergreen = (company) => {
    const e = closure[String(company || '').toLowerCase()];
    return Boolean(e && e.n >= 4 && e.pctAlive >= EVERGREEN_PCT);
  };

  return {
    isWhale,
    isEvergreen,
    whaleMaxAgeDays,
    maxAgeDaysFor: (role) => maxAgeDaysFor(role, { isWhale, isEvergreen, whaleMaxAgeDays }),
  };
}
