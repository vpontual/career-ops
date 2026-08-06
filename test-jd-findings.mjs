#!/usr/bin/env node

/**
 * test-jd-findings.mjs — diligence must contain findings, and the bar must be
 * one that real postings can clear.
 *
 * research.md existed to replace the Glassdoor gate with "diligence read from
 * the employer's own posting". It produced 74 files with THREE distinct bodies,
 * 73 saying only "INTERVIEW PROCESS — NOT STATED", and ready-check.py accepted
 * the file's existence as diligence — the exact rubber stamp the swap was made
 * to avoid.
 */

import { extractFindings, isSubstantive } from './lib/jd-findings.mjs';

const T = [];
const eq = (l, got, want) => T.push([l, got, want]);
const has = (body, key) => extractFindings(body).some((f) => f.key === key);

eq('finds a stated comp band',
  has('The base salary range for this role is $180,000 - $220,000 per year.', 'comp'), true);
eq('finds a k-suffixed band', has('Compensation: $150k to $190k.', 'comp'), true);
eq('finds a years-of-experience bar',
  has('You have 8+ years of product management experience.', 'yoe'), true);
eq('finds an in-office requirement',
  has('This is a hybrid role; we are in the office 3 days a week.', 'onsite'), true);
eq('finds a sponsorship refusal',
  has('We are unable to sponsor employment visas at this time.', 'sponsorship'), true);
eq('finds a clearance requirement',
  has('An active security clearance is required for this position.', 'clearance'), true);
eq('finds a travel requirement', has('Expect up to 25% travel.', 'travel'), true);
eq('finds a reporting line',
  has('This role reports to the VP of Product.', 'reports'), true);

// MISSION STANDING RULE: "check whether each company screens applications with
// AI". NYC Local Law 144 makes the notice mandatory, so it is free signal — and
// nothing in the pipeline collected it before.
eq('finds an AEDT / AI-screening notice',
  has('We use an automated employment decision tool as part of our hiring process.', 'aedt'), true);

// Verbatim, never paraphrase — a wrong extraction must be visible.
eq('quotes the source sentence',
  extractFindings('The base salary range is $180,000 - $220,000 per year.')[0].quote
    .includes('$180,000 - $220,000'), true);

// EEO boilerplate is not a finding.
eq('ignores EEO boilerplate',
  extractFindings('We are an equal employment opportunity employer and do not discriminate.').length, 0);

// THE BAR. A first draft required two findings and failed 27 of 29 live cards —
// not because the postings were bad but because the threshold was. Real
// postings state ONE of these things, usually comp.
eq('one real finding is enough', isSubstantive([{ key: 'comp' }], []), true);
eq('an interview-format hit alone is enough', isSubstantive([], [{ label: 'case study' }]), true);
eq('nothing at all is NOT diligence', isSubstantive([], []), false);

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  ❌ ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\njd-findings — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log('\nA diligence file with no findings is not diligence.\n'); process.exit(1); }
console.log('');
