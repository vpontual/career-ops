#!/usr/bin/env node

/**
 * fetch-olas.mjs — Business & Marketing CTE teaching vacancies around NYC.
 *
 * Why this exists: VP's objection to the NYCPS route was that NYC DOE has no
 * central placement, so the search is his own. That is true of the city and
 * substantially untrue of the ring around it — his Transitional A certificate
 * is a NEW YORK STATE certificate, and the suburban districts post their
 * vacancies publicly and hire the ordinary way. A sample of one CTE board
 * showed 12 Business & Marketing vacancies statewide in five weeks, 8 of them in
 * the NYC metro, and none inside NYC, because NYC posts internally.
 *
 * OLAS is the standard NY school job board. It is an Angular app with no public
 * API - every path returns the shell - so this drives the real search form and
 * reads the rendered results. robots.txt allows everything except the Google
 * Maps paths, and this runs once a night on a handful of queries.
 *
 * Output goes into data/pipeline.md like every other source, so these roles flow
 * through the same ranking, staging and review queue as the PM roles.
 *
 * Usage: node fetch-olas.mjs [--dry-run]
 */

import { readFile, appendFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const HISTORY = path.join(ROOT, 'data', 'scan-history.tsv');
const JDS_DIR = path.join(ROOT, 'jds');
const DRY = process.argv.includes('--dry-run');

// The search results need a browser - the listing is an Angular view. The
// DETAIL pages do not: olasjobs.org server-renders them for SEO, so the whole
// description is in the raw HTML. That distinction matters, because fetch-jds
// only knows how to read JSON-LD and OLAS publishes a `WebSite` block rather
// than a `JobPosting` one. Every OLAS row therefore came back "FAIL parse",
// which meant all 8 Business-teacher vacancies had no description on disk and
// could never be scored. Track C was dead here, before anyone looked at it.
async function fetchDetailHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

function field(text, label) {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\s(?:Job Number|Start Date|End Date|Description|Salary|Contact|Apply):|$)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function writeOlasJd(rec, existingFiles) {
  // fetch-jds.mjs gets null from detectAts() for olasjobs.org, so it would name
  // the file sha1-of-URL. Match that exactly or it will re-fetch and re-fail.
  const suffix = crypto.createHash('sha1').update(rec.url).digest('hex').slice(0, 12);
  const company = rec.district || 'Unknown District';
  const filename = `${slugify(company)}-${suffix}.md`;
  if (existingFiles.has(filename)) return { filename, skipped: true };

  const text = visibleText(await fetchDetailHtml(rec.url));
  const desc = field(text, 'Description');
  if (!desc || desc.length < 80) throw new Error(`no description found (${desc.length} chars)`);

  const endDate = field(text, 'End Date').split('T')[0];
  const startDate = field(text, 'Start Date').split('T')[0];

  // OLAS publishes no posted date, only a start date and an application
  // deadline. Discovery date is the honest stand-in and is what the pipeline row
  // already records; labelling it as the posted date would overstate freshness.
  const today = new Date().toISOString().slice(0, 10);
  const md = [
    `# ${rec.title}`,
    ``,
    `**URL:** ${rec.url}`,
    `**Company:** ${company}`,
    `**Location:** ${rec.location || rec.where || ''}`,
    `**Posted:** ${today} (0 days ago)`,
    startDate ? `**Start date:** ${startDate}` : '',
    endDate ? `**Application deadline:** ${endDate}` : '',
    `**Source:** olas (no posted date published; date above is first-seen)`,
    ``,
    `---`,
    ``,
    desc,
  ].filter(Boolean).join('\n');

  await writeFile(path.join(JDS_DIR, filename), md);
  return { filename, skipped: false };
}

// One zip per target county. Manhattan is included so NYC postings that DO
// reach OLAS are not missed.
const SEARCHES = [
  { zip: '10011', label: 'Manhattan' },
  { zip: '10601', label: 'Westchester' },
  { zip: '11550', label: 'Nassau' },
  { zip: '11772', label: 'Suffolk' },
  { zip: '10901', label: 'Rockland' },
];
// ⚠ 'marketing' REMOVED 2026-08-06: it returned 0 rows and 0 kept in 30 of 30
// searches — half the OLAS query budget, spent nightly, that has never produced
// a single row. It was also redundant: SUBJECT below already matches 'marketing'
// in a title, so a marketing-adjacent CTE vacancy surfaced by the 'business'
// search is kept anyway. School districts simply do not title a teaching
// vacancy "marketing".
const KEYWORDS = ['business'];

// Two independent tests, because "business" alone is badly ambiguous in a school
// district: every district has an Assistant Superintendent for Business &
// Operations, a business office, and a school business administrator. None of
// those is a teaching job, and the first version surfaced nothing else.
const SUBJECT = /\b(business|marketing|entrepreneur|finance|accounting|economics|cte|career and technical)\b/i;
const TEACHING = /\b(teacher|teaching|instructor|educator|faculty)\b/i;
// Administrative and operational roles that merely contain the word business.
const NOT_TEACHING = /\b(superintendent|administrator|business official|business manager|treasurer|payroll|purchasing|custodian|aide|paraprofessional|secretary|clerk|bus driver|nurse|coach|monitor|cleaner|food service|director of (?:business|finance|operations))\b/i;

function wanted(title) {
  if (NOT_TEACHING.test(title)) return false;
  return SUBJECT.test(title) && TEACHING.test(title);
}

async function search(page, zip, keyword) {
  await page.goto('https://www.olasjobs.org/jobs', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  try {
    await page.check('#zipcode').catch(() => {});
    await page.fill('#Keyword', keyword);
    await page.fill('#dp-find-jobs-zipcode', zip);
    // The search control is a button or an enter-submit depending on layout.
    const btn = await page.$('button:has-text("Search"), input[type=submit], .btn-search');
    if (btn) await btn.click();
    else await page.press('#dp-find-jobs-zipcode', 'Enter');
    await page.waitForTimeout(5000);
  } catch (e) {
    console.log(`    form interaction failed: ${String(e).slice(0, 70)}`);
    return [];
  }

  return page.evaluate(() => {
    // Rows are <app-job-card-view> elements. The anchors inside them carry
    // class "d-none" and are duplicated, so reading from the anchor and walking
    // up gave the same card's text for every link - which is how the first
    // version reported ten different URLs all titled "Assistant Superintendent
    // for Business & Operations". Iterate the cards themselves instead.
    const out = [];
    for (const card of document.querySelectorAll('app-job-card-view')) {
      const a = card.querySelector('a[href*="job-details"]');
      if (!a) continue;
      const lines = (card.innerText || '')
        .split('\n').map(t => t.trim()).filter(Boolean);
      if (!lines.length) continue;
      // Card layout, verified against the rendered DOM: line 0 is the DISTRICT,
      // line 1 is the job title, line 2 is the location. Reading line 0 as the
      // title meant the filter was testing district names against a pattern for
      // job titles, so it rejected every row - indistinguishable from "there are
      // no vacancies", which is exactly how it first read.
      out.push({
        href: a.getAttribute('href') || '',
        district: lines[0] || '',
        title: (lines[1] || '').slice(0, 120),
        location: lines[2] || '',
      });
    }
    return out;
  });
}

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const found = new Map();

  for (const s of SEARCHES) {
    for (const kw of KEYWORDS) {
      process.stdout.write(`  ${s.label} / ${kw}: `);
      const rows = await search(page, s.zip, kw).catch(() => []);
      let kept = 0;
      for (const r of rows) {
        if (!wanted(r.title)) continue;
        const url = r.href.startsWith('http') ? r.href : 'https://www.olasjobs.org' + (r.href.startsWith('/') ? '' : '/') + r.href;
        if (!found.has(url)) {
          found.set(url, { url, title: r.title, where: s.label, district: r.district, location: r.location });
          kept++;
        }
      }
      console.log(`${rows.length} rows, ${kept} kept`);
    }
  }
  await browser.close();

  const list = [...found.values()];
  console.log(`\nunique Business/Marketing-ish vacancies: ${list.length}`);
  for (const f of list) console.log(`  [${f.where}] ${f.title}\n      ${f.district} — ${f.location}\n      ${f.url}`);

  if (DRY || !list.length) {
    if (DRY) console.log('\n--dry-run, nothing written');
    return;
  }

  // Every vacancy gets its JD, including ones already in pipeline.md — those are
  // precisely the backlog that has been failing to parse every night.
  await mkdir(JDS_DIR, { recursive: true });
  const existingFiles = new Set(await readdir(JDS_DIR).catch(() => []));
  let wrote = 0, kept = 0;
  for (const rec of list) {
    try {
      const r = await writeOlasJd(rec, existingFiles);
      if (r.skipped) kept++; else wrote++;
    } catch (e) {
      console.log(`  JD failed: ${rec.title.slice(0, 45)} — ${String(e.message).slice(0, 60)}`);
    }
  }
  console.log(`\nJDs: ${wrote} written, ${kept} already present`);

  let existing = '';
  try { existing = await readFile(PIPELINE, 'utf8'); } catch {}
  const fresh = list.filter((f) => !existing.includes(f.url));
  if (!fresh.length) { console.log('all already known in pipeline.md'); return; }

  const today = new Date().toISOString().slice(0, 10);
  await appendFile(PIPELINE, '\n' + fresh.map((f) =>
    `- [ ] ${f.url} | ${f.district || f.where} | ${f.title} | source: olas | ${today}`).join('\n') + '\n');
  await appendFile(HISTORY, fresh.map((f) =>
    `${f.url}\t${today}\tolas\t${f.title}\t${f.district || f.where}\tadded\n`).join(''));
  console.log(`\nappended ${fresh.length} to pipeline.md`);
};

main().catch((e) => { console.error(e); process.exit(1); });
