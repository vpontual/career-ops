#!/usr/bin/env node

/**
 * test-slate.mjs — the daily slate picks by slot, never by a blended score.
 *
 * Five tracks, five rubrics, and a 5 that means something different on each.
 * VP wants them unblended, so the one property that matters most here is a
 * NEGATIVE one: rescaling every score inside one track must not change which
 * tracks end up on the slate. The rest pins the within-track order, the
 * exclusions, the roll-off, and that a starved track leaves its slot empty
 * rather than borrowing.
 *
 * Every case is built from the card shape data/review-queue.json actually has
 * (slug, company, role, ats, score, ageDays, enqueuedAt, coverLetter, track,
 * decision). Fields a later phase adds (postedAt, updatedAt, postUntil) are
 * exercised as optional.
 */

import { readFileSync } from 'fs';
import {
  buildSlate, compareWithinTrack, liveAgeDays, atsFriction, packReadiness,
  DEFAULT_QUOTAS, DEFAULT_ROTATION, DEADLINE_PREEMPT_DAYS, DEFAULT_MAX_DAYS_ON_SLATE,
} from './lib/slate.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);
const same = (label, got, want) => T.push([label, JSON.stringify(got), JSON.stringify(want)]);

const TODAY = '2026-09-02';
const DAY = 86400000;
const shift = (iso, days) => new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
const dayNo = (iso) => Math.floor(Date.parse(iso) / DAY);
// The date on or after `from` when it is `track`'s turn in the default ring.
const turnOf = (track, from = TODAY) => {
  const ring = DEFAULT_ROTATION.among;
  for (let i = 0; i < ring.length; i++) {
    const d = shift(from, i);
    if (ring[dayNo(d) % ring.length] === track) return d;
  }
  throw new Error('unreachable');
};

let seq = 0;
const card = (o = {}) => ({
  slug: o.slug ?? `card-${++seq}`,
  company: 'Acme',
  role: 'Senior Product Manager',
  sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
  applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
  ats: 'greenhouse',
  score: 5,
  ageDays: 3,
  enqueuedAt: TODAY,
  geo: 'nyc',
  coverLetter: 'absent',
  cvVariant: 'ai-infra',
  notes: '',
  decision: null,
  decidedAt: null,
  track: 'pm',
  ...o,
});

const slugs = (r) => r.items.map((i) => i.slug);
const tracksOf = (r) => r.items.map((i) => i.track);
// pm slots only, no ring — the simplest way to look at one track's order.
const pmOnly = (items, extra = {}) =>
  buildSlate({ items, today: TODAY, quotas: { pm: 10 }, rotation: null, ...extra });

// ── within a track: the order, one boundary at a time ─────────────────────

// ⚠ RECENCY IS FIRST, and these three cases are the ones that changed when it
// became so (VP, 2026-09-08). The slate had been the one surface still ordering
// by tier and whale ahead of the date, which put Stripe at 11d above Google at
// 1d — both tier 5 — on the page he opens first.
same('recency beats tier',
  slugs(pmOnly([card({ slug: 'fresh-4', score: 4, ageDays: 1 }), card({ slug: 'old-5', score: 5, ageDays: 15 })])),
  ['fresh-4', 'old-5']);

same('recency beats whale — the Stripe/Google case, exactly',
  slugs(buildSlate({
    today: TODAY, quotas: { pm: 10 }, rotation: null,
    policy: { isWhale: (c) => /stripe/i.test(c) },
    items: [
      card({ slug: 'stripe-11d', company: 'Stripe', score: 5, ageDays: 11 }),
      card({ slug: 'google-1d', company: 'Google', score: 5, ageDays: 1 }),
    ],
  })),
  ['google-1d', 'stripe-11d']);

// ⚠ ...and tier and whale still do real work as TIE-BREAKS. Dropping them
// entirely would be the opposite overcorrection: at equal freshness the rubric
// and the whale list are exactly how two roles should be separated.
same('at equal recency, tier breaks the tie',
  slugs(pmOnly([card({ slug: 'four', score: 4, ageDays: 3 }), card({ slug: 'five', score: 5, ageDays: 3 })])),
  ['five', 'four']);

same('at equal recency and tier, whale breaks the tie',
  slugs(buildSlate({
    today: TODAY, quotas: { pm: 10 }, rotation: null,
    policy: { isWhale: (c) => /anthropic/i.test(c) },
    items: [card({ slug: 'acme-3d', ageDays: 3 }), card({ slug: 'anthropic-3d', company: 'Anthropic', ageDays: 3 })],
  })),
  ['anthropic-3d', 'acme-3d']);

same('a `whale: true` flag on the card is honoured without a policy, at equal recency',
  slugs(pmOnly([card({ slug: 'a', ageDays: 9 }), card({ slug: 'w', whale: true, ageDays: 9 })])),
  ['w', 'a']);

same('but the flag does not lift an older whale over a fresher role',
  slugs(pmOnly([card({ slug: 'a', ageDays: 1 }), card({ slug: 'w', whale: true, ageDays: 9 })])),
  ['a', 'w']);

same('fresher beats older at equal tier, non-whale',
  slugs(pmOnly([card({ slug: 'nine', ageDays: 9 }), card({ slug: 'two', ageDays: 2 })])),
  ['two', 'nine']);

// ageDays is frozen at mint time. A card carded 10 days ago at 2d is 12d old
// now; one carded today at 9d is 9d old. The frozen numbers say the opposite.
same('recency is LIVE: ageDays is corrected by the days since enqueuedAt',
  slugs(pmOnly([
    card({ slug: 'frozen-2-really-12', ageDays: 2, enqueuedAt: shift(TODAY, -10) }),
    card({ slug: 'frozen-9-really-9', ageDays: 9, enqueuedAt: TODAY }),
  ])),
  ['frozen-9-really-9', 'frozen-2-really-12']);

eq('liveAgeDays: frozen + drift', liveAgeDays({ ageDays: 2, enqueuedAt: shift(TODAY, -10) }, TODAY).days, 12);
eq('liveAgeDays: no enqueuedAt falls back to the frozen number', liveAgeDays({ ageDays: 4 }, TODAY).days, 4);
eq('liveAgeDays: no age at all is null', liveAgeDays({}, TODAY).days, null);
eq('liveAgeDays: postedAt is preferred over ageDays',
  liveAgeDays({ ageDays: 40, postedAt: shift(TODAY, -3) }, TODAY).days, 3);
eq('liveAgeDays: the more recent of posted/updated wins',
  liveAgeDays({ postedAt: shift(TODAY, -27), updatedAt: shift(TODAY, -2) }, TODAY).days, 2);
eq('liveAgeDays: says which stamp it used',
  liveAgeDays({ postedAt: shift(TODAY, -27), updatedAt: shift(TODAY, -2) }, TODAY).source, 'updated');
eq('liveAgeDays: a future enqueuedAt does not make a card younger',
  liveAgeDays({ ageDays: 5, enqueuedAt: shift(TODAY, 3) }, TODAY).days, 5);

same('unknown age sorts last, not first',
  slugs(pmOnly([card({ slug: 'no-age', ageDays: null, enqueuedAt: null }), card({ slug: 'aged', ageDays: 20 })])),
  ['aged', 'no-age']);

const packs = { ready: { answers: true }, half: { answers: false } };
same('pack readiness beats ATS friction at equal tier/whale/age',
  slugs(pmOnly([
    card({ slug: 'half', ats: 'greenhouse' }),
    card({ slug: 'ready', ats: 'other', applyUrl: 'https://acme.com/apply' }),
  ], { packs })),
  ['ready', 'half']);

eq('readiness: absent cover letter + answers is fully ready',
  packReadiness(card({ slug: 'r', coverLetter: 'absent' }), { r: { answers: true } }).level, 2);
eq('readiness: required cover letter, not drafted, is not settled',
  packReadiness(card({ slug: 'r', coverLetter: 'required' }), { r: { answers: true } }).level, 1);
eq('readiness: required cover letter, drafted, is settled',
  packReadiness(card({ slug: 'r', coverLetter: 'required' }), { r: { answers: true, coverDrafted: true } }).level, 2);
// 176 of 205 cards read `unknown`. Unknown is not "none needed".
eq('readiness: unknown cover letter is NOT treated as settled',
  packReadiness(card({ slug: 'r', coverLetter: 'unknown' }), { r: { answers: true } }).coverOk, false);
eq('readiness: no packs input means unchecked, not unready',
  packReadiness(card({ slug: 'r' }), null).checked, false);

// ── an unreadable form is a THIRD state, not "not ready yet" ───────────────
// 127 of 514 packs on 2026-09-08 held a finding rather than answers, and the
// caller read the FILENAME, so every one of them ranked as fully ready and
// /today badged it "answers drafted" over a file whose last line says nothing
// above is an answer.
eq('readiness: an unreadable form does not count as answers',
  packReadiness(card({ slug: 'r', coverLetter: 'absent' }),
    { r: { answers: false, formUnreadable: true } }).answers, false);
eq('readiness: an unreadable form scores like a missing pack, not a finished one',
  packReadiness(card({ slug: 'r', coverLetter: 'absent' }),
    { r: { answers: false, formUnreadable: true } }).level, 1);
eq('readiness: an unreadable form is reported as its own state',
  packReadiness(card({ slug: 'r' }), { r: { answers: false, formUnreadable: true } }).formUnreadable, true);
// The two are mutually exclusive by construction: a pack cannot both hold
// answers and hold a finding, and a caller that sets both must not get both.
eq('readiness: answers win over a stale formUnreadable flag',
  packReadiness(card({ slug: 'r' }), { r: { answers: true, formUnreadable: true } }).formUnreadable, false);
eq('readiness: an unchecked pack is not an unreadable one',
  packReadiness(card({ slug: 'r' }), null).formUnreadable, false);

// build-slate.mjs falls back to this exact sentence for packs written before
// answers-meta.enumerated existed. Rewording renderWallFinding() without
// updating that fallback would silently re-promote every one of them, so the
// string is pinned here rather than left to a comment.
{
  const src = readFileSync(new URL('./generate-answers.mjs', import.meta.url), 'utf-8');
  const bs = readFileSync(new URL('./build-slate.mjs', import.meta.url), 'utf-8');
  // Every sentence a finding can carry must be one build-slate recognises.
  // 21 findings predate the footer - the Citi Workday reqs, "behind an account
  // wall" with no footer - and a marker that knew only the footer read all 21
  // as answered.
  for (const phrase of [
    'no field list could be read for this pack',
    'behind an account wall',
    'exposed no application field',
    'the application form could not be read',
  ]) {
    eq(`generate-answers still emits: ${phrase}`, src.includes(phrase), true);
    eq(`build-slate still recognises: ${phrase}`, bs.includes(phrase), true);
  }
  eq('build-slate prefers the written flag over the prose',
    bs.includes("typeof meta.enumerated === 'boolean'"), true);
}

same('ATS friction: extension-fillable before other before Workday',
  slugs(pmOnly([
    card({ slug: 'wd', ats: 'other', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1' }),
    card({ slug: 'custom', ats: 'other', applyUrl: 'https://acme.com/apply' }),
    card({ slug: 'lever', ats: 'lever', applyUrl: 'https://jobs.lever.co/acme/1' }),
  ])),
  ['lever', 'custom', 'wd']);
eq('friction: ashby is extension-fillable', atsFriction({ ats: 'ashby' }), 0);
eq('friction: an explicit ats of workday counts', atsFriction({ ats: 'workday', applyUrl: 'https://x' }), 2);
eq('friction: a Workday URL under ats=other counts',
  atsFriction({ ats: 'other', applyUrl: 'https://a.wd1.myworkdayjobs.com/x' }), 2);
eq('friction: olas / amazon / custom are by-hand forms', atsFriction({ ats: 'olas' }), 1);

same('civic post_until soonest first, all else equal',
  slugs(buildSlate({
    today: TODAY, quotas: { civic: 10 }, rotation: null,
    items: [
      card({ slug: 'far', track: 'civic', ats: 'other' }),
      card({ slug: 'soon', track: 'civic', ats: 'other' }),
      card({ slug: 'none', track: 'civic', ats: 'other' }),
    ],
    deadlines: { far: shift(TODAY, 40), soon: shift(TODAY, 20) },
  })),
  ['soon', 'far', 'none']);

same('post_until on the card itself works too',
  slugs(buildSlate({
    today: TODAY, quotas: { civic: 10 }, rotation: null,
    items: [
      card({ slug: 'far', track: 'civic', postUntil: shift(TODAY, 40) }),
      card({ slug: 'soon', track: 'civic', postUntil: shift(TODAY, 20) }),
    ],
  })),
  ['soon', 'far']);

same('friction beats deadline within a track (deadline is the LAST tiebreak)',
  slugs(buildSlate({
    today: TODAY, quotas: { civic: 10 }, rotation: null,
    items: [
      card({ slug: 'soon-by-hand', track: 'civic', ats: 'other', postUntil: shift(TODAY, 20) }),
      card({ slug: 'far-greenhouse', track: 'civic', ats: 'greenhouse', postUntil: shift(TODAY, 40) }),
    ],
  })),
  ['far-greenhouse', 'soon-by-hand']);

same('equal on everything falls through to slug, so the order is stable',
  slugs(pmOnly([card({ slug: 'b' }), card({ slug: 'a' }), card({ slug: 'c' })])),
  ['a', 'b', 'c']);

// Input order must not leak into output order.
{
  const base = [
    card({ slug: 'p1', score: 5, ageDays: 2 }), card({ slug: 'p2', score: 5, ageDays: 2, ats: 'other' }),
    card({ slug: 'p3', score: 4, ageDays: 1 }), card({ slug: 'p4', score: 5, ageDays: 7 }),
    card({ slug: 'p5', score: 5, ageDays: 2, whale: true }),
  ];
  const want = slugs(pmOnly(base));
  const perms = [base.slice().reverse(), [base[2], base[4], base[0], base[3], base[1]], [base[3], base[1], base[4], base[2], base[0]]];
  eq('deterministic under every permutation of the input', perms.every((p) => JSON.stringify(slugs(pmOnly(p))) === JSON.stringify(want)), true);
  // recency first: p3 (1d), then the three at 2d separated by tier then whale
  // (p5 is the whale), then p4 (7d).
  same('...and the order is the documented one', want, ['p3', 'p5', 'p1', 'p2', 'p4']);
}

// ── ⚠ NO CROSS-TRACK SCORE, EVER ───────────────────────────────────────────
// Rescale one track's scores end to end. The set of tracks on the slate, and
// how many slots each holds, must not move - only which card fills a slot may.
{
  const fixture = (pmScore, nowScore) => [
    card({ slug: 'pm-a', score: pmScore, ageDays: 1 }),
    card({ slug: 'pm-b', score: pmScore, ageDays: 2 }),
    card({ slug: 'pm-c', score: pmScore, ageDays: 3 }),
    card({ slug: 'now-a', track: 'now', score: nowScore, ageDays: 1 }),
    card({ slug: 'now-b', track: 'now', score: nowScore, ageDays: 2 }),
    card({ slug: 'np-a', track: 'nonprofit', score: 4, ageDays: 1 }),
  ];
  const day = turnOf('now');
  const run = (pmScore, nowScore) => buildSlate({ items: fixture(pmScore, nowScore), today: day });
  const shape = (r) => tracksOf(r);
  same('pm 5s / now 1s: two pm slots plus the rotation slot on now', shape(run(5, 1)), ['pm', 'pm', 'now']);
  same('pm 1s / now 5s: IDENTICAL composition — a now 5 cannot take a pm slot', shape(run(1, 5)), ['pm', 'pm', 'now']);
  same('pm 5s / now 5s: identical', shape(run(5, 5)), ['pm', 'pm', 'now']);
  same('pm 0s / now 0s: identical', shape(run(0, 0)), ['pm', 'pm', 'now']);

  // The strongest form: with only a pm slot on offer, a pm 1 is chosen while a
  // now 5 sits out. No slot ever moves because of a number.
  same('a pm 1 fills the pm slot while a now 5 has no slot',
    slugs(buildSlate({ items: fixture(1, 5), today: day, quotas: { pm: 1 }, rotation: null })), ['pm-a']);
  same('...and with only a now slot, the pm 5s sit out',
    slugs(buildSlate({ items: fixture(5, 1), today: day, quotas: { now: 1 }, rotation: null })), ['now-a']);
}

// The allocator's SOURCE must not mention a score. A comparison that never
// happens in the code cannot happen in the data.
{
  const src = readFileSync(new URL('./lib/slate.mjs', import.meta.url), 'utf-8');
  const m = src.match(/function allocate\([\s\S]*?\n}\n/);
  eq('allocate() exists as a standalone function', Boolean(m), true);
  eq('allocate() never reads `score`', m ? /score/.test(m[0]) : true, false);
  eq('allocate() never reads `tier`', m ? /\btier\b/.test(m[0]) : true, false);
  eq('allocate() never sorts — order is settled before it runs', m ? /\.sort\(|compareWithinTrack/.test(m[0]) : true, false);
  const rw = src.match(/function rankWithin\([\s\S]*?\n}\n/);
  eq('rankWithin() sorts with the one comparator and nothing else',
    rw ? /\.sort\(compareWithinTrack\)/.test(rw[0]) : false, true);
}

// ── the rotation, and the civic deadline that jumps it ────────────────────
{
  const day = turnOf('now');
  const items = [
    card({ slug: 'pm-1' }), card({ slug: 'pm-2' }),
    card({ slug: 'now-1', track: 'now' }),
    card({ slug: 'civic-1', track: 'civic', ats: 'other' }),
  ];
  same("on now's day the rotation slot goes to now",
    slugs(buildSlate({ items, today: day })), ['pm-1', 'pm-2', 'now-1']);
  same('a civic role 5 days from post_until pre-empts the rotation',
    slugs(buildSlate({ items, today: day, deadlines: { 'civic-1': shift(day, 5) } })), ['pm-1', 'pm-2', 'civic-1']);
  same(`exactly ${DEADLINE_PREEMPT_DAYS} days out still pre-empts`,
    slugs(buildSlate({ items, today: day, deadlines: { 'civic-1': shift(day, DEADLINE_PREEMPT_DAYS) } })), ['pm-1', 'pm-2', 'civic-1']);
  same(`${DEADLINE_PREEMPT_DAYS + 1} days out does not`,
    slugs(buildSlate({ items, today: day, deadlines: { 'civic-1': shift(day, DEADLINE_PREEMPT_DAYS + 1) } })), ['pm-1', 'pm-2', 'now-1']);
  same('closing today still pre-empts (0 days)',
    slugs(buildSlate({ items, today: day, deadlines: { 'civic-1': day } })), ['pm-1', 'pm-2', 'civic-1']);
  same('pre-emption takes the ROTATION slot only, never a pm slot',
    tracksOf(buildSlate({ items, today: day, deadlines: { 'civic-1': shift(day, 2) } })), ['pm', 'pm', 'civic']);
  eq('the why line says the rotation was pre-empted',
    buildSlate({ items, today: day, deadlines: { 'civic-1': shift(day, 5) } }).items[2].why.some((w) => /pre-empts the rotation/.test(w)), true);

  // The urgent card is the one that pre-empts, not civic's best card.
  same('the pre-empting card is the urgent one, not the top-ranked civic card',
    slugs(buildSlate({
      today: day,
      items: [...items, card({ slug: 'civic-5-no-deadline', track: 'civic', score: 5, ageDays: 1 }),
              card({ slug: 'civic-4-urgent', track: 'civic', score: 4, ageDays: 1, postUntil: shift(day, 3) })],
    })),
    ['pm-1', 'pm-2', 'civic-4-urgent']);
  same('two urgent civic cards: the higher-ranked urgent one, by the same within-track order',
    slugs(buildSlate({
      today: day, quotas: {}, rotation: { slots: 1, among: ['now', 'civic'] },
      items: [card({ slug: 'now-1', track: 'now' }),
              card({ slug: 'u4', track: 'civic', score: 4, postUntil: shift(day, 3) }),
              card({ slug: 'u5', track: 'civic', score: 5, postUntil: shift(day, 6) })],
    })),
    ['u5']);
}

{
  // The ring walks past an empty track rather than leaving the slot empty.
  const day = turnOf('nonprofit');
  same("nonprofit's day, nonprofit empty: the slot passes to the next track in the ring",
    slugs(buildSlate({
      today: day, quotas: {},
      items: [card({ slug: 'now-1', track: 'now' }), card({ slug: 'teach-1', track: 'teaching' })],
    })),
    ['now-1']);
  eq('...and the why line says so',
    buildSlate({ today: day, quotas: {}, items: [card({ slug: 'now-1', track: 'now' })] })
      .items[0].why.some((w) => /nonprofit's turn, nothing eligible, passed to now/.test(w)), true);
  same('the whole ring empty: the rotation slot stays empty, pm does not fill it',
    slugs(buildSlate({ today: day, items: [card({ slug: 'pm-1' }), card({ slug: 'pm-2' }), card({ slug: 'pm-3' })] })),
    ['pm-1', 'pm-2']);
  // Four consecutive days visit four tracks.
  const seen = [0, 1, 2, 3].map((i) => buildSlate({
    today: shift(TODAY, i), quotas: {},
    items: DEFAULT_ROTATION.among.map((t) => card({ slug: `${t}-1`, track: t })),
  }).items[0].track).sort();
  same('over four days every ring track gets its turn', seen, [...DEFAULT_ROTATION.among].sort());
  eq('a track outside quotas and ring is never slated',
    buildSlate({ today: TODAY, items: [card({ slug: 'v', track: 'venture' }), card({ slug: 'g', track: 'govtech' })] }).items.length, 0);
}

// ── exclusions ────────────────────────────────────────────────────────────
for (const d of ['approved', 'rejected', 'hold', 'expired']) {
  eq(`a card decided "${d}" is excluded`, pmOnly([card({ decision: d })]).items.length, 0);
}
eq('a dead card is excluded', pmOnly([card({ dead: true })]).items.length, 0);
eq('liveness "expired" is excluded', pmOnly([card({ liveness: 'expired' })]).items.length, 0);
eq('liveness "active" is not', pmOnly([card({ liveness: 'active' })]).items.length, 1);
{
  const r = buildSlate({ today: TODAY, quotas: { civic: 5 }, rotation: null,
    items: [card({ slug: 'gone', track: 'civic', postUntil: shift(TODAY, -2) })] });
  eq('a civic card past its post_until is excluded', r.items.length, 0);
  same('...and reported as expired with the reason', r.expired, [{ slug: 'gone', why: 'post_until has passed (2d ago)' }]);
}
eq('a pm card at 22 days is outside its window', pmOnly([card({ ageDays: 22 })]).items.length, 0);
eq('a pm card at 21 days is inside it', pmOnly([card({ ageDays: 21 })]).items.length, 1);
eq('the frozen age is corrected before the window is applied',
  pmOnly([card({ ageDays: 15, enqueuedAt: shift(TODAY, -10) })]).items.length, 0);
eq('a civic card at 22 days is inside ITS window (60)',
  buildSlate({ today: TODAY, quotas: { civic: 1 }, rotation: null, items: [card({ track: 'civic', ageDays: 22 })] }).items.length, 1);
eq('a whale at 25 days is inside the whale window',
  pmOnly([card({ company: 'Anthropic', ageDays: 25 })], { policy: { isWhale: (c) => /anthropic/i.test(c) } }).items.length, 1);
eq('an evergreen board at 8 days is outside its 7-day window',
  pmOnly([card({ company: 'Sierra', ageDays: 8 })], { policy: { isEvergreen: (c) => /sierra/i.test(c) } }).items.length, 0);
eq('a card with no age at all is not excluded on age',
  pmOnly([card({ ageDays: null, enqueuedAt: null })]).items.length, 1);
same('exclusion counts reconcile',
  buildSlate({ today: TODAY, quotas: { pm: 5, civic: 5 }, rotation: null, items: [
    card({ decision: 'rejected' }), card({ dead: true }), card({ ageDays: 40 }),
    card({ track: 'civic', postUntil: shift(TODAY, -1) }), card({ slug: 'old', slatedAt: shift(TODAY, -9) }), card(),
  ] }).excluded,
  { decided: 1, dead: 1, deadlinePassed: 1, stale: 1, rolledOff: 1 });

// ── roll-off ──────────────────────────────────────────────────────────────
{
  const items = [card({ slug: 'sat' }), card({ slug: 'new' })];
  const at = (daysAgo) => buildSlate({ items, today: TODAY, quotas: { pm: 5 }, rotation: null,
    history: { sat: shift(TODAY, -daysAgo) } });
  eq(`on the slate ${DEFAULT_MAX_DAYS_ON_SLATE} days: still on it`, slugs(at(DEFAULT_MAX_DAYS_ON_SLATE)).includes('sat'), true);
  eq(`on the slate ${DEFAULT_MAX_DAYS_ON_SLATE + 1} days: rolled off`, slugs(at(DEFAULT_MAX_DAYS_ON_SLATE + 1)).includes('sat'), false);
  same('...and reported as expired', at(DEFAULT_MAX_DAYS_ON_SLATE + 1).expired,
    [{ slug: 'sat', why: `on the slate more than ${DEFAULT_MAX_DAYS_ON_SLATE} days` }]);
  eq('a rolled-off card frees its slot for the next one', slugs(at(DEFAULT_MAX_DAYS_ON_SLATE + 1)).includes('new'), true);
  eq('maxDaysOnSlate is honoured', buildSlate({ items, today: TODAY, quotas: { pm: 5 }, rotation: null,
    history: { sat: shift(TODAY, -2) }, maxDaysOnSlate: 1 }).expired.length, 1);
  eq('slatedAt is carried from history so the caller can persist it', at(2).items.find((i) => i.slug === 'sat').slatedAt, shift(TODAY, -2));
  eq('a first-time pick is slated today', at(2).items.find((i) => i.slug === 'new').slatedAt, TODAY);
  eq('slatedAt on the card itself is honoured', pmOnly([card({ slatedAt: shift(TODAY, -5) })]).items.length, 0);
  eq('history as a Map works', buildSlate({ items, today: TODAY, quotas: { pm: 5 }, rotation: null,
    history: new Map([['sat', shift(TODAY, -6)]]) }).expired.length, 1);
}

// ── quotas, n, and the slate that shrinks instead of borrowing ────────────
same('pm:2 with one eligible pm card yields one item, not a borrowed one',
  slugs(buildSlate({ today: TODAY, rotation: null, items: [card({ slug: 'pm-1' }), card({ slug: 'now-1', track: 'now' })] })),
  ['pm-1']);
eq('quota of 3 takes three', buildSlate({ today: TODAY, quotas: { pm: 3 }, rotation: null,
  items: [card(), card(), card(), card()] }).items.length, 3);
same('multiple fixed quotas fill in the order given',
  tracksOf(buildSlate({ today: TODAY, quotas: { now: 1, pm: 2 }, rotation: null,
    items: [card(), card(), card({ track: 'now' })] })),
  ['now', 'pm', 'pm']);
eq('n caps the slate below the quotas', buildSlate({ today: TODAY, n: 1, rotation: null,
  items: [card(), card()] }).items.length, 1);
eq('n larger than the slots does not invent slots', buildSlate({ today: TODAY, n: 50, rotation: null,
  items: [card(), card(), card()] }).items.length, 2);
eq('n=0 is an empty slate', buildSlate({ today: TODAY, n: 0, items: [card(), card()] }).items.length, 0);
eq('the default slate is DEFAULT_QUOTAS + the rotation', buildSlate({ today: TODAY,
  items: [card(), card(), card(), card({ track: 'civic' }), card({ track: 'now' }), card({ track: 'nonprofit' }), card({ track: 'teaching' })] }).items.length,
  DEFAULT_QUOTAS.pm + DEFAULT_ROTATION.slots);
eq('a negative or junk quota is zero', buildSlate({ today: TODAY, quotas: { pm: -3, now: 'x' }, rotation: null,
  items: [card(), card({ track: 'now' })] }).items.length, 0);
eq('a card with no track is treated as pm, as the review page does',
  pmOnly([card({ track: undefined })]).items.length, 1);

// ── degenerate inputs ─────────────────────────────────────────────────────
eq('no items: empty slate', buildSlate({ today: TODAY, items: [] }).items.length, 0);
eq('items undefined: empty slate', buildSlate({ today: TODAY }).items.length, 0);
eq('junk entries are ignored', buildSlate({ today: TODAY, items: [null, 3, 'x', card()] }).items.length, 1);
eq('no quotas and no rotation: empty slate', buildSlate({ today: TODAY, quotas: {}, rotation: null, items: [card()] }).items.length, 0);
eq('quotas {} alone still leaves the rotation slot', buildSlate({ today: TODAY, quotas: {},
  items: [card({ track: 'civic' })] }).items.length, 1);
eq('rotation with an empty ring is no rotation', buildSlate({ today: TODAY, quotas: {}, rotation: { slots: 1, among: [] },
  items: [card({ track: 'civic' })] }).items.length, 0);
eq('date is echoed back as YYYY-MM-DD', buildSlate({ today: new Date(`${TODAY}T15:00:00Z`), items: [] }).date, TODAY);
{
  let threw = false;
  try { buildSlate({ items: [card()] }); } catch { threw = true; }
  eq('today is required — there is no clock in the module', threw, true);
  let threw2 = false;
  try { buildSlate({ today: 'not a date', items: [card()] }); } catch { threw2 = true; }
  eq('an unparsable today throws rather than silently aging nothing', threw2, true);
}
eq('the input cards are not mutated',
  (() => { const c = card(); pmOnly([c]); return 'why' in c || 'slatedAt' in c; })(), false);

// ── the why line: every entry is a fact the card carries ──────────────────
{
  const day = turnOf('civic');
  const r = buildSlate({
    today: day,
    policy: { isWhale: (c) => /anthropic/i.test(c) },
    packs: { w: { answers: true }, c: { answers: true, coverDrafted: true } },
    items: [
      card({ slug: 'w', company: 'Anthropic', score: 5, postedAt: shift(day, -1), coverLetter: 'absent', ats: 'greenhouse' }),
      card({ slug: 'c', track: 'civic', score: 4, postedAt: shift(day, -6), coverLetter: 'required', ats: 'other',
             applyUrl: 'https://cityjobs.nyc.gov/job/1', postUntil: shift(day, 5) }),
    ],
  });
  const w = r.items.find((i) => i.slug === 'w').why;
  const c = r.items.find((i) => i.slug === 'c').why;
  same('a whale pm card, fully ready, on greenhouse', w,
    ['tier 5', 'whale', 'posted 1d ago', 'answers drafted', 'no cover letter field', 'greenhouse — extension fills it', 'pm slot 1 of 2']);
  same('a civic card with a drafted letter and a deadline', c,
    ['tier 4', 'posted 6d ago', 'answers drafted', 'cover letter drafted', 'other — fill by hand',
     `closes in 5d (post_until ${shift(day, 5)})`, "rotation slot — civic's turn"]);
}
{
  const why = pmOnly([card({ slug: 'x', ageDays: 2, enqueuedAt: shift(TODAY, -4), coverLetter: 'required', ats: 'other',
    applyUrl: 'https://acme.wd5.myworkdayjobs.com/x' })], { packs: {} }).items[0].why;
  eq('a drifted age says so, with the numbers', why.includes(`about 6d old (2d when carded on ${shift(TODAY, -4)})`), true);
  eq('an unwritten answers file is stated, not hidden', why.includes('no answers yet'), true);
  eq('a required, undrafted letter is stated', why.includes('cover letter still needed'), true);
  // Three readiness states must read as three different sentences on the card.
  // "answers drafted" over a finding was the bug; "no answers yet" over one
  // would be the opposite lie, promising a pack tonight's run cannot produce.
  {
    const w = pmOnly([card({ slug: 'x', coverLetter: 'absent' })],
      { packs: { x: { answers: false, formUnreadable: true } } }).items[0].why;
    eq('an unreadable form says so, and does not claim answers',
      w.includes('form not readable — fill it by hand') && !w.includes('answers drafted'), true);
  }
  eq('Workday friction is stated', why.includes('workday — needs an employer account first'), true);
  eq('no packs input reads as unchecked', pmOnly([card()]).items[0].why.includes('pack not checked'), true);
  eq('unknown cover letter reads as unchecked, never as "not needed"',
    pmOnly([card({ coverLetter: 'unknown' })], { packs: {} }).items[0].why.includes('cover letter requirement unchecked'), true);
  eq('updatedAt reads as employer activity',
    pmOnly([card({ updatedAt: shift(TODAY, -1), postedAt: shift(TODAY, -20) })]).items[0].why.includes('employer updated it 1d ago'), true);
  eq('a frozen age with no enqueuedAt says it was measured at carding',
    pmOnly([card({ ageDays: 4, enqueuedAt: null })]).items[0].why.includes('4d old when carded'), true);
  eq('closing today is said plainly',
    buildSlate({ today: TODAY, quotas: { civic: 1 }, rotation: null, items: [card({ track: 'civic', postUntil: TODAY })] })
      .items[0].why.includes(`closes today (post_until ${TODAY})`), true);
}

// compareWithinTrack is exported for the reason the header gives - so the
// order can be asserted directly, not just through the slate.
{
  const f = (o) => ({ tier: 5, whale: false, age: { days: 3 }, ready: { level: 2 }, friction: 0, deadline: null, item: { slug: 'a' }, ...o });
  eq('compare: tier', Math.sign(compareWithinTrack(f({ tier: 4 }), f({ tier: 5 }))), 1);
  eq('compare: whale', Math.sign(compareWithinTrack(f({ whale: true }), f({}))), -1);
  eq('compare: age', Math.sign(compareWithinTrack(f({ age: { days: 9 } }), f({}))), 1);
  eq('compare: readiness', Math.sign(compareWithinTrack(f({ ready: { level: 1 } }), f({}))), 1);
  eq('compare: friction', Math.sign(compareWithinTrack(f({ friction: 2 }), f({}))), 1);
  eq('compare: deadline', Math.sign(compareWithinTrack(f({ deadline: 3 }), f({ deadline: 9 }))), -1);
  eq('compare: null deadline sorts after a real one', Math.sign(compareWithinTrack(f({}), f({ deadline: 40 }))), 1);
  eq('compare: identical facts, slug decides', Math.sign(compareWithinTrack(f({ item: { slug: 'b' } }), f({}))), 1);
}

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  x ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nslate — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) {
  console.log('\nA slot is allocated to a track. A score never crosses one.\n');
  process.exit(1);
}
console.log('');
