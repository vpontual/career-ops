#!/usr/bin/env node
// batch-stage.mjs - stage many roles from a JSON manifest of cover letters.
//
// Each entry: { slug, url, company, role, score, days, text }
// For each entry: create output/{slug}/, write cover-letter.md (with the
// standard header score-all/stage-applications use), copy the shared
// cv.pdf in, and render cover-letter.pdf using the same htmlForCoverLetter
// template as stage-applications.mjs.

import { readFile, writeFile, mkdir, copyFile, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(ROOT, 'output');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('usage: batch-stage.mjs <manifest.json>');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
const profile = await readFile(PROFILE_PATH, 'utf-8').catch(() => '');

const candName = (profile.match(/full_name:\s*"([^"]+)"/) || [])[1] || 'Vitor Pontual';
const email = (profile.match(/email:\s*"([^"]+)"/) || [])[1] || '';
const phone = (profile.match(/phone:\s*"([^"]+)"/) || [])[1] || '';
const linkedin = (profile.match(/linkedin:\s*"([^"]+)"/) || [])[1] || '';
const today = new Date().toISOString().slice(0, 10);

function htmlForCoverLetter(text, role, company) {
  const escaped = text.split('\n').map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>\n');
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
      <div class="contact">${[email, phone, linkedin].filter(Boolean).join(' &middot; ')}</div>
    </div>
    <div class="meta">${today}<br>Re: ${role}, ${company}</div>
    <div class="body">${escaped}</div>
  </body></html>`;
}

const sharedCv = path.join(OUTPUT_DIR, 'cv.pdf');
let sharedCvExists = false;
try { await stat(sharedCv); sharedCvExists = true; } catch {}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

let staged = 0, failed = 0;
for (const m of manifest) {
  const dir = path.join(OUTPUT_DIR, m.slug);
  try {
    await mkdir(dir, { recursive: true });
    const text = m.text.trim();
    const md = `# Cover letter - ${m.company}: ${m.role}\n\n**URL:** ${m.url}\n**Generated:** ${new Date().toISOString()}\n**Days old at staging:** ${m.days ?? 'n/a'}\n**Score:** ${m.score ?? 'n/a'}\n\n---\n\n${text}\n`;
    await writeFile(path.join(dir, 'cover-letter.md'), md);

    if (sharedCvExists) {
      await copyFile(sharedCv, path.join(dir, 'cv.pdf'));
    }

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent(htmlForCoverLetter(text, m.role, m.company));
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: path.join(dir, 'cover-letter.pdf'),
      format: 'Letter',
      margin: { top: '0.7in', bottom: '0.7in', left: '0.85in', right: '0.85in' }
    });
    await ctx.close();
    console.log(`OK   ${m.slug}`);
    staged++;
  } catch (e) {
    console.log(`ERR  ${m.slug}: ${e.message}`);
    failed++;
  }
}

await browser.close();
console.log(`\nDone. staged=${staged} failed=${failed}`);
