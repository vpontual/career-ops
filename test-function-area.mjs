#!/usr/bin/env node
/**
 * test-function-area.mjs — the discipline label, and the two gates that hard-
 * score a role to 1 on the strength of it.
 *
 * `functionArea` is the only fact in this repo that can delete a role on its
 * own. scoreNow, scoreNonprofit and scoreCivic all read `CANNOT_DO.has(f.
 * functionArea)` and return 1, and Track A hard-rejects `marketing-demand`. So a
 * mislabel is not a rounding error - in one direction VP never sees a role he
 * could do, and in the other a tailored CV gets staged against a job he cannot.
 *
 * The bug this file was written for: the ACLU's "Associate Director, Web
 * Strategy" (NYC, $128,294, hybrid) scored 5 before the nonprofit discipline
 * gate and 1 after. The model had answered "marketing-demand" - and because
 * that is a legal enum value, normalizeFunctionArea returned it verbatim and no
 * title test ever ran. The model's label was unfalsifiable.
 *
 * The JD is not demand generation. Its requirements read "Demonstrated
 * experience in content strategy and digital project/product management" and
 * "6-8 years of professional marketing communications and/or UX, product
 * management, or digital project management experience"; the work is "lead
 * collaborative UX discovery processes", "draft requirements for new web
 * features, UX/IA improvements", manage a Digital Producer, and "Build and
 * maintain strategic relationships with external agencies, vendors, and
 * contractors". The paid/email/SMS teams are named as COLLABORATORS, not as
 * this role. It is the web channel's product owner sitting inside a comms
 * department.
 *
 * The rule that came out of it: the title outranks the model, exactly as it
 * already does for geo and archetype - and it outranks it ASYMMETRICALLY,
 * because the two kinds of error do not cost the same.
 */
import { normalizeFunctionArea } from './rank-leads.mjs';
import { scoreCivic, scoreNonprofit, scoreNow, CANNOT_DO } from './lib/track.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);
const fa = (raw, title) => normalizeFunctionArea(raw, title);

// ── 1. The ACLU case, in both directions ─────────────────────────────
// A `marketing-demand` answer must not survive a title that positively names a
// discipline VP practises.
eq('ACLU: "Associate Director, Web Strategy" is not demand generation',
   fa('marketing-demand', 'Associate Director, Web Strategy'), 'strategy');
eq('ACLU: ...and so it is not gated',
   CANNOT_DO.has(fa('marketing-demand', 'Associate Director, Web Strategy')), false);
// Anthropic's "Web Product Manager" is the same job with a PM title on it - own
// the web properties, run experiments, drive conversion. It was also a hard 1.
eq('Anthropic: "Web Product Manager" is a PM, whatever the model called it',
   fa('marketing-demand', 'Web Product Manager'), 'product');

// ── 2. ...and the roles that MUST stay gated ─────────────────────────
// Vera's "Director, Media Strategy & Campaigns": "Lead the drafting of talking
// points", "Oversee the development and distribution of ... press releases,
// pitches, memos", "Draft and place op-eds", and 10 years of press experience
// required. Writing-led press relations - VP: "i hate marketing writing".
// The title carries `Campaigns`, so the title agrees with the model.
eq('Vera: "Director, Media Strategy & Campaigns" stays out',
   fa('Communications', 'Director, Media Strategy & Campaigns'), 'marketing-demand');
// Nava's ISSO Program Manager - "lead Risk Management Framework (RMF)
// activities, maintain the system's Authorization to Operate (ATO)". The
// functionAreaRaw is free text that matches no enum; the title carries `ISSO`.
eq('Nava: "ISSO Program Manager" is security, not a program role',
   fa('Security/Compliance', 'ISSO Program Manager'), 'security');
// SILENCE IS NOT A RESCUE. This title names no discipline VP practises, so the
// model's answer stands. Any rule reading "no contrary signal" as permission
// un-gates a security-governance role.
eq('GitLab: "Customer Trust & Security Governance" is not rescued by silence',
   fa('security', 'Senior Manager, Customer Trust & Security Governance'), 'security');
// `partnerships` is deliberately NOT a rescue target: this is a BDR-management
// role and the partnerships pattern matches "business development".
eq('GitLab: "Manager, Business Development" stays sales',
   fa('sales', 'Manager, Business Development'), 'sales');
eq('GitLab: "High Velocity Enablement Lead" stays sales',
   fa('sales', 'High Velocity Enablement Lead'), 'sales');

// ── 3. Domain words must not steal a product title ───────────────────
// The already-fixed case, kept so it cannot regress.
eq('a PM who owns finance systems is a PM',
   fa('finance', 'Staff Product Manager, RevOps & Finance Systems'), 'product');
// TITLE_PRODUCT is checked BEFORE the decisive-noun list, or every PM for a
// developer product becomes an engineer.
eq('"Product Manager, Developer Experience" is a PM, not a developer',
   fa('engineering', 'Product Manager, Developer Experience'), 'product');
// ...but the phrase "head of product" appears inside titles that are not
// product management at all.
eq('"Head of Product Security" is security, not product (raw: security)',
   fa('security', 'Head of Product Security'), 'security');
eq('"Head of Product Security" is security, not product (raw: engineering)',
   fa('engineering', 'Head of Product Security'), 'security');
// Product marketing, rescued from the domain word rather than from the model.
// Stripe's "Product Marketing Lead, Billing" normalised to `finance` on the word
// Billing; Datadog's "- Observability Pipelines" normalised to `sales` on the
// word Pipelines. Neither is a finance or a sales role.
eq('"Product Marketing Lead, Billing" is not finance',
   fa('', 'Product Marketing Lead, Billing'), 'product');
eq('"...- Observability Pipelines" is not sales',
   fa('Product Marketing', 'Senior Product Marketing Manager - Observability Pipelines'), 'product');
// ...but a real demand-generation title still lands on marketing-demand.
eq('"Director of Growth Marketing (Partner Acquisition)" is demand gen',
   fa('', 'Director of Growth Marketing (Partner Acquisition)'), 'marketing-demand');
eq('"Paid Media Manager (B2B)" is demand gen',
   fa('Paid Media', 'Paid Media Manager (B2B)'), 'marketing-demand');
// ⚠ THIS HOLD WAS RELEASED, DELIBERATELY, on 2026-08-11 - the case below is the
// reversal of the one that used to sit here. It was held because whether PMM is
// in scope is a Track A policy question the nonprofit-gate fix should not decide
// silently. Decided separately, on evidence: VP maintains a dedicated cv-pmm.md
// variant, "Product Marketing" is one of the archetypes rank-leads asks the
// model to report, 12 PMM roles were pending in his review queue at the time,
// and rank-leads' own lead-gen comment records VP APPROVING Mercury's Senior PMM
// after it had been gated to 1. Seventeen roles moved, as predicted.
eq('a PMM title DOES overturn a marketing-demand answer',
   fa('marketing-demand', 'Product Marketing Manager'), 'product');

// ── 4. The same posting must get the same answer twice ───────────────
// DCWP's "Senior Data Scientist" is in the corpus twice, with the model
// answering "research" once and "Research & Analytics" once. One normalised to
// `research` and one to `engineering` - one gated, one not.
eq('"Senior Data Scientist" is engineering (raw: research)',
   fa('research', 'Senior Data Scientist'), 'engineering');
eq('"Senior Data Scientist" is engineering (raw: Research & Analytics)',
   fa('Research & Analytics', 'Senior Data Scientist'), 'engineering');
eq('"Appian Developer - Software & Data Management" is engineering',
   fa('Engineering', 'Appian Developer - Software & Data Management'), 'engineering');

// ── 5. The words nonprofits and the city use for product work ────────
// This repo already learned the lesson for titles (see NONPROFIT_OK). `program`
// and `operations` are what a foundation calls the work a tech company calls
// product, and NEITHER may ever be in CANNOT_DO or the whole track empties.
eq('program is never a gated discipline', CANNOT_DO.has('program'), false);
eq('operations is never a gated discipline', CANNOT_DO.has('operations'), false);
eq('strategy is never a gated discipline', CANNOT_DO.has('strategy'), false);
eq('"Senior Program Manager" is a program role', fa('undefined', 'Senior Program Manager'), 'program');
eq('"Chief of Staff, Emergency Cash" is not gated',
   CANNOT_DO.has(fa('Strategy & Operations', 'Chief of Staff, Emergency Cash (Senior Manager)')), false);
eq('"Initiative Director, Greater Justice New York" is not gated',
   CANNOT_DO.has(fa('', 'Initiative Director, Greater Justice New York')), false);
eq('"Lead Product Manager" at a nonprofit is product', fa('', 'Lead Product Manager'), 'product');

// ── 6. The gates themselves ──────────────────────────────────────────
const npBase = { geo: 'nyc', level: 'at', leadership: true, compLow: 128294 };
eq('nonprofit: the ACLU role now scores, it is not deleted',
   scoreNonprofit({ ...npBase, functionArea: 'strategy' }), 5);
eq('nonprofit: a finance discipline is still a hard 1',
   scoreNonprofit({ ...npBase, functionArea: 'finance' }), 1);
eq('nonprofit: "Senior Strategic Finance Manager" is why the gate exists',
   scoreNonprofit({ ...npBase, functionArea: fa('finance', 'Senior Strategic Finance Manager') }), 1);

// Track E had no discipline gate at all until 2026-08-11, and its title filter
// admits `data` and `analytics` by design - so the city's developer and data
// science postings were being carded at tier 4.
const cvBase = { geo: 'nyc', level: 'at', productScope: true, leadership: true };
eq('civic: an Appian Developer is not a role VP can do',
   scoreCivic({ ...cvBase, functionArea: fa('Engineering', 'Appian Developer - Software & Data Management') }), 1);
eq('civic: a Data Scientist is not a role VP can do',
   scoreCivic({ ...cvBase, functionArea: fa('Data Science', 'Program Data Scientist') }), 1);
eq('civic: a program role is untouched by the gate',
   scoreCivic({ ...cvBase, functionArea: 'program' }), 5);
// A civil-service exam is a PATH IN, not a barrier, and the discipline gate must
// not be read as touching it.
eq('civic: an exam pathway still scores as an advantage',
   scoreCivic({ ...cvBase, functionArea: 'product', examPathway: true }), 5);

// Track D's gate is unchanged - the same set, the same fact.
eq('now: the shared set still gates Track D',
   scoreNow({ geo: 'nyc', functionArea: 'sales', fastStart: true, seniorEnough: true }), 1);

// ── Product Marketing is in scope ────────────────────────────────────
// Decided 2026-08-11 on evidence, after the discipline audit deliberately held
// it as a separate Track A call: VP maintains a dedicated cv-pmm.md variant,
// "Product Marketing" is one of the archetypes rank-leads asks the model to
// report, 12 PMM roles were sitting in his review queue awaiting decision, and
// the lead-gen comment in rank-leads records VP APPROVING Mercury's Senior PMM
// after it had been gated to 1. Seventeen roles were blocked by a label every
// other signal contradicted.
eq('PMM title is rescued from a marketing-demand label',
   normalizeFunctionArea('marketing-demand', 'Senior Product Marketing Manager'), 'product');
eq('PMM rescue survives a domain word in the title',
   normalizeFunctionArea('marketing-demand', 'Product Marketing Lead, Billing'), 'product');
eq('technical PMM is rescued too',
   normalizeFunctionArea('marketing-demand', 'Technical Product Marketing Manager'), 'product');
// ...and the lead-gen trap stays shut, which is the whole reason the hold
// existed. Tested against the TITLE only: on that branch the raw IS the string
// "marketing-demand", so matching the haystack would match itself.
eq('a PMM title that names demand generation stays blocked',
   normalizeFunctionArea('marketing-demand', 'Product Marketing Manager, Demand Generation'), 'marketing-demand');
eq('growth marketing stays blocked',
   normalizeFunctionArea('marketing-demand', 'Growth Marketing Manager'), 'marketing-demand');
eq('demand generation director stays blocked',
   normalizeFunctionArea('marketing-demand', 'Director, Demand Generation'), 'marketing-demand');

let pass = 0; const fails = [];
for (const [l, g, w] of T) { if (JSON.stringify(g) === JSON.stringify(w)) pass++; else fails.push(`  ❌ ${l}\n     expected ${JSON.stringify(w)}, got ${JSON.stringify(g)}`); }
console.log(`\nfunction area — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) {
  console.log('\nThis label can delete a role on its own. A false block is silent —\n' +
              'VP never learns the role existed. Do not relax a case to make it pass.\n');
  process.exit(1);
}
console.log('');
