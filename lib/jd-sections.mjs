/**
 * lib/jd-sections.mjs — where in a posting a sentence sits: required, preferred,
 * benefits/legal boilerplate, or unattributed.
 *
 * ONE COPY, because two consumers now depend on getting the same answer and
 * they had already drifted. lib/skill-gate.mjs decides block-vs-warn from the
 * section a skill appears in ("IF its a requirement, block it. if its in the
 * nice to haves section, show it with a warning" — VP, 2026-08-10), and
 * lib/cv-coverage.mjs harvests requirement tokens from the same spans. When
 * cv-coverage was written on 2026-08-13 it copied skill-gate's splitter and
 * immediately had to fix two defects in the copy; leaving both versions on disk
 * would have guaranteed they diverged again.
 *
 * TWO FIXES CAME WITH THE MERGE, and both change live behaviour:
 *
 * 1. NO LENGTH GUARD. The original required a heading line to be <= 90 chars,
 *    which assumes the heading sits alone on its line. Ashby's scraped postings
 *    run it straight into the first bullet — Harvey's requirements begin
 *    "What You Have - 5+ years of product management experience, ..." on ONE
 *    145-character line — so the guard silently reported no requirements
 *    section at all. The patterns are anchored at line start, so a bullet
 *    ("- Requirements gathering") cannot false-match.
 *
 * 2. STOP_HEAD. Every line was attributed to the last heading seen, so a
 *    benefits or EEO block printed after "Qualifications" was read as
 *    REQUIREMENT text. Measured across all 2,255 JDs, that is where PTO, HSA
 *    and ESPP were coming from, and — from one employer's recurring template —
 *    the words LEAVE, CAREER and GROWTH, each in 59 postings. It also meant a
 *    skill named in a perks paragraph could be treated as a hard requirement.
 *
 * ⚠ "what you have" is in REQUIRED_HEAD and was not in skill-gate's original.
 */

export const PREFERRED_HEAD = /^\s*(?:#+\s*)?\**\s*(?:preferred|nice[- ]to[- ]have|bonus|plus(?:es)?|desirable|good to have|it'?s a plus|additional|we'?d love|even better|extra credit)\b/im;

export const REQUIRED_HEAD = /^\s*(?:#+\s*)?\**\s*(?:requirements?|required|minimum|basic qualifications?|must[- ]have|qualifications?|what you(?:'ll| will)? need|what you have|who you are|what we(?:'re| are) looking for|skills? (?:&|and) experience)\b/im;

export const STOP_HEAD = /^\s*(?:#+\s*)?\**\s*(?:benefits?|perks|compensation|salary|pay range|what we offer|our offer|why (?:join|work|apply)|about (?:us|the (?:company|team|role))|equal (?:employment )?opportunity|eeo|e-verify|accommodations?|privacy|disclaimer|legal|total rewards|life at|our values|diversity|how to apply|next steps|interview process)\b/im;

/**
 * Split a JD body into `{kind, text}` spans, kind ∈ required | preferred |
 * stop | unknown. `unknown` is everything before the first heading, and its
 * sentences are resolved by their own language downstream.
 */
/**
 * ⚠ THE JD FILE HEADER IS NOT SECTION STRUCTURE. Every jds/*.md opens with
 * metadata — `**Company:**`, `**Location:**`, `**Compensation:**`,
 * `**Salary:**` — and two of those key names are also STOP_HEAD words. Without
 * this guard a `**Salary:**` line opens a stop section, and on the many
 * postings whose entire body is scraped onto ONE line (NYC's cityjobs feed does
 * this for all of them) nothing afterwards can ever reopen it: the whole
 * requisition is discarded. Caught 2026-08-13 when three NYC data roles
 * silently stopped reporting a Python requirement they plainly state.
 */
const META_LINE = /^\s*\*\*[A-Za-z][A-Za-z /]{0,24}:\*\*/;

export function sections(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let cur = { kind: 'unknown', text: '' };
  for (const line of lines) {
    if (META_LINE.test(line)) { cur.text += line + '\n'; continue; }
    const isStop = STOP_HEAD.test(line);
    const isPref = !isStop && PREFERRED_HEAD.test(line);
    const isReq = !isStop && !isPref && REQUIRED_HEAD.test(line);
    if (isStop || isPref || isReq) {
      if (cur.text.trim()) out.push(cur);
      cur = { kind: isStop ? 'stop' : isPref ? 'preferred' : 'required', text: '' };
    }
    cur.text += line + '\n';
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}
