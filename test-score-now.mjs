#!/usr/bin/env node

/**
 * test-score-now.mjs — the Track D ("Get Hired Now") rubric.
 *
 * WHY THIS EXISTS. Track D is deliberately loose: no comp floor, no archetype,
 * no NYC-fit requirement. On 2026-08-11 that looseness was found to include
 * "no geography gate at all", which scored QuintoAndar's "Staff Product Manager
 * - Growth" a 5 on geoRaw "Brasil" / geoModel "Remote (Brazil)" - remote WITHIN
 * Brazil - and put it at the top of VP's shortlist. VP asked how he would
 * actually collect that income. He would not: it needs Brazilian work
 * authorization and residence. `remote` and `languageEdge` had fired as
 * BONUSES on a role he is ineligible for.
 *
 * The brief conflated being PAID from elsewhere (fine, and the point of the
 * track) with being REQUIRED TO RESIDE elsewhere (never fine, on any track).
 * These cases pin both halves: the gate must reject foreign residence, and it
 * must NOT quietly tighten the parts VP deliberately left loose.
 */
import { scoreNow } from './lib/track.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

// A role he cannot be hired into scores 1 regardless of how fast it would pay.
// Every bonus is set here on purpose: without the gate this is exactly the 5.
eq('foreign onsite is 1 even with every speed bonus',
   scoreNow({ geo: 'onsite-elsewhere', remote: true, languageEdge: true, seniorEnough: true, fastStart: true, hiringUrgently: true }), 1);
eq('foreign hybrid is 1',
   scoreNow({ geo: 'hybrid-elsewhere', remote: true, languageEdge: true, seniorEnough: true }), 1);
eq('the exact QuintoAndar fact pattern is 1',
   scoreNow({ geo: 'onsite-elsewhere', remote: true, languageEdge: true, seniorEnough: true, fastStart: false, hiringUrgently: false }), 1);

// The loose parts of the brief are UNCHANGED. A remote role for a foreign
// employer that pays a Manhattan resident is still the point of this track.
eq('remote-us contract still scores 5',
   scoreNow({ geo: 'remote-us', remote: true, fastStart: true, languageEdge: true, seniorEnough: true }), 5);
eq('remote-us with no bonuses is still not disqualified',
   scoreNow({ geo: 'remote-us', remote: true }), 3);
eq('speed alone reaches 4 without comp or archetype',
   scoreNow({ geo: 'remote-us', fastStart: true }), 4);
eq('unclear geography is not hard-gated here',
   scoreNow({ geo: 'unclear', remote: true, seniorEnough: true }), 4);

// Pre-existing disqualifiers must still fire.
eq('stated live-coding screen is 1', scoreNow({ geo: 'remote-us', technicalScreenStated: true, fastStart: true }), 1);
eq('hard credential is 1', scoreNow({ geo: 'remote-us', hardCredential: true, fastStart: true }), 1);
eq('a discipline he has never practised is 1', scoreNow({ geo: 'remote-us', functionArea: 'engineering', fastStart: true }), 1);

let pass = 0, fail = 0;
console.log('\nTrack D "Get Hired Now" rubric — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${want}, got ${got}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nGeography is not a preference on this track, it is eligibility.');
  process.exitCode = 1;
}
