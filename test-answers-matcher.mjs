#!/usr/bin/env node

/**
 * test-answers-matcher.mjs — golden fixture for the form-answer matcher.
 *
 * WHY THIS EXISTS. generate-answers.mjs writes answers.md, which VP transcribes
 * into live employer forms. It shipped with no test, and an audit on 2026-08-06
 * found it filling federal EEO self-identification rows with contradictory
 * values, answering "current base salary (in reais)" with a USD target, and
 * answering "Preferred Last Name" with a first name — while printing, at the
 * bottom of every file, "A question with no confident match is left explicitly
 * blank rather than guessed".
 *
 * Every case below is a REAL question harvested from output/*&#47;answers.md or from
 * a live ATS form, paired with what the answer must be. The file is expected to
 * FAIL when first added; it is the specification, not a description.
 *
 * NO PERSONAL DATA IS WRITTEN HERE. This repo is a public fork with a pre-commit
 * secret check. Expected values are expressed as references to a bullet in
 * application-defaults.md (resolved at runtime), or as predicates — never as
 * literals. That is also why the assertions read `sameAs: /legal last name/i`
 * rather than a name.
 *
 * Usage: node test-answers-matcher.mjs
 */

import { loadDefaults, canonMatch, bestMatch, applyStepUrl, looksLikeLoginWall } from './generate-answers.mjs';

// Mirror of renderAnswers()'s resolution order. If that order changes, change it
// here too — deliberately duplicated so the test pins the ORDER as well as the
// outcome.
function resolve(question, defaults) {
  const c = canonMatch(question, defaults);
  if (c) return { answer: String(c.answer ?? ''), via: `CANON(${c.from})` };
  const m = bestMatch(question, defaults);
  if (m) return { answer: String(m.d.value ?? ''), via: `bestMatch(${m.d.label} @${m.score.toFixed(2)})` };
  return null;                       // an honest gap
}

const valueOf = (defaults, re) => {
  const d = defaults.find((x) => re.test(x.label));
  return d ? String(d.value ?? '') : null;
};

/**
 * Assertion vocabulary:
 *   blank   — must be an explicit gap. A wrong answer here is worse than none.
 *   sameAs  — must equal the value of the application-defaults.md bullet matching
 *             this regex.
 *   equals  — must equal this literal (only ever non-personal: Yes / No / …).
 *   notSameAs — must NOT equal that bullet's value (catches first-name-for-surname).
 *   contains  — answer must contain the value of that bullet (for joined fields).
 *   notContains — answer must not contain this substring, case-insensitive.
 */
const CASES = [
  // ── Names. "Vitor Vitor" is the defect that started the audit. ─────────────
  { q: 'Legal First and Last Name',
    contains: [/legal first name/i, /legal last name/i],
    why: 'a combined name field needs BOTH halves; it returned the first name alone' },
  { q: 'Preferred Last Name',
    sameAs: /legal last name/i, notSameAs: /legal first name/i,
    why: '"Preferred name" is a token-subset of this question and scored a perfect 1.00' },
  { q: 'Preferred First Name',
    notSameAs: /legal last name/i,
    why: 'the mirror of the above — must not swap the other way' },

  // ── Numbers hijacked by a subset match. ───────────────────────────────────
  { q: 'How many years of experience do you have managing direct reports?',
    blank: true,
    why: '"Years of experience: 18" is a token subset; 18 is his total PM tenure, not report-management' },
  { q: 'How would you describe your experience working in a Deal Desk or Revenue Operations function?',
    blank: true,
    why: 'a free-text/multiple-choice question was answered with the integer 18' },
  { q: 'Do you have any experience with GitHub Actions?',
    blank: true, notContains: 'github.com',
    why: 'token overlap cannot tell "GitHub Actions experience" from "GitHub profile URL"' },

  // ── Comp. A fabricated salary history is the most damaging wrong answer. ──
  { q: 'What is your current base salary? (in reais)',
    blank: true, notContains: 'USD',
    why: 'salary history, in another currency, answered with his USD target' },
  { q: 'Salary history',
    blank: true, notContains: 'decline',
    why: 'VP\'s recorded rule is leave blank, never "decline to answer"' },
  { q: 'What are your salary expectations?',
    sameAs: /target base salary/i,
    why: 'expectations ARE answerable and must not regress to blank' },

  // ── Identity fields that must not be over-broadened. ──────────────────────
  { q: 'Please select your Country Phone Code',
    sameAs: /^country code/i, notSameAs: /^phone/i,
    why: 'answered with the full phone number on 5 files' },
  { q: 'What city and state do you reside in?',
    notContains: 'United States',
    why: 'returned street/zip/country for a city-and-state question' },

  // ── EEO. VP flagged this one "get this right". Race and ethnicity are two
  //     different questions and the code had them inverted. ─────────────────
  { q: 'What is your ethnicity?',
    equalsOneOf: ['Latino', 'Hispanic or Latino'],
    why: 'answered "White" — that is the RACE answer, not the ethnicity answer' },
  { q: 'Which race do you self-identify with?',
    equals: 'White',
    why: 'the race question is the one that takes White' },

  // ── Option labels are NOT questions. The Ashby group reader emits each radio
  //     option as its own field; answering them tells VP to tick every box. ──
  { q: 'White (Not Hispanic or Latino)', blank: true,
    why: 'an option label matched /hispanic|latino/ and was answered "Hispanic or Latino"' },
  { q: 'Black or African American (Not Hispanic or Latino)', blank: true,
    why: 'same — this instructed VP to check a race box that is not his' },
  { q: 'I identify as one or more of the classifications of protected veteran listed above',
    blank: true,
    why: 'answered "I am not a protected veteran" — ticking it asserts the opposite' },
  { q: 'Yes, I have a disability, or have had one in the past', blank: true,
    why: 'answered "No, I do not have a disability" — ticking it declares a disability' },
  { q: 'Decline to self-identify', blank: true,
    why: 'an opt-out option label must never be auto-answered' },

  // ── Conditionals. Not gaps VP owes work on. ──────────────────────────────
  { q: 'If you selected "Other," please provide additional details.',
    blank: true, conditional: true,
    why: 'follow-up to an option that was not selected; counted as a gap needing VP' },

  // ── Things that SHOULD be answerable and are not. ────────────────────────
  { q: 'Current or Most Recent Employer',
    answerable: true,
    why: 'the CANON regex requires "current employer" adjacent, so "or Most Recent" missed' },
  { q: 'University or School Attended',
    answerable: true,
    why: 'application-defaults.md has no education section at all; his degrees are in cv.md' },
  { q: 'Highest level of education completed',
    answerable: true,
    why: 'same missing section' },
  { q: 'Yes, I will require Harvey to sponsor my employment',
    equals: 'No',
    why: 'sponsorship regex wanted the noun "sponsorship"; this phrasing says "sponsor my employment"' },
  { q: 'Yes, I am based in this location and able to work from the office 3 days per week',
    equals: 'Yes',
    why: 'the in-office regex missed "from the office ... 3 days per week"' },
];

const defaults = await loadDefaults();
if (!defaults.length) {
  console.error('application-defaults.md not found or empty — cannot run. This test must run on the VM.');
  process.exit(2);
}

let pass = 0;
const failures = [];

for (const c of CASES) {
  const got = resolve(c.q, defaults);
  const answer = got ? got.answer : null;
  const via = got ? got.via : 'GAP';
  const problems = [];

  if (c.blank && answer !== null && answer !== '') {
    problems.push(`expected a GAP, got "${answer}"`);
  }
  if (c.answerable && (answer === null || answer === '')) {
    problems.push('expected an answer, got a GAP');
  }
  if (c.sameAs) {
    const want = valueOf(defaults, c.sameAs);
    if (want === null) problems.push(`no application-defaults.md bullet matches ${c.sameAs}`);
    else if (answer !== want) problems.push(`expected the ${c.sameAs} default, got "${answer}"`);
  }
  if (c.notSameAs) {
    const bad = valueOf(defaults, c.notSameAs);
    if (bad !== null && answer === bad) problems.push(`answered with the ${c.notSameAs} default`);
  }
  for (const re of c.contains || []) {
    const want = valueOf(defaults, re);
    if (want && !(answer || '').includes(want)) problems.push(`answer is missing the ${re} default`);
  }
  if (c.notContains && (answer || '').toLowerCase().includes(c.notContains.toLowerCase())) {
    problems.push(`answer contains "${c.notContains}"`);
  }
  if (c.equals && answer !== c.equals) {
    problems.push(`expected "${c.equals}", got ${answer === null ? 'a GAP' : `"${answer}"`}`);
  }
  if (c.equalsOneOf && !c.equalsOneOf.includes(answer)) {
    problems.push(`expected one of ${c.equalsOneOf.join(' / ')}, got ${answer === null ? 'a GAP' : `"${answer}"`}`);
  }

  if (problems.length) failures.push({ c, via, problems });
  else pass++;
}

console.log(`\nanswer-matcher golden fixture — ${CASES.length} cases\n`);
for (const { c, via, problems } of failures) {
  console.log(`❌ ${c.q}`);
  for (const p of problems) console.log(`     ${p}   [${via}]`);
  console.log(`     why: ${c.why}\n`);
}
console.log('='.repeat(64));
console.log(`${pass}/${CASES.length} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nThis fixture is the specification. Do not weaken a case to make it pass.\n');
  process.exit(1);
}
console.log('');

// ── Account-wall detection ────────────────────────────────────────────────
// WHY THIS EXISTS. On 2026-08-11 five Citi cards (Workday) failed the nightly
// ready gate because the job page renders zero inputs - Workday only starts the
// application after an account step. The first fix INFERRED the wall from the
// hostname plus an empty read, and wrote an answers.md stating "Form inspected:
// <today>" - the exact token batch/ready-check.py accepts as proof the live form
// was opened. A review agent reproduced it firing with playwright entirely
// missing and against a hostname that does not resolve, i.e. it manufactured the
// gate's own evidence out of an absence. These tests pin the replacement: the
// wall must be OBSERVED (real fields on the board's account step), never
// inferred, so a dead page or a broken browser still fails loudly.

function checkAccountWall() {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${name}`); } };

  // applyStepUrl builds the board's documented account step from a job URL.
  t('workday job url -> apply step',
    applyStepUrl('https://citi.wd5.myworkdayjobs.com/en-US/2/job/New-York/Custody-PM_123')
      === 'https://citi.wd5.myworkdayjobs.com/en-US/2/job/New-York/Custody-PM_123/apply/applyManually');
  t('trailing slash collapses',
    applyStepUrl('https://x.myworkdayjobs.com/a/b/') === 'https://x.myworkdayjobs.com/a/b/apply/applyManually');
  t('query and hash dropped',
    applyStepUrl('https://x.myworkdayjobs.com/a?src=li#top') === 'https://x.myworkdayjobs.com/a/apply/applyManually');
  t('vanity domain fronting workday is not special-cased',
    applyStepUrl('https://careers.happydance.website/job/9') === 'https://careers.happydance.website/job/9/apply/applyManually');

  for (const bad of [null, undefined, '', 'not a url', '/relative/path', 'javascript:alert(1)', 'file:///etc/passwd']) {
    t(`rejects ${JSON.stringify(bad)}`, applyStepUrl(bad) === null);
  }

  // The wall is recognised ONLY from observed fields.
  t('observed create-account fields are a wall',
    looksLikeLoginWall([{ label: 'Email Address' }, { label: 'Password' }, { label: 'Verify New Password' }]) === true);
  t('empty read is NOT a wall (absence of evidence)', looksLikeLoginWall([]) === false);
  t('a real application form is not a wall',
    looksLikeLoginWall([{ label: 'Why do you want to work here?' }, { label: 'Resume' }]) === false);
  t('password alone is not a wall', looksLikeLoginWall([{ label: 'Password' }]) === false);

  console.log(`  ${pass} passed, ${fail} failed — account-wall detection`);
  return fail;
}

const wallFailures = checkAccountWall();
if (wallFailures) process.exitCode = 1;
