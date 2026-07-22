// blacklist.mjs — user-owned do-not-apply list (ported from upstream #1748).
//
// data/blacklist.md is an opt-in markdown table the user owns:
//   | Company | Since | Scope | Reason |
// Absent file = no filtering; nothing ever auto-populates it. It is a GATE,
// never a scoring input. Companies match case- and punctuation-insensitively
// (same normalization as the canonical dedup).
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeCompany } from './lib/canonical.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BLACKLIST_PATH = path.join(ROOT, 'data', 'blacklist.md');

// normalizeCompany is the shared canonical primitive (single source of truth).
export { normalizeCompany };

/** Parse blacklist.md text → Map<normalizedCompany, {company, since, scope, reason}>. */
export function parseBlacklist(text) {
  const entries = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company)) continue;   // separator row
    if (company.toLowerCase() === 'company') continue;     // header row
    const key = normalizeCompany(company);
    if (!key || entries.has(key)) continue;
    entries.set(key, { company, since: cells[2] || '', scope: cells[3] || '', reason: cells[4] || '' });
  }
  return entries;
}

/** Load data/blacklist.md (absent → empty map = no filtering). */
export async function loadBlacklist() {
  try { return parseBlacklist(await readFile(BLACKLIST_PATH, 'utf-8')); }
  catch { return new Map(); }
}

/** @returns the matching entry, or null. */
export function blacklistEntry(company, entries) {
  return entries.get(normalizeCompany(company)) || null;
}
