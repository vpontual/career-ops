#!/usr/bin/env node

/**
 * test-cv-coverage.mjs — the CV says it, or it does not.
 *
 * WHY THIS EXISTS. Harvey's "Senior Product Manager, Command Center" scored a
 * clean 5 and was rejected on 2026-08-13 at the resume screen, seven days after
 * applying, with no human contact. Its requirements name SSO, SCIM, RBAC, audit
 * logging and access controls; cv-ai-enterprise.md — the variant that was
 * actually rendered and sent — contains none of them. Nothing in the pipeline
 * looked, because skill-gate and credential-gate BLOCK on disqualifiers and
 * neither measures coverage of what the posting asked for.
 *
 * ⚠ EVERY CASE BELOW IS ABOUT THE DOCUMENT, NEVER ABOUT VP. "The CV does not
 * mention SCIM" is checkable and fixable. "VP does not know SCIM" is a
 * different claim that this module must never be read as making — see the
 * header of lib/cv-coverage.mjs, and skill-gate's note that cv.md lists one of
 * the skills he has and omits Kubernetes while he runs a k3s cluster.
 */
import { requiredTokens, cvCoverage, coverageGap, sections } from './lib/cv-coverage.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);
const has = (label, arr, tok) => T.push([label, arr.includes(tok), true]);
const hasNot = (label, arr, tok) => T.push([label, arr.includes(tok), false]);

const toks = (body, company = '') => requiredTokens(body, { company }).map(t => t.token);

// ── The regression that mattered: Ashby runs the heading into the first bullet.
// skill-gate.mjs guards its heading match with `line.trim().length <= 90`, which
// assumes a heading sits alone on its line. Harvey's is 145 characters:
//   "What You Have - 5+ years of product management experience, with ..."
// With that guard, this posting reports NO requirements section at all.
const HARVEY = `# Senior Product Manager, Command Center
**Company:** Harvey
Role Overview Harvey is building the definitive AI platform for legal.
What You Have - 5+ years of product management experience, with significant time spent building B2B SaaS products for large enterprise customers.

- Deep familiarity with enterprise admin, analytics, and governance domains such as usage reporting, identity management (SSO, SCIM, RBAC), audit logging, and access controls.
`;
const H = toks(HARVEY, 'Harvey');
has('an inline "What You Have" heading is still a requirements section', H, 'SCIM');
has('SSO is extracted', H, 'SSO');
has('RBAC is extracted', H, 'RBAC');
has('B2B is extracted', H, 'B2B');

// ⚠ THE SIGNAL LIVES IN THE TAIL. Across all 2,255 JDs, SQL appears in 97
// postings but SSO in 9, RBAC in 8 and SCIM in exactly 1. Any "common enough to
// matter" frequency floor deletes precisely what this module exists to catch.
eq('a token seen in ONE posting corpus-wide is still extracted', H.includes('SCIM'), true);

// ── Coverage against a CV, with the CV supplied so the test never depends on
// whatever cv-variants/ happens to hold today.
const CV_WITHOUT = 'Product leader. Shipped B2B SaaS. Ran GTM. Built RAG pipelines.';
const CV_WITH = CV_WITHOUT + ' Owned SSO, SCIM and RBAC provisioning for enterprise admin.';
const covOut = cvCoverage(HARVEY, 'ai-enterprise', { company: 'Harvey', cvText: CV_WITHOUT });
has('a term the CV omits is reported missing', covOut.missing, 'SCIM');
has('a term the CV states is reported covered', covOut.covered, 'B2B');
eq('ratio is covered/required', covOut.ratio, covOut.covered.length / covOut.required.length);
const covIn = cvCoverage(HARVEY, 'ai-enterprise', { company: 'Harvey', cvText: CV_WITH });
eq('a CV naming everything has nothing missing', covIn.missing.length, 0);
eq('and rates 1', covIn.ratio, 1);

// Word-boundary, case-sensitive. "SSO" must not be satisfied by "ASSOCIATE",
// which is the kind of match that makes a coverage claim quietly false.
eq('SSO is not covered by the word ASSOCIATE',
  cvCoverage(HARVEY, 'x', { company: 'Harvey', cvText: 'ASSOCIATE PRODUCT MANAGER' }).covered.includes('SSO'), false);
eq('and not by lowercase sso in a url',
  cvCoverage(HARVEY, 'x', { company: 'Harvey', cvText: 'https://example.com/sso/login' }).covered.includes('SSO'), false);

// ── STOP_HEAD: the highest-leverage filter. sections() gives every line to the
// last heading it saw, so a benefits block printed after "Qualifications" was
// read as REQUIREMENTS. That is where PTO/HSA/ESPP came from, and — from one
// employer's recurring template — LEAVE, CAREER and GROWTH, each in 59 postings.
const WITH_BENEFITS = `Qualifications
- Strong SQL and experience with ETL pipelines.

Benefits
- Generous PTO, HSA and ESPP. Paid parental LEAVE. CAREER GROWTH support.
`;
const B = toks(WITH_BENEFITS);
has('a real requirement before the benefits block survives', B, 'ETL');
hasNot('PTO is not a requirement', B, 'PTO');
hasNot('ESPP is not a requirement', B, 'ESPP');
hasNot('CAREER is not a requirement', B, 'CAREER');
eq('the benefits block becomes its own non-required section',
  sections(WITH_BENEFITS).some(s => s.kind === 'stop'), true);

// ── ALL-CAPS lines are headings and banners, not requirement sentences.
const SHOUTY = `REQUIREMENTS
WHO YOU ARE AND WHAT WE WANT
- Experience with GraphQL and REST APIs.
`;
const S = toks(SHOUTY);
hasNot('a word from an ALL-CAPS banner is not an acronym', S, 'WHO');
hasNot('nor is ARE', S, 'ARE');

// ── Two-letter tokens were measured as almost entirely noise (SA alone in 36
// postings, with CS, EE, ME, OP, PR, AD, ID, MR), and the real ones (AI, ML,
// UX, QA) are too generic to tell VP anything.
const SHORT = `Requirements
- Work with the CS and SA teams on UX and AI, using SQL.
`;
const SH = toks(SHORT);
hasNot('two-letter tokens are not extracted', SH, 'SA');
hasNot('nor AI', SH, 'AI');
has('three-letter technical tokens still are', SH, 'SQL');

// ── The employer's own name is not a requirement.
const SELF = `Requirements
- Experience at a company like N26 building for N26 customers, plus SQL.
`;
hasNot('the employer name is dropped', toks(SELF, 'N26'), 'N26');
const INITIALS = `Requirements
- You will support TFD across CCT, and write SQL.
`;
hasNot('an initialism formed from the company name is dropped',
  toks(INITIALS, "The Farmer's Dog"), 'TFD');
hasNot('and one from a multiword name too',
  toks(`Requirements\n- Own WBD reporting and SQL.\n`, 'Warner Bros. Discovery'), 'WBD');

// ── Company values lists are English words in caps, not requirements.
// ⚠ The values words sit on their own line here, as they do in real postings.
// Cramming them into the same sentence as the real requirement pushes that line
// over the >50%-uppercase rule and the whole line is skipped — conservative and
// correct, but it would be testing the caps filter rather than the deny list.
const VALUES = `Requirements
- Our values are GRIT, TRUST, CANDOR and CARE.
- You have written a fair amount of SQL in a previous role.
`;
const V = toks(VALUES);
hasNot('a values word is not a requirement', V, 'GRIT');
hasNot('nor CANDOR', V, 'CANDOR');
has('the real requirement beside them survives', V, 'SQL');

// ── Denylisted categories.
const DENIED = `Requirements
- MBA preferred. Based in NYC. Must know SQL.
`;
const D = toks(DENIED);
hasNot('a degree is not a technical requirement', D, 'MBA');
hasNot('geography is not a technical requirement', D, 'NYC');

// ── A preferred section is not a requirement (skill-gate's rule, kept here).
const PREF = `Requirements
- Strong SQL.

Nice to have
- Familiarity with SCIM and RBAC.
`;
const P = toks(PREF);
has('the required skill is extracted', P, 'SQL');
hasNot('a nice-to-have is not a requirement', P, 'SCIM');

// ── ratio null means NOT MEASURED, never "zero coverage". 1,562 of 2,255 JDs
// have no detectable requirements section; treating those as 0 would flag most
// of the corpus on the strength of a parsing failure.
const NOSECTION = `# Product Manager\nWe are hiring. Come build with us.\n`;
eq('no requirements section gives ratio null', cvCoverage(NOSECTION, 'x', { cvText: '' }).ratio, null);
eq('and is never flagged as a gap', coverageGap(cvCoverage(NOSECTION, 'x', { cvText: '' })), false);

// ── The gap threshold. Both conditions must hold: enough misses to be a
// pattern, and a majority missed.
eq('null ratio is not a gap', coverageGap({ ratio: null, missing: ['A', 'B'] }), false);
eq('one miss is not a gap', coverageGap({ ratio: 0, missing: ['SCIM'] }), false);
eq('two misses at 0 coverage is a gap', coverageGap({ ratio: 0, missing: ['SCIM', 'SSO'] }), true);
eq('a minority missed is not a gap', coverageGap({ ratio: 0.75, missing: ['SCIM', 'SSO'] }), false);
eq('exactly half missed is a gap', coverageGap({ ratio: 0.5, missing: ['SCIM', 'SSO'] }), true);
eq('full coverage is never a gap', coverageGap({ ratio: 1, missing: [] }), false);

// ── The live case, end to end.
eq('Harvey Command Center is flagged against a CV that names none of it',
  coverageGap(cvCoverage(HARVEY, 'ai-enterprise', { company: 'Harvey', cvText: 'Product leader.' })), true);
eq('and is NOT flagged once the CV names them',
  coverageGap(cvCoverage(HARVEY, 'ai-enterprise', { company: 'Harvey', cvText: CV_WITH })), false);

let pass = 0, fail = 0;
console.log('\ncv coverage — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nA false "missing" prints a wrong warning on the card AND costs a tier.');
  process.exitCode = 1;
}
