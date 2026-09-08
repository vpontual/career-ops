#!/usr/bin/env node

/**
 * test-liveness-verdict.mjs — "we could not reach it" is not "it is gone".
 *
 * checkUrl returned `expired` for ANY navigation exception: a timeout, a DNS
 * blip, a Cloudflare challenge, a reset connection. That is the most expensive
 * error this pipeline can make — the role loses its application pack, and since
 * enqueue-review refuses to card a role with no CV, VP never sees it at all.
 *
 * Observed live during a full nightly run on 2026-08-06:
 *   "prune (expired): Datadog | Senior Product Manager - Fleet and Lifecycle
 *    Management — navigation error: page.goto: Timeout 15000ms exceeded"
 * a tier-5 NYC role that had become visible only that morning.
 *
 * prune-stale.mjs had compensated for it locally while stage-applications.mjs
 * had not, which is the same one-caller-fixed drift that produced the
 * branded-board and slug bugs.
 */

import { checkUrl } from './check-liveness.mjs';
import { classifyLiveness, classifyLivenessFromFetch, htmlToText } from './liveness-core.mjs';

const T = [];
const eq = (l, got, want) => T.push([l, got, want]);

// A page object whose goto() throws, exactly as Playwright does on timeout.
const throwingPage = (msg) => ({
  goto: async () => { throw new Error(msg); },
  content: async () => '',
  evaluate: async () => [],
  url: () => '',
});

const timeout = await checkUrl(throwingPage('page.goto: Timeout 15000ms exceeded\nCall log:...'), 'https://x.test/j/1');
eq('a navigation timeout is UNREACHABLE, not expired', timeout.result, 'unreachable');
eq('and it is definitely not expired', timeout.result === 'expired', false);
eq('the reason still names the cause', /navigation error/.test(timeout.reason), true);

const dns = await checkUrl(throwingPage('net::ERR_NAME_NOT_RESOLVED'), 'https://x.test/j/2');
eq('a DNS failure is unreachable', dns.result, 'unreachable');

const reset = await checkUrl(throwingPage('net::ERR_CONNECTION_RESET'), 'https://x.test/j/3');
eq('a reset connection is unreachable', reset.result, 'unreachable');

// A POSITIVE expiry must still be reported — the check has to keep working.
eq('a page that says the role is closed is still expired',
  classifyLiveness({
    status: 200,
    finalUrl: 'https://x.test/jobs/closed',
    bodyText: 'Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  }).result,
  'expired');

// And a live page is still active.
eq('a live posting is still active',
  classifyLiveness({
    status: 200,
    finalUrl: 'https://x.test/jobs/1',
    bodyText: 'Senior Product Manager\nOwn the roadmap, partner with engineering, ship.',
    applyControls: ['Apply for this Job'],
  }).result,
  'active');

// ── classifyLivenessFromFetch — the browser-free path used by the nightly ──
//
// The report runs on the host, where no chromium exists, so it classifies from
// a plain fetch. Two opposite errors are possible and both were live:
// calling a `?error=true` redirect OPEN (three weeks of nagging about two dead
// roles), and — if the thin-content rule were copied over — calling every SPA
// board dead, which would silently bury live requisitions.

eq('a Greenhouse error redirect is dead',
  classifyLivenessFromFetch({
    status: 200,
    finalUrl: 'https://job-boards.greenhouse.io/wikimedia?error=true',
    bodyText: 'Jobs at Wikimedia Foundation '.repeat(40),
  }).result,
  'expired');

eq('HTTP 404 is dead',
  classifyLivenessFromFetch({ status: 404, finalUrl: 'https://x/y', bodyText: '' }).result,
  'expired');

eq('a hard expiry phrase is dead',
  classifyLivenessFromFetch({
    status: 200, finalUrl: 'https://x/y',
    bodyText: 'This job is no longer available. ' + 'filler '.repeat(80),
  }).result,
  'expired');

// ⚠ The load-bearing case. An Ashby/Lever/Workday shell is a few hundred bytes
// of nothing for a perfectly open role. classifyLiveness calls that dead
// because a browser had already hydrated the page; from a raw fetch it means
// only that we cannot see.
eq('a thin SPA shell is UNCERTAIN, never dead',
  classifyLivenessFromFetch({
    status: 200,
    finalUrl: 'https://jobs.ashbyhq.com/acme/abc-123',
    bodyText: '<div id="root">',
  }).result,
  'uncertain');

eq('bot protection (403) is uncertain, not dead',
  classifyLivenessFromFetch({ status: 403, finalUrl: 'https://x/y', bodyText: 'Access denied' }).result,
  'uncertain');

eq('rate limiting (429) is uncertain, not dead',
  classifyLivenessFromFetch({ status: 429, finalUrl: 'https://x/y', bodyText: '' }).result,
  'uncertain');

eq('a served posting is active',
  classifyLivenessFromFetch({
    status: 200,
    finalUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8684348002',
    bodyText: 'Senior Product Manager, Growth at GitLab. '.repeat(30),
  }).result,
  'active');

eq('no arguments does not throw', classifyLivenessFromFetch().result, 'uncertain');

eq('htmlToText strips scripts and tags',
  htmlToText('<script>var a=1</script><p>Hello <b>world</b></p>'),
  'Hello world');

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  x ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nliveness-verdict — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log('\nArchiving a live role is far worse than leaving a dead one up.\n'); process.exit(1); }
console.log('');
