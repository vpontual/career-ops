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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(ROOT, 'output');
const CV_PATH = path.join(ROOT, 'cv.md');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');

function htmlForCv(cvMd) {
  const lines = cvMd.split('\n');
  const html = [];
  let inList = false;
  for (let line of lines) {
    line = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    if (/^# /.test(line)) { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h1>${line.slice(2)}</h1>`); }
    else if (/^## /.test(line)) { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h2>${line.slice(3)}</h2>`); }
    else if (/^### /.test(line)) { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h3>${line.slice(4)}</h3>`); }
    else if (/^- /.test(line)) { if (!inList) { html.push('<ul>'); inList = true; } html.push(`<li>${line.slice(2)}</li>`); }
    else if (line.trim() === '') { if (inList) { html.push('</ul>'); inList = false; } html.push(''); }
    else { if (inList) { html.push('</ul>'); inList = false; } html.push(`<p>${line}</p>`); }
  }
  if (inList) html.push('</ul>');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #111; }
    h1 { font-size: 22pt; margin: 0 0 0.1in 0; letter-spacing: -0.02em; }
    h2 { font-size: 13pt; margin: 0.25in 0 0.05in 0; border-bottom: 1px solid #888; padding-bottom: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
    h3 { font-size: 11pt; margin: 0.12in 0 0.02in 0; }
    p { margin: 0.04in 0; }
    ul { margin: 0.05in 0 0.1in 0.25in; padding: 0; }
    li { margin: 0.02in 0; }
    a { color: #1a4faa; text-decoration: none; }
    strong { font-weight: 600; }
  </style></head><body>${html.join('\n')}</body></html>`;
}

function htmlForCoverLetter(text, profile, headingMeta) {
  const candName = (profile.match(/full_name:\s*"([^"]+)"/) || [])[1] || 'Vitor Pontual';
  const email = (profile.match(/email:\s*"([^"]+)"/) || [])[1] || '';
  const phone = (profile.match(/phone:\s*"([^"]+)"/) || [])[1] || '';
  const linkedin = (profile.match(/linkedin:\s*"([^"]+)"/) || [])[1] || '';
  const today = new Date().toISOString().slice(0, 10);
  const escaped = text.split('\n').map(l =>
    l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  ).join('<br>\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #111; padding: 0; }
    .head { border-bottom: 1px solid #ccc; padding-bottom: 0.15in; margin-bottom: 0.25in; }
    .name { font-size: 18pt; font-weight: 600; letter-spacing: -0.01em; }
    .contact { font-size: 9.5pt; color: #555; margin-top: 4px; }
    .meta { font-size: 9pt; color: #666; margin: 0.25in 0; }
    .body { margin: 0.1in 0; }
  </style></head><body>
    <div class="head">
      <div class="name">${candName}</div>
      <div class="contact">${[email, phone, linkedin].filter(Boolean).join(' · ')}</div>
    </div>
    <div class="meta">${today}${headingMeta ? '<br>' + headingMeta : ''}</div>
    <div class="body">${escaped}</div>
  </body></html>`;
}

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
  await renderPdf(htmlForCv(cv), sharedCvPdf, browser);

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
    await renderPdf(htmlForCoverLetter(body, profile, heading), pdfPath, browser);

    // Mirror shared CV into per-role dir
    try { await copyFile(sharedCvPdf, path.join(dir, 'cv.pdf')); } catch {}

    rendered++;
    console.log(`  OK ${slug}`);
  }

  await browser.close();
  console.log(`\nDone. rendered=${rendered} missing=${missing}`);
}

main().catch(e => { console.error(e); process.exit(1); });
