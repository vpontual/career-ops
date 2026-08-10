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

import {
  normalizeGeo, normalizeLevel, normalizeFunctionArea, normalizeArchetype,
  sanitizeCompLow, scoreFromFacts, PRODUCT_ROLE,
} from './rank-leads.mjs';
import { compBand } from './lib/comp-band.mjs';

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


// ── archetype ──────────────────────────────────────────────────────────
// The fourth field to learn the geo lesson: the posting says what the role IS,
// the model says what it thought. Seniority now comes from the title.
//
// REGRESSION: Spectrum's Head of Product Management – Intelligence Ventures —
// NYC, AI-native, $263,200–$393,800 stated — sat at tier 3 for 12 days and was
// never enqueued. The model answered the archetype 'Platform PM', which falls
// through to Senior PM and forfeits the Director/Head +1.
eq('arch: title outranks the model on seniority',
   normalizeArchetype('Platform PM', 'Head of Product Management – Intelligence Ventures'),
   'Director/Head of Product');
eq('arch: Director in the title',
   normalizeArchetype('Product Management', 'Director, Product Management'), 'Director/Head of Product');
eq('arch: VP in the title',
   normalizeArchetype('Product Manager', 'Product Manager, VP - Card Benefits Experience'),
   'Director/Head of Product');
eq('arch: founding from the title',
   normalizeArchetype('', 'Founding Product Manager'), 'Founding/Early PM');
// REGRESSION GUARD: /director/ unbounded matches 'directory'. Rippling's Sr PM,
// Provider Directory Products is an IC role and must not collect the +1.
eq('arch: Directory is not Director',
   normalizeArchetype('B2B SaaS PM', 'Sr Product Manager, Provider Directory Products'), 'Senior PM');
// Order still matters: a senior PMM title is a marketing role, not a head-of.
eq('arch: PMM still beats seniority',
   normalizeArchetype('Product Marketing', 'Sr Director, Product Marketing - Cookware'),
   'Product Marketing');
// Back-compat: entries whose JD is gone recompute from raw alone.
eq('arch: raw-only still works', normalizeArchetype('Platform PM'), 'Senior PM');
eq('arch: nothing at all is Other', normalizeArchetype('', ''), 'Other');

// ── compLow ─────────────────────────────────────────────────────────────
// A number the model invents is worse than no number: an unstated band is null
// and costs nothing, while compLow: 1 costs -1 AND caps the score at 3.
eq('comp: 1 is not a salary', sanitizeCompLow(1), null);
eq('comp: an hourly-looking 35.6 is not a salary', sanitizeCompLow(35.6), null);
eq('comp: 9999 is under the floor', sanitizeCompLow(9999), null);
eq('comp: a real band survives', sanitizeCompLow(263200), 263200);
eq('comp: a numeric string survives', sanitizeCompLow('180000'), 180000);
eq('comp: unstated stays null, never 0', sanitizeCompLow(null), null);
eq('comp: garbage stays null', sanitizeCompLow('competitive'), null);

// ── policy: a title cannot buy a tier ───────────────────────────
// VP, 2026-08-10: "i dont care if its senior, director, principla, co founding
// they all count, even regular pm counts because every company does titles
// differently. why would we block it based on the title?"
//
// This pair is the whole rule. SAME facts, DIFFERENT title, SAME score. If these
// two ever disagree, a title is buying a tier again.
const SPECTRUM = {
  aiNative: true, geo: 'nyc', level: 'above', functionArea: 'product',
  technicalScreenStated: false, track: 'pm', compLow: null,
};
eq('title: a plain Senior PM',
   scoreFromFacts({ ...SPECTRUM, archetype: 'Senior PM' }), 4);
eq('title: Director/Head scores THE SAME',
   scoreFromFacts({ ...SPECTRUM, archetype: 'Director/Head of Product' }), 4);
eq('title: Founding scores THE SAME',
   scoreFromFacts({ ...SPECTRUM, archetype: 'Founding/Early PM' }), 4);
eq('title: Other scores THE SAME',
   scoreFromFacts({ ...SPECTRUM, archetype: 'Other' }), 4);

// REGRESSION: "Associate Technical Product Manager" (Ancestry, aiNative,
// remote-us) was a hard 1 because normalizeLevel reads the word "Associate".
// A title word must never hard-reject. It costs a point; it does not delete.
eq('level: a junior-sounding title is a -1, not a rejection',
   scoreFromFacts({ ...SPECTRUM, level: 'below' }), 3);

// ── policy: comp never BLOCKS ─────────────────────────────────
// VP: "if i want 150k why would we block 250k? 1M? thats dumb and we shouldnt
// block below 15[0]k automatically either because the other aspects of it can
// help prop up the role."
eq('comp: a high band is never a penalty', scoreFromFacts({ ...SPECTRUM, compLow: 250000 }), 5);
eq('comp: an absurdly high band is still never a penalty',
   scoreFromFacts({ ...SPECTRUM, compLow: 1000000 }), 5);
// REGRESSION: this returned 3 under the `< 150000 -> Math.min(score, 3)` cap,
// which no other evidence could lift. That cap was the block VP rejected.
eq('comp: below floor is no longer capped', scoreFromFacts({ ...SPECTRUM, compLow: 130000 }), 4);
// ...but a real sub-floor band still costs a point, which other signals can outweigh.
eq('comp: well below floor still costs -1', scoreFromFacts({ ...SPECTRUM, compLow: 100000 }), 3);
eq('comp: silence still costs nothing', scoreFromFacts({ ...SPECTRUM, compLow: null }), 4);

// ── the pre-filter that runs BEFORE the model ──────────────────────
// A drop here is unrecoverable - scoreFromFacts never sees the posting.
const passesTitle = (t) => PRODUCT_ROLE.test(String(t).replace(/[_/|]+/g, ' '));
// REGRESSION: dropped by the 24-string whitelist, which had "Director, Product
// Management" but not a bare "Product Management". Agentic AI product work,
// discarded on word order.
eq('prefilter: bare "Product Management" in any phrasing',
   passesTitle('Senior Manager, Product Management: Agentic Software Delivery'), true);
eq('prefilter: Product Builder', passesTitle('Product Builder'), true);
// REGRESSION: '_' is a word character, so \bmanager\b failed on this real title.
eq('prefilter: underscores are separators',
   passesTitle('Product Manager_Product Studio'), true);
eq('prefilter: the ordinary cases still pass', passesTitle('Senior Product Manager'), true);
eq('prefilter: head of product', passesTitle('Head of Product'), true);
eq('prefilter: VP Product with no "of"', passesTitle('VP Product'), true);
eq('prefilter: Founding PM', passesTitle('Founding PM'), true);
// Still correctly excluded - these are not product roles whatever the word order.
eq('prefilter: a product ANALYST is not a PM', passesTitle('Product Analyst SR - Payments Performance'), false);
eq('prefilter: HR for the product org is not product',
   passesTitle('Senior People Business Partner, Product & Marketing'), false);
eq('prefilter: product ACCOUNTING is not product',
   passesTitle('Controllership Specialist - Global Product Accounting'), false);


// ── comp read from the POSTING, not the model ──────────────────────
// 116 of the 315 records marked "no comp stated" print a salary in the body.
// The model was asked and guessed; these cases are why it is now read in code.
const band = (t) => compBand(t).compLow;
// REGRESSION: Indeed escapes markdown, so the real Spectrum posting contains
// `\$263,200\.00`. Every earlier scan looked straight past it and the model
// returned 1 - below every floor, which used to cap the role to tier 3.
eq('comp: escaped markdown is still a salary',
   band('The base pay for this position generally is between \\$263,200\\.00 and \\$393,800\\.00.'), 263200);
eq('comp: a plain range takes the low end',
   band('Salary range: $168,000 - $231,000 per year'), 168000);
eq('comp: "between X and Y"',
   band('The expected base salary is between $150,000 and $190,000 annually.'), 150000);
eq('comp: k-notation', band('Base pay range: $180K - $220K USD'), 180000);
// A dollar sign near a number is not a salary. All four appear in real bodies.
eq('comp: funding rounds are not salaries',
   band('We recently raised $50,000,000 in Series B funding.'), null);
eq('comp: signing bonuses are not base pay',
   band('Compensation includes a $5,000 signing bonus.'), null);
eq('comp: hourly rates are not an annual base',
   band('Compensation: $85.00 per hour, paid weekly.'), null);
eq('comp: transaction volume is not pay',
   band('Our compensation platform serves $2,000,000 in payroll annually.'), null);
eq('comp: silence stays silent', band('We offer competitive compensation and benefits.'), null);
// A number with no pay language anywhere near it must not be picked up.
eq('comp: a bare number out of context is ignored',
   band('Our office is at 250,000 square feet. $175,000 users signed up.'), null);

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
