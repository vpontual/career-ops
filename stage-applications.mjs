#!/usr/bin/env node
/**
 * stage-applications.mjs — Level A automation.
 *
 * For every role scored >= MIN_SCORE posted within MAX_AGE_DAYS days,
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
 *   MAX_AGE_DAYS=14
 *   MAX_CONCURRENT=2
 *   GEMINI_MODEL=gemini-2.5-flash
 */

import { readFile, writeFile, mkdir, stat, copyFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { chromium } from 'playwright';
import { checkUrl } from './check-liveness.mjs';

try {
  const { config } = await import('dotenv');
  config();
} catch {}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIN_SCORE = parseFloat(process.env.MIN_SCORE || '4.0');
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS || '14', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1', 10);  // free tier = 5 RPM
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY missing in .env');
  process.exit(1);
}

const ai = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: GEMINI_MODEL });

// Candidate scores now come from rank-leads.mjs's nightly cache (the single
// scoring authority) rather than the retired score-all.mjs report snapshots.
const SCORES_PATH = path.join(ROOT, 'data', 'lead-scores.json');
const JDS_DIR = path.join(ROOT, 'jds');
const OUTPUT_DIR = path.join(ROOT, 'output');
const CV_PATH = path.join(ROOT, 'cv.md');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
const CV_TEMPLATE = path.join(ROOT, 'templates', 'cv-template.html');
const PROFILE_OVERRIDES = path.join(ROOT, 'modes', '_profile.md');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// Strip non-ASCII typography an ATS parser can garble (em/en dashes, smart
// quotes, ellipsis, zero-width spaces, nbsp) out of LLM-generated prose before
// it lands in a shipped PDF/.md. Mirrors generate-pdf.mjs's normalizeTextForATS
// pass, applied at the plain-text level (safer than regexing rendered HTML).
function sanitizeAtsText(text) {
  if (!text) return text;
  return text
    .replace(/[\u2014\u2013]/g, '-')                    // em / en dash
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')       // smart double quotes
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")       // smart single quotes
    .replace(/\u2026/g, '...')                          // ellipsis
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')  // zero-width / BOM
    .replace(/\u00A0/g, ' ');                           // non-breaking space
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

// Parse the front-matter that fetch-jds.mjs writes at the top of every jds/*.md.
function parseJdMeta(jdContent) {
  const lines = jdContent.split('\n');
  const title = (lines[0] || '').replace(/^#\s*/, '').trim();
  let url = '', company = '', postedIso = null, postedDays = null;
  for (const line of lines.slice(0, 20)) {
    let m;
    if ((m = line.match(/^\*\*URL:\*\*\s*(.+)/i))) url = m[1].trim();
    else if ((m = line.match(/^\*\*Company:\*\*\s*(.+)/i))) company = m[1].trim();
    else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)\s*\((\d+)\s*days/i))) { postedIso = m[1]; postedDays = parseInt(m[2], 10); }
    else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)/i))) { postedIso = m[1]; }
  }
  return { title, url, company, postedIso, postedDays };
}

async function loadCandidates() {
  // rank-leads.mjs is the single scoring authority. Its cache is keyed by JD
  // filename → { score, verdict, ... }. Join it to the live jds/*.md files so
  // freshness is recomputed against today (not frozen at scoring time).
  let scores;
  try {
    scores = JSON.parse(await readFile(SCORES_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`Cannot read scores at ${SCORES_PATH} (run rank-leads.mjs first): ${e.message}`);
  }

  const out = [];
  for (const [filename, rec] of Object.entries(scores)) {
    const score = Number(rec?.score) || 0;
    if (score < MIN_SCORE) continue;              // tier gate up front — skip cheaply

    const jdPath = path.join(JDS_DIR, filename);
    let jdContent = '';
    try { jdContent = await readFile(jdPath, 'utf-8'); }
    catch { continue; }                           // JD pruned/gone → drop silently
    const meta = parseJdMeta(jdContent);

    let days = null;
    if (meta.postedIso) {
      const t = Date.parse(meta.postedIso);
      if (!Number.isNaN(t)) days = Math.floor((Date.now() - t) / 86400000);
    }
    if (days === null) days = meta.postedDays;

    out.push({
      reportFile: filename,
      jdPath,
      jdContent,
      url: meta.url,
      company: meta.company,
      role: meta.title,
      score,
      days,
      verdict: rec?.verdict || '',
      slug: slugify(`${meta.company}-${meta.title}`),
    });
  }
  return out.filter(r => r.days != null && r.days <= MAX_AGE_DAYS);
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
  console.log(`\nstage-applications: score>=${MIN_SCORE}, age<=${MAX_AGE_DAYS}d → ${candidates.length} candidates\n`);

  // --list / --dry-run: show what WOULD be staged and exit (no Gemini, no PDFs).
  if (process.argv.includes('--list') || process.argv.includes('--dry-run')) {
    for (const c of candidates.sort((a, b) => b.score - a.score || (a.days ?? 999) - (b.days ?? 999))) {
      console.log(`  [${c.score}] ${c.days ?? '?'}d  ${c.company} | ${c.role}  → output/${c.slug}/`);
    }
    console.log('\n(dry run — nothing generated)');
    return;
  }

  if (!candidates.length) {
    console.log('Nothing to stage.');
    return;
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // Liveness prune — skip only CONFIDENTLY expired roles (HTTP error, expired
  // redirect, hard "posting closed" copy) before spending Gemini calls. Never
  // drop 'uncertain'/'active', nor a role we simply couldn't reach (transient
  // network blips) — those keep flowing through to staging.
  const liveCandidates = [];
  {
    const probe = await browser.newPage();
    for (const c of candidates) {          // sequential — never Playwright in parallel
      if (!c.url) { liveCandidates.push(c); continue; }
      try {
        const { result, reason } = await checkUrl(probe, c.url);
        if (result === 'expired') {
          console.log(`  prune (expired): ${c.company} | ${c.role} — ${reason}`);
          continue;
        }
      } catch { /* unreachable right now → keep, don't silently drop */ }
      liveCandidates.push(c);
    }
    await probe.close();
  }
  console.log(`Liveness: ${liveCandidates.length}/${candidates.length} still live\n`);
  if (!liveCandidates.length) {
    console.log('Nothing live to stage.');
    await browser.close();
    return;
  }

  // Render the CV PDF once (no per-JD tailoring in v1)
  const sharedCvPdf = path.join(OUTPUT_DIR, 'cv.pdf');
  console.log(`Rendering shared CV PDF → ${sharedCvPdf}`);
  await renderPdf(htmlForCv(cv, profile), sharedCvPdf, browser);

  let staged = 0;
  const results = await pLimit(liveCandidates, MAX_CONCURRENT, async (c, idx) => {
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
    const letterText = sanitizeAtsText(await generateCoverLetter(c, profile, cv, profileOverrides));
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
  const failed = results.filter(r => r && r.error).length;
  console.log(`\nDone. staged=${staged} failed=${failed}`);
  console.log(`\nReview: ls -la ${OUTPUT_DIR}/`);
}

main().catch(e => { console.error(e); process.exit(1); });
