#!/usr/bin/env node

/**
 * fetch-amazon.mjs — Amazon and its subsidiaries, which no ATS scan can reach.
 *
 * Audible, Ring, Zappos, IMDb and Whole Foods do not use Greenhouse, Ashby or
 * Lever; everything routes through amazon.jobs, so portals.yml is blind to all
 * of them. amazon.jobs does publish a JSON search endpoint, and it carries the
 * two fields that matter here: `company_name`, which names the actual employer,
 * and `business_category`, which has a dedicated `subsidiaries` value.
 *
 * Why this exists at all: VP worked at Amazon (Seattle, 2015-2016) and did not
 * enjoy it. He will not go back to corporate HQ, but he WILL consider a non-HQ
 * office, and he is actively interested in the acquired companies — Audible,
 * Ring, Zappos — on the theory that an acquisition may have kept a better
 * culture than its parent. So this cannot be a blanket include or a blanket
 * exclude of "Amazon". It has to read the office and the employer.
 *
 * Audible is the find: it is headquartered in Newark, New Jersey, which is a
 * real commute from Manhattan and the only one of the named subsidiaries in his
 * geography.
 *
 * Rules applied:
 *   DROP  Seattle and Bellevue — that is HQ, and that is the part he left.
 *   KEEP  NY, NJ, and anything remote.
 *   KEEP  any subsidiary anywhere, tagged, because he named them unprompted.
 *   DROP  everything else, quietly.
 *
 * Usage: node fetch-amazon.mjs [--dry-run]
 */

import { readFile, appendFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const HISTORY = path.join(ROOT, 'data', 'scan-history.tsv');
const JDS_DIR = path.join(ROOT, 'jds');
const DRY = process.argv.includes('--dry-run');

// amazon.jobs renders its posting pages in the browser and publishes no
// JSON-LD, so fetch-jds.mjs could never read one: every Amazon and Audible URL
// came back "FAIL parse", 13 of them on 2026-08-04 alone, and a role with no
// description on disk is never scored and can never reach the review queue.
//
// It does not need scraping at all. The same search.json response that finds
// these roles already carries `description`, `basic_qualifications` and
// `preferred_qualifications` in full, so the JD is written here, at discovery,
// in the exact format and filename convention fetch-jds.mjs uses - which means
// fetch-jds then counts it as already-present and skips it.
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// "August  4, 2026" (note the double space amazon.jobs emits) -> "2026-08-04".
function isoDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/\s+/g, ' ').trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// `team` comes back as an object ({id, businessCategory, label, ...}), not a
// string, so interpolating it directly wrote "**Department:** [object Object]".
function teamName(job) {
  const t = job.team;
  if (!t) return '';
  if (typeof t === 'string') return t;
  const n = String(t.label || t.name || t.businessCategory || '').trim();
  return /^no-team-listed$/i.test(n) ? '' : n;
}

async function writeJd(k, job) {
  // Must match fetch-jds.mjs exactly: detectAts() returns null for amazon.jobs,
  // so it falls through to the sha1-of-URL suffix.
  const suffix = crypto.createHash('sha1').update(k.url).digest('hex').slice(0, 12);
  const filename = `${slugify(k.company)}-${suffix}.md`;
  const posted = isoDate(k.posted);
  const body = [
    stripHtml(job.description),
    job.basic_qualifications ? `\n## Basic Qualifications\n\n${stripHtml(job.basic_qualifications)}` : '',
    job.preferred_qualifications ? `\n## Preferred Qualifications\n\n${stripHtml(job.preferred_qualifications)}` : '',
  ].filter(Boolean).join('\n');

  const md = [
    `# ${k.title}`,
    ``,
    `**URL:** ${k.url}`,
    `**Company:** ${k.company}`,
    `**Location:** ${k.loc}`,
    teamName(job) ? `**Department:** ${teamName(job)}` : '',
    posted ? `**Posted:** ${posted} (${daysSince(posted)} days ago)` : '',
    ``,
    `---`,
    ``,
    body,
  ].filter(Boolean).join('\n');

  await writeFile(path.join(JDS_DIR, filename), md);
  return filename;
}

const UA = 'Mozilla/5.0 (compatible; career-ops/1.0)';
const BASE = 'https://www.amazon.jobs/en/search.json';

// Titles worth surfacing. amazon.jobs calls almost everything "Technical", so
// the PM-T variants have to be allowed through rather than filtered as
// engineering.
const TITLE_OK = /(product manager|product lead|head of product|director,? product|principal pm|\bpmt\b)/i;
// Word-anchored. Unanchored, `intern` matched INTERNational and silently dropped
// every "Senior Product Manager, International Expansion" and "Internal Tools"
// req before it reached pipeline.md, where it was invisible to every count.
const TITLE_NO = /\b(intern|interns|internship|university|apprentice|assistant|coordinator|recruiter|sourcer)\b/i;

// HQ. The specific thing he is not going back to.
const HQ = /\b(seattle|bellevue|redmond)\b/i;

const QUERIES = [
  { label: 'subsidiaries', params: { 'business_category[]': 'subsidiaries' } },
  { label: 'nyc',          params: { 'city[]': 'New York' } },
  { label: 'newark',       params: { 'city[]': 'Newark' } },
  // ⚠ WAS `base_query: 'product manager remote'`, which returned 0 raw results on
  // 6 of 6 runs — a quarter of the sweep, dead, reporting as a legitimate zero.
  // amazon.jobs treats base_query near-literally: measured against the live API,
  // "product manager remote" -> 0 hits and "product manager" -> 759. Adding the
  // word killed the search rather than filtering it.
  //
  // Replaced with the plain US-wide query, which is strictly better: it is the
  // only query here with no city or category filter, so it is the one that can
  // surface a fully-remote role at all, and the location rules below already
  // KEEP remote and drop Seattle/Bellevue.
  { label: 'us-recent',    params: {} },
];

function url(extra) {
  const p = new URLSearchParams({
    base_query: 'product manager',
    'country[]': 'USA',
    result_limit: '100',
    sort: 'recent',
  });
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'base_query') p.set(k, v);
    else p.append(k, v);
  }
  return `${BASE}?${p}`;
}

async function fetchQuery(q) {
  try {
    const r = await fetch(url(q.params), { headers: { 'User-Agent': UA } });
    if (!r.ok) {
      console.log(`  ${q.label}: HTTP ${r.status}`);
      return [];
    }
    const d = await r.json();
    return d.jobs ?? [];
  } catch (e) {
    // A failed query is reported, never silently read as "no results" — that
    // misreporting is exactly how the Indeed DNS failures hid for a week.
    console.log(`  ${q.label}: FAILED (${String(e).slice(0, 60)})`);
    return [];
  }
}

// "Audible, Inc. - B13" -> "Audible". The suffix is an internal cost-centre code.
function cleanCompany(name) {
  return String(name || 'Amazon')
    .replace(/\s*-\s*[A-Z]\d+\s*$/, '')
    .replace(/,?\s*(Inc\.?|LLC|Ltd\.?)\s*$/i, '')
    .trim() || 'Amazon';
}

function isSubsidiary(job) {
  return job.business_category === 'subsidiaries' &&
         !/^amazon\.com services/i.test(job.company_name || '');
}

const main = async () => {
  console.log('amazon.jobs sweep');
  const seen = new Map();
  for (const q of QUERIES) {
    const jobs = await fetchQuery(q);
    console.log(`  ${q.label}: ${jobs.length} raw`);
    for (const j of jobs) if (!seen.has(j.id_icims)) seen.set(j.id_icims, j);
  }
  console.log(`\nunique: ${seen.size}`);

  let existing = '';
  try { existing = await readFile(PIPELINE, 'utf8'); } catch {}

  const kept = [];
  const counts = { title: 0, hq: 0, geo: 0, dupe: 0 };

  for (const j of seen.values()) {
    const title = j.title || '';
    if (!TITLE_OK.test(title) || TITLE_NO.test(title)) { counts.title++; continue; }

    const loc = j.normalized_location || j.location || '';
    const sub = isSubsidiary(j);
    const remote = /remote|virtual/i.test(loc) || /remote/i.test(title);

    if (HQ.test(loc) && !sub) { counts.hq++; continue; }
    if (!sub && !remote && !/\b(New York|New Jersey|Newark)\b/i.test(loc)) { counts.geo++; continue; }

    const link = `https://www.amazon.jobs${j.job_path}`;
    // A role already in pipeline.md still needs its JD written if the earlier
    // run predates this file doing so - that is the whole 13-role Audible
    // backlog. Dupes are kept here and filtered out of the pipeline append
    // below, rather than skipped outright.
    const dupe = existing.includes(link);
    if (dupe) counts.dupe++;

    kept.push({
      dupe,
      url: link,
      company: cleanCompany(j.company_name),
      title,
      loc,
      sub,
      posted: j.posted_date || '',
      job: j,
    });
  }

  const fresh = kept.filter((k) => !k.dupe);
  console.log(`dropped: ${counts.title} title, ${counts.hq} HQ, ${counts.geo} geo`);
  console.log(`${counts.dupe} already in pipeline (JD still written if missing)`);
  console.log(`\nKEEPING ${kept.length} (${fresh.length} new to pipeline):\n`);
  for (const k of kept) {
    console.log(`  ${k.sub ? '★ SUBSIDIARY' : '  amazon    '}${k.dupe ? ' [known]' : '       '} ${k.company} | ${k.title.slice(0, 52)} | ${k.loc}`);
  }

  if (DRY || !kept.length) {
    if (DRY) console.log('\n--dry-run, nothing written');
    return;
  }

  // Write the JD before the pipeline row. If this run dies halfway, a JD with
  // no pipeline row is inert, whereas a pipeline row with no JD is exactly the
  // FAIL-parse backlog this change exists to remove.
  await mkdir(JDS_DIR, { recursive: true });
  let wrote = 0;
  for (const k of kept) {
    try {
      await writeJd(k, k.job);
      wrote++;
    } catch (e) {
      console.log(`  JD write failed for ${k.company} | ${k.title}: ${String(e).slice(0, 70)}`);
    }
  }
  console.log(`\nwrote ${wrote}/${kept.length} JDs to jds/`);

  if (!fresh.length) { console.log('no new pipeline rows'); return; }
  const today = new Date().toISOString().slice(0, 10);
  await appendFile(
    PIPELINE,
    '\n' + fresh.map((k) => `- [ ] ${k.url} | ${k.company} | ${k.title} | source: amazon-jobs | ${today}`).join('\n') + '\n'
  );
  await appendFile(
    HISTORY,
    fresh.map((k) => `${k.url}\t${today}\tamazon-jobs\t${k.title}\t${k.company}\tadded\n`).join('')
  );
  console.log(`\nappended ${fresh.length} to pipeline.md`);
};

main().catch((e) => { console.error(e); process.exit(1); });
