#!/usr/bin/env node

/**
 * measure-req-lifespan.mjs — how long does a requisition actually stay open?
 *
 * VP, 2026-08-06: "freshness should be at whatever means the role is actually
 * open and being considered, not just sitting there. we want roles that the
 * employer actually wants filled soon. whether thats 1 day, 2 days 3 days 2
 * weeks i dont know. you are supposed to become an expert on it and know."
 *
 * He is right that days-since-posted is a proxy and a bad one. FRESH_MAX_AGE_DAYS
 * is currently 3, which is simultaneously too tight (a 6-day-old Brex req is
 * being actively filled) and too loose (a 2-day-old repost of an evergreen
 * pipeline listing nobody intends to fill this quarter). This measures the thing
 * the proxy is standing in for.
 *
 * METHOD. data/scan-history.tsv records first_seen for 1,667 postings. 713 of
 * them are Greenhouse or Ashby, and both publish a board API listing every job
 * currently open - so membership in that list is an authoritative alive/dead
 * signal, and one request covers an entire board. For each posting we then know:
 * it was open when we first saw it, and it is or is not open today.
 *
 * That yields a right-censored survival curve: "of the postings first seen N days
 * ago, what fraction are still open?" It cannot say exactly when a role closed -
 * scan-history has no last_seen column, which is itself worth fixing - but it
 * answers the question the age gate is actually trying to answer.
 *
 * Read-only. Makes one API call per distinct board.
 *
 * Usage: node measure-req-lifespan.mjs [--json] [--limit-boards N]
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const ROOT = process.env.CAREER_OPS_ROOT ?? process.cwd();
const AS_JSON = process.argv.includes('--json');
const LIMIT = (() => { const i = process.argv.indexOf('--limit-boards'); return i >= 0 ? Number(process.argv[i + 1]) : Infinity; })();

const tsv = await readFile(path.join(ROOT, 'data', 'scan-history.tsv'), 'utf8');
const rows = tsv.split('\n').slice(1).filter(Boolean).map((l) => {
  const [url, first_seen, portal, title, company] = l.split('\t');
  return { url, first_seen, portal, title, company };
});

const DAY = 86400000;
const today = Date.now();
const ageOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((today - t) / DAY) : null;
};

// ── classify each row into a board we can ask about ───────────────────────
function ref(url) {
  const u = String(url || '');
  let m = /job-boards\.greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/i.exec(u)
       || /boards\.greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/i.exec(u);
  if (m) return { kind: 'greenhouse', board: m[1].toLowerCase(), id: m[2] };
  m = /jobs\.ashbyhq\.com\/([a-z0-9._-]+)\/([0-9a-f-]{36})/i.exec(u);
  if (m) return { kind: 'ashby', board: m[1].toLowerCase(), id: m[2].toLowerCase() };
  return null;
}

const tracked = [];
for (const r of rows) {
  const k = ref(r.url);
  const age = ageOf(r.first_seen);
  if (k && age != null) tracked.push({ ...r, ...k, age });
}

const boards = new Map();
for (const t of tracked) {
  const key = `${t.kind}:${t.board}`;
  if (!boards.has(key)) boards.set(key, { kind: t.kind, board: t.board, rows: [] });
  boards.get(key).rows.push(t);
}

// ── ask each board what is still open ─────────────────────────────────────
async function liveIds(kind, board) {
  try {
    if (kind === 'greenhouse') {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`,
        { headers: { 'User-Agent': 'career-ops/1.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      const d = await res.json();
      return new Set((d.jobs || []).map((j) => String(j.id)));
    }
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${board}`,
      { headers: { 'User-Agent': 'career-ops/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const d = await res.json();
    return new Set((d.jobs || []).map((j) => String(j.id || '').toLowerCase()));
  } catch { return null; }
}

const results = [];
let unreachable = 0;
const boardList = [...boards.values()].sort((a, b) => b.rows.length - a.rows.length).slice(0, LIMIT);
for (const b of boardList) {
  const live = await liveIds(b.kind, b.board);
  if (!live) { unreachable += b.rows.length; continue; }
  for (const r of b.rows) results.push({ ...r, alive: live.has(String(r.id)) });
}

// ── the survival curve ────────────────────────────────────────────────────
const BUCKETS = [
  [0, 3], [4, 7], [8, 14], [15, 21], [22, 30], [31, 45], [46, 60], [61, 90], [91, 9999],
];
const curve = BUCKETS.map(([lo, hi]) => {
  const inb = results.filter((r) => r.age >= lo && r.age <= hi);
  const alive = inb.filter((r) => r.alive).length;
  return { lo, hi, n: inb.length, alive, pct: inb.length ? (100 * alive / inb.length) : null };
});

// ── per-employer: who runs evergreen reqs, who actually closes them ──────
// ⚠ CONTROL FOR THE OBSERVATION WINDOW. Ranking employers by raw percent-open
// is confounded: a board we started tracking eight days ago shows 100% open
// because nothing has had TIME to close, not because it never closes. Democracy
// Prep, Scale AI and Braze all scored 100% on that measure with an oldest
// posting of 8 days. Only postings we have watched for at least MATURE days can
// say anything about whether an employer closes its requisitions.
const MATURE = 30;
const byCompany = new Map();
for (const r of results) {
  if (r.age < MATURE) continue;
  const c = (r.company || '?').trim();
  if (!byCompany.has(c)) byCompany.set(c, { n: 0, alive: 0, ages: [] });
  const e = byCompany.get(c);
  e.n++; if (r.alive) { e.alive++; e.ages.push(r.age); }
}
const evergreen = [...byCompany.entries()]
  .filter(([, e]) => e.n >= 4)
  .map(([c, e]) => ({
    company: c, n: e.n, alive: e.alive,
    pctAlive: 100 * e.alive / e.n,
    oldestAlive: e.ages.length ? Math.max(...e.ages) : null,
  }))
  .sort((a, b) => b.pctAlive - a.pctAlive || b.oldestAlive - a.oldestAlive);

// Persist what the gate needs: which employers actually close requisitions.
// enqueue-review.mjs reads this rather than recomputing, so the nightly gate
// costs no API calls, and the file is refreshed by running this script.
await writeFile(path.join(ROOT, 'data', 'employer-closure.json'), JSON.stringify({
  measuredAt: new Date().toISOString().slice(0, 10),
  matureDays: MATURE,
  note: 'pctAlive = share of this employer\'s postings, watched MATURE+ days, that are STILL OPEN. High means the board is evergreen and an old posting there signals nothing about hiring intent.',
  curve,
  employers: Object.fromEntries(evergreen.map((e) => [e.company.toLowerCase(), { n: e.n, pctAlive: Math.round(e.pctAlive) }])),
}, null, 2));

if (AS_JSON) {
  console.log(JSON.stringify({ curve, evergreen, total: results.length, unreachable }, null, 2));
  process.exit(0);
}

console.log(`\nreq-lifespan — ${results.length} postings across ${boardList.length} boards`);
console.log(`(${unreachable} on boards that did not answer; ${rows.length - tracked.length} not on an API-backed ATS)\n`);

console.log('SURVIVAL — of postings first seen N days ago, how many are still open today?');
console.log('  age at first sight     n    still open');
for (const c of curve) {
  if (!c.n) continue;
  const label = c.hi > 1000 ? `${c.lo}+ d` : `${c.lo}-${c.hi} d`;
  const bar = '█'.repeat(Math.round((c.pct ?? 0) / 4));
  console.log(`  ${label.padStart(10)}  ${String(c.n).padStart(6)}   ${String(Math.round(c.pct)).padStart(3)}%  ${bar}`);
}

console.log(`\nEVERGREEN EMPLOYERS — postings watched ${MATURE}+ days only, so the window is comparable`);
console.log('  company                          n   open   oldest still open');
for (const e of evergreen.slice(0, 12)) {
  console.log(`  ${e.company.slice(0, 30).padEnd(30)} ${String(e.n).padStart(3)}  ${String(Math.round(e.pctAlive)).padStart(3)}%   ${e.oldestAlive ?? '-'}d`);
}
console.log('\n  (the bottom of this list closes its reqs; the top does not)');
const closers = evergreen.slice().reverse().slice(0, 8);
for (const e of closers) {
  console.log(`  ${e.company.slice(0, 30).padEnd(30)} ${String(e.n).padStart(3)}  ${String(Math.round(e.pctAlive)).padStart(3)}%   ${e.oldestAlive ?? '-'}d`);
}
console.log('');
