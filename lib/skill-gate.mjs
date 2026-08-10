/**
 * lib/skill-gate.mjs — a skill VP does not have, weighed by WHERE the posting asks for it.
 *
 * VP's rule, given 2026-08-10 verbatim: "IF its a requirement, block it. if its
 * in the nice to haves section, show it with a warning."
 *
 * That distinction is the entire difficulty, and this repo has already been
 * burned by ignoring it: the years-of-experience parser took its number from
 * anywhere in the body, and 204 of 778 postings had their minimum sitting inside
 * a "preferred / nice-to-have" block. A skill gate with the same flaw would hard
 * -reject roles over a bonus qualification. So every match is resolved to the
 * SECTION it appears in, and the section decides block vs warn.
 *
 * The skills themselves are VP's data and live in config/profile.yml under
 * `skills:`. They are NOT hardcoded here - he edits that file, not this one.
 * As of 2026-08-10 he confirmed: has AWS/cloud, Kubernetes, A/B testing and BI
 * tools (plus Docker, already on the CV); does not have SQL, Python, statistics
 * /experiment design, or data-pipeline/ETL work.
 *
 * ⚠ Why this cannot read cv.md directly: it was measured on 2026-08-10 and
 * cv.md lists exactly ONE of these (Docker). It omits Kubernetes even though VP
 * runs a k3s cluster. Gating on CV text alone would have screened out roles he
 * is qualified for, which is how "candidate cannot write code or SQL" ended up
 * on a card as though it were a fact.
 */

const PREFERRED_HEAD = /^\s*(?:#+\s*)?\**\s*(?:preferred|nice[- ]to[- ]have|bonus|plus(?:es)?|desirable|good to have|it'?s a plus|additional|we'?d love|even better|extra credit)\b/im;
const REQUIRED_HEAD = /^\s*(?:#+\s*)?\**\s*(?:requirements?|required|minimum|basic qualifications?|must[- ]have|qualifications?|what you(?:'ll| will)? need|who you are|what we(?:'re| are) looking for|skills? (?:&|and) experience)\b/im;

// Sentence-level requirement language, for postings with no headings at all.
const REQ_WORDS = /\b(?:required|must have|must be able|you must|proficien\w+|expertise in|deep (?:experience|knowledge)|strong (?:experience|background|proficiency)|demonstrated ability|minimum of)\b/i;
const PREF_WORDS = /\b(?:preferred|nice to have|a plus|bonus|desirable|ideally|familiarity|exposure to|helpful)\b/i;

/**
 * Split the body into (headingType, text) spans so a match can be attributed.
 * Headings in these postings are markdown (`**Required Qualifications**`,
 * `### Preferred`) or bare lines; both shapes appear in the corpus.
 */
function sections(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let cur = { kind: 'unknown', text: '' };
  for (const line of lines) {
    const isPref = PREFERRED_HEAD.test(line);
    const isReq = !isPref && REQUIRED_HEAD.test(line);
    if ((isPref || isReq) && line.trim().length <= 90) {
      if (cur.text.trim()) out.push(cur);
      cur = { kind: isPref ? 'preferred' : 'required', text: '' };
    }
    cur.text += line + '\n';
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}

const DEGREE_LIST = /\b(?:bachelor|master|b\.?s\.?|m\.?s\.?|m\.?b\.?a\.?|ph\.?d|degree|major(?:ed)? in|field of study)\b[^.]{0,120}\bin\b|\bdegree in\b/i;

function sentenceAround(text, idx) {
  const a = Math.max(text.lastIndexOf('.', idx), text.lastIndexOf('\n', idx));
  let b = text.indexOf('\n', idx); if (b < 0) b = text.length;
  return text.slice(a + 1, Math.min(b, a + 400)).trim().slice(0, 200);
}

/**
 * @param {string} body       the JD text
 * @param {Array<{name:string, re:RegExp}>} lacks  skills VP does NOT have
 * @returns {{blocked:Array, warned:Array}}
 */
export function skillGate(body, lacks) {
  const blocked = [], warned = [];
  const seen = new Set();
  for (const { kind, text } of sections(body)) {
    for (const skill of lacks) {
      const re = new RegExp(skill.re.source, skill.re.flags.replace('g', ''));
      const m = re.exec(text);
      if (!m) continue;
      if (seen.has(skill.name)) continue;
      const evidence = sentenceAround(text, m.index);
      // A FIELD OF STUDY is not a skill requirement. Upstart's "Bachelor's
      // degree in Computer Science, Engineering, Mathematics, Statistics,
      // Economics, or a related field" was blocking the role on "Statistics" -
      // it is naming acceptable majors, and VP holds an MBA and an Economics BA.
      // Blocking a role over a degree list is a silent loss of a good match.
      if (DEGREE_LIST.test(evidence)) continue;
      // A heading wins. With no heading, the sentence's own language decides,
      // and ambiguity resolves to WARN - losing a role silently is the worse
      // error, and VP asked to be shown the borderline ones.
      let verdict = kind;
      if (verdict === 'unknown') {
        verdict = PREF_WORDS.test(evidence) ? 'preferred'
                : REQ_WORDS.test(evidence) ? 'required'
                : 'preferred';
      }
      seen.add(skill.name);
      if (verdict !== 'required') { warned.push({ skill: skill.name, evidence }); continue; }
      // BAR HEIGHT. VP has basic SQL and understands pipelines without building
      // them, so "you can write SQL" is not the same requirement as "complex SQL
      // with CTEs and query optimisation". Without this distinction a single
      // "SQL: no" deleted 17 reviewable roles, two of them tier-5. When a skill
      // carries `beyond`, only a requirement that exceeds his level blocks; one
      // at or below it still warns, so he knows it was asked for.
      if (skill.beyond && !skill.beyond.test(evidence)) {
        warned.push({ skill: `${skill.name} (required, but at a level you have)`, evidence });
        continue;
      }
      blocked.push({ skill: skill.name, evidence });
    }
  }
  return { blocked, warned };
}

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

let _cached = null;
/** VP's `skills.lacks` from config/profile.yml, read once. */
export function defaultLacks() {
  if (_cached) return _cached;
  try {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const y = yaml.load(readFileSync(path.join(root, 'config', 'profile.yml'), 'utf-8'));
    _cached = lacksFrom(y);
  } catch { _cached = []; }
  return _cached;
}

/** Build the matcher list from config/profile.yml's `skills.lacks`. */
export function lacksFrom(profile) {
  const raw = profile?.skills?.lacks || [];
  return raw.map(s => ({
    name: s.name || String(s),
    re: new RegExp(s.pattern || `\\b${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    beyond: s.beyond ? new RegExp(s.beyond, 'i') : null,
  }));
}
