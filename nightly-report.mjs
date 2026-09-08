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
 * ⚠ 2026-09-02 — THE REPORT ITSELF WAS WRONG IN BOTH DIRECTIONS FOR THREE WEEKS,
 * and being unsent was the only thing that stopped it doing damage. Two fixes:
 *
 *   1. LIVENESS. It called any HTTP 200 OPEN. Greenhouse answers a dead job by
 *      redirecting to `<board>?error=true`, which is a 200, so Wikimedia and
 *      Nava PBC — both closed — were advertised as "[OPEN] … confirmed open"
 *      every night from 08-11. It now classifies through liveness-core.mjs, the
 *      same rules stage-applications.mjs prunes with, and a DEAD role stops
 *      being counted as owed. Nagging about corpses is how a nag gets ignored.
 *   2. IDENTITY. It matched approved cards to the tracker BY COMPANY NAME, so
 *      GitLab | Senior Product Manager, Growth — approved 09-01, pack complete,
 *      posting live — was silently counted as submitted because two other
 *      GitLab rows existed. The one decision VP made in three weeks was the one
 *      thing this script could not see. See lib/applied-gate.mjs for why the
 *      match needs all three of URL, output slug and canonKey.
 *
 * Usage: node nightly-report.mjs [--quiet] [--no-liveness]
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// ⚠ LOAD .env BEFORE lib/notify.mjs IS IMPORTED. notify reads its token and
// chat id into module-level constants at import time, and nightly.sh never
// sources .env — it runs `/usr/bin/node nightly-report.mjs` with the plain cron
// environment. Without this line the credentials sit correctly in .env while
// notify reports "unset — not sent" forever: a config that looks done, changes
// nothing, and fails silently, which is the exact class of bug the rest of this
// file was rewritten to remove. rank-leads.mjs and gemini-eval.mjs bootstrap the
// same way for the same reason.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'), quiet: true });

// Where VP reads this pipeline. Deployment-specific, so it is read from the
// environment and defaulted to localhost rather than written into a public
// fork's source. Trailing slashes are stripped so `${UI_URL}/today` is right
// whichever way it was set.
const UI_URL = (process.env.CAREER_OPS_UI_URL || 'http://localhost:3340').replace(/\/+$/, '');

const { notify, notifyEnabled } = await import('./lib/notify.mjs');
import { loadAppliedIdentities, isApplied } from './lib/applied-gate.mjs';
import { classifyLivenessFromFetch, htmlToText } from './liveness-core.mjs';

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

// Which approved roles have actually been submitted? Three identities, because
// no single one survives both hand-edited rows and retitled postings.
const appliedIds = await loadAppliedIdentities(ROOT);

const pending = queue.items.filter((i) => !i.decision);

// Tonight's slate — the few roles VP should act on, chosen by lib/slate.mjs and
// written by build-slate.mjs.
//
// ⚠ THE MESSAGE REPORTS THE SLATE, NOT THE BACKLOG. "Pending your review: 277"
// was the second line of every report for weeks; it is a number that only ever
// goes up, it named no action, and it was the same number whether the night had
// produced something or nothing. It stays in the log, where it is a health
// signal, and leaves the message, which is supposed to be a request.
const slate = JSON.parse(await read(path.join(ROOT, 'data', 'slate.json')) || 'null');
const slateIsToday = slate && slate.date === new Date().toISOString().slice(0, 10);

// Cards the nightly retired because their freshness window closed while they
// sat here. An FYI, never an alert: nothing is owed and nothing is broken, and
// `clear` puts any of them back. Reported so a queue that visibly shrank
// overnight has a stated reason, rather than looking like data loss.
const expiredToday = queue.items.filter((i) =>
  i.decision === 'expired' && String(i.decidedAt ?? '').slice(0, 10) === new Date().toISOString().slice(0, 10));
const approved = queue.items.filter((i) => i.decision === 'approved');
const unapplied = approved.filter((i) => !isApplied(i, appliedIds));

// Are those requisitions still open? An approved pack against a dead req is not
// a missed opportunity, and saying so wrongly would make the whole nag ignorable.
const liveness = [];
if (!NO_LIVENESS) {
  for (const it of unapplied) {
    const url = it.applyUrl || it.sourceUrl;
    if (!url) { liveness.push({ it, verdict: { result: 'uncertain', reason: 'no url on the card' } }); continue; }
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      const bodyText = htmlToText(await res.text().catch(() => ''));
      liveness.push({ it, verdict: classifyLivenessFromFetch({ status: res.status, finalUrl: res.url, bodyText }) });
    } catch (err) {
      // ⚠ NOT dead. A fetch that never completed — timeout, DNS, TLS, a
      // Cloudflare challenge — says nothing about the requisition.
      liveness.push({ it, verdict: { result: 'uncertain', reason: `fetch failed: ${String(err.message).split('\n')[0]}` } });
    }
  }
}

const verdictOf = (it) => liveness.find((l) => l.it === it)?.verdict ?? { result: 'uncertain', reason: 'not checked' };

// A closed requisition is not owed. This is the line that lets the nag stop.
const dead = NO_LIVENESS ? [] : unapplied.filter((it) => verdictOf(it).result === 'expired');
const owed = unapplied.filter((it) => !dead.includes(it));

// ⚠ A SIDE-FILE ENQUEUE DID NOT WRITE TODAY IS A SNAPSHOT, NOT A COUNT.
// held-no-pack.md was written only on nights that held something, so it froze
// on 2026-08-18 and this report announced its single row every night for a
// fortnight about a role long since promoted. enqueue-review.mjs now rewrites
// both files every run, so a "Written by … on <date>" that is not today means
// the step did not run — which is worth saying and not worth counting.
const todayIso = new Date().toISOString().slice(0, 10);
const writtenOn = (text) => (String(text).match(/Written by [^\n]*? on (\d{4}-\d{2}-\d{2})/) || [])[1] ?? null;
const sideFile = (text) => {
  const on = writtenOn(text);
  return { on, count: on === todayIso ? (text.match(/^- \[ \]/gm) || []).length : null };
};

const heldFile = sideFile(await read(path.join(ROOT, 'data', 'held-no-pack.md')));
const unresolvedFile = sideFile(await read(path.join(ROOT, 'data', 'unresolved-apply-paths.md')));

const appliedTotal = applications.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).length;

// ── the message ───────────────────────────────────────────────────────────
const lines = [];
lines.push('career-ops nightly');
lines.push('');
lines.push(`Submitted to date: ${appliedTotal}`);

if (slateIsToday && slate.items?.length) {
  lines.push('');
  lines.push(`TODAY (${slate.items.length}):`);
  for (const it of slate.items) {
    lines.push(`  ${it.company} — ${String(it.role).slice(0, 44)}`);
    // Three reasons only — the page shows all of them, and a phone notification
    // that needs scrolling is one he stops opening.
    //
    // ⚠ URGENCY FIRST, NOT SOURCE ORDER. lib/slate.mjs emits `why` in the order
    // its comparator reads the facts, which puts the deadline LAST. Taking the
    // first three verbatim therefore cut "closes in 2d" off the one card that
    // was chosen BECAUSE it closes in 2d, and left it looking like the least
    // urgent of the three. A truncation that drops the reason for the pick is
    // worse than no reason at all.
    const urgent = (w) => /closes in|deadline|pre-empt/i.test(w);
    const reasons = [...(it.why || [])].sort((a, b) => Number(urgent(b)) - Number(urgent(a)));
    const why = reasons.slice(0, 3).join(' · ');
    if (why) lines.push(`    ${why}`);
  }
  // The host is deployment-specific and this repo is a public fork, so it comes
  // from the environment, never the source. CAREER_OPS_UI_URL lives in .env
  // beside every other deployment value; without it the report still names the
  // right path, just on localhost.
  lines.push(`  ${UI_URL}/today`);
} else if (slate && !slateIsToday) {
  lines.push('');
  lines.push(`⚠ the slate is from ${slate.date}, not today — build-slate did not run`);
}

if (owed.length) {
  const oldest = owed
    .map((i) => days(i.decidedAt))
    .filter((d) => d != null)
    .sort((a, b) => b - a)[0];
  const open = owed.filter((it) => verdictOf(it).result === 'active').length;
  lines.push('');
  lines.push(`APPROVED BUT NOT SUBMITTED: ${owed.length}` +
    (oldest != null ? ` (oldest decided ${oldest}d ago)` : ''));
  if (!NO_LIVENESS) lines.push(`  ${open} open, ${owed.length - open} unconfirmed`);
  for (const it of owed) {
    // UNCONFIRMED is not DEAD. Several ATS hosts refuse a server-side fetch
    // (bot protection, JS-only shells), so a failure here says nothing about
    // whether the requisition is open. Calling those closed would give VP a
    // reason to ignore the only message this system sends him.
    const mark = NO_LIVENESS ? 'APPROVED' : (verdictOf(it).result === 'active' ? 'OPEN' : 'UNCONFIRMED');
    lines.push(`  [${mark}] ${it.company} — ${String(it.role).slice(0, 46)}`);
  }
  if (!NO_LIVENESS && owed.some((it) => verdictOf(it).result !== 'active')) {
    lines.push('  (UNCONFIRMED = our fetch was refused, not evidence the role is closed)');
  }
  lines.push('  These packs are already built. Nothing else in the pipeline will move them.');
}

if (dead.length) {
  lines.push('');
  lines.push(`CLOSED BEFORE YOU SUBMITTED: ${dead.length}`);
  for (const it of dead) {
    lines.push(`  [DEAD] ${it.company} — ${String(it.role).slice(0, 46)}`);
    lines.push(`         ${verdictOf(it).reason}`);
  }
}

const sideLine = (label, file, path_) => {
  if (file.count === null) return `${label}: not refreshed tonight — ${path_} last written ${file.on ?? 'never'}`;
  return file.count ? `${label}: ${file.count} (${path_})` : null;
};
for (const l of [
  sideLine('Held for a missing CV', heldFile, 'data/held-no-pack.md'),
  sideLine('Aggregator-only, no form', unresolvedFile, 'data/unresolved-apply-paths.md'),
].filter(Boolean)) lines.push((lines[lines.length - 1] ? '\n' : '') + l);

if (expiredToday.length) lines.push(`\nExpired tonight: ${expiredToday.length} card(s) whose window closed (reversible — 'clear' on the card)`);

const gateFailures = process.env.CAREER_OPS_GATE_FAILURES || '';
if (gateFailures.trim()) {
  lines.push('');
  lines.push(`GATES FAILED: ${gateFailures.trim()}`);
}

const msg = lines.join('\n');
console.log('\n' + msg + '\n');
console.log(`[log-only] pending review queue: ${pending.length}` +
  (expiredToday.length ? `, expired tonight: ${expiredToday.length}` : ''));

// Only interrupt VP when there is something he alone can act on: an approved
// role nobody has submitted, or a broken run. A quiet night stays quiet - a
// notifier that fires nightly regardless is one he stops reading.
//
// ⚠ `owed`, not `unapplied`: a dead requisition is reported once in the body if
// it is there, but it must never be the REASON a message is sent. That is the
// difference between a nag that ends and one that ran for three weeks.
const worthSending = owed.length > 0 || gateFailures.trim().length > 0 ||
  (slateIsToday && (slate.items?.length ?? 0) > 0);
if (!notifyEnabled) console.log('[notify] telegram not configured — set CAREER_OPS_TELEGRAM_TOKEN/CHAT in .env');
if (!QUIET && worthSending) await notify(msg);
else if (!worthSending) console.log('[notify] nothing actionable — not sending');

process.exit(0);
