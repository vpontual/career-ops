/**
 * lib/applied-gate.mjs — roles that already left the building, so staging never
 * rebuilds a pack for them.
 *
 * THE BUG THIS FIXES: stage-applications.mjs picks candidates out of
 * lead-scores.json by score tier and freshness, and never consults
 * data/applications.md. Nothing in that chain knows an application was already
 * submitted, so an applied role regenerates its cover letter, CV and PDFs every
 * single night for as long as its posting stays fresh. Caught on 2026-08-13:
 * Harvey's "Senior Product Manager, Command Center" was applied to on
 * 2026-08-06 and re-staged at 04:46 that morning — a week of nightly Gemini
 * calls and Chromium renders spent rebuilding a pack for a decision VP had
 * already made, and which had in fact been REJECTED by then.
 *
 * ⚠ WHY THIS DOES NOT BREAK THE STAGING INVARIANT ("anything enqueue-review can
 * card, this step can build"). A role only reaches data/held-no-pack.md through
 * enqueue-review's NEW-card loop, and that loop skips any canonical key already
 * carried in the queue under a decision. Every role this gate hides is by
 * definition one VP already decided on, so it is already carded and can never
 * re-enter that loop. Verified against enqueue-review.mjs before shipping — if
 * that skip is ever removed, this gate has to be re-checked with it.
 *
 * ⚠ WHAT IS NOT GATED: `evaluated`. It is the one canonical status that means
 * "on the tracker, not yet sent", so those roles still need a pack built.
 * Everything else — applied, responded, interview, offer, rejected, discarded,
 * skip — is either already submitted or deliberately closed out.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { canonKey } from './canonical.mjs';
import { normalizeStatus } from './status.mjs';

/**
 * Canonical statuses that mean "do not rebuild this pack". Deliberately a
 * denylist of the closed states rather than `!== 'evaluated'`: an unparseable
 * or newly-invented status should fall through and still get a pack, because
 * failing to build one is the more expensive error (it lands the role in
 * held-no-pack.md with a remedy that has already run).
 */
export const CLOSED_STATUSES = new Set([
  'applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip',
]);

/**
 * Parse applications.md text → Map<canonKey, {company, role, status, date}>.
 * Column layout mirrors analyze-patterns.mjs's parseTracker exactly:
 *   ['', '#', date, company, role, score, status, pdf, report, notes, '']
 */
export function parseAppliedKeys(text) {
  const out = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 9) continue;
    if (isNaN(parseInt(parts[1]))) continue;          // header / separator row
    const company = parts[3], role = parts[4];
    if (!company || !role) continue;
    const status = normalizeStatus(parts[6]);
    if (!CLOSED_STATUSES.has(status)) continue;
    const key = canonKey(company, role);
    // First closed row wins. Rows are append-ordered, so this keeps the
    // earliest record of a role rather than a later duplicate re-entry.
    if (!out.has(key)) out.set(key, { company, role, status, date: parts[2] });
  }
  return out;
}

/** Load data/applications.md (absent → empty map = nothing gated). */
export async function loadAppliedKeys(root) {
  try {
    return parseAppliedKeys(await readFile(path.join(root, 'data', 'applications.md'), 'utf-8'));
  } catch {
    return new Map();
  }
}
