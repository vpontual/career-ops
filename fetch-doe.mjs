#!/usr/bin/env node
/**
 * fetch-doe.mjs — NYC Public Schools central-office vacancies.
 *
 * WHY THIS EXISTS. VP passed Exam 6003 (Administrative Education Officer) on
 * 2026-08-14 and asked which DOE roles he could act on. His pipeline had never
 * seen one: `grep -ic "Administrative Education Officer" data/scan-history.tsv`
 * returned 0 across 2,255 JDs. The reason is not a filter bug — DOE does not
 * post here at all. Measured the same day against the NYC Open Data feed
 * fetch-civic.mjs reads (kpav-sd4t, 1,389 external postings): ZERO rows from
 * any agency with "EDUCATION" in the name, and zero Administrative Education
 * titles of any kind. NYCPS runs its own board, and this is it.
 *
 * ⚠ INTERNAL-ONLY POSTINGS ARE SKIPPED, and that is most of what looks good.
 * A large share of DOE central roles carry "Position is only open to current
 * City employees with permanent NYC civil service status as <title>". VP has
 * never been a city employee, so those are unapplyable no matter how well they
 * fit. Measured on the first run: of 12 postings matching his profile, 5 were
 * internal-only — including every one whose civil service title was in the
 * Administrative Education family. They are counted and logged, never silently
 * dropped.
 *
 * ⚠ A LIST NUMBER IS NOT ELIGIBILITY FOR THESE. Two distinct traps:
 *   - The DOE roles nearest his profile are Administrative Education ANALYST,
 *     a different title and a different exam from the OFFICER list he is on.
 *   - Postings with "Civil Service Title: Not Applicable" are consultant lines.
 *     No list is certified against them, so standing on one buys nothing.
 *
 * ⚠ THERE IS NO POSTED DATE ON THIS BOARD, only a Posting End Date. The JD is
 * stamped with the date this script FIRST SAW it, and the file is never
 * rewritten afterwards, so the age is "days since we noticed" and freezes on
 * first sight. lib/jd-parse.mjs reads posted_days out of the "(N days ago)"
 * parenthetical and a null there makes enqueue-review treat the role as stale —
 * which is the bug that silently binned all 31 civic roles on their first run.
 *
 * Run: node fetch-doe.mjs [--dry-run] [--all]
 *   --all   include internal-only postings (for auditing; they stay unapplyable)
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JDS = path.join(ROOT, 'jds');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const HISTORY = path.join(ROOT, 'data', 'scan-history.tsv');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') || args.includes('--list');
const ALL = args.includes('--all');

const BASE = 'https://nychb.teacherssupportnetwork.com';
const LIST_URL = `${BASE}/guest/ShowVacancies.do?externalOnly=yes&resultsPerPage=200`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// Same shape as fetch-civic's filter and for the same reason: the board is
// mostly school-based clinical and instructional vacancies the scorer would
// gate to 1 anyway, so they are never ingested rather than scored and discarded.
const WANTED = /\b(director|deputy|executive|chief|project manager|program manager|product|data|analyt|strateg|operations|policy|planning|innovation|technology|research)\b/i;
const EXCLUDED = /\b(interpreter|teacher|paraprofessional|nurse|therapist|counselor|social worker|custodial|bus |food service|coach|substitute|principal|assistant principal)\b/i;

const INTERNAL_ONLY = /only open to current City employees|only open to current NYCPS employees|permanent (?:NYC )?civil service status/i;

const strip = (s) => String(s || '')
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '\n');

const decode = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&rsquo;/g, '’').replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"');

const lines = (h) => decode(strip(h)).split('\n').map(l => l.trim()).filter(Boolean);

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

/** The listing page is division-grouped; each vacancy row carries its id. */
function parseList(htmlText) {
  const body = htmlText.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  const out = [];
  let division = '';
  for (const row of body.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [])
      .map(c => decode(c.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (cells.length === 2 && cells[0] === '-') { division = cells[1]; continue; }
    const id = row.match(/vacancyId=(\d+)/);
    if (!id || cells.length < 4) continue;
    out.push({ division, title: cells[1], borough: cells[2], endDate: cells[3], id: id[1] });
  }
  return out;
}

/** Pull a labelled field out of the detail page's definition-list layout. */
function field(ls, label) {
  const want = label.toLowerCase();
  for (let i = 0; i < ls.length; i++) {
    if (ls[i].replace(/:$/, '').toLowerCase() !== want) continue;
    for (const n of ls.slice(i + 1, i + 3)) if (n) return n;
  }
  return '';
}

const main = async () => {
  const rows = parseList(await get(LIST_URL));
  console.log(`NYCPS board: ${rows.length} vacancies listed`);

  const matched = rows.filter(r => WANTED.test(r.title) && !EXCLUDED.test(r.title));
  console.log(`after title filter: ${matched.length} director/program/data/strategy roles`);

  const keep = [], internal = [];
  for (const r of matched) {
    const url = `${BASE}/guest/ShowVacancyDetails.do?vacancyId=${r.id}`;
    let ls;
    try { ls = lines(await get(url)); }
    catch (e) { console.log(`  ! ${r.id} detail fetch failed: ${e.message}`); continue; }
    const blob = ls.join(' ');
    const rec = {
      ...r, url,
      civilServiceTitle: field(ls, 'Civil Service Title'),
      level: field(ls, 'Level'),
      positionType: field(ls, 'Position Type'),
      // Everything from "Description:" on is the actual posting.
      body: ls.slice(Math.max(0, ls.findIndex(l => /^Description:?$/i.test(l)))).join('\n').slice(0, 12000),
    };
    (INTERNAL_ONLY.test(blob) ? internal : keep).push(rec);
    await new Promise(s => setTimeout(s, 400));   // this board is not a CDN
  }

  // Never a silent cap — an unapplyable role that vanishes without a line in
  // the log is indistinguishable from one that was never posted.
  if (internal.length) {
    console.log(`\nskipping ${internal.length} INTERNAL-ONLY posting(s) — permanent city employees only:`);
    for (const r of internal) console.log(`    ${r.civilServiceTitle || '?'} | ${r.title.slice(0, 62)}`);
  }
  const use = ALL ? [...keep, ...internal] : keep;
  console.log(`\napplyable: ${keep.length}`);

  if (DRY) {
    for (const k of use) {
      console.log(`  [ends ${k.endDate}] ${k.title.slice(0, 62)}`);
      console.log(`      ${k.division.slice(0, 52)} | ${k.borough} | CS: ${k.civilServiceTitle || 'Not Applicable (consultant line)'}`);
    }
    console.log('\n--dry-run, nothing written');
    return;
  }

  await mkdir(JDS, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  let wrote = 0;
  for (const k of use) {
    const slug = `nycps-${k.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 52)}`.replace(/-+/g, '-').replace(/-$/, '');
    const file = path.join(JDS, `${slug}.md`);
    const md = [
      `# ${k.title}`,
      `**URL:** ${k.url}`,
      `**Company:** NYC Public Schools`,
      `**Location:** ${k.borough}, New York, NY`,
      // See the header: this board publishes no posted date, so the stamp is
      // first-seen and freezes because the file is never rewritten.
      `**Posted:** ${today} (0 days ago)`,
      `**Source:** nycps-board`,
      `**Division:** ${k.division}`,
      k.civilServiceTitle ? `**Civil Service Title:** ${k.civilServiceTitle}` : '',
      k.level ? `**Level:** ${k.level}` : '',
      `**Posting End Date:** ${k.endDate}`,
      '---',
      k.body,
    ].filter(Boolean).join('\n');
    try { await readFile(file, 'utf8'); } catch { await writeFile(file, md); wrote++; }
    k.slug = slug;
  }
  console.log(`JDs: ${wrote} written`);

  let existing = '';
  try { existing = await readFile(PIPELINE, 'utf8'); } catch {}
  const fresh = use.filter(k => !existing.includes(k.url));
  if (!fresh.length) { console.log('all already known in pipeline.md'); return; }
  await appendFile(PIPELINE, '\n' + fresh.map(f =>
    `- [ ] ${f.url} | NYC Public Schools | ${f.title} | source: nycps-board | ${today}`).join('\n') + '\n');
  await appendFile(HISTORY, fresh.map(f =>
    `${f.url}\t${today}\tnycps-board\t${f.title}\tNYC Public Schools\tadded\t${today}\n`).join(''));
  console.log(`appended ${fresh.length} to pipeline.md`);
};

main().catch((e) => { console.error(e); process.exit(1); });
