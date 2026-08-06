/**
 * lib/repost.mjs — an employer relisting a role is actively re-sourcing it.
 *
 * The freshness question VP actually asked was "does the employer want this
 * filled soon", and a repost is the strongest positive answer available: they
 * posted it, it did not get filled, and they went back and listed it AGAIN.
 * That is a company still spending money on the search, months after the
 * original posting date that every age gate would have thrown the role out on.
 *
 * The pattern was invisible because every layer treats it as a duplicate:
 * canonKey collapses company+title, and enqueue-review indexes both the
 * canonical key and the apply URL specifically so a role cannot reappear. That
 * dedup is correct - VP should not see the same job twice - but it discarded
 * the signal along with the noise.
 *
 * Measured over data/scan-history.tsv: 122 of 1,463 distinct roles have been
 * listed under more than one URL on more than one date.
 *
 * ⚠ A SECOND SIGHTING IS NOT AUTOMATICALLY A REPOST. Several of those pairs are
 * 2026-04-21 -> 2026-04-22, which is the initial history backfill re-observing
 * the same board a day apart, not an employer relisting anything. MIN_GAP_DAYS
 * requires a real interval before it counts, so the flag means what it says.
 */

import { readFileSync, existsSync } from 'fs';
import { canonKey } from './canonical.mjs';

const DAY = 86400000;
const MIN_GAP_DAYS = 14;

/**
 * @param {string} historyPath  data/scan-history.tsv
 * @returns {Map<string, {count:number, first:string, last:string, gapDays:number}>}
 *          keyed by canonKey(company, title)
 */
export function loadReposts(historyPath) {
  const out = new Map();
  if (!existsSync(historyPath)) return out;

  const lines = readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean);
  if (lines.length < 2) return out;
  const header = lines[0].split('\t');
  const iTitle = header.indexOf('title');
  const iCompany = header.indexOf('company');
  if (iTitle === -1 || iCompany === -1) return out;

  // url -> first_seen, grouped by canonical role
  const byRole = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    const company = c[iCompany];
    const title = c[iTitle];
    const url = c[0];
    const seen = c[1];
    if (!company || !title || !url || !seen) continue;
    const key = canonKey(company, title);
    if (!byRole.has(key)) byRole.set(key, new Map());
    byRole.get(key).set(url, seen);
  }

  for (const [key, urls] of byRole) {
    if (urls.size < 2) continue;
    const dates = [...new Set(urls.values())].sort();
    if (dates.length < 2) continue;
    const gapDays = Math.round((Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / DAY);
    if (!Number.isFinite(gapDays) || gapDays < MIN_GAP_DAYS) continue;   // backfill, not a relist
    out.set(key, { count: urls.size, first: dates[0], last: dates[dates.length - 1], gapDays });
  }
  return out;
}

/**
 * The note that goes on the review card. Returns '' when the role is not a
 * repost, so it composes into the existing notes chain.
 */
export function repostNote(reposts, company, role) {
  const r = reposts.get(canonKey(company || '', role || ''));
  if (!r) return '';
  return `↻ RELISTED: this employer has posted this role ${r.count} times, ` +
    `first seen ${r.first} and again ${r.last} (${r.gapDays}d apart). They did not fill it ` +
    `and went back to market — an unfilled req they are still spending on, which is a ` +
    `stronger signal of hiring intent than the posting date.`;
}
