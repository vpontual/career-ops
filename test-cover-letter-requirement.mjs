#!/usr/bin/env node
/**
 * test-cover-letter-requirement.mjs — the cover-letter decision has a spec.
 *
 * This gate decides whether VP is handed a written letter or a note saying none
 * is wanted, and BOTH failure directions are expensive:
 *   - claiming a requirement that was never observed puts a fabricated fact on a
 *     real application (a fix was rejected on 2026-08-11 for stamping
 *     "Form inspected: <today>" onto packs nothing had inspected);
 *   - shrugging "could not be determined" at a form we already read is how 72 of
 *     104 pending cards ended up with no answer and no letter.
 *
 * Every case below is a real string from the 2026-08-11 queue.
 */
import {
  fromGreenhouseQuestions, parseAnswersMd, fromEnumeratedFields,
  requiredFromJdText, resolveCoverLetterRequirement,
} from './lib/cover-letter-requirement.mjs';
import { greenhouseRef } from './lib/branded-boards.mjs';

let passed = 0, failed = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log('\n1. Greenhouse board API questions');
eq(fromGreenhouseQuestions([{ label: 'Resume', required: true }, { label: 'Cover Letter', required: false }]),
  'optional', 'a cover-letter field that is not required is optional');
eq(fromGreenhouseQuestions([{ label: 'Cover Letter', required: true }]),
  'required', 'a required cover-letter field is required');
eq(fromGreenhouseQuestions([{ label: 'Resume', required: true }]),
  'absent', 'no cover-letter field at all is absent');
// Greenhouse names the field in `fields[].name` when the label is generic.
eq(fromGreenhouseQuestions([{ label: 'Attach', fields: [{ name: 'cover_letter' }], required: false }]),
  'optional', 'the field NAME cover_letter counts, not only the label');
eq(fromGreenhouseQuestions(undefined), 'absent', 'no questions array does not throw');

console.log('\n2. Reading back an enumerated form');
// ⚠ The load-bearing rule. A rendered read that never reached the attachments
// returns the same "no cover-letter field" as a form that has none, and they are
// not the same claim. 34 of the 2026-08-11 rendered reads were of a job
// DESCRIPTION page — 7 inputs, no uploads — and every one would otherwise have
// been reported as "absent" on VP's card.
eq(fromEnumeratedFields([{ label: 'First Name', required: true }, { label: 'Email', required: true }]),
  null, 'no resume field means the read never reached the attachments — refuse to answer');
eq(fromEnumeratedFields([{ label: 'Resume', required: true }, { label: 'Email', required: true }]),
  { value: 'absent', sawResume: true }, 'a resume upload and no cover-letter field IS evidence of absence');
eq(fromEnumeratedFields([{ label: 'Resume', required: true }, { label: 'Cover Letter', required: false }]),
  { value: 'optional', sawResume: true }, 'an unrequired cover-letter field is optional');
eq(fromEnumeratedFields([{ label: 'Cover Letter', required: true }]),
  { value: 'required', sawResume: true }, 'a required cover-letter field needs no resume corroboration');
eq(fromEnumeratedFields([{ label: 'Resume/CV', required: true }]),
  { value: 'absent', sawResume: true }, 'Lever labels it Resume/CV');
// Greenhouse renders BOTH uploads with the label "Attach" and generate-answers
// dedups rows by label, so one "Attach" row can mean one upload or two.
eq(fromEnumeratedFields([{ label: 'Attach', required: false }, { label: 'Email', required: true }]),
  null, 'a bare "Attach" label is too ambiguous to be attachment evidence');
eq(fromEnumeratedFields([]), null, 'an empty field list answers nothing');

console.log('\n3. Parsing answers.md written before form-fields.json existed');
const ANSWERS = `# Twilio — Sr. Principal Product Manager

**Apply:** https://job-boards.greenhouse.io/twilio/jobs/8108776
**ATS:** greenhouse · **Form inspected: 2026-08-11** — read via the Greenhouse board API.
**Fields:** 3 · answered 2 · N/A 0 · gaps 1 (0 required)

| Field | Required | Answer |
|---|---|---|
| First Name | **yes** | Vitor |
| Resume | no | _attached from the pack_ |
| Cover Letter | no | _attached from the pack_ |
`;
const parsed = parseAnswersMd(ANSWERS);
eq(parsed.how, 'the Greenhouse board API', 'carries HOW the form was read');
eq(parsed.inspectedOn, '2026-08-11', 'carries WHEN it was read — not today');
eq(parsed.fields.length, 3, 'reads exactly the field rows, not the separator or header');
eq(parsed.fields[0], { label: 'First Name', required: true }, '**yes** is required');
eq(fromEnumeratedFields(parsed.fields), { value: 'optional', sawResume: true }, 'and the whole path agrees');
eq(parseAnswersMd('# nothing here'), null, 'a file with no field table answers nothing');
eq(parseAnswersMd(`**Form inspected: 2026-08-09** — the application is behind an account wall, so the field list cannot be read without registering.`).loginWall,
  true, 'an account wall is recorded as a wall, not as an empty form');

console.log('\n4. The JD\'s own words — required only, never optional');
const REQ = [
  ['A resume and cover letter are required as part of the application.', 'NYC Consumer & Worker Protection'],
  ['Resume and cover letter are required for consideration.', 'NYC Campaign Finance Board'],
  ['A cover letter is required to be considered for this position.', 'NYC OMB'],
  ['Applications submitted without a cover letter will not be considered.', 'NYC OMB, second sentence'],
  ['In addition to the resume, a cover letter is required to apply.', 'Office of the Mayor'],
  ['PLEASE SUBMIT YOUR RESUME AND COVER LETTER SPECIFIC TO THIS ROLE', 'Office of Criminal Justice'],
  ['How to Apply: Please upload a copy of your resume, a cover letter, and three (3) references.', 'Commission on Racial Equity'],
];
for (const [s, who] of REQ) eq(!!requiredFromJdText(s), true, `required: ${who}`);

// ⚠ Every one of these is a real sentence that mentions a cover letter and does
// NOT impose one on VP. A looser rule matched all four and would have generated
// four letters on invented requirements.
const NOT_REQ = [
  ['Please indicate in your resume or cover letter that you would like to be considered for the position under the 55-a program.',
    'the 55-a opt-in line is not a requirement'],
  ['Current Employees please include your ERN and on your cover letter and resume.',
    'an instruction about the ERN, addressed to current employees'],
  ['Current SBS Employees: Please email your resume and cover letter including the following subject line.',
    'addressed to current employees of that agency, not to VP'],
  ['While completing the application, candidates are invited to provide a cover letter via "attachments".',
    'invited is the opposite of required'],
  ['A cover letter is optional but encouraged.', 'optional is optional'],
  ['We review every application carefully.', 'no mention at all'],
  ['If you wish, you may attach a cover letter.', 'conditional on wanting to'],
  // ⚠ The one real false positive found by scanning all 2057 JDs in the corpus.
  // Read as a requirement, this generates a letter for an employer who said in
  // writing not to send one.
  ['**Please submit a resume and answer the application questions in lieu of a cover letter.**',
    '"in lieu of a cover letter" is an instruction NOT to send one'],
  ['Please submit a resume; do not include a cover letter.', 'an explicit prohibition'],
];
for (const [s, why] of NOT_REQ) eq(requiredFromJdText(s), null, `not required: ${why}`);
eq(requiredFromJdText(null), null, 'no JD text does not throw');

// ⚠ THE QUOTE MUST CONTAIN THE CLAIM. NYC postings arrive as one unpunctuated
// bullet block; quoting "the sentence" quoted the DESIRED SKILLS list as the
// evidence for a requirement it never mentions.
const BLOCK = 'DESIRED SKILLS: Strong computer skills including proficiency in Microsoft Office software '
  + '(Word, Excel, Access, and PowerPoint) and the ability to learn new technology quickly, exceptional '
  + 'attention to detail, as well as superb organizational and research skills and excellent interpersonal '
  + 'skills, please submit a resume and cover letter for this position';
const q = requiredFromJdText(BLOCK);
eq(/cover letter/i.test(q.sentence), true, 'the quote from a long block contains the cover-letter claim');
eq(/DESIRED SKILLS/.test(q.sentence), false, 'and not the unrelated prose it was buried in');
eq(requiredFromJdText('• A cover letter is required. • Salary is competitive.').sentence,
  'A cover letter is required.', 'bullet glyphs split chunks too');

console.log('\n5. The ladder, end to end');
const noFetch = async () => { throw new Error('network must not be touched in this test'); };

// The employer stating it in prose beats a form field, and never the reverse:
// an ATS marks almost everything optional.
let r = await resolveCoverLetterRequirement({
  url: 'https://cityjobs.nyc.gov/job/785987', jdText: 'A cover letter is required to be considered for this position.',
  formEvidence: null, fetchFn: noFetch, greenhouseRef,
});
eq([r.value, r.source], ['required', 'jd-text'], 'a civic posting with no form resolves from its own words');
eq(/verbatim: "A cover letter is required/.test(r.evidence), true, 'and quotes the sentence it relied on');

// Greenhouse: staging's URL is unanswerable, the card's is not. This is the
// 2026-08-11 defect — 12 Greenhouse roles said "could not be determined".
let calls = [];
const fakeGh = async (u) => { calls.push(u); return { ok: true, json: async () => ({ questions: [{ label: 'Cover Letter', required: false }] }) }; };
r = await resolveCoverLetterRequirement({
  url: 'https://www.indeed.com/viewjob?jk=48d002dc4f508e97',
  cardUrl: 'https://job-boards.greenhouse.io/ocrolusinc/jobs/6135057004',
  jdText: 'We are hiring.', formEvidence: null, fetchFn: fakeGh, greenhouseRef,
});
eq([r.value, r.source], ['optional', 'greenhouse-api'], 'falls back to the card URL when staging holds the Indeed one');
eq(calls.length, 1, 'and asks once, not once per URL it holds');

// Enumerated form, no Greenhouse.
r = await resolveCoverLetterRequirement({
  url: 'https://jobs.ashbyhq.com/ramp/cdc3cb5a', jdText: 'We are hiring.',
  formEvidence: { loginWall: false, how: 'a rendered browser session', inspectedOn: '2026-08-10',
    fields: [{ label: 'Resume', required: true }, { label: 'Email', required: true }] },
  fetchFn: noFetch, greenhouseRef,
});
eq([r.value, r.source, r.observedOn], ['absent', 'enumerated-form', '2026-08-10'],
  'Ashby resolves from the form this pipeline already read, dated when it read it');

// The honest failures.
r = await resolveCoverLetterRequirement({
  url: 'https://cityjobs.nyc.gov/job/789458', jdText: 'We are hiring.',
  formEvidence: { loginWall: false, how: 'a rendered browser session', inspectedOn: '2026-08-10',
    fields: [{ label: 'Search jobs', required: false }] },
  fetchFn: noFetch, greenhouseRef,
});
eq(r.value, 'unknown', 'a read of the posting rather than the form resolves nothing');
eq(/not evidence that there is none/.test(r.evidence), true, 'and says exactly why');

r = await resolveCoverLetterRequirement({
  url: 'https://olasjobs.org/job-details/NRON0379934-6021', jdText: '',
  formEvidence: { loginWall: true, how: null, inspectedOn: '2026-08-10', fields: [] },
  fetchFn: noFetch, greenhouseRef,
});
eq([r.value, /account wall/.test(r.evidence)], ['unknown', true], 'an account wall is reported as an account wall');

r = await resolveCoverLetterRequirement({
  url: 'https://www.amazon.jobs/en/jobs/10489668/x', jdText: '', formEvidence: null,
  fetchFn: noFetch, greenhouseRef,
});
eq(r.value, 'unknown', 'a board with no readable field list stays unknown');
eq(/never|no form enumerated|no readable field list/.test(r.evidence), true, 'and does not blame "this ATS" generically');

// A Greenhouse API that errors must not become a fabricated answer.
r = await resolveCoverLetterRequirement({
  url: 'https://job-boards.greenhouse.io/twilio/jobs/8108776', jdText: '', formEvidence: null,
  fetchFn: async () => ({ ok: false, status: 404 }), greenhouseRef,
});
eq(r.value, 'unknown', 'a 404 from the board API is unknown, not absent');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
