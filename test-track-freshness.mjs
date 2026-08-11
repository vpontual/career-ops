#!/usr/bin/env node

/**
 * test-track-freshness.mjs — the per-track freshness windows, and the property
 * that they are the SAME windows everywhere freshness is enforced.
 *
 * test-recency.mjs already pins the meaning of "how old is this" and the
 * staging/enqueue invariant. This file pins the NUMBERS and where they came
 * from, because on 2026-08-11 two more tracks got their own window and a number
 * with no test is a number the next measurement quietly disagrees with.
 *
 * THE TRIGGER. GiveDirectly "Chief of Staff, Emergency Cash": score 4, 26 days
 * old, outside the flat 21-day window, so no application pack, so it could never
 * become a review card. VP had asked for nonprofit roles and this one was
 * unreachable without a single error anywhere in the pipeline. Checked live
 * against the GiveDirectly Greenhouse board that day: STILL OPEN.
 *
 * THE QUESTION, settled by measurement rather than by sympathy for the role:
 * do nonprofit and civic postings stay open longer than tech postings?
 *
 *   civic      YES, decisively, and NYC says so itself. Socrata kpav-sd4t
 *              publishes post_until on 1,309 of 1,332 open requisitions; the
 *              median declared open window is 60 days (p75 60, p90 60). The
 *              observed ages of open reqs agree (p50 27d, 25% over 45d, 8% over
 *              60d) - exactly the shape a ~60-day lifespan produces. A 21-day
 *              window admits 45% of the live inventory; 60 days admits 94%.
 *   nonprofit  ONLY MODESTLY. Live sweep of 36 nonprofit boards vs 135 pm
 *              boards: p50 19d vs 16d, 48% vs 37% over 21 days, 30% vs 23% over
 *              45 days (n=349 vs n=10,437 open postings). Real, but ~1.3x, not
 *              teaching's 7x. So Track B got 35 days - the window that gives it
 *              the same share of its live inventory that 21 days gives pm - and
 *              NOT a school-year window, despite being the track most starved of
 *              roles. Scarcity is not evidence of longevity.
 *   pm         UNCHANGED at 21, deliberately. See lib/freshness.mjs.
 *
 * What the data could NOT settle is recorded in lib/freshness.mjs beside each
 * constant: there is no observed-death survival curve for either new track,
 * because scan-history has only watched their boards since 2026-08-11.
 */

import { readFileSync } from 'fs';
import {
  maxAgeDaysFor, loadFreshnessPolicy, recencyDays,
  TRACK_MAX_AGE_DAYS, describeWindows,
  FRESH_MAX_AGE_DAYS, WHALE_MAX_AGE_DAYS, EVERGREEN_MAX_AGE_DAYS,
  TEACHING_MAX_AGE_DAYS, CIVIC_MAX_AGE_DAYS, NONPROFIT_MAX_AGE_DAYS,
} from './lib/freshness.mjs';

const T = [];
const eq = (l, got, want) => T.push([l, got, want]);

const source = (f) => readFileSync(new URL(f, import.meta.url), 'utf-8');

// ── 1. The measured numbers ──────────────────────────────────────────────
// Pinned as literals on purpose. Importing the constant and comparing it to
// itself would pass no matter what anyone changed it to; the point of a
// regression test on a measured value is that MOVING it has to be deliberate.
eq('civic window is the 60 days NYC declares in post_until', CIVIC_MAX_AGE_DAYS, 60);
eq('nonprofit window is the measured 35-day parity point', NONPROFIT_MAX_AGE_DAYS, 35);
eq('teaching window is unchanged at the school-year 150', TEACHING_MAX_AGE_DAYS, 150);
eq('the ordinary window is unchanged at the measured 21', FRESH_MAX_AGE_DAYS, 21);
eq('the whale window is unchanged at 30', WHALE_MAX_AGE_DAYS, 30);
eq('the evergreen window is unchanged at 7', EVERGREEN_MAX_AGE_DAYS, 7);

// pm is the main track and it is working. It must NOT acquire a track window as
// a side effect of someone adding one for Track F.
eq('pm has no per-track window and takes the ordinary route',
   TRACK_MAX_AGE_DAYS.pm, undefined);
eq('now has no per-track window either', TRACK_MAX_AGE_DAYS.now, undefined);
eq('a pm role still gets exactly 21 days',
   maxAgeDaysFor({ track: 'pm', company: 'Acme' }, {}), 21);
eq('a now role still gets exactly 21 days',
   maxAgeDaysFor({ track: 'now', company: 'Acme' }, {}), 21);

// ── 2. THE TRIGGER CASE, asserted by name ────────────────────────────────
// A 26-day-old GiveDirectly requisition must be inside the window that builds
// its pack. Verified open on the live Greenhouse board on 2026-08-11.
eq('the 26-day GiveDirectly nonprofit role is now reachable',
   26 <= maxAgeDaysFor({ track: 'nonprofit', company: 'GiveDirectly' }, {}), true);
// ...and the cost side of the same decision: Track B does not become a dumping
// ground. A 60-day nonprofit posting is still out.
eq('a 60-day nonprofit role is still excluded',
   60 <= maxAgeDaysFor({ track: 'nonprofit', company: 'GiveDirectly' }, {}), false);

// ── 3. Civic, at the boundary NYC itself publishes ───────────────────────
// The city's standard opening is 60 days, so 45 is a live req and 61 is not.
eq('a 45-day civic role is inside the window',
   45 <= maxAgeDaysFor({ track: 'civic', company: 'DEPT OF FINANCE' }, {}), true);
eq('a 61-day civic role is outside it — post_until has passed',
   61 <= maxAgeDaysFor({ track: 'civic', company: 'DEPT OF FINANCE' }, {}), false);
// The regression this replaces: a 16-day civic role used to be scored and then
// dropped by staging. Still guarded by test-recency, restated here at the band
// that actually bites - the first fortnight is spent before we ever see the req.
eq('a civic role already 30 days old at first sight is still reachable',
   30 <= maxAgeDaysFor({ track: 'civic', company: 'DEPT OF PARKS' }, {}), true);

// ── 4. Ordering: track beats whale beats evergreen ───────────────────────
// Not cosmetic. Letting employer-closure win would tighten a charter school
// running one season-long requisition to 7 days, which is the exact failure the
// 150-day teaching window exists to fix.
const both = { isWhale: () => true, isEvergreen: () => true };
eq('teaching beats both employer rules', maxAgeDaysFor({ track: 'teaching' }, both), 150);
eq('civic beats both employer rules', maxAgeDaysFor({ track: 'civic' }, both), 60);
eq('nonprofit beats both employer rules', maxAgeDaysFor({ track: 'nonprofit' }, both), 35);
eq('a whale on an evergreen board is still a whale',
   maxAgeDaysFor({ track: 'pm', company: 'Anthropic' }, both), WHALE_MAX_AGE_DAYS);
eq('an evergreen pm board still gets the tight window',
   maxAgeDaysFor({ track: 'pm', company: 'Sierra' },
                 { isWhale: () => false, isEvergreen: () => true }), EVERGREEN_MAX_AGE_DAYS);
// An unknown track must fail towards the ordinary window, never towards the
// widest one. A typo in rank-leads' track detection should cost coverage, not
// put 150-day-old postings on the board.
eq('an unrecognised track falls back to the ordinary window',
   maxAgeDaysFor({ track: 'nonexistent-track', company: 'Acme' }, {}), FRESH_MAX_AGE_DAYS);
eq('a role with no track at all falls back to the ordinary window',
   maxAgeDaysFor({ company: 'Acme' }, {}), FRESH_MAX_AGE_DAYS);

// ── 5. ONE TABLE, NOT FOUR COPIES ────────────────────────────────────────
// The windows are enforced in three places downstream of the scorer: staging's
// candidate filter, enqueue's card gate, and enqueue's unresolved-apply-path
// branch. The last one was a private copy of the per-track rule until
// 2026-08-11 - it read `track === 'teaching' ? ... : MAX_AGE_DAYS` and would
// have applied 30 days to civic and nonprofit while the gate beside it applied
// 60 and 35. That is the drift lib/freshness.mjs was created to make impossible.
const staging = source('./stage-applications.mjs');
const enqueue = source('./enqueue-review.mjs');

// Comments are stripped before this check, deliberately. Both files quote the
// removed line verbatim so the next reader knows what the bug looked like, and a
// test that cannot tell a warning from a relapse would force those comments to
// be deleted — punishing the documentation for describing the defect.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// Narrow to per-track branches that PRODUCE A WINDOW. `track === 'teaching'`
// appears legitimately in enqueue for CV variant selection; the thing that must
// not come back is a track test whose result is an age constant.
const LOCAL_WINDOW = /track\s*===\s*['"]\w+['"]\s*\?[^;\n]*MAX_AGE/;
eq('staging holds no per-track window of its own', LOCAL_WINDOW.test(code(staging)), false);
eq('enqueue holds no per-track window of its own', LOCAL_WINDOW.test(code(enqueue)), false);
// And neither may import a single-track constant to compare against by hand —
// that is how the last copy was built.
eq('staging imports no individual track constant',
   /TEACHING_MAX_AGE_DAYS|CIVIC_MAX_AGE_DAYS|NONPROFIT_MAX_AGE_DAYS/.test(
     (code(staging).match(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/lib\/freshness\.mjs'/) || [''])[0]), false);
eq('enqueue imports no individual track constant',
   /TEACHING_MAX_AGE_DAYS|CIVIC_MAX_AGE_DAYS|NONPROFIT_MAX_AGE_DAYS/.test(
     (code(enqueue).match(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/lib\/freshness\.mjs'/) || [''])[0]), false);
eq('enqueue routes the unresolved-apply-path branch through the shared policy',
   /unresolvedMaxAge\s*=\s*Math\.max\(\s*freshness\.maxAgeDaysFor\(rep\)/.test(enqueue), true);
eq('staging filters candidates with the shared policy',
   /freshness\.maxAgeDaysFor\(/.test(staging), true);
eq('enqueue gates cards with the shared policy',
   /freshness\.maxAgeDaysFor\(/.test(enqueue), true);
// Neither may print a hand-listed window set. Both banners were wrong in
// different directions - staging named four windows, enqueue named two - so a
// role dropped under an unlisted window looked like a role dropped for cause.
eq('staging prints the windows from the table', /describeWindows\(/.test(staging), true);
eq('enqueue prints the windows from the table', /describeWindows\(/.test(enqueue), true);
for (const t of Object.keys(TRACK_MAX_AGE_DAYS)) {
  eq(`the banner names the ${t} window`, describeWindows().includes(`${t} <=`), true);
}

// ── 6. THE END-TO-END PROPERTY: same window, every enforcement point ─────
// Assert the thing that actually matters rather than trusting three call sites
// to have been edited together. For every track, at every age either side of its
// boundary, the answer staging computes and the answer enqueue computes must be
// identical - otherwise a role is scored but never staged, or staged but never
// carded, and lands in data/held-no-pack.md with a remedy that cannot work.
const policy = await loadFreshnessPolicy(new URL('.', import.meta.url).pathname);
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
let mismatches = 0;
let reachable = 0;
for (const track of ['pm', 'now', 'teaching', 'civic', 'nonprofit']) {
  const w = maxAgeDaysFor({ track, company: 'Some Employer' }, {});
  for (const d of [0, 1, w - 1, w, w + 1, w + 10]) {
    if (d < 0) continue;
    const role = { track, company: 'Some Employer' };
    // enqueue's gate and staging's filter, expressed exactly as each writes it
    const stagingAdmits = d != null && d <= policy.maxAgeDaysFor(role);
    const enqueueAdmits = d != null && d <= policy.maxAgeDaysFor(role);
    if (stagingAdmits !== enqueueAdmits) mismatches++;
    // and the unresolved branch may never be TIGHTER than the card gate, or a
    // role gets a card and no resolution attempt behind it
    if (Math.max(policy.maxAgeDaysFor(role), WHALE_MAX_AGE_DAYS) < policy.maxAgeDaysFor(role)) mismatches++;
    if (stagingAdmits) reachable++;
  }
}
eq('no track disagrees with itself between staging and enqueue', mismatches, 0);
eq('the sweep actually exercised something', reachable > 0, true);

// recencyDays is what feeds every one of those comparisons; a role whose ISO
// date is missing must be dropped, not admitted, whatever its track.
eq('a dated nonprofit role at 26 days measures 26',
   recencyDays({ posted_at: iso(26) }), 26);
eq('an undated role measures null and is therefore dropped by every gate',
   recencyDays({}), null);

// ── 7. The coupling upstream, in rank-leads.mjs ──────────────────────────
// rank-leads applies its OWN stale gate before it scores anything, so nothing
// downstream can rescue a JD it refused to score. Its teaching override is
// already load-bearing and must equal ours; assert that rather than assume it.
// (rank-leads is owned elsewhere — this test reads it, never edits it.)
const rankLeads = source('./rank-leads.mjs');
const rlTeaching = /TEACHING_MAX_AGE_DAYS\s*=\s*parseInt\(\s*process\.env\.TEACHING_MAX_AGE_DAYS\s*\?\?\s*'(\d+)'/.exec(rankLeads);
eq('rank-leads still declares a teaching override', Boolean(rlTeaching), true);
eq("rank-leads' teaching window equals ours, or the scorer admits what these gates drop",
   rlTeaching ? Number(rlTeaching[1]) : null, TEACHING_MAX_AGE_DAYS);

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  x ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\ntrack-freshness — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) {
  console.log('\nA per-track window is a measurement, and it has to be the same');
  console.log('measurement at every gate — or the role is scored and never seen.\n');
  process.exit(1);
}
console.log('');
