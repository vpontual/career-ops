#!/usr/bin/env node

/**
 * test-answer-classifier.mjs — what a language model is allowed to be pointed at.
 *
 * WHY THIS EXISTS. generate-answers.mjs now writes a DRAFT for the open-ended
 * questions on an application, because leaving "Why Do You Want To Be A Product
 * Manager for Membership Growth and Development at ProPublica?" as
 * `⚠ NO DEFAULT — VP to answer` was leaving him the entire job. VP, 2026-08-11:
 * "why didnt any of the propublica questions get answered? they were listed but
 * not answered".
 *
 * The moment a model can write into that table, the classifier becomes the
 * safety boundary. This file is that boundary's specification. It is NOT a
 * description of lib/answer-classify.mjs — it is the list of things that must
 * never happen, harvested from what this pipeline has actually done:
 *
 *   - filled federal EEO self-identification rows with contradictory values
 *   - answered "current base salary (in reais)" with a USD target
 *   - printed "No, I do not have a disability" beside the checkbox
 *     "Yes, I have (or previously had) a disability" — on a live pack, found
 *     2026-08-11 in output/vendelux-product-manager/answers.md
 *   - rendered a required free-text essay as "_attached from the pack_" because
 *     the question contained the word "resumes"
 *
 * A model asked for a mailing address will produce a street address. A model
 * asked "have you ever worked at CoreWeave" will produce a Yes or a No. Neither
 * is knowable from cv.md, so neither is ever asked.
 *
 * Usage: node test-answer-classifier.mjs
 */

import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classify, isNoise, isOptionLabel, isAttachment, factualRule,
  FACTUAL, OPEN_ENDED, OPTION, NOISE, ATTACHMENT, CONDITIONAL, UNKNOWN,
} from './lib/answer-classify.mjs';
import {
  loadDefaults, decide, canonMatch, addressParts, composeAddress,
  mentionsForeignCountry, canRewrite,
} from './generate-answers.mjs';
import { parseDraftResponse, checkProvenance, namedEntities } from './lib/answer-draft.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);
const bucket = (q, field = {}) => classify(q, field).bucket;

// ── 1. THE DENY LIST. Nothing here may ever be drafted. ───────────────────
// Every one of these is a real field from the 114 pending packs.
const NEVER = [
  'Current Mailing Address',
  'Legal Address',
  'Zip Code/Postal Code',
  'What is your home zip code?',
  'Province/State',
  'In what cities are you available to work?',
  'What is your current base salary? (in reais)',
  'What are your salary expectations?',
  'Is the posted salary range aligned with your requirements?',
  'What is the minimum annual salary desired (in USD)?',
  'Available start date',
  'Notice period at current role',
  'What is your ethnicity?',
  'Which race do you self-identify with?',
  'What is your gender identity?',
  'Veteran status',
  'Disability status',
  'How do you identify your sexual orientation? Please select all that apply.',
  'It is important to us to create an accessible and inclusive interview experience. Please let us know if there are any adjustments we can make to assist you.',
  'Are you legally authorized to work in the United States?',
  'Will you now or in the future require sponsorship to be legally authorized to work in the United States?',
  'Please indicate whether you are a “U.S. person”. U.S. person is defined as a (i) U.S. citizen or national; (ii) U.S. lawful permanent resident.',
  'Please indicate whether you are either a citizen or resident of any of the following countries: Cuba, Iran, North Korea, Syria.',
  'References',
  'Have you ever been convicted of a felony?',
  'Do you currently hold or have previously held any securities industry licenses (ie - SEC, FINRA, NASAA, CFTC, NFA or other)?',
  'Have you previously worked at or consulted for GitLab?',
  'Are you a former CoreWeave employee?',
  'Are you now or have you ever been employed by CoreWeave?',
  'Are you currently or have you ever provided services to Fivetran as a consultant or independent contractor?',
  'Are you a parent of a current or former SA scholar?',
  'Do you know, or are you related to, anyone at GiveDirectly?',
  'Were you referred to Nava? If so, please provide their name below.',
  'I certify that the information provided in this application is true and correct to the best of my knowledge.',
  'By checking this box, I confirm I have read, reviewed and understood the guidelines outlined in the Candidate AI Responsible Use Policy.',
  'Are you currently bound by any agreements with a current or former employer that may restrict your ability to work for Scale AI?',
  'How many years of product management experience do you have?',
  'How many years of relevant experience do you have?',
  'Would you like to receive communications via SMS and/or WhatsApp to the number provided?',
  "Please share 1–2 writing samples of external-facing content you've created for a cybersecurity or technical B2B audience.",
  'Additional Information',
  "Is there anything else you'd like us to know?",
];
for (const q of NEVER) {
  // TWO assertions, and both matter.
  //
  // The deny list itself must recognise the question — not merely "the bucket
  // happens not to be open-ended today". UNKNOWN also stays blank, but it would
  // silently start being drafted the moment somebody widened a prose verb, and
  // that is exactly the regression this file exists to catch.
  eq(`NEVER DRAFT (deny list knows it): ${q.slice(0, 50)}`, factualRule(q) !== null, true);
  // And the classifier must not hand it to a model. A legal attestation resolves
  // to OPTION before FACTUAL (it is a checkbox), which is equally un-draftable —
  // so this half asserts the outcome, not the route.
  eq(`NEVER DRAFT (not draftable): ${q.slice(0, 50)}`,
    [OPEN_ENDED, UNKNOWN].includes(bucket(q, { type: 'textarea' })), false);
}
// …and the same questions must not become draftable just because the form marks
// them as a long free-text box or as required.
eq('a textarea does not override the deny list',
  bucket('Current Mailing Address', { type: 'textarea', required: true }), FACTUAL);
eq('EEO in a textarea is still denied',
  bucket('Please describe your disability status', { type: 'textarea' }), FACTUAL);
eq('salary phrased as an essay is still denied',
  bucket('Tell us about your compensation expectations for this role', { type: 'textarea' }), FACTUAL);
eq('prior employment phrased as an essay is still denied',
  bucket('Describe any previous work you have done for Instacart', { type: 'textarea' }), FACTUAL);

// ── 2. The essays. These are the whole point; they must NOT regress to blank. ─
const ESSAYS = [
  'Why Do You Want To Be A Product Manager for Membership Growth and Development at ProPublica?',
  'Why do you want to work at Flock? What excites you most about the company and this role?',
  'Why are you interested in Abnormal AI and this role specifically?',
  'Why are you interested in this job at Socure?',
  'Why do you want to join Figma?',
  'Why Higharc?',
  'Why PermitFlow in one sentence?',
  'What excites you about Deepgram?',
  'Describe a real piece of work where AI changed your process. What did you use it for?',
  'Describe a product launch you owned. What were the measurable business outcomes?',
  'Tell me about your experience working in adtech and with creative',
  "Please share why you're interested in this role?",
  'In 3-5 sentences please share with us Why Posh? What makes you a good fit for this role',
  'The role requires depth in Mortgage domain, Can you pls elaborate your experience in the domain?',
  'Can you share an example of how you have integrated an AI tool into your product development workflow?',
  'What is the most impressive thing you have personally built or automated with AI?',
  'What do we need to know about you and your hopes for this position that can’t be contained in projects and resumes?',
  'Project 1 Backstory:',
];
for (const q of ESSAYS) eq(`DRAFTABLE: ${q.slice(0, 62)}`, bucket(q, { type: 'textarea' }), OPEN_ENDED);

// ProPublica's application is three named projects with backstories, and
// "EXPERIENCE:" is the first project's TITLE field, not a section header.
eq('a project slot is open-ended', bucket('EXPERIENCE:', { type: 'input_text' }), OPEN_ENDED);
eq('a project slot asks for a line, not an essay', classify('Project 2', { type: 'input_text' }).form, 'short');
eq('a backstory asks for prose', classify('Project 2 Backstory:', { type: 'textarea' }).form, 'prose');

// ── 3. Option rows. Answering one tells VP to tick it. ────────────────────
// The disability row below was live on 2026-08-11 in
// output/vendelux-product-manager/answers.md, reading:
//   | Yes, I have (or previously had) a disability | no |
//     No, I do not have a disability and have not had one in the past |
// The checkbox says one thing and the instruction beside it says the opposite.
const OPTIONS = [
  'Yes, I have (or previously had) a disability',
  'No, I do not have a disability',
  'I am not a protected veteran',
  'I identify as one or more of the classifications of protected veteran listed above',
  'White (Not Hispanic or Latino)',
  'Hispanic or Latino',
  'Male', 'Female', 'Non-binary', 'Woman',
  'Transgender Female', 'Transgender Male',
  'Lesbian', 'Queer', 'Bisexual', 'Heterosexual / straight',
  'Asian or Asian American', 'Two or more races', 'Native Hawaiian or Other Pacific Islander',
  'Under 30', '17 or younger',
  'he/him', 'she/her',
  'Atlanta, GA', 'Boston, MA',
  'Prefer to not identify', 'Decline to self-identify', 'I do not wish to answer',
  'I consent', 'I agree',
  'Immediate family member', 'Neurodiverse', 'Refugee or immigrant',
  'French', 'Portuguese',
  'Yes — direct voice AI experience',
];
for (const q of OPTIONS) eq(`OPTION ROW: ${q.slice(0, 50)}`, bucket(q), OPTION);
eq('a question mark makes it a question, not an option',
  isOptionLabel('Male or female?'), false);

// ── 4. Noise, uploads and conditionals ────────────────────────────────────
for (const q of ['Targeting Cookies', 'Cookie list search', 'checkbox label', 'Switch Label',
  'Keyword', 'language dropdown menu', 'Type your response', 'cards[686da28a-3833-49b1-8d23-867e052d5359][field0]',
  'What can we help you find?', 'Copy the link and open WeChat to share.']) {
  eq(`NOISE: ${q.slice(0, 45)}`, isNoise(q), true);
}
eq('a bare lowercase name is not HARD noise (it may be a real field)', isNoise('email'), false);
eq('"Upload option" is an upload, by type', bucket('Upload option', { type: 'input_file' }), ATTACHMENT);
eq('Resume/CV is an upload', bucket('Resume/CV', { type: 'input_file' }), ATTACHMENT);
// The bug this replaced: /resume|cv\b|cover letter/ against the LABEL turned a
// required ProPublica essay into "_attached from the pack_".
eq('a question containing the word "resumes" is NOT an upload',
  isAttachment('What do we need to know about you that can’t be contained in projects and resumes?', 'textarea'), false);
eq('conditionals are conditionals',
  bucket('If you selected "Other," please provide additional details.'), CONDITIONAL);

// ── 5. decide(): the ORDER is the safety property ─────────────────────────
const defaults = await loadDefaults();
if (!defaults.length) {
  console.error('application-defaults.md not found or empty — cannot run. This test must run on the VM.');
  process.exit(2);
}
const kindOf = (label, drafts = {}, field = {}) => decide({ label, required: true, ...field }, defaults, drafts).kind;
const answerOf = (label) => decide({ label, required: true }, defaults, {}).text;

// A draft handed to decide() for a denied question must be ignored outright.
// This is the assertion that matters most: it means a mistake in the drafting
// half cannot leak into a factual field even if a draft somehow exists for it.
const POISON = { text: 'I currently earn $250,000 at Stripe.', form: 'prose' };
for (const q of ['What is your current base salary? (in reais)', 'Current Mailing Address',
  'Are you a former CoreWeave employee?', 'What is your ethnicity?']) {
  eq(`a stray draft cannot fill "${q.slice(0, 42)}"`, kindOf(q, { [q]: POISON }) === 'draft', false);
}
eq('a draft DOES fill an open-ended question',
  kindOf('Why do you want to join Figma?', { 'Why do you want to join Figma?': { text: 'Because.', form: 'prose' } }), 'draft');
eq('a REJECTED draft never reaches the table',
  kindOf('Why do you want to join Figma?',
    { 'Why do you want to join Figma?': { text: 'Because.', rejected: true, reason: 'unverified figure' } }), 'undrafted');
eq('an option row is never answered by bestMatch either',
  kindOf('Yes, I have (or previously had) a disability'), 'option');

// ── 6. The address, which is the fix VP actually asked for ────────────────
const parts = addressParts(defaults);
eq('street parsed', !!parts.street, true);
eq('city parsed', !!parts.city, true);
eq('state parsed', !!parts.state, true);
eq('zip parsed', !!parts.zip, true);
eq('country parsed', !!parts.country, true);
eq('composed address contains the street', composeAddress(parts).includes(parts.street), true);
eq('composed address contains the zip', composeAddress(parts).includes(parts.zip), true);

eq('Current Mailing Address is answered', kindOf('Current Mailing Address'), 'canon');
eq('Legal Address is answered', kindOf('Legal Address'), 'canon');
eq('a mailing address gets the composed form', answerOf('Current Mailing Address'), composeAddress(parts));
// ⚠ the coordinator's point: a broad address rule must not fire on a bare City.
eq('a bare City field gets the city ALONE', answerOf('City'), parts.city);
eq('a bare City field does not get the zip', answerOf('City').includes(parts.zip), false);
eq('Zip Code gets the zip alone', answerOf('Zip Code'), parts.zip);
eq('Postal/Zip Code gets the zip, not the state', answerOf('Postal/Zip Code'), parts.zip);
eq('Province/State gets the state', answerOf('Province/State'), parts.state);
eq('Country gets the country, not the dial code', answerOf('Country'), parts.country);
// The golden fixture pins this one too; it is here because the address rules sit
// next to it and a careless \bcountry\b would take it.
eq('Country Phone Code is still the DIAL code',
  answerOf('Please select your Country Phone Code').includes('+1'), true);
eq('Address Line 2 is left blank on purpose', /leave blank/i.test(answerOf('Address Line 2 (Optional)')), true);
eq('Address Line 2 does not repeat line 1', answerOf('Address Line 2 (Optional)').includes(parts.street), false);

// ── 7. Work authorisation is not transferable across borders ──────────────
eq('Canada is a foreign country', mentionsForeignCountry('Are you legally entitled to work in Canada?'), true);
eq('the United States is not', mentionsForeignCountry('Are you authorized to work in the United States?'), false);
eq('an unnamed country is not', mentionsForeignCountry('Are you authorised to work in the country where this job is based?'), false);
eq('a foreign work-auth question is a GAP, not a Yes',
  canonMatch('Are you legally entitled to work in Canada?', defaults), null);
eq('the British spelling is answered',
  canonMatch('Are you legally authorised to work full-time in the country where this job is based?', defaults)?.answer, 'Yes');
eq('"eligible to work" is answered',
  canonMatch('Are you currently eligible to work in the country in which this job is posted?', defaults)?.answer, 'Yes');

// ── 8. The office rules require an actual NYC token ───────────────────────
eq('an NYC hub question is a Yes',
  canonMatch('Are you open to working 3 days from one of our office hubs in NYC, NJ, CA, WA?', defaults)?.answer, 'Yes');
eq('an office question with NO NYC in it is NOT answered',
  canonMatch('Are you open to working 3 days from one of our office hubs in Austin and San Francisco?', defaults), null);
eq('living within N miles of an unnamed hub is not answerable',
  canonMatch("(Product & DS Hub) Do you live within 45 miles of one of Socure's talent hubs in the US?", defaults), null);
eq('"how did you hear about us? (… LinkedIn …)" is not his LinkedIn URL',
  /linkedin\.com/i.test(String(canonMatch('How did you hear about us? (Previous or Current Employee, LinkedIn, Conference, Job board, etc)', defaults)?.answer || '')), false);

// ── 9. The anti-fabrication checks on a draft ─────────────────────────────
const SOURCE = 'He led product at Reco through a $15M Series A and took the Amazon Dash Button to over 100 brands.';
eq('an organisation in the CV passes',
  checkProvenance('I led product at Reco and worked with Amazon.', SOURCE).ok, true);
eq('an organisation NOT in the CV is caught',
  checkProvenance('I ran payments at Stripe for three years.', SOURCE).ok, false);
eq('and it is named', checkProvenance('I ran payments at Stripe.', SOURCE).unknown.join(','), 'Stripe');
eq('the target company itself is allowed',
  checkProvenance('I want to work at ProPublica.', `${SOURCE}\nProPublica`).ok, true);
eq('namedEntities ignores a lowercase word', namedEntities('I built it with care.').size, 0);

eq('a fenced JSON reply parses',
  parseDraftResponse('```json\n{"answers":[{"n":1,"text":"hello"}]}\n```', [{ label: 'Q1', form: 'prose' }])[0].text, 'hello');
eq('a bare JSON reply parses',
  parseDraftResponse('{"answers":[{"n":1,"text":"hi"}]}', [{ label: 'Q1', form: 'prose' }])[0].text, 'hi');
eq('JSON wrapped in prose parses',
  parseDraftResponse('Sure!\n{"answers":[{"n":1,"text":"hi"}]}\nHope that helps.', [{ label: 'Q1', form: 'prose' }]).length, 1);
eq('garbage yields nothing rather than throwing',
  parseDraftResponse('I cannot help with that.', [{ label: 'Q1', form: 'prose' }]).length, 0);
eq('an answer numbered past the question list is dropped',
  parseDraftResponse('{"answers":[{"n":9,"text":"x"}]}', [{ label: 'Q1', form: 'prose' }]).length, 0);
eq('smart quotes are normalised out of a draft',
  parseDraftResponse('{"answers":[{"n":1,"text":"the “thing” — it"}]}', [{ label: 'Q1', form: 'prose' }])[0].text,
  'the "thing" - it');

// ── 10. Idempotency: never clobber a file VP edited ───────────────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'answers-guard-'));
  const body = 'body\n\n_Generated by generate-answers.mjs from application-defaults.md, cv.md and the JD._\n';
  const { createHash } = await import('crypto');
  const digest = (s) => createHash('sha256').update(s).digest('hex');

  eq('a pack with no answers.md may be written', (await canRewrite(dir)).ok, true);

  await writeFile(join(dir, 'answers.md'), body);
  eq('a machine-written file with no hash may be rewritten', (await canRewrite(dir)).ok, true);

  await writeFile(join(dir, 'answers-meta.json'), JSON.stringify({ sha256: digest(body) }));
  eq('an untouched file we hashed may be rewritten', (await canRewrite(dir)).ok, true);

  await writeFile(join(dir, 'answers.md'), body.replace('body', 'VP EDITED THIS'));
  eq('a file edited since we wrote it is LEFT ALONE', (await canRewrite(dir)).ok, false);
  eq('and it says why', /edited by hand/i.test((await canRewrite(dir)).why), true);

  await rm(join(dir, 'answers-meta.json'));
  await writeFile(join(dir, 'answers.md'), 'something VP typed himself\n');
  eq('a file with no generator footer is never overwritten', (await canRewrite(dir)).ok, false);
  await rm(dir, { recursive: true, force: true });
}

// ── report ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
console.log(`\nanswer classifier — the deny list, the drafts, and the address — ${T.length} cases\n`);
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nThis file is the specification for what a model may write into a live');
  console.log('employer form. Do not weaken a case to make it pass.\n');
  process.exitCode = 1;
}
