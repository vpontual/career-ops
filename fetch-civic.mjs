#!/usr/bin/env node

/**
 * fetch-civic.mjs — City of New York job postings, for Track E.
 *
 * Why this exists: Track E (civic) was added to lib/track.mjs on 2026-08-10 with
 * its own rubric — no AI-native requirement, comp that only ever adds, and a
 * civil-service exam scored as a PATH IN rather than a barrier — and then scored
 * nothing at all, because no source in this repo covers city jobs. Verified: zero
 * city-employer JDs in a 1,938-JD corpus. NYC hires through its own system, not
 * Greenhouse/Ashby/Lever, so the ~155 tracked ATS boards can never see them.
 *
 * The city publishes every posting as OPEN DATA (Socrata), so this needs no
 * scraping, no browser, and no credentials — unlike fetch-olas.mjs, which has to
 * drive an Angular app. Dataset kpav-sd4t, "Jobs NYC Postings".
 *
 * ⚠ Two things this dataset gives us that ordinary ATS scrapes do not:
 *   - REAL SALARY BANDS on nearly every row (salary_range_from/to). Track E treats
 *     comp as additive, so this is signal rather than a filter.
 *   - The civil-service structure itself (civil_service_title, title_classification),
 *     which is what makes an exam route visible to the scorer.
 *
 * Output goes into data/pipeline.md like every other source, so these flow through
 * the same fetch → rank → stage → review chain as everything else.
 *
 * Usage: node fetch-civic.mjs [--dry-run] [--limit N]
 */

import { readFile, appendFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const HISTORY = path.join(ROOT, 'data', 'scan-history.tsv');
const JDS = path.join(ROOT, 'jds');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : 400; })();

const API = 'https://data.cityofnewyork.us/resource/kpav-sd4t.json';

// Roles VP could plausibly do. Deliberately broad on the product/program/tech
// side and silent everywhere else - the city posts thousands of roles a year and
// most are trades, clinical or enforcement positions the scorer would gate to 1
// anyway. Better to not ingest them than to score and discard them nightly.
const WANTED = /\b(product manager|product management|program manager|project manager|digital|technology|data|analytics|innovation|service design|user experience|\bUX\b|strategy|transformation|chief of staff)\b/i;
// Titles that are a hard no regardless of the words above.
const EXCLUDED = /\b(nurse|physician|police|correction|sanitation|plumber|electrician|carpenter|inspector|attorney|counsel|architect|engineer in charge|licensed|clinician|social worker|teacher|paraprofessional|construction|markings|cartograph|surveyor|content analyst|highway|bridge|paving|fleet|custodial)\b/i;

const clean = (s) => String(s || '').replace(/\r/g, '').replace(/ /g, ' ').trim();

async function fetchPostings() {
  // Externally-posted, still-open roles, newest first.
  const q = new URL(API);
  q.searchParams.set('$limit', String(LIMIT));
  q.searchParams.set('$order', 'posting_date DESC');
  q.searchParams.set('$where', "posting_type='External'");
  const r = await fetch(q, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`NYC Open Data HTTP ${r.status}`);
  return r.json();
}

const main = async () => {
  const rows = await fetchPostings();
  console.log(`NYC Open Data: ${rows.length} external postings pulled`);

  const seen = new Set();
  const keep = [];
  for (const j of rows) {
    const title = clean(j.business_title) || clean(j.civil_service_title);
    if (!title || !WANTED.test(title) || EXCLUDED.test(title)) continue;
    // One row per requisition; the dataset repeats a job_id per location.
    if (seen.has(j.job_id)) continue;
    seen.add(j.job_id);
    keep.push({
      id: j.job_id,
      title,
      agency: clean(j.agency) || 'City of New York',
      // ⚠ PATH form, not a query string. `/job/?id=<id>` does not resolve at all,
      // and stage-applications' liveness probe pruned all 31 of these as expired
      // on the first run. `/job/<id>` returns 200.
      url: `https://cityjobs.nyc.gov/job/${j.job_id}`,
      // ⚠ Normalise the location, do not pass the raw address through.
      // The dataset gives street addresses like "42 Broadway, N.Y." and
      // "55 Water St Ny Ny", which normalizeGeo cannot read - bare "NY" is the
      // STATE, and matching it would wrongly claim Albany as NYC. Every posting
      // here is a City of New York role by definition, so the city is known.
      // The street address is preserved in the body for the reader.
      location: 'New York, NY',
      street: clean(j.work_location),
      posted: clean(j.posting_date).slice(0, 10),
      salaryFrom: j.salary_range_from, salaryTo: j.salary_range_to, salaryFreq: clean(j.salary_frequency),
      civilServiceTitle: clean(j.civil_service_title),
      careerLevel: clean(j.career_level),
      body: [clean(j.job_description), clean(j.minimum_qual_requirements), clean(j.preferred_skills), clean(j.to_apply), clean(j.residency_requirement)].filter(Boolean).join('\n\n'),
    });
  }
  console.log(`after title filter: ${keep.length} product/program/technology roles`);
  if (DRY) {
    for (const k of keep.slice(0, 12)) console.log(`  ${k.agency.slice(0, 30).padEnd(32)} ${k.title.slice(0, 46)}`);
    console.log('\n--dry-run, nothing written');
    return;
  }

  await mkdir(JDS, { recursive: true });
  let wrote = 0;
  for (const k of keep) {
    const slug = `nyc-${k.agency.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28)}-${k.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 46)}`.replace(/-+/g, '-');
    const file = path.join(JDS, `${slug}.md`);
    const pay = k.salaryFrom && k.salaryTo
      ? `\n**Salary:** $${Number(k.salaryFrom).toLocaleString()} - $${Number(k.salaryTo).toLocaleString()} ${k.salaryFreq || ''}`.trimEnd()
      : '';
    const md = [
      `# ${k.title}`,
      `**URL:** ${k.url}`,
      `**Company:** ${k.agency}`,
      `**Location:** ${k.location}`,
      // ⚠ MUST include the "(N days ago)" parenthetical. lib/jd-parse.mjs reads
      // posted_days from it, not from the date, and a null posted_days makes
      // enqueue-review count the role STALE - which silently binned all 31 of
      // these on the first run despite every one being 7-18 days old.
      `**Posted:** ${k.posted} (${Math.max(0, Math.round((Date.now() - Date.parse(k.posted)) / 86400000))} days ago)`,
      `**Source:** nyc-open-data`,
      k.street ? `**Work location:** ${k.street}` : '',
      k.civilServiceTitle ? `**Civil Service Title:** ${k.civilServiceTitle}` : '',
      k.careerLevel ? `**Career Level:** ${k.careerLevel}` : '',
      pay,
      '---',
      k.body,
    ].filter(Boolean).join('\n');
    try { await readFile(file, 'utf8'); } catch { await writeFile(file, md); wrote++; }
    k.slug = slug;
  }
  console.log(`JDs: ${wrote} written`);

  let existing = '';
  try { existing = await readFile(PIPELINE, 'utf8'); } catch {}
  const fresh = keep.filter((k) => !existing.includes(k.url));
  if (!fresh.length) { console.log('all already known in pipeline.md'); return; }
  const today = new Date().toISOString().slice(0, 10);
  await appendFile(PIPELINE, '\n' + fresh.map((f) =>
    `- [ ] ${f.url} | ${f.agency} | ${f.title} | source: nyc-open-data | ${today}`).join('\n') + '\n');
  await appendFile(HISTORY, fresh.map((f) =>
    `${f.url}\t${today}\tnyc-open-data\t${f.title}\t${f.agency}\tadded\t${today}\n`).join(''));
  console.log(`appended ${fresh.length} to pipeline.md`);
};

main().catch((e) => { console.error(e); process.exit(1); });
