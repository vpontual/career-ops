#!/usr/bin/env node

/**
 * test-recency.mjs — freshness must mean employer ACTIVITY, not shelf age.
 *
 * VP, 2026-08-06: "freshness should be at whatever means the role is actually
 * open and being considered, not just sitting there. we want roles that the
 * employer actually wants filled soon."
 *
 * Greenhouse publishes updated_at beside first_published, and fetch-jds has
 * always written both into the JD. lib/jd-parse.mjs never parsed updated_at, so
 * the best available signal of active hiring intent sat unread on disk while
 * every gate used posting age instead. 684 JDs carry it; 607 of them were
 * touched MORE RECENTLY than they were posted.
 */

import { parseJd } from './lib/jd-parse.mjs';
import { readFileSync } from 'fs';
import {
  recencyDays, maxAgeDaysFor,
  FRESH_MAX_AGE_DAYS, WHALE_MAX_AGE_DAYS, EVERGREEN_MAX_AGE_DAYS, TEACHING_MAX_AGE_DAYS,
} from './lib/freshness.mjs';

const T = [];
const eq = (l, got, want) => T.push([l, got, want]);

const jd = (extra) => parseJd([
  '# Senior Product Manager',
  '',
  '**URL:** https://job-boards.greenhouse.io/acme/jobs/1',
  '**Company:** Acme',
  '**Location:** New York, NY',
  ...extra,
  '',
  '---',
  '',
  'Own the roadmap.',
].join('\n'), 'acme-1.md');

// Both fields parse, independently.
const both = jd(['**Posted:** 2026-07-10 (27 days ago)', '**Updated:** 2026-08-04 (2 days ago)']);
eq('posted_days parses', both.posted_days, 27);
eq('updated_days parses', both.updated_days, 2);
eq('posted_at parses', both.posted_at, '2026-07-10');
eq('updated_at parses', both.updated_at, '2026-08-04');

// The Updated line must not be swallowed by the Posted matcher, and vice versa.
const onlyPosted = jd(['**Posted:** 2026-07-10 (27 days ago)']);
eq('updated is null when absent', onlyPosted.updated_days, null);
eq('posted still parses alone', onlyPosted.posted_days, 27);

const onlyUpdated = jd(['**Updated:** 2026-08-04 (2 days ago)']);
eq('updated parses alone', onlyUpdated.updated_days, 2);
eq('posted is null when absent', onlyUpdated.posted_days, null);

// A date with no "(N days ago)" still yields the date.
const bare = jd(['**Updated:** 2026-08-04']);
eq('bare updated date parses', bare.updated_at, '2026-08-04');

// ── the policy the parser feeds ──────────────────────────────────────────
// The most recent employer activity. A 27-day-old req edited yesterday is being
// worked; a 2-day-old repost nobody has touched since is not.
//
// These call the REAL lib/freshness.mjs. They used to call a two-line copy of it
// written inside this file, which is the same mistake the code was making — a
// test that re-implements the rule cannot catch the rule drifting.
const iso = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

eq('recency prefers the more recent activity',
   recencyDays({ posted_at: iso(27), updated_at: iso(2) }), 2);
eq('recency falls back to posted when updated is absent',
   recencyDays({ posted_at: iso(27) }), 27);
eq('recency falls back to updated when posted is absent',
   recencyDays({ updated_at: iso(5) }), 5);
eq('recency keeps posted when it is the fresher of the two',
   recencyDays({ posted_at: iso(1), updated_at: iso(30) }), 1);
eq('recency is null when the posting carries no date at all',
   recencyDays({}), null);

// The `(N days ago)` parenthetical is frozen at the moment fetch-jds wrote the
// file. Recompute from the ISO date or a role gets a day younger every day it
// sits on disk — 113 of 551 tier-4+ JDs were already adrift on 2026-08-10.
eq('recency recomputes from the ISO date, not the frozen parenthetical',
   recencyDays({ posted_at: iso(9), posted_days: 2 }), 9);
eq('recency falls back to the parenthetical when there is no ISO date',
   recencyDays({ posted_days: 4 }), 4);

// ── ONE WINDOW, OR THE PIPELINE BUILDS A TRAP ────────────────────────────
// enqueue-review mints the card; stage-applications builds the CV the card is
// not allowed to exist without. When their windows disagree, the band between
// them is a set of roles that qualify for a card forever and can never get one:
// they land in data/held-no-pack.md and age out unseen. It happened at 31-150
// days (teaching) and again at 15-21 days (nine tier-4/5 NYC civic roles,
// 2026-08-10). Assert the invariant instead of trusting two constants to match.
const source = (f) => readFileSync(new URL(f, import.meta.url), 'utf-8');
const staging = source('./stage-applications.mjs');
const enqueue = source('./enqueue-review.mjs');

eq('staging imports the shared freshness policy',
   /from '\.\/lib\/freshness\.mjs'/.test(staging), true);
eq('enqueue imports the shared freshness policy',
   /from '\.\/lib\/freshness\.mjs'/.test(enqueue), true);
eq('staging declares no window of its own',
   /^const\s+\w*MAX_AGE_DAYS\s*=/m.test(staging), false);
eq('staging computes age with recencyDays, not posted_at alone',
   /recencyDays\(/.test(staging), true);

// Every shape of role, asked of the one function both steps call.
const whales = { isWhale: (c) => /anthropic/i.test(String(c || '')),
                 isEvergreen: (c) => /sierra/i.test(String(c || '')) };
eq('teaching gets the school-year window',
   maxAgeDaysFor({ track: 'teaching', company: 'Success Academy' }, whales), TEACHING_MAX_AGE_DAYS);
eq('a whale gets the whale window',
   maxAgeDaysFor({ track: 'pm', company: 'Anthropic' }, whales), WHALE_MAX_AGE_DAYS);
eq('an evergreen board gets the tight window',
   maxAgeDaysFor({ track: 'pm', company: 'Sierra' }, whales), EVERGREEN_MAX_AGE_DAYS);
eq('everything else gets the measured 21-day window',
   maxAgeDaysFor({ track: 'pm', company: 'Acme' }, whales), FRESH_MAX_AGE_DAYS);
// A whale on an evergreen board is still a whale — order, not a set.
eq('whale beats evergreen when both match',
   maxAgeDaysFor({ track: 'pm', company: 'Anthropic' },
                 { isWhale: () => true, isEvergreen: () => true }), WHALE_MAX_AGE_DAYS);
// Track E is why this reopened: NYC publishes on its own cadence and a civic
// posting is routinely a fortnight old the first time fetch-civic sees it, so it
// is born inside any window narrower than the card gate's.
eq('a 16-day-old civic role is inside the window that builds its pack',
   16 <= maxAgeDaysFor({ track: 'civic', company: 'DEPARTMENT OF FINANCE' }, whales), true);

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  x ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nrecency — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) {
  console.log('\nShelf age is not hiring intent, and one window means one window.\n');
  process.exit(1);
}
console.log('');
