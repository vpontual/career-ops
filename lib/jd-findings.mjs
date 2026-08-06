/**
 * lib/jd-findings.mjs — decision-changing facts that ARE in the posting.
 *
 * WHY. research.md existed to replace the Glassdoor gate with "diligence read
 * from the employer's own posting". What it actually produced was 74 files with
 * three distinct bodies, 73 of them saying "INTERVIEW PROCESS — NOT STATED",
 * and a byte-identical "Ask this at the recruiter screen" block. ready-check.py
 * accepted the file's mere existence as diligence, which is precisely the rubber
 * stamp the swap was meant to avoid.
 *
 * The interview-format scan is not the problem - "NOT STATED" is the honest
 * state of the world, since 0 of 1,593 postings on disk state a disqualifying
 * screen. The problem is that it was the ONLY thing in the file, so a document
 * that named the right company contained nothing about it.
 *
 * These extract what a posting genuinely does say and VP would otherwise have to
 * read the whole JD to find. Each returns a verbatim quote, never a paraphrase,
 * so a wrong extraction is visible rather than plausible.
 *
 * ⚠ AEDT is here because MISSION-nyc-job.md makes it a STANDING RULE - "check
 * whether each company screens applications with AI, and prepare accordingly" -
 * and nothing in the pipeline gathered it. NYC Local Law 144 requires employers
 * using an automated employment decision tool to post a notice, so its presence
 * on a NYC posting is a real, free, legally-mandated signal.
 */

const clip = (s, n = 240) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Each finding: { key, label, value, quote } */
const EXTRACTORS = [
  {
    key: 'comp',
    label: 'Stated compensation',
    // NYC and several states require a posted range, so this is usually present
    // and is the single most decision-relevant number in the document.
    re: /\$\s?\d{2,3}(?:,\d{3})?(?:\s?[kK])?\s*(?:-|–|—|to)\s*\$?\s?\d{2,3}(?:,\d{3})?(?:\s?[kK])?/,
  },
  {
    key: 'aedt',
    label: 'AI / automated screening notice',
    re: /\b(automated employment decision tool|\bAEDT\b|automated (?:decision|screening) (?:tool|system)|artificial intelligence (?:is|may be) used (?:to|in)|we use AI to (?:screen|review|evaluate))\b/i,
  },
  {
    key: 'yoe',
    label: 'Years of experience required',
    // The domain words between "years of" and "experience" are unbounded in
    // practice - "8+ years of PRODUCT MANAGEMENT experience" - so a fixed
    // adjective list missed the most common phrasing there is. Bounded to four
    // words so it cannot swallow a sentence.
    re: /\b(\d{1,2})\+?\s*(?:-|–|to)?\s*(?:\d{1,2})?\+?\s*years?(?:\s+of)?\s*(?:[\w-]+\s+){0,4}?(?:experience|exp\b)/i,
  },
  {
    key: 'onsite',
    label: 'In-office requirement',
    re: /\b(\d)\s*(?:\+)?\s*days?\s*(?:a|per)\s*week\b[^.]{0,60}|(?:hybrid|in[- ]office|on[- ]site)[^.]{0,60}\b\d\s*days?\b/i,
  },
  {
    key: 'sponsorship',
    label: 'Visa sponsorship stance',
    re: /\b(?:do(?:es)? not (?:offer|provide|sponsor)|unable to sponsor|no(?:t)? able to (?:offer )?sponsor|will not sponsor|sponsorship is not available)\b[^.]{0,80}/i,
  },
  {
    key: 'travel',
    label: 'Travel requirement',
    re: /\b(?:up to\s*)?\d{1,3}\s?%\s*(?:of the time\s*)?travel|travel\s*(?:up to\s*)?\d{1,3}\s?%|willing(?:ness)? to travel[^.]{0,60}/i,
  },
  {
    key: 'clearance',
    label: 'Clearance or licence required',
    re: /\b(security clearance|ts\/sci|public trust|active clearance|must be a us citizen|state (?:teaching )?certification|licensure required)\b[^.]{0,60}/i,
  },
  {
    key: 'reports',
    label: 'Reporting line / team',
    re: /\breport(?:s|ing)?\s+(?:directly\s+)?to\s+(?:the\s+)?[A-Z][^.]{0,70}|\blead(?:ing)?\s+a\s+team\s+of\s+\d+[^.]{0,40}/,
  },
  {
    key: 'deadline',
    label: 'Application deadline',
    re: /\bapplications? (?:close|must be (?:received|submitted))[^.]{0,60}|\bdeadline (?:to apply|for applications)[^.]{0,60}/i,
  },
];

// Sentences that merely contain the words. Shared with the interview scan.
const BOILERPLATE = /(reasonable accommodation|accommodations? (throughout|during)|equal (employment )?opportunity|does not discriminate|will never (ask|request)|recruiting (team|fraud)|social security number|e-verify)/i;

/**
 * @param {string} body  the JD text
 * @returns {Array<{key,label,value,quote}>} verbatim findings, deduped by key
 */
export function extractFindings(body) {
  const out = [];
  const seen = new Set();
  for (const s of sentences(body)) {
    if (BOILERPLATE.test(s)) continue;
    for (const e of EXTRACTORS) {
      if (seen.has(e.key)) continue;
      const m = e.re.exec(s);
      if (!m) continue;
      seen.add(e.key);
      out.push({ key: e.key, label: e.label, value: clip(m[0], 90), quote: clip(s) });
    }
  }
  return out;
}

/**
 * Is this document worth calling diligence? A file that found nothing about the
 * role is not diligence and must not satisfy a readiness gate by existing.
 *
 * ⚠ THE BAR IS ONE, NOT TWO, AND THAT WAS MEASURED. A first draft required two
 * findings, which failed 27 of 29 pending cards - and the cause was not bad
 * postings, it was a bad threshold. Across the live queue the distribution is
 * {0 findings: 11, 1: 16, 2: 1, 3: 1}: real postings state ONE of these things,
 * usually the comp band. GitLab's Senior CSM posting is 5,713 characters and
 * contains no dollar figure, no years bar, no office requirement and no
 * sponsorship line - one finding is the honest ceiling for it, not a failure to
 * read it properly.
 *
 * A gate that fails 27 of 29 is one VP disables, at which point it protects
 * nothing - the same failure as the fact checker that fired on 40% of letters.
 * So this flags the genuinely empty case: the posting told us NOTHING about
 * this specific role.
 */
export function isSubstantive(findings, interviewHits) {
  return (findings?.length ?? 0) + (interviewHits?.length ?? 0) >= 1;
}
