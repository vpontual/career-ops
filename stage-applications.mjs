#!/usr/bin/env node
/**
 * stage-applications.mjs — Level A automation.
 *
 * For every role scored >= MIN_SCORE that is older than MIN_AGE_DAYS,
 * generate:
 *   1. A tailored cover letter (Gemini call against profile.yml + cv.md + JD)
 *   2. A CV PDF (uses career-ops' cv-template.html + cv.md, no per-JD tailoring in v1)
 *   3. A cover letter PDF
 * All saved to output/{slug}/
 *
 * Designed to run inside the `applier` container which has Chromium.
 *
 * Tunables (env overrides):
 *   MIN_SCORE=4.0
 *   MIN_AGE_DAYS=30
 *   MAX_CONCURRENT=2
 *   GEMINI_MODEL=gemini-2.5-flash
 */

import { readFile, writeFile, mkdir, readdir, stat, copyFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { chromium } from 'playwright';

try {
  const { config } = await import('dotenv');
  config();
} catch {}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIN_SCORE = parseFloat(process.env.MIN_SCORE || '4.0');
const MIN_AGE_DAYS = parseInt(process.env.MIN_AGE_DAYS || '30', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1', 10);  // free tier = 5 RPM
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY missing in .env');
  process.exit(1);
}

const ai = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: GEMINI_MODEL });

const REPORTS_DIR = path.join(ROOT, 'reports');
const JDS_DIR = path.join(ROOT, 'jds');
const OUTPUT_DIR = path.join(ROOT, 'output');
const CV_PATH = path.join(ROOT, 'cv.md');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
const CV_TEMPLATE = path.join(ROOT, 'templates', 'cv-template.html');
const PROFILE_OVERRIDES = path.join(ROOT, 'modes', '_profile.md');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function pLimit(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          results[idx] = await fn(items[idx], idx);
        } catch (e) {
          results[idx] = { error: e.message };
          console.error(`[${idx}] ERROR ${items[idx].slug}: ${e.message}`);
        }
      }
    })
  );
  return results;
}

async function loadCandidates() {
  const reportFiles = (await readdir(REPORTS_DIR)).filter(f => f.startsWith('v-') && f.endsWith('.md'));
  const out = [];
  for (const rf of reportFiles) {
    const content = await readFile(path.join(REPORTS_DIR, rf), 'utf-8');
    const url = (content.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1];
    const company = (content.match(/\*\*Company:\*\*\s+(.+)/) || [])[1];
    const role = (content.match(/^# .+ — (.+)$/m) || [])[1];
    const score = parseFloat((content.match(/\*\*Score:\*\*\s+([\d.]+)/) || [])[1] || '0');
    const daysMatch = content.match(/\((\d+)\s+days\s+ago\)/);
    const days = daysMatch ? parseInt(daysMatch[1], 10) : null;
    const jdSlug = rf.replace(/^v-/, '').replace(/\.md$/, '');
    const jdPath = path.join(JDS_DIR, jdSlug + '.md');
    let jdContent = '';
    try { jdContent = await readFile(jdPath, 'utf-8'); } catch {}
    out.push({
      reportFile: rf,
      jdPath,
      jdContent,
      url, company, role, score, days,
      slug: slugify(`${company}-${role}`),
    });
  }
  return out.filter(r => r.score >= MIN_SCORE && r.days != null && r.days >= MIN_AGE_DAYS);
}

async function callGeminiWithRetry(prompt, maxAttempts = 6) {
  let attempt = 0;
  while (true) {
    try {
      const r = await model.generateContent(prompt);
      return r.response.text().trim();
    } catch (e) {
      attempt++;
      const msg = String(e?.message || e);
      const retryMatch = msg.match(/retry in ([\d.]+)s/);
      const wait = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : Math.min(60, 5 * Math.pow(2, attempt));
      if (!/429|Too Many Requests|quota|RetryInfo/i.test(msg) || attempt >= maxAttempts) throw e;
      console.log(`  rate-limited, sleeping ${wait}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
}

async function generateCoverLetter(candidate, profile, cv, profileOverrides) {
  const prompt = `You are writing a one-page cover letter for Vitor Pontual applying to a job.
Constraints:
- Cite SPECIFIC details from the job description (mission, product, team).
- Cite SPECIFIC achievements from Vitor's CV with numbers (e.g., $15M Series A, scaled 20→100+ brands).
- Open with a hook that reflects his unique combination: PM who builds his own AI infra (homelab: Proxmox, k3s, Ollama fleet).
- 280-380 words. Three paragraphs max.
- No corporate filler. No "passionate about", "leveraged", "spearheaded", "results-oriented", "synergies".
- US English. Plain text. No markdown, no headers, no bullets.
- Address to "Hiring Team at <Company>" if no specific name is in the JD.
- Sign off with "— Vitor Pontual".
- Do NOT invent companies, customers, or metrics that aren't in the CV. Stay strictly factual.

=== Candidate Profile (config/profile.yml) ===
${profile.slice(0, 4000)}

=== Candidate CV (cv.md) ===
${cv}

=== Candidate scoring rules / framing (modes/_profile.md, optional context) ===
${profileOverrides.slice(0, 2500)}

=== Job Description ===
Company: ${candidate.company}
Role: ${candidate.role}
URL: ${candidate.url}
Scored ${candidate.score}/5 by Claude against Vitor's rules.

JD body:
${candidate.jdContent.slice(0, 8000)}

Now write the cover letter.`;

  return callGeminiWithRetry(prompt);
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

function htmlForCv(cvMd, profile) {
  // Quick markdown-to-html: just enough for cv.md format. No external deps.
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

function htmlForCoverLetter(text, candidate, profile) {
  const candName = (profile.match(/full_name:\s*"([^"]+)"/) || [])[1] || 'Vitor Pontual';
  const email = (profile.match(/email:\s*"([^"]+)"/) || [])[1] || '';
  const phone = (profile.match(/phone:\s*"([^"]+)"/) || [])[1] || '';
  const linkedin = (profile.match(/linkedin:\s*"([^"]+)"/) || [])[1] || '';
  const today = new Date().toISOString().slice(0, 10);
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
      <div class="contact">${[email, phone, linkedin].filter(Boolean).join(' · ')}</div>
    </div>
    <div class="meta">${today}<br>Re: ${candidate.role} — ${candidate.company}</div>
    <div class="body">${escaped}</div>
  </body></html>`;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const profile = await readFile(PROFILE_PATH, 'utf-8');
  const cv = await readFile(CV_PATH, 'utf-8');
  let profileOverrides = '';
  try { profileOverrides = await readFile(PROFILE_OVERRIDES, 'utf-8'); } catch {}

  const candidates = await loadCandidates();
  console.log(`\nstage-applications: score>=${MIN_SCORE}, age>=${MIN_AGE_DAYS}d → ${candidates.length} candidates\n`);

  if (!candidates.length) {
    console.log('Nothing to stage.');
    return;
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // Render the CV PDF once (no per-JD tailoring in v1)
  const sharedCvPdf = path.join(OUTPUT_DIR, 'cv.pdf');
  console.log(`Rendering shared CV PDF → ${sharedCvPdf}`);
  await renderPdf(htmlForCv(cv, profile), sharedCvPdf, browser);

  let staged = 0, failed = 0;
  await pLimit(candidates, MAX_CONCURRENT, async (c, idx) => {
    const dir = path.join(OUTPUT_DIR, c.slug);
    await mkdir(dir, { recursive: true });

    // Skip if already staged (rerun-friendly)
    const coverMdPath = path.join(dir, 'cover-letter.md');
    try {
      await stat(coverMdPath);
      console.log(`[${idx}] SKIP (already staged): ${c.slug}`);
      staged++;
      return;
    } catch {}

    console.log(`[${idx}] generating cover letter for ${c.company} | ${c.role} (${c.days}d, score ${c.score})`);
    const letterText = await generateCoverLetter(c, profile, cv, profileOverrides);
    await writeFile(coverMdPath, `# Cover letter — ${c.company}: ${c.role}\n\n**URL:** ${c.url}\n**Generated:** ${new Date().toISOString()}\n**Days old at staging:** ${c.days}\n**Score:** ${c.score}\n\n---\n\n${letterText}\n`);

    const coverPdfPath = path.join(dir, 'cover-letter.pdf');
    await renderPdf(htmlForCoverLetter(letterText, c, profile), coverPdfPath, browser);

    // Symlink CV PDF rather than rerender
    const cvLink = path.join(dir, 'cv.pdf');
    try { await copyFile(sharedCvPdf, cvLink); } catch {}

    staged++;
    console.log(`[${idx}] staged: ${dir}`);
  });

  await browser.close();
  console.log(`\nDone. staged=${staged} failed=${failed}`);
  console.log(`\nReview: ls -la ${OUTPUT_DIR}/`);
}

main().catch(e => { console.error(e); process.exit(1); });
