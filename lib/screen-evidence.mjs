/**
 * lib/screen-evidence.mjs — does the posting ACTUALLY say it runs a coding screen?
 *
 * The mission's interview-format rule has two halves and only the first was ever
 * implemented:
 *
 *   "Do not shortlist roles that will run a live-coding technical screen, unless
 *    the role explicitly allows building through AI. ... Check the interview
 *    process before shortlisting WHERE IT IS KNOWABLE; FLAG THE RISK WHERE IT IS
 *    NOT."
 *
 * `scoreFromFacts` gated on `f.technicalScreen`, a boolean the LLM returns. But
 * employers almost never publish interview format - 41 of 42 researched postings
 * came back NOT STATED - so the model was inferring a screen from technical
 * vocabulary in the body. It set the flag on 176 of 806 records (22%), and two
 * scrapes of the SAME requisition disagree about 20% of the time: the Datadog
 * Bits Agent Builder req scores 1 read from Datadog's own ATS and 5 read from
 * Indeed. An inferred flag was being treated as knowledge and hard-rejecting to
 * tier 1, which buried roles VP wanted - including a $240K Google GenAI GPM role
 * and three of the six roles in the mission's own PREPARED ledger.
 *
 * This module supplies the missing half. It reads the JD text and returns the
 * VERBATIM phrase that establishes a screen, or null. Policy then becomes:
 *
 *   stated   -> gate to 1. This is VP's rule and it is not being weakened.
 *   inferred -> flag the risk on the card. Do not bury the role.
 *
 * It is deliberately deterministic and LLM-free, so it can be replayed over the
 * whole stored corpus at zero cost and unit-tested, which the model's guess
 * could not be.
 */

// Unambiguous: naming one of these is the employer describing their own process.
// No context test needed - nobody writes "HackerRank" about anything else.
// NOTE on two removals. "Woven" and "Karat" are real technical-interview vendors
// and were in this list; both are ordinary English words and produced 11 hits on
// the corpus, ALL false. Grafana Labs: "experiences you're building are tightly
// woven into our overall Grafana Cloud suite". A vendor name only counts as
// evidence when it cannot be mistaken for prose - Karat therefore moved to the
// contextual list, where it must sit near interview language, and Woven is gone.
const STRONG = [
  /\b(hackerrank|codility|coderpad|codesignal|leetcode)\b/i,
  /\blive[- ]coding\b/i,
  /\bpair[- ]programming\b/i,
  /\bwhiteboard(?:ing)?\s+(?:coding|exercise|interview)/i,
  /\btake[- ]home\s+(?:assignment|exercise|project|test|challenge|assessment)/i,
];

// Ambiguous on their own - "coding challenge" appears in JDs for companies that
// BUILD coding challenges. Only counted when the surrounding text is talking
// about the hiring process.
const CONTEXTUAL = [
  /\bcoding\s+(?:test|exercise|challenge|assessment|round)/i,
  /\bprogramming\s+(?:test|exercise|challenge|assessment)/i,
  /\bsql\s+(?:test|exercise|assessment|challenge)/i,
  /\btechnical\s+(?:assessment|exercise|challenge|screen(?:ing)?)/i,
  /\bkarat\b/i,                  // vendor name that is also an ordinary word
];

// Formats worth REPORTING but which do not disqualify. The mission separates the
// two: "check for live coding, SQL exercises, take-homes, and case formats, and
// report the format alongside the role" versus "a role with a screen HE CANNOT
// PASS is not a candidate". VP is a product manager - a case study is his home
// ground, and system-design and architecture rounds are explicitly "fine and he
// holds them credibly". Gating on these would exclude roles on the strength of
// an interview he would walk.
const REPORTABLE = [
  /\bcase\s+study\b/i,
  /\bsystem[- ]design\s+(?:round|interview|exercise)/i,
  /\bproduct\s+sense\s+(?:round|interview)/i,
  /\bpresentation\s+(?:round|to the (?:team|panel))/i,
];

const PROCESS = /\b(interview|hiring process|recruit|screen|round|stage|onsite|on-site|panel|loop|assessment process|what to expect|our process)\b/i;

// The mission's stated exception. If the employer says AI tooling is allowed,
// the screen is not disqualifying and must not gate.
const AI_ALLOWED = [
  /\b(?:use|using|leverage|allowed to use|encouraged to use)\s+(?:of\s+)?ai\s+(?:tools?|assistants?|coding tools?)/i,
  /\bai[- ]assisted\s+(?:coding|development|interview)/i,
  /\b(?:copilot|cursor|claude|chatgpt)\b[^.]{0,60}\b(?:permitted|allowed|encouraged|welcome)/i,
];

const WINDOW = 240;   // chars either side of a contextual hit to look for process language

/**
 * @param {string} text  the JD body (title + body is fine)
 * @returns {{stated: boolean, phrase: string|null, aiAllowed: boolean, kind: string|null}}
 */
export function findScreenEvidence(text) {
  const s = String(text || '');
  const aiAllowed = AI_ALLOWED.some((re) => re.test(s));

  for (const re of STRONG) {
    const m = s.match(re);
    if (m) return { stated: true, phrase: m[0].trim(), aiAllowed, kind: 'strong' };
  }

  for (const re of CONTEXTUAL) {
    const m = s.match(re);
    if (!m) continue;
    const i = m.index ?? 0;
    const around = s.slice(Math.max(0, i - WINDOW), Math.min(s.length, i + m[0].length + WINDOW));
    if (PROCESS.test(around)) {
      return { stated: true, phrase: m[0].trim(), aiAllowed, kind: 'contextual' };
    }
  }

  return { stated: false, phrase: null, aiAllowed, kind: null };
}

/**
 * Interview formats the posting names that are worth telling VP about but are
 * NOT disqualifying. Returned separately so a card can carry "expect a case
 * study" without that costing the role a single point.
 * @returns {string[]} verbatim phrases, deduped
 */
export function findReportableFormats(text) {
  const s = String(text || '');
  const out = new Set();
  for (const re of REPORTABLE) {
    const m = s.match(re);
    if (!m) continue;
    const i = m.index ?? 0;
    const around = s.slice(Math.max(0, i - WINDOW), Math.min(s.length, i + m[0].length + WINDOW));
    if (PROCESS.test(around)) out.add(m[0].trim());
  }
  return [...out];
}

/**
 * The policy question, kept next to the evidence so the two cannot drift.
 * Returns 'gate' (VP's hard rule applies), 'flag' (unknowable - surface the risk),
 * or 'clear'.
 */
export function screenVerdict(text, modelSaidScreen) {
  const ev = findScreenEvidence(text);
  if (ev.stated && ev.aiAllowed) return { action: 'flag', reason: `states "${ev.phrase}" but allows AI tooling`, ...ev };
  if (ev.stated) return { action: 'gate', reason: `posting states "${ev.phrase}"`, ...ev };
  if (modelSaidScreen) return { action: 'flag', reason: 'model inferred a screen; the posting does not state one', ...ev };
  return { action: 'clear', reason: 'no screen stated', ...ev };
}
