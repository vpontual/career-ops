#!/usr/bin/env node

/**
 * test-applied-gate.mjs — a pack is not rebuilt for an application already sent.
 *
 * WHY THIS EXISTS. stage-applications.mjs picks candidates out of
 * lead-scores.json by score and freshness and never read data/applications.md,
 * so a submitted role regenerated its cover letter, CV and PDFs every night for
 * as long as its posting stayed fresh. Found 2026-08-13: Harvey's Command
 * Center pack was restaged at 04:46 that morning, a week after VP applied to it
 * and on the same day the rejection arrived.
 *
 * ⚠ THE ONE STATUS THAT MUST NOT GATE IS `evaluated` — it means "on the
 * tracker, not yet sent", so those still need a pack. Gating it would starve
 * the queue silently, which is the failure mode data/held-no-pack.md exists to
 * make visible.
 */
import { parseAppliedKeys, CLOSED_STATUSES } from './lib/applied-gate.mjs';
import { canonKey } from './lib/canonical.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

const TABLE = `# Applications tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-08-06 | Harvey | Senior Product Manager, Command Center | 5 | Rejected | - | - | form email |
| 2 | 2026-08-04 | GitLab | Senior Product Manager, Plan to Code | 5 | Applied | - | - | |
| 3 | 2026-08-01 | Acme | Product Manager, Widgets | 4 | Evaluated | - | - | not sent yet |
| 4 | 2026-07-29 | Globex | Head of Product | 4 | Interview | - | - | |
| 5 | 2026-07-20 | Initech | Director of Product | 3 | Discarded | - | - | |
| 6 | 2026-07-15 | Umbrella | Group PM | 3 | Bananas | - | - | not a real status |
`;

const keys = parseAppliedKeys(TABLE);

eq('a rejected role is gated', keys.has(canonKey('Harvey', 'Senior Product Manager, Command Center')), true);
eq('an applied role is gated', keys.has(canonKey('GitLab', 'Senior Product Manager, Plan to Code')), true);
eq('an interview is gated', keys.has(canonKey('Globex', 'Head of Product')), true);
eq('a discarded role is gated', keys.has(canonKey('Initech', 'Director of Product')), true);

// The one that must stay buildable.
eq('an EVALUATED role is NOT gated', keys.has(canonKey('Acme', 'Product Manager, Widgets')), false);

// An unparseable status falls through and still gets a pack: failing to build
// one is the more expensive error, since it lands the role in held-no-pack.md
// with a remedy that has already run.
eq('an unrecognised status is NOT gated', keys.has(canonKey('Umbrella', 'Group PM')), false);

eq('the header row is not a record', keys.has(canonKey('Company', 'Role')), false);
eq('only the closed rows are counted', keys.size, 4);

// The key is canonical, so tracker spelling does not have to match the JD's.
eq('company casing does not matter', keys.has(canonKey('harvey', 'Senior Product Manager, Command Center')), true);
eq('punctuation in the role does not matter', keys.has(canonKey('GitLab', 'Senior Product Manager - Plan to Code')), true);

// The status vocabulary is lib/status.mjs's, not a private copy.
eq('evaluated is not a closed status', CLOSED_STATUSES.has('evaluated'), false);
eq('applied is', CLOSED_STATUSES.has('applied'), true);
eq('offer is', CLOSED_STATUSES.has('offer'), true);
eq('skip is', CLOSED_STATUSES.has('skip'), true);

// Spanish aliases are normalised before the check — the tracker carries legacy
// rows written before the vocabulary was canonicalised.
const LEGACY = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
| 1 | 2026-05-01 | Legacy Co | Product Manager | 4 | Aplicado | - | - | |
| 2 | 2026-05-02 | Otra Co | Product Manager | 4 | Rechazado | - | - | |
| 3 | 2026-05-03 | Tercera Co | Product Manager | 4 | Evaluada | - | - | |
`;
const legacyKeys = parseAppliedKeys(LEGACY);
eq('"Aplicado" gates', legacyKeys.has(canonKey('Legacy Co', 'Product Manager')), true);
eq('"Rechazado" gates', legacyKeys.has(canonKey('Otra Co', 'Product Manager')), true);
eq('"Evaluada" does not', legacyKeys.has(canonKey('Tercera Co', 'Product Manager')), false);

// Degenerate inputs must not throw.
eq('empty text is an empty map', parseAppliedKeys('').size, 0);
eq('null text is an empty map', parseAppliedKeys(null).size, 0);
eq('a table with no data rows is empty', parseAppliedKeys('| # | Date |\n|---|---|\n').size, 0);

let pass = 0, fail = 0;
console.log('\napplied gate — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nGating `evaluated` starves the queue; not gating `applied` rebuilds sent packs nightly.');
  process.exitCode = 1;
}
