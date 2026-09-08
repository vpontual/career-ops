/**
 * lib/slate.mjs — the handful of roles VP should act on TODAY, chosen from the
 * whole review queue without ever putting two tracks on one scale.
 *
 * WHY THIS EXISTS. The queue is a backlog, not a plan: 105 pending cards across
 * five tracks on 2026-09-02, ordered by nothing but the day they were minted.
 * VP asked for a small dated set - "what do I do this morning" - and the
 * obvious way to build one is the one that is forbidden here: sort every card
 * by score and take the top N.
 *
 * ⚠ THE INVARIANT: NO MERGED, CROSS-TRACK SCORE EXISTS ANYWHERE IN THIS FILE.
 * Each track has its own rubric in lib/track.mjs, and a 5 means a different
 * thing in each - on `now` it is the fastest path to income, on `pm` the best
 * NYC product fit, on `civic` a city req whose exam is a door rather than a
 * wall. VP has said they stay unblended. So selection is in two stages that
 * cannot see each other's numbers:
 *
 *   1. rankWithin(track cards)  - compares cards, but only inside ONE track.
 *   2. allocate(ranked queues)  - hands out SLOTS per track and reads nothing
 *                                 from a card except which queue it sits in.
 *
 * allocate() never touches `score`. test-slate.mjs proves it two ways: by
 * rescaling every score in one track (all 1s, then all 5s) and asserting that
 * the per-track composition of the slate does not move, and by grepping this
 * file's allocator for the word `score`. A helper that let a pm 4 and a civic 5
 * meet in one comparison would be the bug, whatever its output.
 *
 * WITHIN a track the order is fixed, and it is this, for these reasons:
 *
 *   1. live recency    newest first, always (VP, 2026-09-08). The survival
 *                      curve in lib/freshness.mjs is why: being late costs
 *                      more than anything below can buy back.
 *   2. tier            the rubric's output, separating roles posted the same
 *                      day.
 *   3. whale           VP, 2026-08-05: "unless its a whale like anthropic" -
 *                      a company he would drop everything for. It breaks a tie
 *                      between equally fresh roles; it NO LONGER lifts an older
 *                      posting above a newer one, which is what put Stripe at
 *                      11d above Google at 1d.
 *   4. pack readiness  a pack he can send this morning over one that still
 *                      needs a step (answers.md written; cover letter either
 *                      not required or already drafted).
 *   5. ATS friction    greenhouse / ashby / lever are filled by the extension;
 *                      Workday demands an employer account before anything.
 *   6. civic deadline  post_until, soonest first. Last WITHIN a track because
 *                      a near deadline is handled at the slot level instead -
 *                      it pre-empts the rotation, see allocate().
 *   7. slug            so equal inputs give an equal slate, always.
 *
 * ACROSS tracks the caller supplies quotas. The documented default is two pm
 * slots plus one slot that rotates day by day through civic / nonprofit / now /
 * teaching. A track with nothing eligible leaves its slot EMPTY - the slate
 * shrinks, it does not borrow - with one explicit exception: the rotation slot
 * belongs to the ring, not to a single track, so when it is nonprofit's day and
 * nonprofit has nothing, the slot walks on to the next track in the ring. And a
 * civic role inside DEADLINE_PREEMPT_DAYS of its post_until takes the rotation
 * slot whichever track's day it is: NYC closes on the date it publishes, and a
 * rotation that came round three days late would be a rotation past a door
 * that had shut.
 *
 * ⚠ ageDays ON A CARD IS FROZEN AT MINT TIME. It is written once by
 * enqueue-review and is wrong by one day for every day since - the same defect
 * the header of lib/freshness.mjs records for the `(N days ago)` parenthetical.
 * enqueuedAt is written beside it, so the live age is ageDays + (today -
 * enqueuedAt). A card carrying postedAt / updatedAt (a later phase adds them)
 * is aged from those instead, exactly as recencyDays does.
 *
 * ⚠ PURE. No file I/O, no network, no Date.now(), no logging. `today` is a
 * parameter, whale-ness and pack readiness are inputs, and the same call with
 * the same inputs returns the same slate. That is what makes it testable, and
 * it is also why the module cannot call lib/freshness.mjs's recencyDays, which
 * is bound to the wall clock. The age rule is restated here once, against
 * `today`, and test-slate.mjs pins it.
 */

import { maxAgeDaysFor } from './freshness.mjs';

const DAY = 86400000;

/** Two pm slots a day. VP's main track, and the one with inventory to fill them. */
export const DEFAULT_QUOTAS = Object.freeze({ pm: 2 });

/**
 * One slot a day, walking the ring in this order. The ring is fixed rather than
 * sorted by inventory so that a starved track (nonprofit: 5 cards) still gets
 * its day instead of being permanently out-voted by civic (29).
 */
export const DEFAULT_ROTATION = Object.freeze({
  slots: 1,
  among: Object.freeze(['civic', 'nonprofit', 'now', 'teaching']),
});

/**
 * A civic req this close to its post_until jumps the rotation. Seven days is
 * one full cycle of a four-track ring plus the weekend VP does not apply on.
 */
export const DEADLINE_PREEMPT_DAYS = 7;

/**
 * How long a card may sit on the slate before it is reported as expired. A
 * slate is a today-list; a card still on it on the fourth morning is one VP
 * has declined three times without saying so.
 */
export const DEFAULT_MAX_DAYS_ON_SLATE = 3;

const EXTENSION_FILLS = new Set(['greenhouse', 'ashby', 'lever']);

// ── dates ─────────────────────────────────────────────────────────────────

/** UTC day number of a 'YYYY-MM-DD' / ISO string / Date, or null when unparsable. */
function dayNumber(value) {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (Number.isNaN(t)) return null;
  return Math.floor(t / DAY);
}

/** Whole days from `from` to `to`; null when either side is missing. */
function daysBetween(from, to) {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a == null || b == null ? null : b - a;
}

function isoDay(dayNo) {
  return new Date(dayNo * DAY).toISOString().slice(0, 10);
}

// ── per-card facts, all derived, none from a model ─────────────────────────

/**
 * The employer's most recent activity, in days before `today`. Prefers the
 * live stamps, then the frozen ageDays corrected by how long the card has sat
 * in the queue, then the frozen number alone. `source` says which, so the
 * `why` line can be honest about it.
 */
export function liveAgeDays(item, today) {
  const stamps = [
    ['posted', daysBetween(item?.postedAt, today)],
    ['updated', daysBetween(item?.updatedAt, today)],
  ].filter(([, d]) => d != null);
  if (stamps.length) {
    stamps.sort((a, b) => a[1] - b[1]);
    return { days: stamps[0][1], source: stamps[0][0] };
  }
  // ⚠ Number(null) is 0. A card with no age at all must read as unknown, not
  // as posted today - test-slate.mjs caught exactly that.
  const raw = item?.ageDays;
  const frozen = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(frozen)) return { days: null, source: null };
  const drift = daysBetween(item?.enqueuedAt, today);
  if (drift == null) return { days: frozen, source: 'frozen' };
  return { days: frozen + Math.max(0, drift), source: 'enqueue' };
}

function isWhale(item, policy) {
  if (item?.whale === true) return true;
  return typeof policy?.isWhale === 'function' && policy.isWhale(item?.company) === true;
}

/**
 * 0 = the extension fills it, 1 = a form VP fills by hand, 2 = Workday, which
 * makes him register with the employer first. The value is only ever compared
 * within a track.
 */
export function atsFriction(item) {
  const ats = String(item?.ats || '').toLowerCase();
  if (EXTENSION_FILLS.has(ats)) return 0;
  if (ats === 'workday' || /myworkdayjobs\.com/i.test(String(item?.applyUrl || ''))) return 2;
  return 1;
}

/**
 * Pack readiness as two booleans: answers.md exists, and the cover letter is
 * settled (not required, or already drafted). `packs` is the caller's reading
 * of output/<slug>/ - this module never touches the disk. A missing `packs`
 * means readiness was not checked, which is different from "not ready" and is
 * reported as such.
 *
 * ⚠ coverLetter 'unknown' is NOT "no letter needed". 176 of 205 cards read
 * unknown on 2026-09-02; treating it as settled would rank a pack whose
 * requirement nobody has read above one that was checked and found required.
 *
 * ⚠ AND `answers.md` EXISTING IS NOT "THE FORM WAS ANSWERED". When a board
 * cannot be read - NYC Jobs and OLAS put the form behind an account wall -
 * generate-answers writes a dated FINDING to the same filename, whose own last
 * line reads "nothing above is an answer". 127 of 514 packs held one on
 * 2026-09-08. The caller passes `answers` from answers-meta.json's `enumerated`
 * flag, written by both writers, so this module never guesses from a filename.
 *
 * `formUnreadable` is deliberately a THIRD state rather than the negation of
 * `answers`. "Nobody has filled this form yet" is a pack that will be finished
 * tonight; "this employer publishes no form until VP registers" is a fact about
 * the employer that no pipeline run will ever change, and ranking them the same
 * would keep re-promising a pack that cannot arrive. It scores like a missing
 * pack - VP still has work to do by hand - but it says so in words.
 */
export function packReadiness(item, packs) {
  if (!packs || typeof packs !== 'object') {
    return { checked: false, answers: false, coverOk: false, formUnreadable: false, level: 0 };
  }
  const p = packs[item?.slug] || {};
  const answers = p.answers === true;
  const formUnreadable = !answers && p.formUnreadable === true;
  const cl = String(item?.coverLetter || 'unknown');
  const coverOk = cl === 'absent' || cl === 'optional' || p.coverDrafted === true;
  return {
    checked: true, answers, coverOk, formUnreadable,
    level: (answers ? 1 : 0) + (coverOk ? 1 : 0),
  };
}

/** Days until the card's post_until, or null when it carries none. */
function daysToDeadline(item, deadlines, today) {
  const raw = (deadlines instanceof Map ? deadlines.get(item?.slug) : deadlines?.[item?.slug])
    ?? item?.postUntil ?? null;
  return raw == null ? null : daysBetween(today, raw);
}

// ── stage 1: order INSIDE one track ────────────────────────────────────────

/**
 * Everything the comparator reads, computed once per card so the sort is
 * deterministic and the `why` line is built from the same facts that ordered it.
 */
function facts(item, { today, policy, packs, deadlines }) {
  const age = liveAgeDays(item, today);
  return {
    item,
    tier: Number.isFinite(Number(item?.score)) ? Number(item.score) : 0,
    whale: isWhale(item, policy),
    age,
    ready: packReadiness(item, packs),
    friction: atsFriction(item),
    deadline: daysToDeadline(item, deadlines, today),
  };
}

/**
 * The within-track order, exactly as the header lists it. Only ever called on
 * two cards from the SAME track - rankWithin() is the sole caller and it
 * partitions first. Null ages and null deadlines sort last.
 */
export function compareWithinTrack(a, b) {
  // ⚠ RECENCY FIRST (VP, 2026-09-08: "nothing gets to be excluded"). This
  // ordered tier, then whale, then recency — so Stripe at 11 days sat above
  // Google at 1 day on the slate, both tier 5, purely because Stripe is in
  // config/whales.yml. That is not newest-to-oldest, and the slate was the one
  // surface left out when every other list was changed.
  //
  // Tier and whale survive as TIE-BREAKS, which is where they still do real
  // work: two roles posted the same day are separated by their rubric score
  // first and by whale second, so a whale still beats an equally-fresh
  // non-whale. What it can no longer do is outrank a fresher posting.
  const ad = a.age.days ?? Infinity;
  const bd = b.age.days ?? Infinity;
  if (ad !== bd) return ad - bd;
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.whale !== b.whale) return a.whale ? -1 : 1;
  if (a.ready.level !== b.ready.level) return b.ready.level - a.ready.level;
  if (a.friction !== b.friction) return a.friction - b.friction;
  const adl = a.deadline ?? Infinity;
  const bdl = b.deadline ?? Infinity;
  if (adl !== bdl) return adl - bdl;
  return String(a.item?.slug || '').localeCompare(String(b.item?.slug || ''));
}

/** Stage 1. Sorts ONE track's cards against each other, in place. */
function rankWithin(list) {
  return list.sort(compareWithinTrack);
}

// ── exclusions ─────────────────────────────────────────────────────────────

/**
 * Why a card is not a candidate today, or null when it is. Order matters only
 * for the reported reason; every one of these is disqualifying on its own.
 */
function excluded(f, { today, policy, history, maxDaysOnSlate }) {
  const it = f.item;
  if (it?.decision) return 'decided';
  if (it?.dead === true || /^(dead|expired|closed)$/i.test(String(it?.liveness || ''))) return 'dead';
  if (f.deadline != null && f.deadline < 0) return 'deadlinePassed';
  const maxAge = maxAgeDaysFor({ track: it?.track, company: it?.company }, policy);
  if (f.age.days != null && f.age.days > maxAge) return 'stale';
  const since = (history instanceof Map ? history.get(it?.slug) : history?.[it?.slug]) ?? it?.slatedAt ?? null;
  const daysOn = daysBetween(since, today);
  if (daysOn != null && daysOn > maxDaysOnSlate) return 'rolledOff';
  return null;
}

// ── stage 2: allocate SLOTS across tracks, blind to every number ───────────

/**
 * ⚠ THIS FUNCTION MUST NOT READ A CARD'S SCORE, AND test-slate.mjs GREPS IT.
 * It sees ordered queues keyed by track and hands out slots. `urgent` is the
 * subset of civic cards inside DEADLINE_PREEMPT_DAYS, already in track order,
 * so choosing "the first urgent one" is still a within-civic comparison.
 *
 * @returns {Array<{track:string, pick:object, slot:string}>}
 */
function allocate(queues, { quotas, rotation, n, today, urgent }) {
  const picks = [];
  const taken = new Set();
  const room = () => picks.length < n;
  const next = (track) => (queues.get(track) || []).find((f) => !taken.has(f.item.slug)) || null;
  const take = (track, f, slot) => { taken.add(f.item.slug); picks.push({ track, pick: f, slot }); };

  for (const [track, want] of Object.entries(quotas || {})) {
    const count = Math.max(0, Math.floor(Number(want) || 0));
    for (let i = 1; i <= count && room(); i++) {
      const f = next(track);
      if (!f) break;                                  // the slate shrinks; no borrowing
      take(track, f, `${track} slot ${i} of ${count}`);
    }
  }

  const ring = Array.isArray(rotation?.among) ? rotation.among.filter(Boolean) : [];
  const slots = Math.max(0, Math.floor(Number(rotation?.slots) || 0));
  if (!ring.length || !slots) return picks;
  const start = ((dayNumber(today) % ring.length) + ring.length) % ring.length;

  for (let s = 0; s < slots && room(); s++) {
    const turn = ring[(start + s) % ring.length];
    const pressing = (urgent || []).find((f) => !taken.has(f.item.slug)) || null;
    if (pressing) {
      take('civic', pressing, turn === 'civic'
        ? "rotation slot — civic's turn"
        : `civic deadline pre-empts the rotation (was ${turn}'s turn)`);
      continue;
    }
    // Walk the ring from today's track: the slot belongs to the ring, so an
    // empty track passes it on rather than leaving it empty.
    for (let k = 0; k < ring.length; k++) {
      const track = ring[(start + s + k) % ring.length];
      const f = next(track);
      if (!f) continue;
      take(track, f, k === 0
        ? `rotation slot — ${track}'s turn`
        : `rotation slot — ${turn}'s turn, nothing eligible, passed to ${track}`);
      break;
    }
  }
  return picks;
}

// ── the `why` line: true statements, from the facts that ordered the card ──

function whyFor(f, slot, today) {
  const it = f.item;
  const out = [`tier ${f.tier}`];
  if (f.whale) out.push('whale');

  const { days, source } = f.age;
  if (days == null) out.push('age unknown');
  else if (source === 'updated') out.push(`employer updated it ${days}d ago`);
  else if (source === 'posted') out.push(`posted ${days}d ago`);
  else if (source === 'enqueue') out.push(`about ${days}d old (${it.ageDays}d when carded on ${it.enqueuedAt})`);
  else out.push(`${days}d old when carded`);

  if (!f.ready.checked) out.push('pack not checked');
  else {
    // Three states, three sentences. "answers drafted" over a finding that says
    // it holds no answers is the lie this replaces.
    if (f.ready.answers) out.push('answers drafted');
    else if (f.ready.formUnreadable) out.push('form not readable — fill it by hand');
    else out.push('no answers yet');
    const cl = String(it.coverLetter || 'unknown');
    if (cl === 'absent') out.push('no cover letter field');
    else if (cl === 'optional') out.push('cover letter optional');
    else if (f.ready.coverOk) out.push('cover letter drafted');
    else if (cl === 'required') out.push('cover letter still needed');
    else out.push('cover letter requirement unchecked');
  }

  const ats = String(it.ats || 'other');
  if (f.friction === 0) out.push(`${ats} — extension fills it`);
  else if (f.friction === 2) out.push('workday — needs an employer account first');
  else out.push(`${ats} — fill by hand`);

  if (f.deadline != null) {
    const until = it.postUntil ?? isoDay(dayNumber(today) + f.deadline);
    out.push(f.deadline === 0 ? `closes today (post_until ${until})` : `closes in ${f.deadline}d (post_until ${until})`);
  }
  out.push(slot);
  return out;
}

// ── entry point ────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {object[]} o.items          review-queue cards
 * @param {string|Date} o.today       the day the slate is for — REQUIRED, there is no clock here
 * @param {Record<string,number>} [o.quotas=DEFAULT_QUOTAS]      fixed slots per track; `{}` for none
 * @param {{slots:number,among:string[]}|null} [o.rotation=DEFAULT_ROTATION]  the ring; null for none
 * @param {number} [o.n]              hard cap on the slate; default = every slot the quotas describe
 * @param {Map|Record<string,string>} [o.deadlines]  slug -> post_until (or `postUntil` on the card)
 * @param {Map|Record<string,string>} [o.history]    slug -> day the card FIRST went on the slate
 * @param {number} [o.maxDaysOnSlate=DEFAULT_MAX_DAYS_ON_SLATE]
 * @param {Record<string,{answers?:boolean,coverDrafted?:boolean}>} [o.packs]  the caller's read of output/
 * @param {{isWhale?:Function,isEvergreen?:Function,whaleMaxAgeDays?:number}} [o.policy]
 *        the closure lib/freshness.mjs loadFreshnessPolicy() returns
 * @returns {{date:string, items:object[], expired:{slug:string,why:string}[], excluded:Record<string,number>}}
 */
export function buildSlate({
  items,
  today,
  quotas = DEFAULT_QUOTAS,
  rotation = DEFAULT_ROTATION,
  n,
  deadlines = null,
  history = null,
  maxDaysOnSlate = DEFAULT_MAX_DAYS_ON_SLATE,
  packs = null,
  policy = {},
} = {}) {
  const todayNo = dayNumber(today);
  if (todayNo == null) throw new TypeError('buildSlate: `today` is required and must be a date (there is no clock in this module)');
  const date = isoDay(todayNo);

  const fixed = Object.values(quotas || {}).reduce((s, v) => s + Math.max(0, Math.floor(Number(v) || 0)), 0);
  const ringSlots = rotation && Array.isArray(rotation.among) && rotation.among.length
    ? Math.max(0, Math.floor(Number(rotation.slots) || 0)) : 0;
  const cap = n == null ? fixed + ringSlots : Math.max(0, Math.floor(Number(n) || 0));

  const ctx = { today: date, policy: policy || {}, packs, deadlines, history, maxDaysOnSlate };
  const excludedCount = { decided: 0, dead: 0, deadlinePassed: 0, stale: 0, rolledOff: 0 };
  const expired = [];
  const byTrack = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const f = facts(item, ctx);
    const why = excluded(f, ctx);
    if (why) {
      excludedCount[why]++;
      if (why === 'rolledOff') expired.push({ slug: item.slug, why: `on the slate more than ${maxDaysOnSlate} days` });
      else if (why === 'deadlinePassed') expired.push({ slug: item.slug, why: `post_until has passed (${-f.deadline}d ago)` });
      continue;
    }
    const track = String(item.track || 'pm');
    if (!byTrack.has(track)) byTrack.set(track, []);
    byTrack.get(track).push(f);
  }

  // Stage 1 - each queue is sorted against itself and nothing else.
  for (const list of byTrack.values()) rankWithin(list);
  const urgent = (byTrack.get('civic') || [])
    .filter((f) => f.deadline != null && f.deadline <= DEADLINE_PREEMPT_DAYS);

  // Stage 2 - slots only.
  const picks = allocate(byTrack, { quotas, rotation, n: cap, today: date, urgent });

  const since = (slug) => (history instanceof Map ? history.get(slug) : history?.[slug]) ?? null;
  const out = picks.map(({ pick, slot }) => ({
    ...pick.item,
    slatedAt: since(pick.item.slug) ?? pick.item.slatedAt ?? date,
    why: whyFor(pick, slot, date),
  }));

  return { date, items: out, expired, excluded: excludedCount };
}
