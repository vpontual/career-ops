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
import { detectTrack, trackFacts, scoreTeaching, scoreNonprofit, scoreNow } from './lib/track.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCORES = path.join(ROOT, 'data', 'lead-scores.json');
const DRY = process.argv.includes('--dry-run');

// Pull the two functions out of rank-leads rather than copying them, so this
// can never drift from the policy it is meant to reapply.
const src = await readFile(path.join(ROOT, 'rank-leads.mjs'), 'utf8');
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in rank-leads.mjs`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} unterminated`);
}
const consts = src.slice(src.indexOf('const NYC_METRO'), src.indexOf('function normalizeGeo'));
const faConsts = src.slice(src.indexOf('const FUNCTION_AREA'), src.indexOf('export function normalizeFunctionArea'));
const mod = new Function(`${consts}\n${faConsts}\n${extract('normalizeGeo')}\n${extract('normalizeArchetype')}\n${extract('normalizeFunctionArea').replace('export ', '')}\n${extract('scoreFromFacts')}\nreturn { normalizeGeo, normalizeArchetype, normalizeFunctionArea, scoreFromFacts };`)();

const scores = JSON.parse(await readFile(SCORES, 'utf8'));
let changed = 0, gated = 0, skipped = 0;
const moves = [];

for (const [k, v] of Object.entries(scores)) {
  if (!('aiNative' in v)) { skipped++; continue; }   // pre-facts entry, leave alone
  // Prefer the JD's own Location header over anything cached from the model.
  // That header is what the ATS reported and it is the only trustworthy source
  // when a company posts one role per city.
  let raw = v.geoRaw ?? v.geo;
  try {
    const head = readFileSync(path.join(ROOT, 'jds', k), 'utf8').slice(0, 600);
    const m = /^\*\*Location:\*\* (.+)$/m.exec(head);
    if (m && m[1].trim()) raw = m[1].trim();
  } catch {}
  const geo = mod.normalizeGeo(raw);
  const archetype = mod.normalizeArchetype(v.archetypeRaw ?? v.archetype);

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
  const facts = { ...v, ...extra, geo, archetype, track, functionArea };
  const score = track === 'teaching' ? scoreTeaching(facts)
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

const tiers = {};
for (const v of Object.values(scores)) if ('aiNative' in v) tiers[v.score] = (tiers[v.score] || 0) + 1;
console.log('new tiers 5/4/3/2/1:', [5, 4, 3, 2, 1].map(t => tiers[t] || 0).join('/'));
const byTrack = {};
for (const v of Object.values(scores)) if ('aiNative' in v) byTrack[v.track || 'pm'] = (byTrack[v.track || 'pm'] || 0) + 1;
console.log('by track:', JSON.stringify(byTrack));

console.log('\nsample of what moved:');
for (const m of moves.slice(0, 12)) {
  console.log(`  ${m.from} → ${m.to}   ${String(m.geoFrom).slice(0, 22).padEnd(24)} → ${m.geoTo}   ${m.k.slice(0, 42)}`);
}

if (DRY) { console.log('\n--dry-run, nothing written'); }
else { await writeFile(SCORES, JSON.stringify(scores, null, 2)); console.log(`\nwrote ${SCORES}`); }
