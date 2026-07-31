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

import { readFile, appendFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const HISTORY = path.join(ROOT, 'data', 'scan-history.tsv');
const DRY = process.argv.includes('--dry-run');

// One zip per target county. Manhattan is included so NYC postings that DO
// reach OLAS are not missed.
const SEARCHES = [
  { zip: '10011', label: 'Manhattan' },
  { zip: '10601', label: 'Westchester' },
  { zip: '11550', label: 'Nassau' },
  { zip: '11772', label: 'Suffolk' },
  { zip: '10901', label: 'Rockland' },
];
const KEYWORDS = ['business', 'marketing'];

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

  let existing = '';
  try { existing = await readFile(PIPELINE, 'utf8'); } catch {}
  const fresh = list.filter((f) => !existing.includes(f.url));
  if (!fresh.length) { console.log('all already known'); return; }

  const today = new Date().toISOString().slice(0, 10);
  await appendFile(PIPELINE, '\n' + fresh.map((f) =>
    `- [ ] ${f.url} | ${f.district || f.where} | ${f.title} | source: olas | ${today}`).join('\n') + '\n');
  await appendFile(HISTORY, fresh.map((f) =>
    `${f.url}\t${today}\tolas\t${f.title}\t${f.district || f.where}\tadded\n`).join(''));
  console.log(`\nappended ${fresh.length} to pipeline.md`);
};

main().catch((e) => { console.error(e); process.exit(1); });
