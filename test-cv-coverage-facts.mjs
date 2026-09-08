#!/usr/bin/env node

/**
 * test-cv-coverage-facts.mjs — the scoring path and the backfill path write
 * the SAME cvCoverage* fields, in the same shape, from the same inputs.
 *
 * WHY THIS EXISTS. rank-leads.mjs (scoring time) and recompute-scores.mjs
 * (backfill, no LLM) each carried an inline copy of the block that turns a
 * cvCoverage() result into the five record fields. Two copies of one rule is
 * this repo's most-documented bug class — normalizeGeo, the cv-variant chooser
 * and hasCaveat's redFlags all drifted that way. rank-leads now exports ONE
 * function, cvCoverageFacts(jd, track); this file pins its shape, pins it
 * against what is persisted in data/lead-scores.json, and pins the fact that
 * coverage is NOT a scoring input.
 *
 * ⚠ Same rule as lib/cv-coverage.mjs: every case is about the DOCUMENT that
 * would be sent, never about what VP can do, and none of it predicts anything.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cvCoverageFacts, scoreFromFacts, hasCaveat } from './rank-leads.mjs';
import { cvCoverage, coverageGap } from './lib/cv-coverage.mjs';
import { cvVariantFor } from './lib/cv-variant.mjs';
import { parseJd } from './lib/jd-parse.mjs';
import { detectTrack } from './lib/track.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const T = [];
const eq = (label, got, want) => T.push([label, got, want]);
const FIELDS = ['cvCoverageRequired', 'cvCoverageMissing', 'cvCoverageRatio', 'cvCoverageEvidence', 'cvCoverageGap'];
const pick = (o) => JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, o[f] ?? null])));

// ── Shape: exactly the five fields, typed as the card and the UI expect.
const HARVEY = {
  title: 'Senior Product Manager, Command Center',
  company: 'Harvey',
  body: `**Company:** Harvey
Role Overview Harvey is building the definitive AI platform for legal.
What You Have - 5+ years of product management experience building B2B SaaS for enterprise.

- Deep familiarity with identity management (SSO, SCIM, RBAC), audit logging, and access controls.
`,
};
const facts = cvCoverageFacts(HARVEY, 'pm');
eq('exactly the five record fields, nothing else', Object.keys(facts).sort().join(','), [...FIELDS].sort().join(','));
eq('required is an array', Array.isArray(facts.cvCoverageRequired), true);
eq('missing is an array', Array.isArray(facts.cvCoverageMissing), true);
eq('ratio is a number or null', facts.cvCoverageRatio === null || typeof facts.cvCoverageRatio === 'number', true);
eq('evidence is a string', typeof facts.cvCoverageEvidence, 'string');
eq('gap is a boolean', typeof facts.cvCoverageGap, 'boolean');
eq('Harvey names SSO/SCIM/RBAC', ['SSO', 'SCIM', 'RBAC'].every((t) => facts.cvCoverageRequired.includes(t)), true);

// ── Parity with the recompute path's expression, written out longhand here
// exactly as recompute-scores.mjs builds it, so a change to either side that
// is not a change to both shows up as a failure.
const recomputeStyle = (jd, track) => {
  const body = `${jd.title || ''}\n${jd.body || ''}`;
  const cov = cvCoverage(body, cvVariantFor(body, track), { company: jd.company || '' });
  return {
    cvCoverageRequired: cov.required,
    cvCoverageMissing: cov.missing,
    cvCoverageRatio: cov.ratio,
    cvCoverageEvidence: cov.evidence,
    cvCoverageGap: coverageGap(cov),
  };
};
eq('scoring helper equals the recompute expression (Harvey, pm)', pick(facts), pick(recomputeStyle(HARVEY, 'pm')));
eq('scoring helper equals the recompute expression (teaching track)', pick(cvCoverageFacts(HARVEY, 'teaching')), pick(recomputeStyle(HARVEY, 'teaching')));

// ── Unmeasured is not a gap: a posting naming nothing yields ratio null and
// gap false, never 0 / true. The card must be able to tell "nothing to check"
// from "checked and empty".
const BLANK = { title: 'Product Manager', company: 'Acme', body: '**Company:** Acme\nWe build things.\nRequirements\n- 5+ years of product experience\n' };
const blank = cvCoverageFacts(BLANK, 'pm');
eq('nothing named → required is empty', blank.cvCoverageRequired.length, 0);
eq('nothing named → ratio is null, not 0', blank.cvCoverageRatio, null);
eq('nothing named → not a gap', blank.cvCoverageGap, false);

// ── Coverage is NOT a scoring input. scoreFromFacts must return the same tier
// whether or not the coverage fields are present or flagged; the only place it
// may touch a tier is hasCaveat's display-coherence cap (5 → 4, never lower).
const base = {
  geo: 'nyc-hybrid', archetype: 'senior-pm', functionArea: 'product', aiNative: true, compLow: 180000,
  compSource: 'posting', level: 'at', technicalScreenStated: false, skillBlocked: [], skillWarnings: [],
  credentialBlocked: false, credentialWarnings: '', redFlags: '', leadGen: false, track: 'pm',
};
const withGap = { ...base, cvCoverageRequired: ['SSO', 'SCIM'], cvCoverageMissing: ['SSO', 'SCIM'], cvCoverageRatio: 0, cvCoverageEvidence: 'x', cvCoverageGap: true };
const withFull = { ...base, cvCoverageRequired: ['SSO', 'SCIM'], cvCoverageMissing: [], cvCoverageRatio: 1, cvCoverageEvidence: 'x', cvCoverageGap: false };
eq('scoreFromFacts ignores a coverage gap', scoreFromFacts(withGap), scoreFromFacts(base));
eq('scoreFromFacts ignores full coverage', scoreFromFacts(withFull), scoreFromFacts(base));
eq('hasCaveat sees a gap (the existing 5→4 display cap)', hasCaveat(withGap), true);
eq('hasCaveat does not fire on full coverage alone', hasCaveat(withFull), hasCaveat(base));

// ── Against the persisted corpus: the helper must reproduce what is on disk
// for real records, using the recompute path's own track choice
// (detectTrack(jd)). A bounded sample - measured and unmeasured - so this
// stays fast and does not need the LLM.
const SCORES = path.join(ROOT, 'data', 'lead-scores.json');
if (existsSync(SCORES)) {
  const scores = JSON.parse(readFileSync(SCORES, 'utf8'));
  const withFacts = Object.entries(scores).filter(([, v]) => 'aiNative' in v && 'cvCoverageRequired' in v);
  const measured = withFacts.filter(([, v]) => typeof v.cvCoverageRatio === 'number').slice(0, 40);
  const unmeasured = withFacts.filter(([, v]) => v.cvCoverageRatio === null).slice(0, 20);
  let checked = 0, agree = 0, firstMismatch = '';
  for (const [k, v] of [...measured, ...unmeasured]) {
    const file = path.join(ROOT, 'jds', k);
    if (!existsSync(file)) continue;
    const jd = parseJd(readFileSync(file, 'utf8'), k);
    const got = pick(cvCoverageFacts(jd, detectTrack(jd)));
    const want = pick(v);
    checked++;
    if (got === want) agree++;
    else if (!firstMismatch) firstMismatch = `${k}\n     stored ${want.slice(0, 160)}\n     fresh  ${got.slice(0, 160)}`;
  }
  eq('a corpus sample was actually checked', checked > 0, true);
  eq(`persisted records agree with the scoring helper (${agree}/${checked})${firstMismatch ? '\n     first mismatch: ' + firstMismatch : ''}`, agree, checked);
}

// ── Source guard: both writers name all five fields. Cheap, and it is exactly
// the drift this file exists to catch - a field dropped from one side only.
const src = (f) => readFileSync(path.join(ROOT, f), 'utf8');
eq('recompute-scores.mjs writes all five fields', FIELDS.every((f) => src('recompute-scores.mjs').includes(`${f}:`)), true);
eq('rank-leads.mjs scores through cvCoverageFacts', /const cvFacts = cvCoverageFacts\(jd, track\)/.test(src('rank-leads.mjs')), true);

let pass = 0, fail = 0;
console.log('\ncv coverage facts — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nThe scoring path and the recompute path must write identical coverage fields.');
  process.exitCode = 1;
}
