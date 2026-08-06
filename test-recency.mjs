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
// enqueue uses the most recent employer activity. A 27-day-old req edited
// yesterday is being worked; a 2-day-old repost nobody has touched since is not.
const recency = (p, u) => Math.min(p ?? Infinity, u ?? Infinity);
eq('recency prefers the more recent activity', recency(27, 2), 2);
eq('recency falls back to posted when updated is absent', recency(27, null), 27);
eq('recency falls back to updated when posted is absent', recency(null, 5), 5);
eq('recency keeps posted when it is the fresher of the two', recency(1, 30), 1);

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  x ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nrecency — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log('\nShelf age is not hiring intent.\n'); process.exit(1); }
console.log('');
