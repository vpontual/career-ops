#!/usr/bin/env node

/**
 * test-normalizers.mjs — the enum normalizers that decide what VP ever sees.
 *
 * The recurring defect in this scorer is not bad policy, it is policy comparing
 * against enum values the model never returns. geo and archetype were fixed that
 * way; level was missed and its gate never fired once in the system's life;
 * functionArea was fixed but ordered so that a domain word beat a job title.
 *
 * Every case below is a real string from data/lead-scores.json or a real title
 * from jds/. The ones marked REGRESSION cost VP a role he had approved.
 */

import { normalizeGeo, normalizeLevel, normalizeFunctionArea } from './rank-leads.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

// ── level ────────────────────────────────────────────────────────────────
// The model returned free text in 785 of 806 records and `below` never once
// appeared, so `if (f.level === 'below') return 1` had never fired.
eq('level: enum passes through', normalizeLevel('below'), 'below');
eq('level: Senior', normalizeLevel('Senior'), 'above');
eq('level: Staff', normalizeLevel('Staff'), 'above');
eq('level: Director', normalizeLevel('Director'), 'above');
eq('level: entry', normalizeLevel('entry'), 'below');
eq('level: Junior', normalizeLevel('Junior'), 'below');
eq('level: Associate', normalizeLevel('Associate'), 'below');
// REGRESSION GUARD: "Individual Contributor" appears 48 times. A Staff or
// Principal PM is an IC. Reading it as junior would hard-reject 48 senior roles.
eq('level: Individual Contributor is NOT junior', normalizeLevel('Individual C'), 'at');
eq('level: Individual Contributor (full)', normalizeLevel('Individual Contributor'), 'at');
// Seniority wins over a junior word, because a false 'below' hard-rejects while
// a false 'at' merely declines to reject.
eq('level: Senior Associate', normalizeLevel('Senior Associate'), 'above');
// "Mid" is 3-5+ years, outside the prompt's definition of below (new-grad,
// associate, 0-3 years). Gating it would invent a rule VP never set.
eq('level: Mid is not below', normalizeLevel('Mid'), 'at');
eq('level: empty defaults to at', normalizeLevel(''), 'at');

// ── geo ──────────────────────────────────────────────────────────────────
eq('geo: NYC', normalizeGeo('New York, NY'), 'nyc');
eq('geo: remote US', normalizeGeo('Remote (US)'), 'remote-us');
eq('geo: remote, no country named', normalizeGeo('Remote'), 'remote-us');
// REGRESSION: these returned 'remote-us' and were enqueued as workable. GitLab's
// Senior Deal Desk Analyst, Philippines went into the queue on 2026-08-05.
eq('geo: Remote France is not US', normalizeGeo('Remote, France'), 'onsite-elsewhere');
eq('geo: Remote Bangalore is not US', normalizeGeo('Remote, Bangalore'), 'onsite-elsewhere');
eq('geo: Brazil remote is not US', normalizeGeo('Brazil (Remote)'), 'onsite-elsewhere');
eq('geo: Remote Canada is not US', normalizeGeo('Remote, Canada'), 'onsite-elsewhere');
// A posting naming both keeps remote-us — he takes the US one.
eq('geo: multi-region incl US stays eligible', normalizeGeo('Remote, Canada; Remote, US'), 'remote-us');
eq('geo: onsite elsewhere', normalizeGeo('San Francisco, CA'), 'onsite-elsewhere');
eq('geo: hybrid NYC', normalizeGeo('New York, NY (hybrid, 3 days a week)'), 'hybrid-nyc');

// ── functionArea ─────────────────────────────────────────────────────────
// REGRESSION: matched /financ/ before /product manager/ and classified as
// `finance`, which Track D's CANNOT_DO hard-rejected to 1 — on a role VP had
// personally APPROVED.
eq('fa: domain PM is product, not the domain',
   normalizeFunctionArea('', 'Staff Product Manager, RevOps & Finance Systems'), 'product');
eq('fa: security PM is product', normalizeFunctionArea('', 'Product Manager, Security Platform'), 'product');
eq('fa: support PM is product', normalizeFunctionArea('', 'Principal Product Manager, Support Tooling'), 'product');
// REGRESSION: normalised to 'other', so the lead-gen gate — which already lists
// marketing-demand — never saw it, and it reached tier 5 with a review card.
eq('fa: paid media is demand gen', normalizeFunctionArea('Paid Media', 'Paid Media Manager (B2B)'), 'marketing-demand');
eq('fa: paid search is demand gen', normalizeFunctionArea('', 'Paid Search Manager'), 'marketing-demand');
// The lead-gen trap turns on WHAT THE PMM ROLE DOES, not on the words "product
// marketing". The mission keeps PMM as a live track and rejects only the
// demand-generation kind, so these two must land differently:
//
//   plain PMM      -> product          (not gated; Mercury's Senior PMM, Cards &
//                                       Spend is this, and VP approved it)
//   demand-gen PMM -> marketing-demand (gated; the trap the mission defines)
//
// My first draft of this file asserted that plain PMM should be
// marketing-demand. That was wrong and would have re-buried the one approved
// role this whole change set exists to stop burying.
eq('fa: plain PMM is not the trap', normalizeFunctionArea('', 'Senior Product Marketing Manager'), 'product');
eq('fa: demand-gen PMM IS the trap',
   normalizeFunctionArea('', 'Product Marketing Manager, Demand Generation'), 'marketing-demand');
eq('fa: sales enablement is the trap',
   normalizeFunctionArea('Sales Enablement', 'Enablement Content Manager'), 'sales');
eq('fa: real engineering role', normalizeFunctionArea('', 'Senior Software Engineer'), 'engineering');
eq('fa: enum passes through', normalizeFunctionArea('product', ''), 'product');

let pass = 0;
const fails = [];
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nnormalizers — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) {
  console.log('\nThese encode gates that decide what VP ever sees. Do not relax a case.\n');
  process.exit(1);
}
console.log('');
