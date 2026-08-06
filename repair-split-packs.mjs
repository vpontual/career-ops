#!/usr/bin/env node

/**
 * repair-split-packs.mjs — reunite cards with the packs that were built for them.
 *
 * One-off repair for the damage done by enqueue-review.mjs's old collision guard
 * (fixed 2026-08-06, pinned by test-slug-identity.mjs). Cards were minted as
 * <slug>-N pointing at an empty directory, while the CV and cover letter sat in
 * <slug>. On the pending queue that meant 8 of 9 cards had no reachable CV.
 *
 * What it does, per affected card:
 *   1. moves answers.md / research.md from <slug>-N into <slug>, never overwriting
 *   2. writes pack-meta.json into <slug> so the pack is self-identifying from now on
 *   3. repoints the card's slug to <slug>
 *   4. removes <slug>-N once empty
 *
 * WHAT IT REFUSES TO DO. It will not merge a pack whose provenance does not match
 * the card. Three of the eight packs were staged from an indeed.com/viewjob URL
 * while the card applies to the employer's own board - same role, different source
 * document - and their cover letters were written from Indeed's reformatting of
 * the posting (one opens "Hiring Team at HARVEY," in caps). The CV is per-role and
 * fine; the letter is not. Those letters are QUARANTINED rather than carried over,
 * so the card gets its CV back and nothing unsendable follows it.
 *
 * Usage: node repair-split-packs.mjs [--apply]     (dry run by default)
 */

import { readFile, writeFile, readdir, rename, rmdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canonKey } from './lib/canonical.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const OUT = path.join(ROOT, 'output');
const APPLY = process.argv.includes('--apply');

const hostPath = (u) => {
  try { const x = new URL(String(u)); return `${x.hostname.toLowerCase()}${x.pathname.replace(/\/$/, '')}`; }
  catch { return ''; }
};
const AGGREGATOR = /indeed\.com|linkedin\.com|glassdoor\.com|ziprecruiter\.com|lensa\.com|jobot\.com/i;

const read = async (p) => { try { return await readFile(p, 'utf-8'); } catch { return ''; } };

const queue = JSON.parse(await readFile(QUEUE, 'utf-8'));
const claimed = new Set(queue.items.map((i) => i.slug));
const actions = [];

for (const card of queue.items.filter((i) => !i.decision)) {
  const m = /-(\d+)$/.exec(card.slug);
  if (!m) continue;
  const base = card.slug.slice(0, m.index);
  const baseDir = path.join(OUT, base);
  const cardDir = path.join(OUT, card.slug);

  if (!existsSync(baseDir)) continue;
  if (claimed.has(base)) { actions.push({ card, base, skip: 'base slug is owned by another card' }); continue; }
  if (!existsSync(path.join(baseDir, 'cv.pdf'))) { actions.push({ card, base, skip: 'base pack has no cv.pdf' }); continue; }

  // Identity. A pack already carrying a marker must match; an unmarked pack is
  // the historical orphan case and is adoptable when the slug derives from the
  // same company+role.
  const meta = JSON.parse(await read(path.join(baseDir, 'pack-meta.json')) || 'null');
  const mine = canonKey(card.company || '', card.role || '');
  if (meta?.canonKey && meta.canonKey !== mine) {
    actions.push({ card, base, skip: `pack belongs to a different role (${meta.canonKey})` });
    continue;
  }

  // Provenance of the COVER LETTER only. The CV is per-role and correct either
  // way; the letter is generated from whichever posting staging read.
  const letter = await read(path.join(baseDir, 'cover-letter.md'));
  const skipNote = await read(path.join(baseDir, 'cover-letter-skipped.md'));
  const urlMatch = /^\*\*URL:\*\*\s*(\S+)/m.exec(letter || skipNote);
  const packUrl = urlMatch ? urlMatch[1] : '';
  const provenanceOk = packUrl
    && [hostPath(card.applyUrl), hostPath(card.sourceUrl)].includes(hostPath(packUrl));

  // A letter is withheld for ANY defect that makes it unsendable, not only for
  // provenance. The artifact audit found three classes on disk and all three are
  // disqualifying on their own.
  const defects = [];
  if (letter && !provenanceOk) defects.push(`staged from ${packUrl}, card applies elsewhere`);
  if (/\[Date\]/.test(letter)) defects.push('renders a literal [Date] placeholder');
  const addressed = /^(?:Dear|Hiring Team at)\s+(.+?),\s*$/m.exec(letter)?.[1]?.trim();
  if (addressed && addressed === addressed.toUpperCase() && /[A-Z]{2,}/.test(addressed)) {
    defects.push(`shouts the employer name ("${addressed}")`);
  }
  const quarantine = letter && defects.length ? ['cover-letter.md', 'cover-letter.pdf'] : [];

  const moves = [];
  for (const f of await readdir(cardDir).catch(() => [])) {
    if (existsSync(path.join(baseDir, f))) continue;      // never overwrite
    moves.push(f);
  }

  actions.push({ card, base, moves, quarantine, packUrl, provenanceOk, defects });
}

// ── report ────────────────────────────────────────────────────────────────
console.log(`\nrepair-split-packs — ${actions.length} affected card(s)${APPLY ? '' : '  [DRY RUN]'}\n`);
for (const a of actions) {
  console.log(`${a.card.company} — ${String(a.card.role).slice(0, 54)}`);
  console.log(`  ${a.card.slug}`);
  console.log(`  → ${a.base}`);
  if (a.skip) { console.log(`  ⛔ SKIPPED: ${a.skip}\n`); continue; }
  console.log(`  move: ${a.moves.length ? a.moves.join(', ') : '(nothing to move)'}`);
  if (a.quarantine.length) {
    console.log(`  ⚠ quarantine: ${a.quarantine.join(', ')}`);
    for (const d of a.defects) console.log(`      - ${d}`);
  }
  console.log('');
}

if (!APPLY) {
  console.log('Dry run. Re-run with --apply to make these changes.\n');
  process.exit(0);
}

await copyFile(QUEUE, `${QUEUE}.bak-repair-${new Date().toISOString().slice(0, 10)}`);

let repaired = 0;
for (const a of actions) {
  if (a.skip) continue;
  const baseDir = path.join(OUT, a.base);
  const cardDir = path.join(OUT, a.card.slug);

  for (const f of a.moves) await rename(path.join(cardDir, f), path.join(baseDir, f));

  for (const f of a.quarantine) {
    const src = path.join(baseDir, f);
    if (existsSync(src)) await rename(src, path.join(baseDir, `QUARANTINED-${f}`));
  }
  if (a.quarantine.length) {
    await writeFile(path.join(baseDir, 'cover-letter-QUARANTINE.md'),
      `# Cover letter withheld\n\n` +
      `This letter is not sendable as written:\n\n` +
      a.defects.map((d) => `- ${d}\n`).join('') +
      `\nThe original is kept as QUARANTINED-cover-letter.md.\n\n` +
      `The CV in this pack is per-role and unaffected.\n\n` +
      `Regenerate from the employer's posting before sending anything.\n`);
  }

  await writeFile(path.join(baseDir, 'pack-meta.json'), JSON.stringify({
    company: a.card.company, role: a.card.role,
    canonKey: canonKey(a.card.company || '', a.card.role || ''),
    url: a.card.applyUrl ?? null,
    stagedAt: null,
    repairedAt: new Date().toISOString(),
    note: 'identity written by repair-split-packs.mjs',
  }, null, 2));

  const left = await readdir(cardDir).catch(() => []);
  if (!left.length) await rmdir(cardDir).catch(() => {});

  a.card.slug = a.base;
  repaired++;
}

await writeFile(QUEUE, JSON.stringify(queue, null, 2));
console.log(`repaired ${repaired} card(s); queue rewritten (backup alongside it)\n`);
console.log('Now verify against the RUNNING app: python3 batch/link-check.py\n');
