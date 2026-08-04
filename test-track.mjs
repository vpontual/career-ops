import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { parseJd } from './lib/jd-parse.mjs';
import { detectTrack, titlePassesForTrack, trackFacts, scoreTeaching, scoreNonprofit } from './lib/track.mjs';

const JDS = 'jds';
const scores = JSON.parse(await readFile('data/lead-scores.json', 'utf-8'));
const files = await readdir(JDS);

const byTrack = { pm: [], teaching: [], nonprofit: [] };
for (const f of files) {
  const jd = parseJd(await readFile(path.join(JDS, f), 'utf-8'), f);
  byTrack[detectTrack(jd)].push({ f, jd });
}

console.log('=== TRACK DISTRIBUTION over', files.length, 'JDs ===');
for (const [k, v] of Object.entries(byTrack)) console.log(`  ${k.padEnd(10)} ${v.length}`);

console.log('\n=== TEACHING (all) ===');
for (const { f, jd } of byTrack.teaching) {
  const rec = scores[f] || {};
  const facts = { ...trackFacts('teaching', jd), geo: rec.geo ?? 'nyc', compLow: rec.compLow ?? null };
  const s = scoreTeaching(facts);
  const flags = Object.entries(facts).filter(([k, v]) => v === true).map(([k]) => k).join(',') || 'none';
  console.log(`  [${s}] ${jd.company.slice(0, 34).padEnd(34)} ${jd.title.slice(0, 46).padEnd(46)} ${flags}`);
}

console.log('\n=== NONPROFIT (all) ===');
for (const { f, jd } of byTrack.nonprofit) {
  const rec = scores[f] || {};
  const facts = { ...trackFacts('nonprofit', jd), geo: rec.geo ?? 'nyc', compLow: rec.compLow ?? null,
                  technicalScreen: rec.technicalScreen === true };
  console.log(`  [${scoreNonprofit(facts)}] ${jd.company.slice(0, 30).padEnd(30)} ${jd.title.slice(0, 50)}`);
}

// The risk that matters: a Track A role pulled onto the wrong rubric. Any
// already-scored PM role that this now calls teaching or nonprofit is a
// regression, so list them explicitly rather than trusting the counts.
console.log('\n=== REGRESSION CHECK: previously-scored roles that changed track ===');
let moved = 0;
for (const t of ['teaching', 'nonprofit']) {
  for (const { f, jd } of byTrack[t]) {
    if (scores[f]) {
      moved++;
      console.log(`  ${t}: ${jd.company} | ${jd.title.slice(0, 50)} (was scored ${scores[f].score} as PM)`);
    }
  }
}
if (!moved) console.log('  none - no previously-scored role changes rubric');

console.log('\n=== TITLE GATE: what Track B/C now admits that PM filter rejected ===');
let admitted = 0;
for (const t of ['teaching', 'nonprofit']) {
  for (const { jd } of byTrack[t]) if (titlePassesForTrack(t, jd.title)) admitted++;
}
console.log(`  ${admitted} roles admitted by the track filters`);
