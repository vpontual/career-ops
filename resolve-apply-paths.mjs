#!/usr/bin/env node

/**
 * resolve-apply-paths.mjs — find the employer's own posting for roles we only
 * know from an aggregator.
 *
 * 107 roles score tier 4+ and cannot be enqueued, because the only URL we have
 * is an Indeed viewjob page and there is no form on it. They sit in
 * data/unresolved-apply-paths.md doing nothing. This goes and finds the real one.
 *
 * ⚠ SLUG GUESSING IS BANNED in this repo, and for good reason: the venture
 * config once matched eight wrong companies in a day (greenhouse/robinhood is
 * Robinhood Markets, not Robin Hood Foundation). So this guesses candidate
 * slugs, then REFUSES to accept any of them unless the board actually carries a
 * posting whose canonical title matches the role we are looking for. The title
 * match is the proof, not the slug.
 *
 * A resolved role is appended to pipeline.md with its real ATS URL, so the
 * ordinary chain fetches, scores, stages and enqueues it like anything else.
 *
 * Usage: node resolve-apply-paths.mjs [--limit N] [--dry-run]
 */

import { readFile, appendFile, readdir } from 'fs/promises';
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseJd } from './lib/jd-parse.mjs';
import { canonKey, normalizeCompany, normalizeTitle } from './lib/canonical.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : null; })();
const MIN_SCORE = 4;

const AGG = /(indeed\.com|glassdoor\.com|linkedin\.com|ziprecruiter\.com|lensa\.com|jobot\.com|simplyhired)/i;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' };

// Workday, which is a different shape from the four board APIs: it is a POST,
// its coordinates are tenant + pod + SITE ID, and the site ID is arbitrary -
// Citi's is literally "2". Nothing about it is guessable from a company name, so
// the coordinates live in config/workday-boards.yml and are found by hand once.
//
// ⚠ Measured 2026-08-10 before building this: of the employers dominating the
// unresolved backlog, only CITI is on Workday. Gartner, Humana, Mastercard,
// Capital One, MSCI, Uber and Bloomberg are on Phenom, Avature or bespoke
// career sites. Workday is not the enterprise skeleton key it looks like. It is
// here because it is cheap and correct, not because it clears the backlog.
//
// It searches by title rather than paging: Citi alone has 2,000 open reqs.
let WORKDAY = null;
function workdayBoards() {
  if (WORKDAY) return WORKDAY;
  try {
    WORKDAY = yaml.load(readFileSync(path.join(ROOT, 'config', 'workday-boards.yml'), 'utf-8'))?.boards || [];
  } catch { WORKDAY = []; }
  return WORKDAY;
}

async function workdaySearch(entry, title) {
  const { tenant, pod, site } = entry;
  const url = `https://${tenant}.${pod}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...UA },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: String(title || '').slice(0, 90) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.jobPostings || []).map(j => ({
      title: j.title || '',
      url: j.externalPath ? `https://${tenant}.${pod}.myworkdayjobs.com/en-US/${site}${j.externalPath}` : '',
      location: j.locationsText || '',
    })).filter(x => x.title && x.url);
  } catch { return null; }
}

const BOARDS = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`,
};

// Candidate slugs from a company name. These are GUESSES and are worthless on
// their own; the title check below is what makes them safe.
function candidateSlugs(company) {
  const base = String(company || '').toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|the|group|holdings|technologies|technology|labs|software)\b/g, ' ')
    .trim();
  const squashed = base.replace(/[^a-z0-9]+/g, '');
  const hyphened = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const first = base.split(/\s+/)[0] || '';
  // Suffix variants. Measured 2026-08-10: Ocrolus's Greenhouse board is
  // "ocrolusinc" and Ironclad's Ashby board is "ironcladhq" - both mechanical,
  // both un-generated, both sitting in the unresolved backlog for weeks. The
  // legal-entity suffix this function strips out of the NAME is often exactly
  // what the employer kept in its SLUG.
  //
  // Adding candidates costs only board-API calls, which are free and unmetered,
  // and cannot cost precision: the exact-title check below is what accepts, and
  // a wrong slug's board simply will not carry the role.
  const SUFFIXES = ['inc', 'hq', 'app', 'co', 'ai'];
  const bases = [squashed, hyphened, first].filter(x => x && x.length > 2);
  const withSuffix = [];
  for (const b of bases) for (const suf of SUFFIXES) withSuffix.push(b + suf);
  return [...new Set([...bases, ...withSuffix])];
}

const boardCache = new Map();
async function board(kind, slug) {
  const key = `${kind}:${slug}`;
  if (boardCache.has(key)) return boardCache.get(key);
  let out = null;
  try {
    const r = await fetch(BOARDS[kind](slug), { headers: UA, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const d = await r.json();
      const jobs = kind === 'smartrecruiters' ? (d.content || [])
        : Array.isArray(d) ? d : (d.jobs || []);
      out = jobs.map(j => ({
        title: j.title || j.text || j.name || '',
        url: j.absolute_url || j.jobUrl || j.hostedUrl
          || (j.company?.identifier && j.id ? `https://jobs.smartrecruiters.com/${j.company.identifier}/${j.id}` : ''),
        location: j.location?.name || j.location || j.locationName || j.categories?.location
          || [j.location?.city, j.location?.region].filter(Boolean).join(', ') || '',
      })).filter(x => x.title && x.url);
    }
  } catch { /* unreachable board is just a miss */ }
  boardCache.set(key, out);
  return out;
}

const main = async () => {
  const scores = JSON.parse(await readFile(path.join(ROOT, 'data/lead-scores.json'), 'utf-8'));
  const jdFiles = await readdir(path.join(ROOT, 'jds'));
  const pipeline = await readFile(path.join(ROOT, 'data/pipeline.md'), 'utf-8');

  // Everything already known by a real ATS URL, so we never re-add a duplicate.
  const knownKeys = new Set();
  const targets = [];
  for (const f of jdFiles) {
    const rec = scores[f];
    if (!rec || typeof rec !== 'object') continue;
    const jd = parseJd(await readFile(path.join(ROOT, 'jds', f), 'utf-8'), f);
    const company = (jd.company || '').trim();
    if (!company || /^(nan|unknown|none|null)$/i.test(company)) continue;
    const key = canonKey(company, jd.title || '');
    if (!AGG.test(jd.url || '')) { knownKeys.add(key); continue; }
    if (Number(rec.score) >= MIN_SCORE) targets.push({ f, jd, rec, key, company });
  }

  const todo = targets.filter(t => !knownKeys.has(t.key));
  const work = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.log(`aggregator-only at tier ${MIN_SCORE}+: ${targets.length}; ` +
              `${targets.length - todo.length} already known by a real URL; resolving ${work.length}\n`);

  const rows = [];
  let hit = 0, miss = 0;
  for (const [i, t] of work.entries()) {
    const wantTitle = normalizeTitle(t.jd.title || '');
    let found = null;

    // Known Workday employers first: the coordinates are exact, so this is a
    // single request with no guessing, and the same exact-title rule accepts it.
    const wdEntry = workdayBoards().find(
      (b) => normalizeCompany(b.company) === normalizeCompany(t.company));
    if (wdEntry) {
      const jobs = await workdaySearch(wdEntry, t.jd.title || '');
      for (const j of jobs || []) {
        if (normalizeTitle(j.title) === wantTitle) { found = { ...j, kind: 'workday', slug: wdEntry.tenant }; break; }
      }
    }

    if (!found)
    outer:
    for (const slug of candidateSlugs(t.company)) {
      for (const kind of Object.keys(BOARDS)) {
        const jobs = await board(kind, slug);
        if (!jobs || !jobs.length) continue;
        // THE CHECK THAT MAKES THE GUESS SAFE: the board must carry this exact
        // role. A board full of someone else's jobs simply will not match.
        for (const j of jobs) {
          if (normalizeTitle(j.title) === wantTitle) { found = { ...j, kind, slug }; break outer; }
        }
      }
    }
    if (found) {
      hit++;
      console.log(`  [${t.rec.score}] ${t.company} | ${t.jd.title.slice(0, 46)}`);
      console.log(`        -> ${found.kind}/${found.slug}: ${found.url.slice(0, 92)}`);
      // Several JD copies of one role resolve to the same posting - Smarsh
      // appeared three times - so dedupe within this run as well as against
      // what pipeline.md already holds.
      if (!pipeline.includes(found.url) && !rows.some((r) => r.includes(found.url))) {
        rows.push(`- [ ] ${found.url} | ${t.company} | ${found.title} | source: resolved | ${new Date().toISOString().slice(0, 10)}`);
      }
    } else {
      miss++;
    }
  }

  console.log(`\nresolved ${hit}, no employer board found for ${miss}`);
  if (rows.length && !DRY) {
    await appendFile(path.join(ROOT, 'data/pipeline.md'), '\n' + rows.join('\n') + '\n');
    console.log(`appended ${rows.length} rows to pipeline.md - the nightly chain will fetch and score them`);
  } else if (DRY) {
    console.log(`(dry run) would append ${rows.length} rows`);
  }
};

main().catch(e => { console.error(e); process.exit(1); });
