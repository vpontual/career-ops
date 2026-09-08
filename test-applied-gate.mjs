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
import { parseAppliedKeys, parseAppliedIdentities, isApplied, CLOSED_STATUSES } from './lib/applied-gate.mjs';
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

// ── Identity matching for the nightly report ───────────────────────────────
//
// Both errors below were live on 2026-09-02. Matching by company name hid the
// only decision VP had made in three weeks; matching by canonKey alone would
// have nagged him about an application he sent on 08-05, because the tracker
// records the posting's fuller title.

const TRACKER = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 3 | 2026-08-05 | Anthropic | Product Manager, Claude Code / Claude Tag | 4 | Applied | cv.pdf (ai-infra) | - | Follow up ~2026-08-19. https://job-boards.greenhouse.io/anthropic/jobs/5251866008 |
| 4 | 2026-08-04 | Mercury | Senior Product Marketing Manager, Cards & Spend Management | 1 | Applied | output/mercury-senior-product-marketing-manager-cards-spend/cv.pdf | - | Backfilled 2026-08-10. |
| 6 | 2026-08-04 | GitLab | Senior Product Manager, Plan to Code | 5 | Applied | output/gitlab-senior-product-manager-plan-to-code/cv.pdf | - | Backfilled. |
| 7 | 2026-08-04 | GitLab | Staff Product Manager,  RevOps & Finance Systems | 5 | Applied | output/gitlab-staff-product-manager-revops-finance-systems/cv.pdf | - | Backfilled. |
| 8 | 2026-08-01 | Acme | Product Manager, Widgets | 4 | Evaluated | - | - | not sent yet https://boards.greenhouse.io/acme/jobs/1 |
`;

const ids = parseAppliedIdentities(TRACKER);

// The regression that started this: a third GitLab role, approved 09-01, whose
// company already appeared twice on the tracker.
eq('a new role at an already-applied company is NOT applied',
  isApplied({ company: 'GitLab', role: 'Senior Product Manager, Growth',
              slug: 'gitlab-senior-product-manager-growth',
              applyUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8684348002' }, ids),
  false);

// The opposite error: same application, fuller title on the tracker. Only the
// URL ties them together.
eq('a retitled posting is matched by URL',
  isApplied({ company: 'Anthropic', role: 'Product Manager, Claude Code',
              slug: 'anthropic-product-manager-claude-code',
              applyUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/5251866008' }, ids),
  true);

eq('a hand-backfilled row is matched by output slug',
  isApplied({ company: 'Mercury', role: 'Some Retitled Thing',
              slug: 'mercury-senior-product-marketing-manager-cards-spend',
              applyUrl: 'https://example.invalid/gone' }, ids),
  true);

eq('canonKey still matches when there is no url or slug',
  isApplied({ company: 'GitLab', role: 'Senior Product Manager, Plan to Code' }, ids),
  true);

// ⚠ `evaluated` means "on the tracker, not yet sent" — the exact thing the
// report exists to shout about. A URL match must not override the status.
eq('an evaluated row does not count as applied',
  isApplied({ company: 'Acme', role: 'Product Manager, Widgets',
              applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }, ids),
  false);

eq('sourceUrl is used when applyUrl is absent',
  isApplied({ company: 'Anthropic', role: 'Totally Different',
              sourceUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/5251866008' }, ids),
  true);

eq('identities are parsed from closed rows only', ids.keys.size, 4);
eq('urls are collected', ids.urls.size >= 1, true);
eq('slugs are collected', ids.slugs.has('mercury-senior-product-marketing-manager-cards-spend'), true);

// Degenerate inputs must not throw.
eq('empty tracker yields empty identities', parseAppliedIdentities('').keys.size, 0);
eq('null tracker yields empty identities', parseAppliedIdentities(null).urls.size, 0);
eq('a null card is not applied', isApplied(null, ids), false);
eq('missing identities is not applied', isApplied({ company: 'A', role: 'B' }, undefined), false);

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
