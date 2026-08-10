#!/usr/bin/env node

/**
 * replay-corpus.mjs — measure a scoring change against VP's own decisions.
 *
 * WHY. Every policy change to rank-leads has so far been argued from a handful of
 * hand-picked examples, and the recurring result is a fix that buries a different
 * set of roles than the one it rescued. The corpus to settle it has been sitting
 * on disk the whole time: 1,000+ scored JDs carrying the FACTS the model
 * extracted, and 99 review-queue cards carrying VP's own approve/reject.
 *
 * The scorer's design - the model reports facts, code applies policy - means the
 * policy can be re-run over stored facts at zero LLM cost. So a change is
 * measurable before it ships:
 *
 *   node replay-corpus.mjs                 # baseline, current policy
 *   node replay-corpus.mjs --save base.json
 *   ...edit scoreFromFacts...
 *   node replay-corpus.mjs --against base.json    # what moved, and did it help
 *
 * WHAT "AGREEMENT" MEANS HERE, AND WHAT IT DOES NOT. VP rejected 91 of 99 cards,
 * many for reasons the scorer cannot see and is not trying to see - a role went
 * stale, he had already applied, he simply did not fancy it. So a rejection is
 * WEAK evidence and is reported separately. An APPROVAL is strong evidence: he
 * looked at it and wanted it, so a policy that scores an approved role below tier
 * 4 has demonstrably buried something he wanted. That asymmetry is the point;
 * treating this as a balanced accuracy number would be false precision.
 *
 * Read-only. Never writes to lead-scores.json.
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { canonKey } from './lib/canonical.mjs';
import { parseJd } from './lib/jd-parse.mjs';
import { scoreFromFacts, normalizeGeo, normalizeLevel, normalizeFunctionArea } from './rank-leads.mjs';
import { screenVerdict } from './lib/screen-evidence.mjs';
import { detectTrack, scoreTeaching, scoreCivic, scoreNonprofit, scoreNow } from './lib/track.mjs';

const ROOT = process.env.CAREER_OPS_ROOT ?? process.cwd();
const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const SAVE = arg('--save');
const AGAINST = arg('--against');
const VERBOSE = argv.includes('--verbose');

const scores = JSON.parse(await readFile(path.join(ROOT, 'data', 'lead-scores.json'), 'utf8'));
const queue = JSON.parse(await readFile(path.join(ROOT, 'data', 'review-queue.json'), 'utf8'));

// Re-derive a score from stored facts, mirroring rank-leads' own dispatch. A
// record with no facts (the 207 pre-2026-07-31 entries) cannot be replayed at
// all - it is reported as such rather than silently counted as agreement.
function replay(rec) {
  if (!rec || typeof rec !== 'object') return { score: null, why: 'no record' };
  const f = rec.facts ?? rec;
  // Detect the pre-2026-07-31 schema, which is {score, archetype, verdict,
  // redFlags} and nothing else. Testing for `archetype` does NOT work - legacy
  // records have one, so an earlier version of this check reported 0 legacy
  // records against an audited count of 207. `geo` and `functionArea` were both
  // introduced with the facts-in-code rewrite and are the honest discriminators.
  const hasFacts = f.geo !== undefined || f.functionArea !== undefined;
  if (!hasFacts) return { score: null, why: 'legacy record, no facts stored' };
  try {
    switch (rec.track) {
      case 'teaching': return { score: scoreTeaching(f), why: 'teaching' };
      case 'civic': return { score: scoreCivic(f), why: 'civic' };
      case 'nonprofit': return { score: scoreNonprofit(f), why: 'nonprofit' };
      case 'now': return { score: scoreNow(f), why: 'now' };
      default: return { score: scoreFromFacts(f), why: 'pm' };
    }
  } catch (e) {
    return { score: null, why: `threw: ${e.message}` };
  }
}

// Index the score records by canonical key so a queue card can find its facts
// even when scoreSource is absent or the filename has drifted.
//
// While here, derive the code-decided facts that stored records predate.
// `technicalScreenStated` is computed from the posting text by
// lib/screen-evidence.mjs, so a policy that gates on it can be replayed over the
// whole corpus at zero LLM cost - which is the entire point of facts-in-code.
const byKey = new Map();
const byFile = new Map();
for (const [file, rec] of Object.entries(scores)) {
  byFile.set(file, rec);
  try {
    const raw = await readFile(path.join(ROOT, 'jds', file), 'utf8').catch(() => null);
    if (!raw) continue;
    const jd = parseJd(raw, file);
    const f = rec.facts ?? rec;
    // Only enrich records that ALREADY carry facts. Deriving fields onto a legacy
    // record would manufacture the very evidence `replay()` uses to detect one -
    // an earlier version of this block set functionArea unconditionally and the
    // legacy count collapsed from 207 to 0, silently scoring 207 pre-audit
    // records on invented facts.
    if (!f || typeof f !== 'object' || (f.geo === undefined && f.functionArea === undefined)) continue;
    if (f.technicalScreenStated === undefined) {
      const v = screenVerdict(`${jd.title || ''}\n${jd.body || ''}`, f.technicalScreen === true);
      f.technicalScreenStated = v.action === 'gate';
      f.technicalScreenEvidence = v.phrase || '';
    }
    // Re-derive the normalized fields from the RAW values the record stored, so
    // a change to a normalizer is measurable without re-asking the model. geoRaw
    // is the ATS location string; level was stored as the model's free text
    // before normalizeLevel existed.
    if (f && typeof f === 'object') {
      if (f.geoRaw) f.geo = normalizeGeo(f.geoRaw);
      f.level = normalizeLevel(f.levelRaw ?? f.level);
      // functionArea is derived from the model's word PLUS the title, and the
      // title is the part that decides a domain-PM role. Records predating
      // functionAreaRaw store only the normalised value, so pass the title and
      // let the normaliser re-run.
      f.functionArea = normalizeFunctionArea(f.functionAreaRaw ?? '', jd.title || '');
    }
    byKey.set(canonKey(jd.company || '', jd.title || ''), { file, rec });
  } catch { /* an unreadable JD is not a scoring question */ }
}

const findRec = (card) => {
  if (card.scoreSource && byFile.has(card.scoreSource)) return { file: card.scoreSource, rec: byFile.get(card.scoreSource) };
  return byKey.get(canonKey(card.company || '', card.role || '')) || null;
};

// ── 1. Whole-corpus replay: does stored policy still reproduce stored scores? ──
let reproduced = 0, drifted = 0, unreplayable = 0;
const drift = [];
for (const [file, rec] of Object.entries(scores)) {
  const { score, why } = replay(rec);
  if (score == null) { unreplayable++; continue; }
  if (Number(rec.score) === score) reproduced++;
  else { drifted++; drift.push({ file, was: Number(rec.score), now: score, track: rec.track || 'pm', why }); }
}

// ── 2. The part that matters: what does policy say about what VP chose? ──────
const decided = queue.items.filter((i) => i.decision === 'approved' || i.decision === 'rejected');
const rows = [];
for (const card of decided) {
  const hit = findRec(card);
  const { score, why } = hit ? replay(hit.rec) : { score: null, why: 'no score record' };
  rows.push({
    slug: card.slug, company: card.company, role: card.role,
    decision: card.decision, cardScore: card.score ?? null, replayed: score, why,
    track: card.track || 'pm',
  });
}

const approved = rows.filter((r) => r.decision === 'approved');
const rejected = rows.filter((r) => r.decision === 'rejected');
const buried = approved.filter((r) => r.replayed != null && r.replayed < 4);
const promoted = rejected.filter((r) => r.replayed != null && r.replayed >= 4);
const unscorable = rows.filter((r) => r.replayed == null);

const summary = {
  corpus: { total: Object.keys(scores).length, reproduced, drifted, unreplayable },
  decisions: {
    approved: approved.length, rejected: rejected.length,
    approvedBuried: buried.length, rejectedPromoted: promoted.length,
    unscorable: unscorable.length,
  },
  buried: buried.map((r) => ({ slug: r.slug, replayed: r.replayed, track: r.track })),
  perCard: rows.map((r) => ({ slug: r.slug, decision: r.decision, replayed: r.replayed })),
};

console.log(`\nreplay-corpus — ${summary.corpus.total} score records, ${decided.length} decided cards\n`);
console.log('1. Policy reproducibility (does replaying stored facts give the stored score?)');
console.log(`   reproduced ${reproduced}   drifted ${drifted}   unreplayable ${unreplayable} (legacy, no facts)`);
if (drifted && VERBOSE) {
  for (const d of drift.slice(0, 25)) console.log(`     ${d.was} → ${d.now}  ${d.file} [${d.track}]`);
  if (drift.length > 25) console.log(`     … and ${drift.length - 25} more`);
}

console.log('\n2. Against VP\'s own decisions');
console.log(`   APPROVED ${approved.length} — of these, ${buried.length} score below tier 4 under current policy`);
for (const r of buried) {
  console.log(`     ✗ [${r.replayed}] ${r.company} | ${String(r.role).slice(0, 52)}  (${r.track})`);
}
console.log(`   REJECTED ${rejected.length} — of these, ${promoted.length} score tier 4+ (weak signal: many were rejected on age)`);
console.log(`   unscorable ${unscorable.length}`);

if (AGAINST) {
  const base = JSON.parse(await readFile(AGAINST, 'utf8'));
  const prev = new Map(base.perCard.map((r) => [r.slug, r.replayed]));
  const moved = summary.perCard.filter((r) => prev.get(r.slug) !== r.replayed);
  console.log(`\n3. Delta vs ${path.basename(AGAINST)}`);
  console.log(`   approved-but-buried: ${base.decisions.approvedBuried} → ${summary.decisions.approvedBuried}`);
  console.log(`   rejected-but-promoted: ${base.decisions.rejectedPromoted} → ${summary.decisions.rejectedPromoted}`);
  console.log(`   cards whose score moved: ${moved.length}`);
  for (const m of moved) {
    console.log(`     ${prev.get(m.slug)} → ${m.replayed}  [${m.decision}] ${m.slug}`);
  }
}

if (SAVE) {
  await writeFile(SAVE, JSON.stringify(summary, null, 2));
  console.log(`\nsaved baseline → ${SAVE}`);
}
console.log('');
