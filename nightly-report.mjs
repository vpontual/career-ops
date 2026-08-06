#!/usr/bin/env node

/**
 * nightly-report.mjs — the missing closing step.
 *
 * WHY THIS IS THE MOST IMPORTANT SCRIPT IN THE REPO. After 107 days the system
 * had discovered 1,667 postings, scored 1,013, generated 602 PDFs — and produced
 * 3 submitted applications, 0 interviews, 0 offers. The audit's verdict was that
 * the pipeline terminates at artifact production: nothing converts an APPROVED
 * card into a submitted application, and nothing ever tells VP there is anything
 * waiting. MISSION-nyc-job.md diagnosed the same thing on 2026-07-29 — "the
 * funnel dies between pack-is-staged" — and it was still true eight days later.
 *
 * The measured cost on 2026-08-06: five approved packs, decided two days
 * earlier, complete on disk, against requisitions that all still returned HTTP
 * 200. Free applications already paid for and not cashed.
 *
 * So this reports against data/applications.md — the only file in the repo that
 * measures the mission, and the only one nightly.sh never writes to.
 *
 * Usage: node nightly-report.mjs [--quiet] [--no-liveness]
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { notify } from './lib/notify.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUIET = process.argv.includes('--quiet');
const NO_LIVENESS = process.argv.includes('--no-liveness');

const read = async (p) => { try { return await readFile(p, 'utf-8'); } catch { return ''; } };
const days = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

const queue = JSON.parse(await read(path.join(ROOT, 'data', 'review-queue.json')) || '{"items":[]}');
const applications = await read(path.join(ROOT, 'data', 'applications.md'));

// Which approved roles have actually been applied to? applications.md is a
// markdown table; match on company name, which is the one field that survives
// hand-editing.
const appliedCompanies = new Set(
  applications.split('\n').filter((l) => l.startsWith('|'))
    .map((l) => (l.split('|')[3] || '').trim().toLowerCase())
    .filter(Boolean)
);

const pending = queue.items.filter((i) => !i.decision);
const approved = queue.items.filter((i) => i.decision === 'approved');
const unapplied = approved.filter((i) => !appliedCompanies.has(String(i.company || '').toLowerCase()));

// Are those requisitions still open? An approved pack against a dead req is not
// a missed opportunity, and saying so wrongly would make the whole nag ignorable.
const liveness = [];
if (!NO_LIVENESS) {
  for (const it of unapplied) {
    const url = it.applyUrl || it.sourceUrl;
    if (!url) { liveness.push({ it, code: null }); continue; }
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      liveness.push({ it, code: res.status });
    } catch { liveness.push({ it, code: null }); }
  }
}
const stillLive = liveness.filter((l) => l.code === 200);

const held = await read(path.join(ROOT, 'data', 'held-no-pack.md'));
const heldCount = (held.match(/^- \[ \]/gm) || []).length;
const unresolved = await read(path.join(ROOT, 'data', 'unresolved-apply-paths.md'));
const unresolvedCount = (unresolved.match(/^- \[ \]/gm) || []).length;

const appliedTotal = applications.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).length;

// ── the message ───────────────────────────────────────────────────────────
const lines = [];
lines.push('career-ops nightly');
lines.push('');
lines.push(`Submitted to date: ${appliedTotal}`);
lines.push(`Pending your review: ${pending.length}`);

if (unapplied.length) {
  const oldest = unapplied
    .map((i) => days(i.decidedAt))
    .filter((d) => d != null)
    .sort((a, b) => b - a)[0];
  lines.push('');
  lines.push(`APPROVED BUT NOT SUBMITTED: ${unapplied.length}` +
    (oldest != null ? ` (oldest decided ${oldest}d ago)` : ''));
  if (!NO_LIVENESS) lines.push(`  ${stillLive.length} confirmed open, ${liveness.length - stillLive.length} unconfirmed`);
  for (const l of liveness.length ? liveness : unapplied.map((it) => ({ it, code: null }))) {
    // UNCONFIRMED is not DEAD. Several ATS hosts refuse a server-side fetch
    // (bot protection, JS-only shells), so a failure here says nothing about
    // whether the requisition is open. Calling those closed would give VP a
    // reason to ignore the only message this system sends him.
    const mark = l.code === 200 ? 'OPEN' : l.code ? `HTTP ${l.code}` : 'UNCONFIRMED';
    lines.push(`  [${mark}] ${l.it.company} — ${String(l.it.role).slice(0, 46)}`);
  }
  if (liveness.some((l) => l.code !== 200)) {
    lines.push('  (UNCONFIRMED = our fetch was refused, not evidence the role is closed)');
  }
  lines.push('  These packs are already built. Nothing else in the pipeline will move them.');
}

if (heldCount) lines.push(`\nHeld for a missing CV: ${heldCount} (data/held-no-pack.md)`);
if (unresolvedCount) lines.push(`Aggregator-only, no form: ${unresolvedCount} (data/unresolved-apply-paths.md)`);

const gateFailures = process.env.CAREER_OPS_GATE_FAILURES || '';
if (gateFailures.trim()) {
  lines.push('');
  lines.push(`GATES FAILED: ${gateFailures.trim()}`);
}

const msg = lines.join('\n');
console.log('\n' + msg + '\n');

// Only interrupt VP when there is something he alone can act on: an approved
// role nobody has submitted, or a broken run. A quiet night stays quiet - a
// notifier that fires nightly regardless is one he stops reading.
const worthSending = unapplied.length > 0 || gateFailures.trim().length > 0;
if (!QUIET && worthSending) await notify(msg);
else if (!worthSending) console.log('[notify] nothing actionable — not sending');

process.exit(0);
