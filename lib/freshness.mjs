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
 *      civic 60, nonprofit 35, whale 30, evergreen 7, everything else 21).
 *      Staging had already been bitten once by copying the FLAT version of this
 *      rule - the teaching comment in stage-applications.mjs records exactly
 *      this incident at 31-150 days - and the fix was another copy of another
 *      constant. Copies are the defect. maxAgeDaysFor() below is the only one.
 *
 *      Per-track windows are now a TABLE (TRACK_MAX_AGE_DAYS), not an if-chain,
 *      because 2026-08-11 added two more of them and an if-chain is how you get
 *      a third copy. Every number in it was measured; the derivation for each
 *      sits above the constant. Summary, all measured 2026-08-11:
 *
 *        civic 60      NYC publishes post_until on 1,309 of 1,332 open reqs and
 *                      the median declared window is exactly 60 days. Not an
 *                      estimate - the employer's own stated policy.
 *        nonprofit 35  nonprofit boards run 1.3x older than pm (p50 19d vs 16d,
 *                      48% vs 37% over 21 days, n=349 open postings / 36 boards).
 *                      35 is the window that gives Track B the same share of its
 *                      live inventory that pm's 21 days gives Track A.
 *        teaching 150  unchanged, and re-confirmed: teaching boards p50 21d but
 *                      p75 83d and 13% of open postings over 150 days.
 *
 *      The finding that did NOT change anything is worth as much as the ones
 *      that did: nonprofit is only marginally slower than pm, so Track B got a
 *      14-day widening and not a school-year window, even though it is the track
 *      most starved of roles. Scarcity is not evidence of longevity.
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

// ── Track E (civic) — 60 days, and this one is not an inference ────────────
//
// Measured 2026-08-11 against the City of New York's own dataset (Socrata
// kpav-sd4t, the same one fetch-civic.mjs reads), 1,332 distinct OPEN
// requisitions:
//
//   post_until (the city's OWN declared close date) present on 1,309 of 1,332
//   declared open-window, post_until - posting_date:  p25 44d  p50 60d  p75 60d  p90 60d
//
// NYC does not leave this to be reverse-engineered. It publishes, in a
// structured field on 98% of its requisitions, how long the posting stays open,
// and the answer is SIXTY DAYS. That is not a survival estimate with a
// confidence interval, it is the employer's stated policy, and it is the
// strongest evidence anywhere in this file.
//
// The observed age distribution agrees exactly, which is the check that matters:
// if reqs live ~60 days and arrive at a steady rate, the ages of the open ones
// are roughly uniform on [0,60] - p50 near 30, a quarter over 45, almost none
// over 60. Observed: p50 27d, 25% over 45d, 8% over 60d. The declared policy and
// the live inventory tell the same story.
//
// So a 21-day window admits 45% of the live NYC inventory and throws away the
// other 55% while it is still, provably, accepting applications:
//
//     21d -> 45%     30d -> 59%     45d -> 79%     60d -> 94%     90d -> 98%
//
// 60 is also where the cost constraint puts it. Past 60 days a NYC req really is
// gone (only 8% survive), so the window ends where the postings die rather than
// somewhere chosen for comfort - widening further buys 4 percentage points of
// coverage and starts paying for dead reqs.
//
// ⚠ This is a PROSPECTIVE fix, and the blast radius today is zero. Track E was
// only wired on 2026-08-10, so every civic JD on disk is 4-19 days old (n=69,
// p50 13d) and none is currently excluded. The gap opens as this population
// ages: a NYC req is routinely already a fortnight old the first time
// fetch-civic sees it (see the header above - it is "born in the gap"), so under
// a 21-day window it gets about a week of eligibility out of a sixty-day
// opening. Do not read "0 roles recovered today" as "no problem".
export const CIVIC_MAX_AGE_DAYS = Number(process.env.CIVIC_MAX_AGE_DAYS || 60);

// ── Track B (nonprofit) — 35 days, derived, and deliberately NOT teaching ──
//
// The trigger was GiveDirectly "Chief of Staff, Emergency Cash": score 4, 26
// days old, outside the 21-day window, therefore no pack, therefore never a
// card. VP had asked for nonprofit roles and this one was silently unreachable.
// Checked live against the GiveDirectly Greenhouse board on 2026-08-11: STILL
// OPEN. The exclusion was not conservatism, it was wrong about the fact.
//
// But one open req is not a policy, so the question was measured properly: do
// nonprofit postings actually stay open longer than tech postings? Live sweep of
// every board in portals-nonprofit.yml and portals.yml on 2026-08-11, taking the
// recency (min of published/updated - the same quantity recencyDays computes) of
// every currently-open posting:
//
//   track       boards      n     p50    p75    >21d   >30d   >45d
//   pm             135  10,437     16d    40d    37%    31%    23%
//   nonprofit       36     349     19d    54d    48%    41%    30%
//   teaching        10     418     21d    83d    50%    46%    42%   (>150d: 13%)
//
// The honest reading: nonprofit runs modestly older than pm - about 1.3x on the
// tail measures, +3 days on the median - and nothing like teaching. There is NO
// case here for a school-year window, and the temptation to give Track B 150
// days because it is starved of roles should be resisted; that would be setting
// policy from scarcity, not from lifespan.
//
// The number comes from a parity rule rather than a guess. pm's 21-day window
// admits 64% of live pm inventory. The window that admits 64% of live NONPROFIT
// inventory - the same share of the same kind of thing - is 34 days. Rounded to
// 35 for legibility (66% coverage against pm's 64%).
//
// ⚠ JUDGEMENT, FLAGGED: 35 is the rounding of a measured 34, and 34 is computed
// from a length-biased sample of open postings, not from observed deaths. The
// per-track SURVIVAL curve could not settle this - scan-history has only tracked
// nonprofit boards since 2026-08-11, so every one of its 43 nonprofit rows is
// under 15 days old and no death has had time to be observed. Treat 35 as
// provisional and recompute when the boards have been watched 60+ days.
//
// ⚠ Do NOT set this from the pipeline population. There are 11 nonprofit JDs on
// disk and 5 at score>=4. Six data points cannot carry a policy; the 349-posting
// board inventory can, which is why the parity rule is computed from that.
//
// ⚠ Track B is bimodal by employer, not uniformly slow. One Acre Fund p50 5d,
// SPLC 3d, DonorsChoose 3d, Common Cause 4d; against ACLU 49d, GiveWell 55d,
// Khan Academy 69d, Propel 123d. That spread is exactly what employer-closure
// measures, and pm is just as bimodal (Databricks 17d vs Crusoe 48d). It is an
// argument for keeping the per-employer evergreen rule healthy, not for a wider
// track prior.
export const NONPROFIT_MAX_AGE_DAYS = Number(process.env.NONPROFIT_MAX_AGE_DAYS || 35);

/**
 * THE PER-TRACK TABLE. One place, not one `if` per track.
 *
 * This was an if-chain with a single `teaching` branch, and it had already been
 * copied wrong twice (see the header). Two more tracks would have meant two more
 * branches in each of the places that ask - so it is a table, and adding Track F
 * is a data change nobody has to remember to mirror.
 *
 * A track absent from this table (pm, now) takes the ordinary route:
 * whale -> evergreen -> FRESH_MAX_AGE_DAYS.
 *
 * ⚠ pm IS DELIBERATELY NOT IN HERE. It is the main track, it works, and it has
 * 453 roles at score>=4 inside 21 days - it has no scarcity problem that a wider
 * window would solve. For the record the measurement does NOT justify moving it
 * either way: of 12 pm roles in the 22-60 day band checkable against a Greenhouse
 * board on 2026-08-11, 11 were still open. But "open" is not "being filled",
 * which is the distinction VP asked for on 2026-08-06, and 21 days is where that
 * line was drawn from the survival curve. Moving it needs its own evidence and
 * its own decision, not a side effect of fixing Track B.
 */
export const TRACK_MAX_AGE_DAYS = Object.freeze({
  teaching:  TEACHING_MAX_AGE_DAYS,
  civic:     CIVIC_MAX_AGE_DAYS,
  nonprofit: NONPROFIT_MAX_AGE_DAYS,
});

// ⚠ THE CEILING UPSTREAM OF THIS FILE. rank-leads.mjs applies its own stale gate
// BEFORE it scores anything (`track === 'teaching' ? TEACHING_MAX_AGE_DAYS :
// MAX_AGE_DAYS`, i.e. 150 or 30). Nothing in this file can rescue a JD the
// scorer refused to score, so a civic req FIRST SEEN at 45 days never reaches
// lead-scores.json and the 60-day window below never gets to see it.
//
// In practice the common path survives, because rank-leads caches by filename
// and never evicts: a role scored while it was young keeps its entry and ages
// inside the cache, which is how 87 pm roles at score>=4 are sitting in the
// 22-60 day band right now. Civic reqs are ~13 days old at first sight and
// nonprofit ~6, so both are scored well inside the 30-day ceiling and then age
// under these windows normally.
//
// It is still a latent trap for any role whose first sighting is already old.
// The one-line fix belongs in rank-leads.mjs (owned elsewhere):
//     const maxAge = maxAgeDaysFor({ track }, { whaleMaxAgeDays: MAX_AGE_DAYS });
// test-track-freshness.mjs asserts the teaching half of this coupling, which is
// the half that is already load-bearing.

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
 * The window this particular role gets. ORDER MATTERS, and it is:
 *
 *     track  ->  whale  ->  evergreen  ->  the ordinary window
 *
 * A whale that also sits on an evergreen board is still a whale.
 *
 * ⚠ The track window deliberately beats BOTH employer rules, and that is not an
 * oversight. Teaching is the case that fixes the order: a charter school running
 * one requisition for a whole season looks exactly like an evergreen board to
 * employer-closure, and letting evergreen win would tighten Success Academy to 7
 * days and re-break Track C - the specific failure the 150-day window exists to
 * fix. The same logic carries to civic (NYC's 60 days is the city's stated
 * policy, not a board habit) and to nonprofit (whose 35 was measured ACROSS the
 * whole board inventory, evergreen organisations included, so it already prices
 * them in). No nonprofit or civic employer is in employer-closure.json today
 * anyway - it needs 4+ postings watched 30+ days and both tracks are days old -
 * so this ordering changes no current behaviour; it is written down so the
 * question does not get relitigated when they do qualify.
 *
 * @param {{track?:string,company?:string}} role
 * @param {{isWhale?:(c:string)=>boolean,isEvergreen?:(c:string)=>boolean,whaleMaxAgeDays?:number}} policy
 */
export function maxAgeDaysFor(role, policy = {}) {
  const { isWhale, isEvergreen, whaleMaxAgeDays = WHALE_MAX_AGE_DAYS } = policy;
  const byTrack = TRACK_MAX_AGE_DAYS[role?.track];
  if (byTrack != null) return byTrack;
  if (isWhale && isWhale(role?.company)) return whaleMaxAgeDays;
  if (isEvergreen && isEvergreen(role?.company)) return EVERGREEN_MAX_AGE_DAYS;
  return FRESH_MAX_AGE_DAYS;
}

/**
 * The windows, rendered for the operator banner both steps print.
 *
 * stage-applications and enqueue-review each used to hand-write this line, and
 * each listed a different subset - staging named four windows, enqueue named
 * two. A window the banner does not mention is a window nobody notices going
 * wrong, and adding Track E to the table without adding it to two format strings
 * would have reproduced exactly that. Derived from TRACK_MAX_AGE_DAYS so it
 * cannot fall behind it.
 */
export function describeWindows({ whaleMaxAgeDays = WHALE_MAX_AGE_DAYS } = {}) {
  const tracks = Object.entries(TRACK_MAX_AGE_DAYS)
    .sort((a, b) => a[1] - b[1])
    .map(([t, d]) => `${t} <=${d}d`);
  return [`<=${FRESH_MAX_AGE_DAYS}d`, `whales <=${whaleMaxAgeDays}d`,
          `evergreen <=${EVERGREEN_MAX_AGE_DAYS}d`, ...tracks].join(', ');
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
