#!/usr/bin/env node

/**
 * recompute-scores.mjs — re-derive every score from facts already collected.
 *
 * The scorer's whole design is that the model reports facts and the policy is
 * applied in code. That has a payoff worth using: when the POLICY is wrong, the
 * facts are still good, so the fix costs no LLM calls at all.
 *
 * This exists because the geo gate was comparing against enum values the model
 * had stopped returning - it sent "San Francisco, CA" where the code expected
 * 'onsite-elsewhere' - so nothing was filtered on location. Rather than spend
 * another 30-minute pass re-asking 403 questions that were already answered
 * correctly, this reclassifies the stored geo text and recomputes.
 *
 * Usage: node recompute-scores.mjs [--dry-run]
 */

import { readFile, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseJd } from './lib/jd-parse.mjs';
import { detectTrack, trackFacts, scoreTeaching, scoreCivic, scoreNonprofit, scoreNow } from './lib/track.mjs';
import { detectHardCredential } from './lib/credential-gate.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCORES = path.join(ROOT, 'data', 'lead-scores.json');
const DRY = process.argv.includes('--dry-run');

// Import the policy functions from rank-leads rather than copying them, so this
// can never drift from the policy it exists to reapply.
//
// This block used to slice them out of rank-leads.mjs's SOURCE TEXT with
// indexOf + brace matching and evaluate the result with `new Function`. The
// intent was right - one source of truth - but the mechanism broke the moment a
// function gained an `export` keyword or a brace moved, and it did: adding
// normalizeLevel made this throw "SyntaxError: Unexpected token 'export'" and
// took the whole tool down. rank-leads.mjs is import-safe now (it guards main()
// behind the argv check), so the same guarantee costs nothing and cannot break.
import {
  normalizeGeo, normalizeArchetype, normalizeFunctionArea, normalizeLevel, scoreFromFacts,
  sanitizeCompLow,
} from './rank-leads.mjs';
import { screenVerdict } from './lib/screen-evidence.mjs';
import { compBand } from './lib/comp-band.mjs';
import { skillGate, defaultLacks } from './lib/skill-gate.mjs';

const mod = { normalizeGeo, normalizeArchetype, normalizeFunctionArea, scoreFromFacts };

const scores = JSON.parse(await readFile(SCORES, 'utf8'));
let changed = 0, gated = 0, skipped = 0, quarantined = 0;
const moves = [];
const quarantine = [];

for (const [k, v] of Object.entries(scores)) {
  // ── Pre-facts entries: QUARANTINED, not rescored and no longer trusted ────
  //
  // 207 records (58 of them at tier 4+) predate the facts-in-code rewrite. They
  // carry exactly five keys - score, archetype, verdict, redFlags, scored_at -
  // and NOTHING else. No geo, no functionArea, no aiNative, no compLow, no
  // level, no *Raw fields. They are the same 207 that `enqueue-review.mjs`
  // isolates as `repIsLegacy` and that `triage-candidates.mjs` drops on
  // `s.geo === undefined`.
  //
  // This branch used to be `{ skipped++; continue; }` - "leave alone" - and
  // leaving them alone was the bug. Their stored 4s and 5s were earned under a
  // 2026-05 rubric that had no geography gate, no skill gate and no credential
  // gate, but `ui/app/page.tsx`'s shortlist is
  //   typeof r.score === "number" && r.score >= 4.0
  //     && r.geo !== "onsite-elsewhere" && r.geo !== "hybrid-elsewhere"
  // and on these records `r.geo` is UNDEFINED, so both geo tests pass by
  // vacuity. Every gate the last three months of work added is bypassed by a
  // record simply not having the field the gate reads. Two scripts had already
  // learned to distrust them one at a time; the UI never did.
  //
  // WHY QUARANTINE AND NOT RESCORE. `scoreFromFacts` is not a pure function of
  // the posting - it takes `aiNative`, and aiNative is a MODEL judgement with
  // no code-derivable substitute. It is worth +1 and it is the sole gate on
  // tier 5 (`if (!f.aiNative) score = Math.min(score, 4)`). Feeding these
  // records through with aiNative absent does not "re-derive" anything: it
  // silently asserts aiNative=false, compLow=null and level='at' for all 207,
  // and hands back a number that looks exactly like a scored one. Measured on
  // the 58 at tier 4+: the code-derived hard gates (geo from the ATS Location
  // header, skill-gate, credential-gate, screen-evidence) fire on only FOUR.
  // The other 54 would receive a manufactured tier resting on three invented
  // facts. That is a worse failure than the one being fixed - it converts
  // "unknown" into "measured", and nothing downstream could tell the
  // difference afterwards.
  //
  // So the honest state is recorded instead: score = null. "We do not know"
  // and "we know it is a 1" are different answers and this keeps them
  // different. Every consumer already reads score defensively - the UI's
  // `typeof sc?.score === "number"`, stage-applications' `Number(rec?.score)
  // || 0`, resolve-apply-paths' `Number(rec.score) >= MIN_SCORE` - so a null
  // drops out of the shortlist, the staging tier gate and the canonical
  // score-join with no further change. The old number is preserved in
  // `legacyScore` so this is auditable and reversible.
  //
  // NO TRACK IS ASSIGNED, deliberately. `detectTrack` would label all 58 'pm',
  // which reads as "scored under the pm rubric" - the exact false claim this
  // block exists to stop. The "None 58" bucket in the tier-4+ breakdown is
  // meant to disappear because these records LEAVE the tier-4+ population, not
  // because they were handed a label they never earned.
  //
  // AND NO DERIVED FACTS, for a second reason: `enqueue-review.mjs` identifies
  // this population with `geo === undefined && functionArea === undefined`.
  // Writing even a code-derived geo here would flip that test to false and
  // these records would be miscounted under `stats.lowScore` instead of
  // `stats.legacyNoFacts`, in a file whose header is about counting honestly.
  // Leave the shape alone; add only the quarantine keys.
  //
  // These 207 are not recoverable by any policy change and re-scoring them by
  // model is not worth buying: all 58 tier-4+ postings are 42-140 days old
  // (none within rank-leads' 30-day freshness window), 40 of the 58 are already
  // in pipeline-archive.md, and at ~34s per role a full pass costs ~33 minutes
  // of DGX time to re-score requisitions that are almost certainly closed. If a
  // legacy req is ever REPOSTED it becomes fresh, and rank-leads.mjs now
  // re-scores any cache entry whose score is null - so the heal happens exactly
  // when the role is worth healing, and never otherwise.
  if (!('aiNative' in v)) {
    skipped++;
    if (v.score != null) {
      quarantine.push({ k, was: v.score });
      v.legacyScore = v.score;
      v.score = null;
      v.legacyNoFacts = true;
      v.legacyReason = 'scored pre-2026-07-31 under a rubric with no geo/skill/credential gate; '
                     + 'no stored facts to re-derive from (no aiNative/geo/functionArea/compLow/level). '
                     + 'Not trusted by the shortlist. Rescore requires an LLM pass.';
      quarantined++;
    }
    continue;
  }
  // Prefer the JD's own Location header over anything cached from the model.
  // That header is what the ATS reported and it is the only trustworthy source
  // when a company posts one role per city.
  //
  // ⚠ The window was 600 characters and that was too small, because the header
  // it reads sits BELOW the `**URL:**` line and some URLs are enormous. A
  // welcometothejungle link carries a ~430-character JWT in its query string,
  // which pushes `**Location:**` past 600 - and the `m` flag lets `$` match end
  // of INPUT as well as end of line, so the regex still matched and returned a
  // value chopped mid-string. Silent corruption, not a miss. Measured over the
  // corpus: 6 records truncated, 4 of them landing on a different geo, and 2 of
  // those in the dangerous direction - Meltwater's "Miami, US / Austin, US /
  // Chicago, US / New York, US" was cut to "...Chicago, US /" and normalised to
  // onsite-elsewhere, hard-gating a role VP can take in New York to 1.
  // 4000 clears every header on disk (largest observed ~900).
  let raw = v.geoRaw ?? v.geo;
  try {
    const head = readFileSync(path.join(ROOT, 'jds', k), 'utf8').slice(0, 4000);
    const m = /^\*\*Location:\*\* (.+)$/m.exec(head);
    if (m && m[1].trim()) raw = m[1].trim();
  } catch {}
  const geo = mod.normalizeGeo(raw);

  // Facts decided in CODE, which stored records predate. Recomputing them here
  // is the whole point of facts-in-code: a policy change reaches the entire
  // corpus without a single LLM call.
  //   level              - was free text; the 'below' gate had never fired
  //   technicalScreen... - now gates on evidence in the posting, not the
  //                        model's inference (176 of 806 records carried an
  //                        inferred screen with nothing in the text to support it)
  v.level = normalizeLevel(v.levelRaw ?? v.level);
  // A fact the model got wrong, healed in code. The $10k floor was added at
  // extraction time only, and extraction never re-runs for a JD already in the
  // cache - so 29 records still carried compLow: 1 against stated bands as high
  // as $263,200, each one silently capped to tier 3 and never enqueued. The
  // corpus is only healed if the guard runs HERE too.
  v.compLow = sanitizeCompLow(v.compLow);
  // Re-read the band from the posting. 116 of 315 records marked "no comp
  // stated" have one printed in the body - Indeed escapes its markdown, so
  // `\$263,200\.00` was invisible to everything that looked. Healing here is
  // the whole point of facts-in-code: no LLM call, and it reaches every
  // cached record rather than only newly-scored ones.
  // Derived in code, so it reaches all 1,226 cached records without an LLM call.
  try {
    const sg = skillGate(readFileSync(path.join(ROOT, 'jds', k), 'utf8'), defaultLacks());
    v.skillBlocked = sg.blocked.map(b => b.skill);
    v.skillBlockedEvidence = sg.blocked.map(b => `${b.skill}: ${b.evidence}`).join(' | ');
    v.skillWarnings = sg.warned.map(w => w.skill);
  } catch { /* JD gone - leave whatever was stored */ }
  try {
    const band = compBand(readFileSync(path.join(ROOT, 'jds', k), 'utf8'));
    if (band.compLow != null) {
      v.compLowRaw = v.compLowRaw ?? v.compLow;
      v.compLow = band.compLow;
      v.compSource = 'posting';
      v.compEvidence = band.evidence;
    } else if (v.compLow != null) {
      v.compSource = v.compSource || 'model';
    }
  } catch { /* JD gone - keep whatever was stored */ }
  try {
    const body = readFileSync(path.join(ROOT, 'jds', k), 'utf8');
    const sv = screenVerdict(body, v.technicalScreen === true);
    v.technicalScreenStated = sv.action === 'gate';
    v.technicalScreenEvidence = sv.phrase || '';
  } catch { v.technicalScreenStated = false; }
  // Same treatment for the credential fact, and for the same reason: it is
  // derived from the posting, so it must be RE-derived here or a record scored
  // before lib/credential-gate.mjs existed would come back through this tool
  // with no credentialBlocked at all and quietly lose the gate.
  try {
    const body = readFileSync(path.join(ROOT, 'jds', k), 'utf8');
    const cg = detectHardCredential(body);
    v.credentialBlocked = cg.blocked;
    v.credentialName = cg.credential || '';
    v.credentialEvidence = cg.evidence || '';
    v.credentialWarnings = cg.warned.map(w => `${w.credential} (${w.why})`).join(' | ');
  } catch { v.credentialBlocked = false; }

  // Track-aware, or this tool silently reverts Tracks B and C. It rewrites every
  // entry carrying an `aiNative` key, and teaching entries carry one, so a single
  // run used to overwrite scoreTeaching values with PM-rubric numbers - undoing
  // the whole rubric it exists to reapply.
  let jd = null;
  try { jd = parseJd(readFileSync(path.join(ROOT, 'jds', k), 'utf8'), k); } catch {}
  const track = jd ? detectTrack(jd) : (v.track || 'pm');
  const extra = jd ? trackFacts(track, jd) : {};
  // Entries scored before functionArea existed get it derived from the title,
  // which costs nothing and is the same fallback the live scorer uses.
  // Pass the model's RAW answer only, never the previously-derived value.
  // 'other' is a legal enum value, so feeding it back in short-circuited the
  // normalizer and the label stuck forever - widening the product pattern
  // moved 2 roles instead of 47 because of exactly this.
  const functionArea = mod.normalizeFunctionArea(v.functionAreaRaw, jd ? jd.title : '');
  // Same reason as geo above: the posting's own title outranks the model's
  // free-text guess at seniority. Computed here rather than at the top of the
  // loop because it needs the parsed JD.
  const archetype = mod.normalizeArchetype(v.archetypeRaw ?? v.archetype, jd ? jd.title : '');
  const facts = { ...v, ...extra, geo, archetype, track, functionArea };
  const score = track === 'teaching' ? scoreTeaching(facts)
              : track === 'civic' ? scoreCivic(facts)
              : track === 'nonprofit' ? scoreNonprofit(facts)
              : track === 'now' ? scoreNow(facts)
              : mod.scoreFromFacts(facts);
  if (geo !== v.geo || score !== v.score) {
    moves.push({ k, from: v.score, to: score, geoFrom: v.geo, geoTo: geo });
    changed++;
    if (score === 1 && v.score > 1) gated++;
  }
  Object.assign(v, extra);
  v.track = track;
  v.functionArea = functionArea;
  v.archetypeRaw = v.archetypeRaw ?? v.archetype;
  v.archetype = archetype;
  v.geoRaw = raw;
  v.geo = geo;
  v.score = score;
}

console.log(`entries: ${Object.keys(scores).length}  recomputed: ${Object.keys(scores).length - skipped}  skipped (no facts): ${skipped}`);
console.log(`changed: ${changed}   newly gated to 1 on geography: ${gated}`);
console.log(`quarantined (pre-facts, score → null): ${quarantined}` +
            `   of which were sitting at tier 4+: ${quarantine.filter(q => q.was >= 4).length}`);

const tiers = {};
for (const v of Object.values(scores)) if ('aiNative' in v) tiers[v.score] = (tiers[v.score] || 0) + 1;
console.log('new tiers 5/4/3/2/1:', [5, 4, 3, 2, 1].map(t => tiers[t] || 0).join('/'));
const byTrack = {};
for (const v of Object.values(scores)) if ('aiNative' in v) byTrack[v.track || 'pm'] = (byTrack[v.track || 'pm'] || 0) + 1;
console.log('by track:', JSON.stringify(byTrack));

// The number VP actually looks at. `ui/app/page.tsx` calls tier 4+ the
// shortlist, so a track showing up here is a claim that those roles cleared
// that track's gates - which is why the untracked bucket had to stop appearing.
const shortlist = {};
for (const v of Object.values(scores)) if (typeof v.score === 'number' && v.score >= 4) {
  shortlist[v.track ?? 'NONE (untracked)'] = (shortlist[v.track ?? 'NONE (untracked)'] || 0) + 1;
}
console.log('shortlist (score >= 4) by track:', JSON.stringify(shortlist));

console.log('\nsample of what moved:');
for (const m of moves.slice(0, 12)) {
  console.log(`  ${m.from} → ${m.to}   ${String(m.geoFrom).slice(0, 22).padEnd(24)} → ${m.geoTo}   ${m.k.slice(0, 42)}`);
}

if (DRY) { console.log('\n--dry-run, nothing written'); }
else { await writeFile(SCORES, JSON.stringify(scores, null, 2)); console.log(`\nwrote ${SCORES}`); }
