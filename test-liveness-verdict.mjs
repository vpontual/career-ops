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
import { classifyLiveness } from './liveness-core.mjs';

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
