#!/usr/bin/env node

/**
 * test-gmail-leads.mjs — the gmail step must not label a job with another job's
 * title, and must not write the same posting many times.
 *
 * Measured 2026-08-06 over 62 nights: 8,951 URLs produced 169 leads, 42 of those
 * nights produced zero, and 11 of the 12 rows then live in pipeline.md carried a
 * role that was not the job.
 */

import { roleFromUrl } from './fetch-gmail-leads.mjs';
import { canonicalizeUrl } from './lib/url-canonical.mjs';

const T = [];
const eq = (l, got, want) => T.push([l, got, want]);

// ── the title bug ────────────────────────────────────────────────────────
// A digest subject was stamped onto every URL in the message. All 12 live rows
// read "Jobot | Head of Product openings are available" while the URLs pointed
// at an Enterprise AE, a Fullstack AI Engineer and a Talent Acquisition Manager.
// jobot.com is in fetch-jds' UNSCRAPEABLE_HOSTS, so no JD ever corrected it.
eq('reads the role out of the URL path',
  roleFromUrl('https://jobot.com/apply/talent-acquisition-manager/8b057c4a06'),
  'Talent Acquisition Manager');
eq('handles a two-word role',
  roleFromUrl('https://jobot.com/apply/head-of-product/7dc0ac5e06'), 'Head Of Product');
// Boards whose JD IS scrapeable must return nothing, so fetch-jds supplies the
// real title rather than this guessing from a slug.
eq('numeric-id boards yield nothing',
  roleFromUrl('https://boards.greenhouse.io/acme/jobs/12345'), '');
eq('uuid paths yield nothing',
  roleFromUrl('https://jobs.lever.co/co/8f2c1a3e-1111-2222-3333-444455556666'), '');
eq('a hex blob is not a title', roleFromUrl('https://x.com/apply/8b057c4a06'), '');
eq('malformed input is safe', roleFromUrl('not a url'), '');

// ── the duplicate-rows bug ───────────────────────────────────────────────
// Every Jobot URL carries ?eid=<email>&uid=<recipient>, which change on every
// send, so 49 distinct postings were written as 168 rows.
const A = 'https://jobot.com/apply/head-of-product/7dc0ac5e06?eid=AAA&uid=BBB&jid=7dc0ac5e06';
const B = 'https://jobot.com/apply/head-of-product/7dc0ac5e06?eid=ZZZ&uid=YYY&jid=7dc0ac5e06';
eq('same posting from two emails canonicalises identically',
  canonicalizeUrl(A) === canonicalizeUrl(B), true);
eq('the job id survives canonicalisation',
  canonicalizeUrl(A).includes('7dc0ac5e06'), true);
// gh_jid is IDENTIFYING and must never be stripped — that regression collapsed a
// whole Stripe board to one URL once already.
eq('gh_jid is preserved',
  canonicalizeUrl('https://stripe.com/jobs/search?gh_jid=8064526&utm_source=x').includes('gh_jid=8064526'), true);
eq('utm params are still stripped',
  canonicalizeUrl('https://x.com/jobs/1?utm_source=news').includes('utm_source'), false);

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  ❌ ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\ngmail-leads — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log("\nA row labelled with another job title is worse than no row.\n"); process.exit(1); }
console.log('');
