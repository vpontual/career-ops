/**
 * lib/cover-letter-requirement.mjs — is a cover letter actually wanted?
 *
 * VP's standing rule (MISSION-nyc-job.md, 2026-07-29, restated 2026-08-06):
 * "If the cover letter is optional, do not submit one. Not a short one, not a
 * good one. None." So this answers ONE question — required, optional, absent,
 * or genuinely unknown — and only `required` ever costs a Gemini call.
 *
 * ⚠ WHY THIS EXISTS AS ITS OWN FILE (measured 2026-08-11, 104 pending cards)
 *
 * stage-applications.mjs could read exactly one ATS: Greenhouse. Everything else
 * returned 'unknown', and 'unknown' is written onto the card VP reads as
 * "could not be determined for this ATS". 72 of 104 pending cards said that.
 * The three things wrong with it:
 *
 *   1. 12 of those 72 were Greenhouse, and the board API answered them fine when
 *      asked. Staging asked with the WRONG URL. loadCandidates() dedups by
 *      canonKey across jds/*.md and can keep the Indeed variant of a role, so
 *      coverLetterRequirement() got `https://www.indeed.com/viewjob?jk=...` while
 *      the review card carried `job-boards.greenhouse.io/ocrolusinc/jobs/...`.
 *      Same requisition, one answerable URL and one not.
 *   2. generate-answers.mjs ALREADY enumerates the live form for every card —
 *      that is what answers.md is — and it knows whether a cover-letter field
 *      exists, because it renders a row for it. Nothing read it back. The
 *      enumerated form is DIRECT evidence; the ATS name is a guess about it.
 *   3. NYC's civic postings (cityjobs.nyc.gov) have no application form on the
 *      page at all, so no amount of form-reading will ever resolve them — and
 *      they are the ones that most often REQUIRE a letter, in prose, in the JD:
 *      "A cover letter is required to be considered for this position.
 *      Applications submitted without a cover letter will not be considered."
 *      Six pending cards said something like that and every one of them was
 *      staged with "could not be determined".
 *
 * ⚠ THE HONESTY RULE, which outranks coverage. Every value this returns carries
 * the evidence it came from and the date that evidence was OBSERVED — not the
 * date this ran. A previous attempt in this repo was rejected for stamping
 * "Form inspected: <today>" onto packs where nothing had been inspected. If
 * there is no evidence, the answer is 'unknown' and it says so. Never infer a
 * requirement from an ATS's reputation, and never let absence of a reading
 * become evidence of absence of a field.
 */

// ── 1. Greenhouse board API ───────────────────────────────────────────────
// Authoritative and free: ?questions=true returns every field with a `required`
// flag. Handled by the caller, which owns the fetch; this is the decision.
export function fromGreenhouseQuestions(questions) {
  const qs = Array.isArray(questions) ? questions : [];
  const cover = qs.find((q) =>
    /cover.?letter/i.test(q.label || '') ||
    (q.fields || []).some((f) => /cover_letter/i.test(f.name || '')));
  if (!cover) return 'absent';
  return cover.required === true ? 'required' : 'optional';
}

// ── 2. The pack's own enumerated form ─────────────────────────────────────
// generate-answers.mjs writes output/<slug>/form-fields.json (added 2026-08-11)
// and, for every pack staged before that, output/<slug>/answers.md. Both carry
// the same thing: the field list it actually read, and how.

const RESUME_FIELD = /\bresum[eé]\b|\bcurriculum vitae\b|(?:^|[^a-z])cv(?:[^a-z]|$)/i;
const COVER_FIELD = /cover.?letter/i;

/**
 * Parse the answers.md this repo writes. Deliberately narrow — it only reads a
 * format we generate ourselves, and returns null rather than guessing if the
 * shape is not the one renderAnswers() produces.
 */
export function parseAnswersMd(md) {
  if (!md || typeof md !== 'string') return null;
  const inspected = md.match(/\*\*Form inspected:\s*(\d{4}-\d{2}-\d{2})\*\*/);
  const how = md.match(/read via ([^.\n]+)/);
  const wall = /behind an account wall/i.test(md);
  if (wall) return { loginWall: true, inspectedOn: inspected ? inspected[1] : null, how: null, fields: [] };
  if (!how) return null;
  const fields = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 4) continue;
    const label = cells[1].trim();
    const req = cells[2].trim();
    if (!label || label === 'Field' || /^-+$/.test(label)) continue;
    if (!/^(?:\*\*yes\*\*|yes|no)$/i.test(req)) continue;   // not a field row
    fields.push({ label, required: /yes/i.test(req) });
  }
  if (!fields.length) return null;
  return { loginWall: false, inspectedOn: inspected ? inspected[1] : null, how: how[1].trim(), fields };
}

/**
 * Decide from an enumerated field list — or refuse to.
 *
 * ⚠ ABSENCE OF A COVER-LETTER FIELD IS ONLY EVIDENCE IF THE READ REACHED THE
 * ATTACHMENTS. A rendered read that never got to the upload section returns the
 * same "no cover-letter field" as a form that genuinely has none, and the two
 * are not the same claim. Measured on the 2026-08-11 queue: 34 of the rendered
 * reads found no résumé field either — those are reads of a job DESCRIPTION
 * page, not of an application form, and they resolve to unknown. The 17 Ashby
 * and Lever reads that DID enumerate a résumé upload are real observations, and
 * a live re-check of five of them confirmed it: `_systemfield_resume` present,
 * no cover-letter control, and the string "cover letter" absent from the whole
 * rendered page.
 *
 * ⚠ It also refuses when the résumé field's label is a bare "Attach". Greenhouse
 * renders both uploads with that same label text, and generate-answers dedups
 * rows by label — so one "Attach" row can mean one upload or two. Greenhouse is
 * answered by the board API above and never needs this path.
 */
export function fromEnumeratedFields(fields) {
  if (!Array.isArray(fields) || !fields.length) return null;
  const labels = fields.map((f) => String(f.label || ''));
  const cover = fields.find((f) => COVER_FIELD.test(String(f.label || '')));
  if (cover) return { value: cover.required ? 'required' : 'optional', sawResume: true };
  const resume = labels.find((l) => RESUME_FIELD.test(l) && !COVER_FIELD.test(l));
  if (!resume) return null;                       // the read never reached the attachments
  if (/^attach$/i.test(resume.trim())) return null; // ambiguous label, see above
  return { value: 'absent', sawResume: true };
}

// ── 3. The JD's own words ─────────────────────────────────────────────────
// Only ever produces 'required', never 'optional' and never 'absent': an
// employer not mentioning a cover letter is not the employer saying it does not
// want one. Every pattern must be a statement about THIS application, and the
// matched sentence is quoted verbatim into the pack so the claim is checkable.

const JD_REQUIRED = [
  // "A cover letter is required", "Resume and cover letter are required for consideration"
  /\bcover letter\b[^.\n]{0,60}\b(?:is|are)\s+required\b/i,
  // "...required to submit a cover letter"
  /\brequired\b[^.\n]{0,40}\b(?:submit|provide|upload|attach)\b[^.\n]{0,40}\bcover letter\b/i,
  // "Applications submitted without a cover letter will not be considered"
  /\bwithout a cover letter\b[^.\n]{0,60}\bnot be considered\b/i,
  // A direct instruction to send one. `include` is deliberately NOT a verb here:
  // "Current Employees please include your ERN on your cover letter and resume"
  // is an instruction about the ERN, not about sending a letter, and it matched.
  /\bplease\s+(?:submit|upload|attach|provide)\b[^.\n]{0,90}\bcover letter\b/i,
];

// Sentences that mention a cover letter but do not impose one on VP.
//
// ⚠ The first entry is the one that matters most. Measured over all 2057 JDs on
// 2026-08-11, the single false positive an earlier version produced was
// "Please submit a resume and answer the application questions IN LIEU OF a
// cover letter" — an employer explicitly saying not to send one, read as an
// instruction to send one. That is the worst possible direction for this gate to
// fail in, and it fired on a real posting in the corpus.
const JD_NOT_A_REQUIREMENT = [
  /\bin lieu of\b|\binstead of\b|\brather than\b|\bno cover letters?\b|\bdo not (?:send|submit|include)\b/i,
  /\bcurrent\s+(?:\w+\s+){0,3}employees?\b/i,   // "Current SBS Employees: please email..."
  /\b55-a\b/i,                                   // NYC's 55-a program opt-in line
  /\binvited to\b/i,                             // "candidates are invited to provide"
  /\bif you (?:wish|would like|choose|prefer)\b/i,
  /\boptional\b/i,
];

/**
 * @returns {{sentence: string}|null} the verbatim matched text, or null.
 *
 * ⚠ IT RETURNS THE MATCH, NOT THE CHUNK IT WAS FOUND IN. Civic postings arrive
 * as one unpunctuated bullet block hundreds of characters long, so quoting "the
 * sentence" quoted whatever the first 300 characters happened to be — on NYC
 * OMB that was the DESIRED SKILLS list, printed onto the pack as the evidence
 * for a cover-letter requirement it does not mention. The evidence VP reads must
 * be the text that actually triggered the decision, or it is not evidence.
 */
export function requiredFromJdText(text) {
  if (!text || typeof text !== 'string') return null;
  // Split on sentence enders, newlines and bullet glyphs. Bullets and ALL-CAPS
  // instruction blocks are common in civic postings and rarely end in a period.
  const chunks = text.split(/(?<=[.!?])\s+|\n+|\s+[•·▪]\s*/);
  for (const raw of chunks) {
    const s = raw.replace(/\s+/g, ' ').replace(/^[-•·▪*\s]+/, '').trim();
    if (!s || !/cover letter/i.test(s)) continue;
    if (JD_NOT_A_REQUIREMENT.some((r) => r.test(s))) continue;
    for (const r of JD_REQUIRED) {
      const m = r.exec(s);
      if (!m) continue;
      // Short chunk: quote it whole, it reads better. Long chunk: quote only the
      // span that matched, so the quote always contains the claim.
      return { sentence: (s.length <= 220 ? s : m[0]).slice(0, 300) };
    }
  }
  return null;
}

// ── The ladder ────────────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {string} o.url          the URL staging holds for this role
 * @param {string} [o.cardUrl]    the apply URL the review card holds, if different.
 *                                Tried as well as `url`, because loadCandidates()
 *                                can hand staging the Indeed variant of a role
 *                                whose card carries the real ATS link.
 * @param {string} [o.jdText]     the JD body
 * @param {object} [o.formEvidence] { fields, how, inspectedOn, loginWall } from the pack
 * @param {function} [o.fetchFn]  injectable for tests
 * @param {function} o.greenhouseRef
 * @returns {Promise<{value:string, source:string, evidence:string, observedOn:string|null}>}
 */
export async function resolveCoverLetterRequirement(o) {
  const { jdText, formEvidence, greenhouseRef } = o;
  const fetchFn = o.fetchFn || fetch;

  // 1. The employer stating it in prose outranks a form field, because an ATS
  //    marks almost everything optional and the sentence is the employer's own
  //    instruction. It can only ever ADD a requirement, never remove one.
  const jd = requiredFromJdText(jdText);
  if (jd) {
    return {
      value: 'required',
      source: 'jd-text',
      evidence: `the job description says, verbatim: "${jd.sentence}"`,
      observedOn: null,
    };
  }

  // 2. Greenhouse board API — try every URL we hold for this role, because they
  //    are not equally answerable (see the header).
  const urls = [o.url, o.cardUrl].filter(Boolean);
  const tried = [];
  for (const u of urls) {
    const ref = greenhouseRef(u);
    if (!ref) continue;
    tried.push(`${ref.board}/${ref.id}`);
    try {
      const res = await fetchFn(
        `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.id}?questions=true`,
        { headers: { 'User-Agent': 'career-ops/1.0' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();
      return {
        value: fromGreenhouseQuestions(data.questions),
        source: 'greenhouse-api',
        evidence: `the Greenhouse board API for ${ref.board}/${ref.id}, which lists every application `
          + `field with its own required flag`,
        observedOn: new Date().toISOString().slice(0, 10),
      };
    } catch { /* fall through to the next URL, then to the form */ }
  }

  // 3. The form this pipeline already enumerated for this pack.
  if (formEvidence && !formEvidence.loginWall) {
    const f = fromEnumeratedFields(formEvidence.fields);
    if (f) {
      const on = formEvidence.inspectedOn ? ` on ${formEvidence.inspectedOn}` : '';
      const how = formEvidence.how ? ` via ${formEvidence.how}` : '';
      const n = formEvidence.fields.length;
      return {
        value: f.value,
        source: 'enumerated-form',
        evidence: f.value === 'absent'
          ? `the application form as enumerated${how}${on} — ${n} fields including a resume upload, `
            + `and no cover-letter field among them`
          : `the application form as enumerated${how}${on} — ${n} fields, one of them a cover-letter `
            + `field marked ${f.value === 'required' ? 'required' : 'not required'}`,
        observedOn: formEvidence.inspectedOn || null,
      };
    }
  }

  // 4. Say so.
  let why;
  if (formEvidence?.loginWall) {
    why = 'the application is behind an account wall, so its field list cannot be read without registering';
  } else if (formEvidence && Array.isArray(formEvidence.fields) && formEvidence.fields.length) {
    why = `the ${formEvidence.fields.length} fields read${formEvidence.how ? ` via ${formEvidence.how}` : ''}`
      + ` do not include a resume upload, so this is a reading of the posting rather than of the `
      + `application form — the absence of a cover-letter field in it is not evidence that there is none`;
  } else if (tried.length) {
    why = `the Greenhouse board API did not answer for ${tried.join(', ')}, and no form has been enumerated for this pack yet`;
  } else {
    why = 'this board has no readable field list (no Greenhouse board API, and no form enumerated for this pack yet)';
  }
  return { value: 'unknown', source: 'none', evidence: why, observedOn: null };
}

// ── Pack I/O ──────────────────────────────────────────────────────────────
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

/**
 * What has this pipeline already observed about this pack's form?
 * form-fields.json first (written by generate-answers.mjs since 2026-08-11),
 * then answers.md, which every pack staged before that has instead.
 */
export async function loadPackFormEvidence(packDir) {
  try {
    const j = JSON.parse(await readFile(path.join(packDir, 'form-fields.json'), 'utf-8'));
    if (Array.isArray(j.fields) || j.loginWall) {
      return { fields: j.fields || [], how: j.how || null, inspectedOn: j.inspectedOn || null, loginWall: !!j.loginWall };
    }
  } catch {}
  try {
    return parseAnswersMd(await readFile(path.join(packDir, 'answers.md'), 'utf-8'));
  } catch {}
  return null;
}

/**
 * The finding, as data. Written next to the pack so enqueue-review can put the
 * real value on the card instead of the hardcoded 'unknown' it used to write,
 * and so a later run can tell "we determined this" from "we never asked".
 */
export const FINDING_FILE = 'cover-letter-requirement.json';

export async function readCoverLetterFinding(packDir) {
  try { return JSON.parse(await readFile(path.join(packDir, FINDING_FILE), 'utf-8')); }
  catch { return null; }
}

export async function writeCoverLetterFinding(packDir, finding) {
  await writeFile(path.join(packDir, FINDING_FILE),
    JSON.stringify({ ...finding, resolvedAt: new Date().toISOString() }, null, 2));
}

/**
 * The human-readable skip marker. Kept in one place because its wording is the
 * thing VP reads on the card, and the wording is the part that has been wrong:
 * it used to blame "this ATS" for every undetermined case, including a dozen
 * Greenhouse roles the board API answers in a single request.
 */
export function renderSkipMarkdown({ company, role, url, finding, existingLetter }) {
  const head = `# No cover letter for ${company}: ${role}\n\n**URL:** ${url}\n`;
  // A pack can hold a letter written before the rule was enforced in code. Say
  // so here rather than leaving a marker that contradicts the file beside it.
  const stale = existingLetter
    ? `\n> ⚠ **This pack still contains cover-letter.md/.pdf, written before this rule was `
      + `enforced in code.** It has not been deleted, but the requirement above says it should not `
      + `be sent.\n`
    : '';
  if (finding.value === 'unknown') {
    return head
      + `**Cover letter requirement:** could not be determined.\n`
      + `**Why:** ${finding.evidence}.\n\n`
      + `Not written. VP's standing rule is that an optional cover letter is not submitted at all, `
      + `and an undetermined requirement is not evidence that one is required. To resolve it: add the `
      + `employer's board to lib/branded-boards.mjs if it is Greenhouse behind a vanity domain, or let `
      + `generate-answers.mjs enumerate the form (it runs after staging, so a pack staged tonight `
      + `resolves tomorrow), or ask for one by hand.\n` + stale;
  }
  const observed = finding.observedOn ? ` (observed ${finding.observedOn})` : '';
  return head
    + `**Cover letter requirement:** ${finding.value}.\n`
    + `**Determined from:** ${finding.evidence}${observed}.\n\n`
    + `Not written, per the standing rule: if it is optional, do not submit one at all.\n` + stale;
}
