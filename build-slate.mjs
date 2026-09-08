#!/usr/bin/env node

/**
 * build-slate.mjs — choose the handful of roles VP should act on today.
 *
 * WHY THIS EXISTS. The pipeline's terminal artifact was a review QUEUE, and a
 * queue only grows. On 2026-09-02 it held 277 pending cards; 131 were already
 * past the freshness window that would refuse to mint them today, 58 were over
 * thirty days old, and 71 (the whole civic track) could not be reached from the
 * UI at all. VP cleared it by hand once, on 4-5 August, rejected 57 of 61 on age
 * — and made one decision in the three weeks that followed. Nothing was broken:
 * there was simply no answer to "what should I do now", only "here is
 * everything".
 *
 * So the queue stops being the thing he opens. This writes data/slate.json: a
 * small, dated, ordered set with a reason attached to every pick, which /today
 * renders and nightly-report.mjs sends. The queue survives as the everything
 * else view.
 *
 * ⚠ ALL POLICY LIVES IN lib/slate.mjs, WHICH IS PURE AND TESTED (119 cases).
 * This file only gathers inputs and writes the answer down. Anything that
 * decides an ordering belongs there, where it can be tested without a disk.
 *
 * Usage: node build-slate.mjs [--dry-run] [--date YYYY-MM-DD]
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { buildSlate, DEFAULT_QUOTAS, DEFAULT_ROTATION, DEFAULT_MAX_DAYS_ON_SLATE } from './lib/slate.mjs';
import { loadFreshnessPolicy } from './lib/freshness.mjs';
import { parseJd } from './lib/jd-parse.mjs';
import { loadAppliedIdentities, isApplied } from './lib/applied-gate.mjs';
import { classifyLivenessFromFetch, htmlToText } from './liveness-core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// What a finding says, for packs written before answers-meta.enumerated existed.
//
// ⚠ FOUR ALTERNATIVES, NOT ONE, AND THAT IS NOT BELT-AND-BRACES. The footer
// sentence was added mid-August; 21 findings predate it - every Citi Workday
// req, all reading "behind an account wall" with no footer at all - and a
// marker that only knew the footer counted all 21 as ANSWERED, which is the
// exact bug this fallback exists to avoid. The other three are the `reason`
// strings generate-answers renders into the "Form inspected:" line, one per
// branch. test-slate.mjs asserts each is still emitted there.
const FINDING_MARKER = new RegExp([
  'no field list could be read for this pack',   // the footer (2026-08-17 on)
  'behind an account wall',                       // a wall seen, or known for the board
  'exposed no application field',                 // a read that completed and found none
  'the application form could not be read',       // the default reason
].join('|'));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const dateArg = (() => { const i = argv.indexOf('--date'); return i >= 0 ? argv[i + 1] : null; })();
const TODAY = dateArg || new Date().toISOString().slice(0, 10);

const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const SLATE = path.join(ROOT, 'data', 'slate.json');
const HISTORY = path.join(ROOT, 'data', 'slate-history.json');
const CONFIG = path.join(ROOT, 'config', 'slate.yml');

/**
 * Whether output/<slug>/ holds ANSWERS or a finding that the form is unreadable.
 *
 * Prefers answers-meta.json's `enumerated`, which generate-answers writes on
 * both paths. Falls back to the finding's own sentence for packs written before
 * that field existed — a fallback that is safe only because renderWallFinding()
 * emits one fixed string, and it is asserted in test-slate.mjs so a reword of
 * that sentence fails a test rather than silently re-promoting 127 packs.
 *
 * @returns {{answers:boolean, formUnreadable:boolean}}
 */
function readAnswersState(dir) {
  const md = path.join(dir, 'answers.md');
  if (!existsSync(md)) return { answers: false, formUnreadable: false };
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, 'answers-meta.json'), 'utf-8'));
    if (typeof meta.enumerated === 'boolean') {
      return { answers: meta.enumerated, formUnreadable: !meta.enumerated };
    }
  } catch { /* pre-2026-09-08 pack, or no meta at all — fall through */ }
  const unreadable = FINDING_MARKER.test(readFileSync(md, 'utf-8'));
  return { answers: !unreadable, formUnreadable: unreadable };
}

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, 'utf-8')); } catch { return fallback; }
};

async function main() {
  const queue = await readJson(QUEUE, { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];

  // ⚠ Config is read live, not baked in. VP owns the shape of his own day, and
  // a number he has to redeploy to change is a number he will not change.
  let cfg = {};
  try { cfg = yaml.load(await readFile(CONFIG, 'utf-8')) || {}; }
  catch { console.log(`no ${path.relative(ROOT, CONFIG)} — using built-in defaults`); }

  // Deadlines: NYC is the only source publishing a real close date. Join JD →
  // card by URL, because scoreSource is absent on cards minted before it was
  // added and a missing deadline must not look like "no deadline".
  const deadlineByUrl = new Map();
  const jdFiles = (await readdir(path.join(ROOT, 'jds'))).filter((f) => f.endsWith('.md'));
  for (const f of jdFiles) {
    const jd = parseJd(await readFile(path.join(ROOT, 'jds', f), 'utf-8'), f);
    if (jd.post_until && jd.url) deadlineByUrl.set(jd.url, jd.post_until);
  }

  const deadlines = {};
  const packs = {};
  for (const it of items) {
    const d = deadlineByUrl.get(it.sourceUrl) || deadlineByUrl.get(it.applyUrl);
    if (d) deadlines[it.slug] = d;

    // What is actually on disk for this role.
    //
    // ⚠ NOT existsSync('answers.md'). That file has TWO meanings: a filled form,
    // or a dated finding that the form could not be read at all (an account wall
    // on NYC Jobs or OLAS), whose own last line says "nothing above is an
    // answer". 127 of the 514 packs on 2026-09-08 were the second kind, and
    // reading the filename counted every one of them as ready — so /today badged
    // "answers drafted" over a pack with no answers in it, and ranked it above
    // a genuinely finished one.
    //
    // answers-meta.json's `enumerated` is written by both of generate-answers'
    // writers, so it is the writer's own statement rather than a reader's guess.
    // Absent on packs written before 2026-09-08: those fall back to the prose,
    // which is checkable because renderWallFinding() has always emitted that
    // exact sentence. A drafted cover letter means the one thing VP would
    // otherwise write by hand is already written. Neither is a claim the pack is
    // GOOD — only that it is finished.
    const dir = path.join(ROOT, 'output', it.slug);
    packs[it.slug] = { ...readAnswersState(dir), coverDrafted: existsSync(path.join(dir, 'cover-letter.md')) };
  }

  const history = await readJson(HISTORY, {});
  const policy = await loadFreshnessPolicy(ROOT);

  const slate = buildSlate({
    items,
    today: TODAY,
    quotas: cfg.quotas || DEFAULT_QUOTAS,
    rotation: cfg.rotation || DEFAULT_ROTATION,
    n: cfg.n,
    deadlines,
    history,
    maxDaysOnSlate: cfg.maxDaysOnSlate ?? DEFAULT_MAX_DAYS_ON_SLATE,
    packs,
    policy,
  });

  // ── owed ────────────────────────────────────────────────────────────────
  // Work VP has already decided on that nothing downstream will move. Computed
  // here rather than in the page because "has this been submitted?" is policy
  // (three identities, closed statuses only) and lives in lib/applied-gate.mjs.
  //
  // ⚠ A DEAD REQUISITION IS NOT OWED. Two approved packs sat in the nightly
  // report as "[OPEN] … confirmed open" for three weeks while both were closed,
  // because the check followed Greenhouse's error redirect to an HTTP 200. This
  // page would have repeated that lie in a different font — it renders "nothing
  // else in the pipeline will move these" — so it checks, with the same
  // browser-free classifier nightly-report.mjs uses.
  //
  // ⚠ Only `expired` is acted on. `uncertain` means our fetch was refused, not
  // that the role is closed, and a handful of ATS hosts refuse a plain fetch.
  const appliedIds = await loadAppliedIdentities(ROOT);
  const owed = items
    .filter((i) => i.decision === 'approved' && !isApplied(i, appliedIds))
    .map((i) => ({
      kind: 'approved-unsubmitted',
      slug: i.slug, company: i.company, role: i.role,
      applyUrl: i.applyUrl || i.sourceUrl,
      decidedAt: i.decidedAt ?? null,
      daysWaiting: i.decidedAt
        ? Math.max(0, Math.floor((Date.parse(TODAY) - Date.parse(i.decidedAt)) / 86400000))
        : null,
    }))
    .sort((a, b) => (b.daysWaiting ?? 0) - (a.daysWaiting ?? 0));

  for (const o of owed) {                       // sequential; there are never many
    if (!o.applyUrl) { o.liveness = 'uncertain'; continue; }
    try {
      const res = await fetch(o.applyUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      const v = classifyLivenessFromFetch({
        status: res.status, finalUrl: res.url, bodyText: htmlToText(await res.text().catch(() => '')),
      });
      o.liveness = v.result;
      o.livenessReason = v.reason;
    } catch (e) {
      o.liveness = 'uncertain';
      o.livenessReason = `fetch failed: ${String(e.message).split('\n')[0]}`;
    }
  }
  slate.owed = owed;

  console.log(`slate for ${slate.date}: ${slate.items.length} card(s)`);
  const owedLive = owed.filter((o) => o.liveness !== 'expired');
  if (owed.length) {
    console.log(`owed: ${owedLive.length} approved pack(s) nothing else will move` +
      (owed.length - owedLive.length ? `, ${owed.length - owedLive.length} closed before submission` : ''));
  }
  for (const it of slate.items) {
    console.log(`  [${it.track}] ${it.company} — ${String(it.role).slice(0, 44)}`);
    console.log(`      ${(it.why || []).join(' · ')}`);
  }
  if (slate.expired?.length) console.log(`  rolled off the slate: ${slate.expired.length}`);
  if (slate.excluded) console.log(`  excluded: ${JSON.stringify(slate.excluded)}`);

  if (DRY) { console.log('\n--dry-run, nothing written'); return; }

  // First day on the slate, per card. Drives roll-off; a card that leaves and
  // returns starts its clock again, which is deliberate — it is being offered
  // afresh, not re-offered.
  const nextHistory = { ...history };
  const onSlate = new Set(slate.items.map((i) => i.slug));
  for (const slug of onSlate) if (!nextHistory[slug]) nextHistory[slug] = slate.date;
  for (const slug of Object.keys(nextHistory)) if (!onSlate.has(slug)) delete nextHistory[slug];

  await writeFile(SLATE, JSON.stringify(slate, null, 1));
  await writeFile(HISTORY, JSON.stringify(nextHistory, null, 1));
  console.log(`\nwrote ${path.relative(ROOT, SLATE)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
