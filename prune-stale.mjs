#!/usr/bin/env node

/**
 * prune-stale.mjs — take dead and ancient roles off the board.
 *
 * The pipeline has always been additive: scan.mjs appends, nothing ever
 * removes. After three months that leaves ~1300 rows on the board, most of
 * them postings that were filled or pulled weeks ago. A board you cannot
 * trust to be current is a board you stop reading.
 *
 * Two independent reasons to archive a row:
 *
 *   1. AGE — the effective date (the more recent of posted/updated) is older
 *      than ARCHIVE_AGE_DAYS. rank-leads already refuses to score these, so
 *      they are dead weight in the UI by definition.
 *   2. DEAD — the ATS says the req is gone. Checked cheaply through the ATS
 *      JSON APIs where one exists (Greenhouse, Ashby, Lever cover ~400 rows),
 *      and through the existing Playwright checker for everything else.
 *
 * Rows are never deleted. They move to data/pipeline-archive.md with the
 * reason and the date, so a mistaken prune is recoverable and so the archive
 * can answer "how long do these postings actually stay open?" later.
 *
 * Applied roles are always kept regardless of age — the board is also the
 * record of what VP is waiting to hear back on.
 *
 * Usage:
 *   node prune-stale.mjs [--dry-run] [--max-browser N] [--age-days N]
 */

import { readFile, writeFile, appendFile, readdir } from 'fs/promises';
import path from 'path';

const ROOT = process.env.CAREER_OPS_ROOT ?? path.resolve('.');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const ARCHIVE = path.join(ROOT, 'data', 'pipeline-archive.md');
const APPLICATIONS = path.join(ROOT, 'data', 'applications.md');
const JDS = path.join(ROOT, 'jds');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ARCHIVE_AGE_DAYS = num('--age-days', parseInt(process.env.ARCHIVE_AGE_DAYS ?? '45', 10));
// Playwright is ~4s/URL. Bounded so the nightly cron stays under a few minutes;
// unchecked rows simply survive to the next run.
const MAX_BROWSER = num('--max-browser', parseInt(process.env.PRUNE_MAX_BROWSER ?? '60', 10));
const NO_JD_GRACE_DAYS = num('--no-jd-days', parseInt(process.env.NO_JD_GRACE_DAYS ?? '7', 10));

function num(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1 || !argv[i + 1]) return fallback;
  const v = parseInt(argv[i + 1], 10);
  return Number.isFinite(v) ? v : fallback;
}

const today = new Date();
const daysSince = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((today - t) / 86400000);
};

// ---------------------------------------------------------------- pipeline io

// Rows look like: `- [ ] URL | Company | Role | extra | ...`
const ROW_RE = /^- \[( |x|X)\] (\S+)(?: \| (.*))?$/;

function parseRow(line) {
  const m = ROW_RE.exec(line.trim());
  if (!m) return null;
  const [, mark, url, rest = ''] = m;
  const parts = rest.split('|').map((s) => s.trim());
  // Gmail-sourced rows carry the date they landed as the last field. That is
  // the only age signal available for a row whose JD never got fetched.
  const dateCell = parts.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p)).pop();
  return {
    line,
    checked: mark.toLowerCase() === 'x',
    url,
    company: parts[0] ?? '',
    role: parts[1] ?? '',
    addedDays: dateCell ? daysSince(dateCell) : null,
  };
}

// A posting URL addresses one req. A search URL addresses a query, and the
// giveaway is a search path or the query-shaped params recruiters paste in.
const SEARCH_PATH_RE = /\/jobs\/search|\/jobs\/?$|\/search\b|\/job-search|\/careers\/?$/i;
function isSearchUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (SEARCH_PATH_RE.test(u.pathname)) return true;
  const q = u.searchParams;
  return ['keywords', 'q', 'query', 'search'].some((k) => q.has(k)) && !/\d{4,}/.test(u.pathname);
}

// ------------------------------------------------------------------ jd dates

// Map canonical URL -> { posted, updated } from the fetched JD store, so age
// costs no network. fetch-jds writes both as ISO on the `**Posted:**` line.
async function loadJdDates() {
  const byUrl = new Map();
  let files = [];
  try { files = await readdir(JDS); } catch { return byUrl; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    let head;
    try {
      head = (await readFile(path.join(JDS, f), 'utf8')).slice(0, 1200);
    } catch { continue; }
    const url = /^\*\*URL:\*\* (\S+)/m.exec(head)?.[1];
    if (!url) continue;
    const posted = /^\*\*Posted:\*\* (\S+)/m.exec(head)?.[1];
    const updated = /^\*\*Updated:\*\* (\S+)/m.exec(head)?.[1];
    byUrl.set(canon(url), {
      posted: posted ? daysSince(posted) : null,
      updated: updated ? daysSince(updated) : null,
    });
  }
  return byUrl;
}

function canon(u) {
  try {
    const x = new URL(u.trim());
    x.hash = '';
    x.hostname = x.hostname.toLowerCase();
    return x.toString().replace(/\/$/, '');
  } catch {
    return u.trim().replace(/\/$/, '');
  }
}

// The more recent signal wins: a 200-day-old req touched last week is live.
function effectiveAge(dates) {
  if (!dates) return null;
  const vals = [dates.posted, dates.updated].filter((d) => d != null);
  return vals.length ? Math.min(...vals) : null;
}

// -------------------------------------------------------------- ats liveness

const ashbyBoards = new Map(); // slug -> Set(job ids) | null when the fetch failed

async function json(url, timeoutMs = 12000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'career-ops/prune' } });
    if (r.status === 404) return { gone: true };
    if (!r.ok) return { error: r.status };
    return { data: await r.json() };
  } catch (e) {
    return { error: String(e?.name ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns 'alive' | 'dead' | null (unknown — caller may fall back to browser).
 * Only the ATS APIs that actually expose a per-req lookup are used here; an
 * API error is never read as death, or a five-minute outage would wipe the
 * board.
 */
async function atsLiveness(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.toLowerCase();

  // Greenhouse: job-boards/boards.greenhouse.io/<slug>/jobs/<id>, or any host
  // carrying ?gh_jid= (company career sites embedding the GH board).
  const ghDirect = /greenhouse\.io$/.test(host)
    ? /^\/(?:embed\/job_app\?for=)?([^/]+)\/jobs\/(\d+)/.exec(u.pathname)
    : null;
  const ghJid = u.searchParams.get('gh_jid');
  if (ghDirect || ghJid) {
    const slug = ghDirect ? ghDirect[1] : null;
    const id = ghDirect ? ghDirect[2] : ghJid;
    if (slug && id) {
      const r = await json(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`);
      if (r.gone) return 'dead';
      if (r.data) return 'alive';
    }
    return null; // gh_jid without a slug — can't address the board
  }

  // Ashby: jobs.ashbyhq.com/<slug>/<uuid>. The posting API returns the whole
  // board, so fetch once per slug and test membership.
  if (host.endsWith('ashbyhq.com')) {
    const m = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(u.pathname);
    if (!m) return null;
    const [, slug, id] = m;
    if (!ashbyBoards.has(slug)) {
      const r = await json(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      ashbyBoards.set(
        slug,
        r.data?.jobs ? new Set(r.data.jobs.map((j) => String(j.id))) : null
      );
    }
    const ids = ashbyBoards.get(slug);
    if (!ids) return null;
    return ids.has(id) ? 'alive' : 'dead';
  }

  // Lever: jobs.lever.co/<slug>/<uuid>
  if (host.endsWith('lever.co')) {
    const m = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(u.pathname);
    if (!m) return null;
    const r = await json(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}?mode=json`);
    if (r.gone) return 'dead';
    if (r.data) return 'alive';
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------- main

async function main() {
  const raw = await readFile(PIPELINE, 'utf8');
  const lines = raw.split('\n');

  const applied = new Set();
  try {
    const appsText = await readFile(APPLICATIONS, 'utf8');
    for (const m of appsText.matchAll(/https?:\/\/\S+/g)) applied.add(canon(m[0].replace(/[|\s]+$/, '')));
  } catch {}

  const jdDates = await loadJdDates();

  const rows = [];
  lines.forEach((line, idx) => {
    const r = parseRow(line);
    if (r) rows.push({ ...r, idx });
  });

  console.log(`Board rows:   ${rows.length}`);
  console.log(`JD dates:     ${jdDates.size}`);
  console.log(`Applied:      ${applied.size} (always kept)`);
  console.log(`Archive age:  >${ARCHIVE_AGE_DAYS}d`);

  const verdicts = new Map(); // idx -> reason

  // Pass 0 — rows that were never a job posting to begin with. Recruiter
  // digests hand us search-result URLs ("all Senior PM jobs near NYC"), which
  // can never resolve to a req and never leave on their own.
  let junk = 0;
  for (const r of rows) {
    if (applied.has(canon(r.url))) continue;
    if (isSearchUrl(r.url)) {
      verdicts.set(r.idx, 'not a posting (search url)');
      junk++;
    }
  }
  console.log(`\nSearch URLs:  ${junk}`);

  // Pass 0b — rows fetch-jds has never managed to resolve. Every nightly run
  // retries the whole board, so a row still without a JD a week after it
  // arrived is one this pipeline cannot parse: Jobot's twice-weekly blast of
  // twelve mislabeled reqs is the bulk of it. Keep the grace window generous
  // so a transient fetch failure doesn't cost a real role.
  // ⚠ THIS SWEEP COULD ONLY EVER FIRE ON 5% OF THE BOARD. r.addedDays comes from
  // a date cell in the pipeline row, and only fetch-amazon and the gmail step
  // write one: 57 of 1,228 rows carry a date, 162 rows have no JD on disk, and
  // 145 of those were structurally EXEMPT. Every night's log read
  // "Never fetched: 0" and that number meant nothing.
  //
  // data/scan-history.tsv records first_seen for every URL the scanner has ever
  // added, which is exactly the missing signal. Used as the fallback, so the
  // sweep covers the whole board instead of the sliver that happened to carry a
  // date.
  const firstSeen = new Map();
  try {
    const tsv = await readFile(path.join(ROOT, 'data', 'scan-history.tsv'), 'utf-8');
    for (const line of tsv.split('\n').slice(1)) {
      const [u, seen] = line.split('\t');
      if (u && seen) firstSeen.set(canon(u), seen);
    }
  } catch { /* no history yet — falls back to the old behaviour */ }
  const daysSinceFirstSeen = (url) => {
    const iso = firstSeen.get(canon(url));
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
  };

  let neverFetched = 0;
  let fromHistory = 0;
  for (const r of rows) {
    if (verdicts.has(r.idx) || applied.has(canon(r.url))) continue;
    if (jdDates.has(canon(r.url))) continue;
    let added = r.addedDays;
    if (added == null) {
      added = daysSinceFirstSeen(r.url);
      if (added != null) fromHistory++;
    }
    if (added != null && added > NO_JD_GRACE_DAYS) {
      verdicts.set(r.idx, `no JD after ${added}d`);
      neverFetched++;
    }
  }
  console.log(`Never fetched: ${neverFetched} (${fromHistory} dated from scan-history rather than the row)`);

  // Pass 1 — age. Free, and it removes the bulk.
  let agedOut = 0;
  for (const r of rows) {
    if (applied.has(canon(r.url))) continue;
    const age = effectiveAge(jdDates.get(canon(r.url)));
    if (age != null && age > ARCHIVE_AGE_DAYS) {
      verdicts.set(r.idx, `age ${age}d`);
      agedOut++;
    }
  }
  console.log(`\nAged out:     ${agedOut}`);

  // Pass 2 — ATS liveness on the survivors. Cheap JSON, so run it on everything
  // an API can address.
  const survivors = rows.filter((r) => !verdicts.has(r.idx) && !applied.has(canon(r.url)));
  let apiChecked = 0;
  let apiDead = 0;
  const unknown = [];

  const CONCURRENCY = 6;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < survivors.length) {
        const r = survivors[cursor++];
        const v = await atsLiveness(r.url);
        if (v === 'dead') {
          verdicts.set(r.idx, 'ats: req gone');
          apiDead++;
          apiChecked++;
        } else if (v === 'alive') {
          apiChecked++;
        } else {
          unknown.push(r);
        }
      }
    })
  );
  console.log(`ATS checked:  ${apiChecked} (${apiDead} dead)`);
  console.log(`No ATS API:   ${unknown.length}`);

  // Pass 3 — browser check for the rest, newest first (an old row that survived
  // pass 1 is already suspect but cheap to leave; a fresh row being dead is the
  // surprising and more useful signal).
  let browserDead = 0;
  let browserChecked = 0;
  // Playwright only exists inside the scanner/applier images, so on the host
  // this pass is expected to be unavailable. Losing it costs a little recall;
  // letting it throw would throw away the age and ATS verdicts too, which is
  // how the first run of this script managed to prune nothing at all.
  if (unknown.length && MAX_BROWSER > 0) {
    try {
      unknown.sort((a, b) => (effectiveAge(jdDates.get(canon(a.url))) ?? 999) - (effectiveAge(jdDates.get(canon(b.url))) ?? 999));
      const batch = unknown.slice(0, MAX_BROWSER);
      const { chromium } = await import('playwright');
      const { checkUrl } = await import(path.join(ROOT, 'check-liveness.mjs'));
      const browser = await chromium.launch();
      const page = await browser.newPage();
      for (const r of batch) {
        browserChecked++;
        try {
          const res = await checkUrl(page, r.url);
          // checkUrl reports a navigation timeout as 'expired'. That conflates
          // a slow page with a pulled req, and archiving a live role is far
          // worse than leaving a dead one up, so only a positive expiry counts.
          const navError = /navigation error/i.test(res?.reason ?? '');
          if (res?.result === 'expired' && !navError) {
            verdicts.set(r.idx, `page: ${res.reason ?? 'expired'}`);
            browserDead++;
          }
        } catch {}
      }
      await browser.close();
    } catch (e) {
      console.log(`Browser:      unavailable (${String(e).split('\n')[0].slice(0, 80)}) — age+ATS verdicts still applied`);
    }
  }
  console.log(`Browser:      ${browserChecked} checked (${browserDead} dead)`);

  // ------------------------------------------------------------------- write
  const removed = rows.filter((r) => verdicts.has(r.idx));
  console.log(`\nTo archive:   ${removed.length}  →  board becomes ${rows.length - removed.length} rows`);

  if (DRY_RUN) {
    console.log('\n--dry-run, nothing written. Sample:');
    for (const r of removed.slice(0, 15)) console.log(`  [${verdicts.get(r.idx)}] ${r.company} | ${r.role}`);
    return;
  }
  if (!removed.length) return;

  const stamp = today.toISOString().slice(0, 10);
  const archiveLines = removed.map((r) => `- ${stamp} | ${verdicts.get(r.idx)} | ${r.url} | ${r.company} | ${r.role}`);
  let archiveHeader = '';
  try { await readFile(ARCHIVE, 'utf8'); } catch {
    archiveHeader = '# Pipeline archive\n\nRows removed from the board by prune-stale.mjs. Kept so a bad prune is recoverable.\n\n';
  }
  await appendFile(ARCHIVE, archiveHeader + archiveLines.join('\n') + '\n');

  const drop = new Set(removed.map((r) => r.idx));
  await writeFile(PIPELINE, lines.filter((_, i) => !drop.has(i)).join('\n'));
  console.log(`Archived to ${ARCHIVE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
