#!/usr/bin/env node

/**
 * seed-pack.mjs — give a hand-added review-queue role a real pack directory.
 *
 * stage-applications.mjs builds a pack for every role the scanner finds, but
 * roles added to the review queue by hand — board sweeps, referrals, the ones
 * researched in conversation — never get one. The UI still renders a CV link
 * for them, so clicking it 404s. Seven of twenty-two queue items were in that
 * state.
 *
 * This renders the queue item's declared cvVariant to output/<slug>/cv.pdf
 * using the same template and page geometry as tailor-cv.mjs, so a hand-added
 * role is indistinguishable from a staged one.
 *
 * Usage:
 *   node seed-pack.mjs            # every queue item missing a cv.pdf
 *   node seed-pack.mjs <slug> ...
 */

import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { renderCvHtml } from './lib/render.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const VARIANTS = path.join(ROOT, 'cv-variants');
const OUTPUT = path.join(ROOT, 'output');

const DEFAULT_VARIANT = 'ai-product';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  const only = new Set(process.argv.slice(2));
  const queue = JSON.parse(await readFile(QUEUE, 'utf8'));

  const targets = [];
  for (const item of queue.items ?? []) {
    if (only.size && !only.has(item.slug)) continue;
    if (await exists(path.join(OUTPUT, item.slug, 'cv.pdf'))) continue;
    targets.push(item);
  }

  if (!targets.length) {
    console.log('Every queue item already has a cv.pdf.');
    return;
  }
  console.log(`Seeding ${targets.length} pack(s)\n`);

  const browser = await chromium.launch();
  let ok = 0;
  for (const item of targets) {
    const variant = item.cvVariant || DEFAULT_VARIANT;
    const variantPath = path.join(VARIANTS, `cv-${variant}.md`);
    let cvMd;
    try {
      cvMd = await readFile(variantPath, 'utf8');
    } catch {
      console.log(`  ✗ ${item.slug} — no cv-${variant}.md`);
      continue;
    }

    const dir = path.join(OUTPUT, item.slug);
    await mkdir(dir, { recursive: true });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent(renderCvHtml(cvMd));
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: path.join(dir, 'cv.pdf'),
      format: 'Letter',
      margin: { top: '0.6in', bottom: '0.6in', left: '0.7in', right: '0.7in' },
    });
    await ctx.close();

    await writeFile(path.join(dir, 'cv-variant.txt'), variant + '\n');
    console.log(`  ✓ ${item.slug} (${variant})`);
    ok++;
  }
  await browser.close();
  console.log(`\nSeeded ${ok}/${targets.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
