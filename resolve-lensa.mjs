#!/usr/bin/env node
/**
 * resolve-lensa.mjs — Playwright resolver for Lensa tracking URLs.
 *
 * Reads all lensa.com entries from data/pipeline.md, uses a headless browser
 * to follow the JS redirect chain, and either:
 *   - Replaces the lensa entry with the real ATS URL if it resolves cleanly
 *   - Removes the entry if expired or still on lensa.com
 *
 * Run inside the applier container (has Chromium + Playwright):
 *   docker compose run --rm applier node resolve-lensa.mjs [--dry-run]
 *
 * Nightly cron: runs after fetch-gmail-leads.mjs, before fetch-jds.mjs.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { canonicalizeUrl } from './lib/url-canonical.mjs';

const ROOT = process.env.CAREER_OPS_ROOT ?? process.cwd();
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const LOG_PATH = path.join(ROOT, 'logs', 'resolve-lensa.log');
const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = parseInt(process.env.RESOLVE_CONCURRENCY ?? '4', 10);
const TIMEOUT_MS = parseInt(process.env.RESOLVE_TIMEOUT_MS ?? '15000', 10);

// Recognized ATS domains — resolving to any of these counts as success.
const ATS_SUFFIXES = [
  'greenhouse.io', 'ashbyhq.com', 'lever.co',
  'myworkdayjobs.com', 'myworkday.com',
  'smartrecruiters.com', 'jobvite.com', 'workable.com',
  'bamboohr.com', 'icims.com', 'taleo.net',
  'welcometothejungle.com', 'linkedin.com',
  'amazon.jobs', 'netflix.com', 'apple.com',
  'microsoft.com', 'meta.com', 'google.com',
  'adp.com', 'successfactors.com', 'dover.io',
];

function isRealJobUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ATS_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
  } catch { return false; }
}

// URL canonicalization now uses the shared lib/url-canonical.mjs (was a local
// copy that stripped fewer params than gmail's — the drift this consolidation
// fixes).

function inferCompany(url) {
  try {
    let m;
    m = url.match(/job-boards\.greenhouse\.io\/([a-z0-9-]+)/i) ||
        url.match(/greenhouse\.io\/([a-z0-9-]+)/i);
    if (m) return m[1].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    m = url.match(/ashbyhq\.com\/([a-z0-9-]+)/i);
    if (m) return m[1].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    m = url.match(/lever\.co\/([a-z0-9-]+)/i);
    if (m) return m[1].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    const host = new URL(url).hostname.replace(/^(www\.|jobs\.|careers\.)/, '');
    const stem = host.split('.')[0];
    return stem.length >= 3 ? stem[0].toUpperCase() + stem.slice(1) : 'Unknown';
  } catch { return 'Unknown'; }
}

function parseLine(line) {
  const m = line.match(/^(-\s*\[[ x]\]\s*)(\S+)(\s*\|.*)$/);
  if (!m) return null;
  return { prefix: m[1], url: m[2], suffix: m[3] };
}

async function resolveOne(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    // Extra wait for JS-driven redirects (window.location, meta refresh)
    await page.waitForTimeout(2000);
    const final = page.url();
    if (!final || final === url || final.includes('lensa.com')) return null;
    return final;
  } catch {
    return null;
  }
}

async function main() {
  if (!existsSync(PIPELINE_PATH)) {
    console.log('pipeline.md not found.');
    return;
  }

  const content = await readFile(PIPELINE_PATH, 'utf-8');
  const lines = content.split('\n');

  const lensaEntries = [];
  for (let i = 0; i < lines.length; i++) {
    const p = parseLine(lines[i]);
    if (p && p.url.includes('lensa.com')) {
      lensaEntries.push({ idx: i, url: p.url });
    }
  }

  if (lensaEntries.length === 0) {
    console.log('No lensa.com entries in pipeline.md — nothing to do.');
    return;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`resolve-lensa — ${new Date().toISOString()}`);
  console.log(`Lensa entries: ${lensaEntries.length}  concurrency: ${CONCURRENCY}${DRY_RUN ? '  DRY RUN' : ''}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Build seen-URL set from non-lensa lines to avoid dupes
  const seenUrls = new Set();
  for (const line of lines) {
    const p = parseLine(line);
    if (p && !p.url.includes('lensa.com')) seenUrls.add(p.url);
  }

  const browser = await chromium.launch({ headless: true });
  const resolvedMap = new Map(); // lensaUrl → canonicalRealUrl
  let resolved = 0, expired = 0, duped = 0;

  // Process in CONCURRENCY-wide windows
  for (let i = 0; i < lensaEntries.length; i += CONCURRENCY) {
    const chunk = lensaEntries.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async ({ url }) => {
      const page = await browser.newPage();
      try {
        const final = await resolveOne(page, url);
        if (!final || !isRealJobUrl(final)) {
          expired++;
          console.log(`  ✗ expired  ${url.slice(0, 70)}`);
          return;
        }
        const clean = canonicalizeUrl(final);
        if (seenUrls.has(clean)) {
          duped++;
          console.log(`  = dupe     ${clean.slice(0, 70)}`);
          return;
        }
        seenUrls.add(clean);
        resolvedMap.set(url, clean);
        resolved++;
        console.log(`  ✓ resolved ${url.slice(0, 40)} → ${clean.slice(0, 60)}`);
      } finally {
        await page.close();
      }
    }));
  }

  await browser.close();

  const summary = { lensaEntries: lensaEntries.length, resolved, expired, duped };
  console.log(`\nDone: ${resolved} resolved, ${expired} expired/blocked, ${duped} already in pipeline`);

  if (!DRY_RUN) {
    const lensaIdxSet = new Set(lensaEntries.map(e => e.idx));
    const today = new Date().toISOString().slice(0, 10);
    const newLines = lines.flatMap((line, i) => {
      if (!lensaIdxSet.has(i)) return [line];
      const realUrl = resolvedMap.get(lensaEntries.find(e => e.idx === i)?.url ?? '');
      if (!realUrl) return []; // drop expired
      const company = inferCompany(realUrl);
      return [`- [ ] ${realUrl} | ${company} | Unknown | source: lensa-resolved | ${today}`];
    });
    await writeFile(PIPELINE_PATH, newLines.join('\n'), 'utf-8');
    console.log(`pipeline.md updated: +${resolved} real ATS URLs, -${lensaEntries.length} lensa entries`);

    await mkdir(path.dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${JSON.stringify(summary)}\n`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
