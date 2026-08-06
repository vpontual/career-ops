#!/usr/bin/env node

/**
 * test-fact-check.mjs — the cover-letter fact checker must be worth reading.
 *
 * Measured 2026-08-06: it fired on 109 of 275 letters on disk and was wrong
 * essentially every time. 100 of those hits were the single string "100 brands"
 * — cv.md says "from 20 brands to over 100", which is the SAME FACT phrased
 * differently, and the checker compared literal "number + unit" strings. The
 * rest were the letter quoting the EMPLOYER'S numbers back at them.
 *
 * A gate that is wrong 40% of the time is one VP learns to skip, at which point
 * it stops catching the real thing. These cases pin both halves: it must stop
 * crying wolf, and it must still fail a genuine invention.
 */

import { checkFacts } from './verify-cv-facts.mjs';

const CV = `Scaled Amazon's Dash Button program from 20 brands to over 100 and lifted
order rates 5x in a year. Led product at Reco.AI from stealth through a $15M
Series A. 15 years in product.`;

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

// REGRESSION: 100 of 109 real warnings were this exact mismatch.
eq('same fact, different phrasing, is not invented',
  checkFacts('Scaled the program to over 100 brands.', CV, {}, {}).invented.length, 0);
eq('5x matches the CV', checkFacts('lifted order rates 5x', CV, {}, {}).invented.length, 0);
eq('$15M matches the CV', checkFacts('secured a $15M Series A', CV, {}, {}).invented.length, 0);

// REGRESSION: the k/M/B suffix must not eat the first letter of the unit word.
// "100 brands" parsed as "100 b" = 100 BILLION, so it never matched plain 100.
eq('unit word is not read as a magnitude suffix',
  checkFacts('over 100 brands', CV, {}, {}).invented.length, 0);
eq('a real magnitude suffix still parses',
  checkFacts('a $15M round', CV, {}, {}).invented.length, 0);

// The employer's own figures are quotations, not claims about VP.
const JD = 'We serve data from over 16,000 customers and 415,000+ merchants.';
eq('employer figure with no JD context is flagged',
  checkFacts('your 16,000 customers', CV, {}, {}).invented.length, 1);
eq('employer figure WITH JD context is not invented',
  checkFacts('your 16,000 customers', CV, {}, { jdText: JD }).invented.length, 0);
eq('employer figure is reported as quoted',
  checkFacts('your 16,000 customers', CV, {}, { jdText: JD }).quoted.length, 1);
eq('comma-grouped employer figure parses',
  checkFacts('their 415,000+ merchants', CV, {}, { jdText: JD }).invented.length, 0);

// It must STILL catch a genuine invention — that is the whole point.
eq('invented percentage still fails',
  checkFacts('I grew revenue 847%', CV, {}, { jdText: JD }).ok, false);
eq('invented headcount still fails',
  checkFacts('I managed 93,000 engineers', CV, {}, { jdText: JD }).ok, false);
eq('invented figure is listed',
  checkFacts('I grew revenue 847%', CV, {}, { jdText: JD }).invented.length, 1);

let pass = 0;
const fails = [];
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nfact-check — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log('\nA checker that cries wolf is a checker VP stops reading.\n'); process.exit(1); }
console.log('');
