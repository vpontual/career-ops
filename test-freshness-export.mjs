#!/usr/bin/env node
/**
 * test-freshness-export.mjs — the JSON the UI reads still means what
 * lib/freshness.mjs decided.
 *
 * The UI cannot import lib/freshness.mjs (separate Docker build context), so it
 * reads data/freshness-windows.json and restates ONE rule: the resolution
 * order. This asserts that order against maxAgeDaysFor() itself, over a matrix
 * that includes the case where the two could disagree — a whale employer on a
 * track that has its own window.
 */
import { existsSync, readFileSync } from 'fs';
import { maxAgeDaysFor, TRACK_MAX_AGE_DAYS, FRESH_MAX_AGE_DAYS } from './lib/freshness.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

// The projection's rule, written exactly as ui/lib/freshness-windows.ts writes it.
const resolve = (doc, role) =>
  doc.byTrack[role.track] ?? doc.byCompany[String(role.company || '').toLowerCase()] ?? doc.defaultDays;

// A policy with one whale and one evergreen, built the way loadFreshnessPolicy
// builds them rather than stubbed, so the substring and threshold rules are the
// real ones.
const policy = {
  isWhale: (c) => String(c || '').toLowerCase().includes('anthropic'),
  isEvergreen: (c) => String(c || '').toLowerCase() === 'sierra',
  whaleMaxAgeDays: 30,
};

const companies = ['Anthropic', 'Anthropic PBC', 'Sierra', 'Some Startup Inc'];
const doc = {
  defaultDays: FRESH_MAX_AGE_DAYS,
  byTrack: { ...TRACK_MAX_AGE_DAYS },
  byCompany: Object.fromEntries(
    companies
      .map((c) => [c.toLowerCase(), maxAgeDaysFor({ company: c }, policy)])
      .filter(([, d]) => d !== FRESH_MAX_AGE_DAYS)
  ),
};

// ⚠ The matrix includes every track AND no track, against every company. If the
// projection's order ever diverges from maxAgeDaysFor's, one of these moves.
const tracks = [undefined, 'pm', 'now', ...Object.keys(TRACK_MAX_AGE_DAYS)];
for (const track of tracks) {
  for (const company of companies) {
    const role = { track, company };
    eq(`${track ?? 'no track'} @ ${company}`, resolve(doc, role), maxAgeDaysFor(role, policy));
  }
}

// The case the precedence exists for, stated on its own so a regression names
// itself: a civic role at a whale gets CIVIC's window, not the whale's 30.
eq('a track window beats a whale',
  resolve(doc, { track: 'civic', company: 'Anthropic' }), TRACK_MAX_AGE_DAYS.civic);
eq('a whale with no track still gets the whale window',
  resolve(doc, { company: 'Anthropic' }), 30);
eq('a substring match is enough to be a whale',
  resolve(doc, { company: 'Anthropic PBC' }), 30);
eq('an ordinary employer falls through to the default',
  resolve(doc, { company: 'Some Startup Inc' }), FRESH_MAX_AGE_DAYS);
eq('byCompany only carries what differs from the default',
  Object.keys(doc.byCompany).includes('some startup inc'), false);

// The generated file, when there is one: its shape must be what the UI expects.
if (existsSync('data/freshness-windows.json')) {
  const live = JSON.parse(readFileSync('data/freshness-windows.json', 'utf-8'));
  eq('live export carries a default', typeof live.defaultDays, 'number');
  eq('live export carries the track table', typeof live.byTrack, 'object');
  eq('live export carries the company overrides', typeof live.byCompany, 'object');
  eq('live export default matches the policy', live.defaultDays, FRESH_MAX_AGE_DAYS);
  for (const [t, d] of Object.entries(TRACK_MAX_AGE_DAYS)) {
    eq(`live export window for ${t}`, live.byTrack[t], d);
  }
}

let pass = 0, fail = 0;
console.log('\nfreshness export — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nThe UI would hide roles on a window the policy never set.');
  process.exitCode = 1;
}
