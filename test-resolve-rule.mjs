#!/usr/bin/env node
/**
 * test-resolve-rule.mjs — the acceptance rule for search-resolved apply paths.
 *
 * Every REJECT case below is a real wrong answer a permissive version of this
 * rule produced when it was measured over 51 rows of
 * data/unresolved-apply-paths.md on 2026-08-10. That version resolved 22 and
 * was WRONG 18 times — 18% precision. A wrong resolution is worse than a miss:
 * career-ops stages a tailored CV against whatever it resolves and VP reviews
 * the card as real.
 *
 * Every ACCEPT case is a real posting the board-API resolver structurally
 * cannot reach, because the slug is unguessable.
 */
import { accepts, registrable, DEAD } from './resolve-via-search.mjs';

const T = [];
const rej = (label, url, co, want, titles, org) =>
  T.push([label, accepts(url, co, want, titles, org).ok, false]);
const acc = (label, url, co, want, titles, org) =>
  T.push([label, accepts(url, co, want, titles, org).ok, true]);

// ── the wrong-COMPANY class ──────────────────────────────────────────
// ats.rippling.com is Rippling's ATS PRODUCT hosting its customers' boards.
// This req is MoneyHash's, an EMEA payments company. The host proves the
// vendor, never the employer. Identical in shape to greenhouse/robinhood,
// which cost this repo 8 wrong companies in a day.
rej('wrong company: MoneyHash on Rippling\'s ATS',
    'https://ats.rippling.com/moneyhash/jobs/36100f75', 'Rippling', 'Product Manager',
    ['Product Manager [Mid-Level & Senior] [Remote | EMEA]']);
// normalizeCompany strips whitespace from the whole page, so short names match
// incidental prose: "affinity" matched "...jobdescriptionaffinityisa...".
rej('wrong company: Indian aggregator matched on prose',
    'https://www.shine.com/jobs/senior-product-manager-crm/remote-click-jobs/19311409',
    'Affinity', 'Senior Product Manager, CRM', ['Senior Product Manager, CRM']);

// ── the wrong-REQUISITION class (substring matching) ─────────────────
// The exact "Senior Product Manager" req sits on the SAME Workable board.
rej('wrong req: a longer title is not the title',
    'https://apply.workable.com/lawnstarter/j/EBB6DC8BC9/', 'LawnStarter',
    'Senior Product Manager', ['Senior Product Manager, Service Delivery']);
// Lever carries "..., Enterprise" and "..., Payor". The board path compared
// exactly, matched neither and correctly REFUSED. Search must not overrule it.
rej('wrong req: two variants, search rank picked one',
    'https://jobs.lever.co/swordhealth/413d9563', 'SWORD Health',
    'Product Marketing Lead', ['Product Marketing Lead, Enterprise']);
// Verified against Gartner's own Workday API: no "Digital Product Manager"
// requisition exists. Wrong seniority AND a req that isn't there.
rej('wrong req: Sr is a different job',
    'https://jobs.gartner.com/jobs/job/112220-sr-digital-product-manager/', 'Gartner',
    'Digital Product Manager', ['Sr Digital Product Manager']);

// ── the not-a-form class ─────────────────────────────────────────────
// These rows are unresolved BECAUSE there is no employer form. Swapping an
// Indeed page for a Teal page resolves nothing. 14 of the 22 bad accepts were
// hosts like these, from 10 distinct domains in a 51-row sample - which is why
// the rule is an allowlist of the company's own identity, not a blocklist.
for (const [host, co] of [['www.tealhq.com', 'Affinity'], ['www.theladders.com', 'Humana'],
                          ['remotive.com', 'Flock Safety'], ['builtin.com', 'Vanta'],
                          ['www.dice.com', 'Intelex'], ['jobright.ai', 'Heidi']]) {
  rej(`not a form: ${host}`, `https://${host}/jobs/info/abc123`, co, 'Product Manager', ['Product Manager']);
}

// ── what SHOULD resolve ──────────────────────────────────────────────
// The employer's own careers domain - the shape all 4 correct answers had.
acc('own domain: Bank of America',
    'https://careers.bankofamerica.com/en-us/job-detail/26025202/treasury-product-manager',
    'Bank of America', 'Treasury Product Manager - AI Products & Transformation',
    ['Treasury Product Manager - AI Products & Transformation']);
// The two cases that justify search existing at all: the slug is unguessable,
// so the board-API resolver can never reach them however good its guesses get.
acc('unguessable slug: Affinity is "affinity.co" on Ashby',
    'https://jobs.ashbyhq.com/affinity.co/da291bc2-1713-4af9-813d-35d992981a89',
    'Affinity', 'Senior Product Manager, CRM', ['Senior Product Manager, CRM']);
acc('unguessable slug: First Due is "localitymediallcdbafirstdue"',
    'http://job-boards.greenhouse.io/localitymediallcdbafirstdue/jobs/4567',
    'First Due', 'Director, Product Management', ['Director, Product Management']);
// hiringOrganization can stand in when the slug does not name the company.
acc('json-ld hiringOrganization vouches for an opaque slug',
    'https://job-boards.greenhouse.io/xyz123/jobs/99', 'Vanta',
    'Staff Product Manager, Foundations', ['Staff Product Manager, Foundations'], 'Vanta');

// ── supporting pieces ────────────────────────────────────────────────
T.push(['registrable: strips www + tld', registrable('careers.bankofamerica.com'), 'bankofamerica']);
T.push(['registrable: two-level tld', registrable('jobs.example.co.uk'), 'example']);
// A closed req still ranks in search; one was accepted in the measured sample.
T.push(['dead: "This job has closed"', DEAD.test('<p>This job has closed</p>'), true]);
T.push(['dead: still-open page is not flagged', DEAD.test('<p>Apply now for this role</p>'), false]);

let pass = 0; const fails = [];
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nresolve acceptance rule — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) {
  console.log('\nEach REJECT case is a real wrong answer measured at 18% precision.\n' +
              'Relaxing one re-admits a wrong employer or a wrong requisition.\n');
  process.exit(1);
}
console.log('');
