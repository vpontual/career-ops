#!/usr/bin/env node
/**
 * render-pdfs.mjs - render PDFs from existing cover-letter.md files.
 * No Gemini, no scoring. Just markdown -> PDF.
 *
 * Reads each output/*\/cover-letter.md and writes cover-letter.pdf next to it.
 * Also (re)writes the shared output/cv.pdf from cv.md.
 */

import { readFile, writeFile, readdir, copyFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { renderCvHtml, renderCoverLetterHtml } from './lib/render.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(ROOT, 'output');
const CV_PATH = path.join(ROOT, 'cv.md');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');

// htmlForCv / htmlForCoverLetter now live in the shared lib/render.mjs
// (renderCvHtml / renderCoverLetterHtml).

async function renderPdf(html, outPath, browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: outPath,
    format: 'Letter',
    margin: { top: '0.5in', bottom: '0.5in', left: '0.6in', right: '0.6in' },
    printBackground: true
  });
  await ctx.close();
}

function extractBody(md) {
  // cover letter format:
  //   # Cover letter - Company: Role
  //   **URL:** ...
  //   ---
  //   <body...>
  const after = md.split(/^---\s*$/m).slice(1).join('---').trim();
  return after || md;
}

function extractHeading(md) {
  const m = md.match(/^# (.+)$/m);
  if (!m) return '';
  // "Cover letter - Company: Role" -> "Re: Role - Company"
  const heading = m[1].replace(/^Cover letter\s*-\s*/i, '');
  const colon = heading.indexOf(':');
  if (colon > 0) {
    const company = heading.slice(0, colon).trim();
    const role = heading.slice(colon + 1).trim();
    return `Re: ${role} - ${company}`;
  }
  return heading;
}

async function main() {
  const profile = await readFile(PROFILE_PATH, 'utf-8');
  const cv = await readFile(CV_PATH, 'utf-8');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  const sharedCvPdf = path.join(OUTPUT_DIR, 'cv.pdf');
  console.log(`Rendering shared CV PDF -> ${sharedCvPdf}`);
  await renderPdf(renderCvHtml(cv), sharedCvPdf, browser);

  const dirs = (await readdir(OUTPUT_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let rendered = 0, missing = 0;
  for (const slug of dirs) {
    const dir = path.join(OUTPUT_DIR, slug);
    const mdPath = path.join(dir, 'cover-letter.md');
    let md;
    try { md = await readFile(mdPath, 'utf-8'); }
    catch { missing++; console.log(`  SKIP ${slug} (no cover-letter.md)`); continue; }

    const body = extractBody(md);
    const heading = extractHeading(md);

    const pdfPath = path.join(dir, 'cover-letter.pdf');
    await renderPdf(renderCoverLetterHtml(body, profile, heading), pdfPath, browser);

    // Mirror shared CV into per-role dir
    try { await copyFile(sharedCvPdf, path.join(dir, 'cv.pdf')); } catch {}

    rendered++;
    console.log(`  OK ${slug}`);
  }

  await browser.close();
  console.log(`\nDone. rendered=${rendered} missing=${missing}`);
}

main().catch(e => { console.error(e); process.exit(1); });
