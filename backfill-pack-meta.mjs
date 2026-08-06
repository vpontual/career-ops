#!/usr/bin/env node

/**
 * backfill-pack-meta.mjs — make every existing application pack self-identifying.
 *
 * stage-applications.mjs now writes pack-meta.json (company, role, canonKey) so
 * enqueue-review.mjs can tell a pack it just built for THIS role from a
 * different role that happens to slugify the same. Packs staged before that
 * change carry no marker, and chooseSlug treats an unmarked directory as
 * adoptable — which is right for the orphan case it was written for, but means
 * 279 directories are adoptable on the strength of their NAME alone.
 *
 * Each pack already records the URL it was staged from, in cover-letter.md or
 * cover-letter-skipped.md. That plus the matching JD gives the same identity
 * staging would have written. Where it cannot be established, nothing is
 * written: an unmarked pack keeps today's behaviour rather than getting a
 * guessed identity, because a WRONG marker is worse than none — it would make
 * chooseSlug refuse a pack that really is the role's own.
 *
 * Read-mostly: writes only pack-meta.json, never touches a CV, letter or answer.
 *
 * Usage: node backfill-pack-meta.mjs [--apply]     (dry run by default)
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canonKey } from './lib/canonical.mjs';
import { parseJd } from './lib/jd-parse.mjs';
import { canonicalizeUrl } from './lib/url-canonical.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'output');
const JDS = path.join(ROOT, 'jds');
const APPLY = process.argv.includes('--apply');

const read = async (p) => { try { return await readFile(p, 'utf-8'); } catch { return ''; } };

// Every JD, indexed by canonical URL — the same key research-roles uses.
const byUrl = new Map();
for (const f of await readdir(JDS).catch(() => [])) {
  const jd = parseJd(await read(path.join(JDS, f)), f);
  if (jd.url) byUrl.set(canonicalizeUrl(String(jd.url)), { f, jd });
}

const queue = JSON.parse(await read(path.join(ROOT, 'data', 'review-queue.json')) || '{"items":[]}');
const cardBySlug = new Map(queue.items.map((i) => [i.slug, i]));

let already = 0, fromCard = 0, fromUrl = 0, unresolved = 0;
const writes = [];

for (const d of (await readdir(OUT, { withFileTypes: true })).filter((e) => e.isDirectory())) {
  const dir = path.join(OUT, d.name);
  if (existsSync(path.join(dir, 'pack-meta.json'))) { already++; continue; }

  // 1. A card owns this slug — that is the identity, no inference needed.
  const card = cardBySlug.get(d.name);
  if (card) {
    writes.push([dir, {
      company: card.company, role: card.role,
      canonKey: canonKey(card.company || '', card.role || ''),
      url: card.applyUrl ?? null, source: 'review-queue card',
    }]);
    fromCard++;
    continue;
  }

  // 2. No card. Use the URL the pack itself recorded at staging time.
  const note = (await read(path.join(dir, 'cover-letter.md')))
    || (await read(path.join(dir, 'cover-letter-skipped.md')))
    || (await read(path.join(dir, 'QUARANTINED-cover-letter.md')));
  const m = /^\*\*URL:\*\*\s*(\S+)/m.exec(note);
  const hit = m && byUrl.get(canonicalizeUrl(m[1]));
  if (hit) {
    writes.push([dir, {
      company: hit.jd.company || '', role: hit.jd.title || '',
      canonKey: canonKey(hit.jd.company || '', hit.jd.title || ''),
      url: m[1], source: `jds/${hit.f}`,
    }]);
    fromUrl++;
    continue;
  }

  unresolved++;
}

console.log(`\nbackfill-pack-meta — ${already + writes.length + unresolved} pack(s)${APPLY ? '' : '  [DRY RUN]'}\n`);
console.log(`  already marked           ${already}`);
console.log(`  identity from its card   ${fromCard}`);
console.log(`  identity from staged URL ${fromUrl}`);
console.log(`  left unmarked            ${unresolved}   (no recorded URL — a guessed identity would be worse than none)`);

if (!APPLY) { console.log('\nDry run. Re-run with --apply.\n'); process.exit(0); }

for (const [dir, meta] of writes) {
  await writeFile(path.join(dir, 'pack-meta.json'),
    JSON.stringify({ ...meta, backfilledAt: new Date().toISOString() }, null, 2));
}
console.log(`\nwrote ${writes.length} pack-meta.json\n`);
