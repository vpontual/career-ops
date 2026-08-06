/**
 * lib/scan-history.mjs — when we first saw a posting, and when we last saw it.
 *
 * data/scan-history.tsv recorded `first_seen` and nothing else, so the question
 * "how long does a requisition actually stay open" could only be answered as a
 * RIGHT-CENSORED survival curve: of the postings first seen N days ago, how many
 * are still open TODAY. That is enough to show the shape - postings stay open for
 * weeks, the cliff is at 45-60 days, and the old 3-day freshness gate was
 * discarding roles with an ~86-93% chance of still being live - but it cannot
 * say when any individual role actually closed.
 *
 * `last_seen` is the missing half. scan.mjs observes every job on every board it
 * sweeps; recording the date it last SAW a URL means that when the posting
 * disappears, last_seen stops advancing and becomes the closure date. Lifespan
 * is then first_seen -> last_seen, measured rather than inferred.
 *
 * ⚠ It only advances for boards scan.mjs actually sweeps (portals*.yml). Roles
 * from Indeed, Amazon, OLAS and the gmail step are never re-observed, so their
 * last_seen stays at first_seen and they are excluded from lifespan statistics
 * rather than counted as same-day closures. Silence is not evidence of death.
 *
 * The file is append-only for six other writers, so this module is deliberately
 * tolerant: unknown trailing columns are preserved, a missing last_seen is read
 * as first_seen, and the rewrite is atomic.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';

export const HEADER = ['url', 'first_seen', 'portal', 'title', 'company', 'status', 'last_seen'];

/** @returns {{header: string[], rows: string[][]}} */
export function readHistory(pathname) {
  if (!existsSync(pathname)) return { header: HEADER.slice(), rows: [] };
  const lines = readFileSync(pathname, 'utf-8').split('\n').filter((l) => l.length);
  if (!lines.length) return { header: HEADER.slice(), rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => l.split('\t'));
  return { header, rows };
}

/**
 * Stamp `last_seen = today` on every URL observed on a board this run, adding
 * the column if the file predates it. Returns how many rows were touched.
 *
 * @param {string} pathname
 * @param {Set<string>} observedCanonical  canonicalised URLs seen live this run
 * @param {(u: string) => string} canon    the project's canonicaliser
 * @param {string} today                   ISO date
 */
export function stampLastSeen(pathname, observedCanonical, canon, today) {
  const { header, rows } = readHistory(pathname);
  if (!rows.length) return { updated: 0, added: 0 };

  let idx = header.indexOf('last_seen');
  let added = 0;
  if (idx === -1) {
    header.push('last_seen');
    idx = header.length - 1;
    added = 1;
  }

  let updated = 0;
  for (const r of rows) {
    // Backfill: a row written before this column existed is only known to have
    // been seen once, on first_seen. Claiming anything else would invent data.
    while (r.length <= idx) r.push('');
    if (!r[idx]) r[idx] = r[1] || '';
    const u = r[0];
    if (u && observedCanonical.has(canon(u)) && r[idx] !== today) {
      r[idx] = today;
      updated++;
    }
  }

  const out = [header.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n') + '\n';
  const tmp = `${pathname}.tmp-${process.pid}`;
  writeFileSync(tmp, out, 'utf-8');
  renameSync(tmp, pathname);      // atomic — six other writers append to this file
  return { updated, added };
}

/**
 * Lifespan in days for rows we have genuinely re-observed. A row whose
 * last_seen never advanced past first_seen was never seen twice, which means we
 * do not know its lifespan - it is excluded rather than counted as zero.
 *
 * @returns {Array<{url: string, company: string, days: number, closed: boolean}>}
 */
export function measuredLifespans(pathname, todayIso) {
  const { header, rows } = readHistory(pathname);
  const li = header.indexOf('last_seen');
  if (li === -1) return [];
  const DAY = 86400000;
  const out = [];
  for (const r of rows) {
    const first = Date.parse(r[1] || '');
    const last = Date.parse(r[li] || '');
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    if (last <= first) continue;                       // never re-observed
    const days = Math.round((last - first) / DAY);
    // Still on the board as of the most recent sweep => still open, so its
    // lifespan is a lower bound, not a measurement.
    const closed = r[li] !== todayIso;
    out.push({ url: r[0], company: r[4] || '', days, closed });
  }
  return out;
}
