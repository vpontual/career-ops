#!/usr/bin/env node
/**
 * fetch-jds.mjs — pull full JD text for every URL in data/pipeline.md
 *
 * Detects ATS from URL and uses the right API:
 *   Greenhouse: boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}
 *   Ashby:      api.ashbyhq.com/posting-api/job-board/{slug} (returns whole board; we filter by id)
 *   Lever:      api.lever.co/v0/postings/{slug}/{id}
 *
 * Writes one file per URL to jds/{company-slug}-{job-id}.md
 * Skips URLs whose JD already exists (rerun-friendly).
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';

const PIPELINE_PATH = 'data/pipeline.md';
const JDS_DIR = 'jds';
const CONCURRENCY = 6;

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'career-ops/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function detectAts(url) {
  if (/job-boards\.greenhouse\.io|boards\.greenhouse\.io/.test(url)) {
    const m = url.match(/greenhouse\.io\/([a-z0-9-]+)\/jobs\/(\d+)/i);
    if (!m) return null;
    return { type: 'greenhouse', slug: m[1], id: m[2] };
  }
  if (/jobs\.ashbyhq\.com/.test(url)) {
    const m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([a-f0-9-]+)/);
    if (!m) return null;
    return { type: 'ashby', slug: m[1], id: m[2] };
  }
  if (/jobs\.lever\.co/.test(url)) {
    const m = url.match(/jobs\.lever\.co\/([^/]+)\/([a-f0-9-]+)/);
    if (!m) return null;
    return { type: 'lever', slug: m[1], id: m[2] };
  }
  return null;
}

async function fetchJd(url) {
  const ats = detectAts(url);
  if (!ats) return null;

  if (ats.type === 'greenhouse') {
    const data = await fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${ats.slug}/jobs/${ats.id}?questions=false`
    );
    return {
      title: data.title,
      location: data.location?.name || '',
      department: data.departments?.[0]?.name || '',
      pay: data.pay_input_ranges?.[0] || data.metadata?.find(m => /salary|comp|pay/i.test(m.name))?.value || '',
      content: stripHtml(data.content || ''),
      posted_at: data.first_published || data.updated_at || null,
      updated_at: data.updated_at || null,
      ats_url: data.absolute_url || url
    };
  }

  if (ats.type === 'ashby') {
    // Ashby exposes the whole board; find by id
    const data = await fetchJson(
      `https://api.ashbyhq.com/posting-api/job-board/${ats.slug}?includeCompensation=true`
    );
    const job = data.jobs?.find(j => j.id === ats.id);
    if (!job) return null;
    return {
      title: job.title,
      location: job.locationName || job.location || '',
      department: job.departmentName || job.team || '',
      pay: job.compensation?.compensationTierSummary || '',
      content: stripHtml(job.descriptionHtml || job.descriptionPlain || ''),
      posted_at: job.publishedAt || job.updatedAt || null,
      updated_at: job.updatedAt || null,
      ats_url: job.jobUrl || url
    };
  }

  if (ats.type === 'lever') {
    const data = await fetchJson(`https://api.lever.co/v0/postings/${ats.slug}/${ats.id}`);
    return {
      title: data.text,
      location: data.categories?.location || '',
      department: data.categories?.team || '',
      pay: data.salaryDescription || '',
      content: stripHtml(
        (data.descriptionPlain || '') +
          '\n\n' +
          (data.lists || []).map(l => `## ${l.text}\n${stripHtml(l.content)}`).join('\n\n')
      ),
      posted_at: data.createdAt ? new Date(data.createdAt).toISOString() : null,
      updated_at: null,
      ats_url: data.applyUrl || data.hostedUrl || url
    };
  }
  return null;
}

function daysSince(isoOrEpoch) {
  if (!isoOrEpoch) return null;
  const d = new Date(isoOrEpoch);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function parsePipelineLine(line) {
  const m = line.match(/^-\s*\[(x|\s)\]\s*(\S+)\s*\|\s*(.+)$/);
  if (!m) return null;
  const url = m[2];
  const parts = m[3].split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { url, company: parts[0], role: parts[1] };
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
        }
      }
    })
  );
  return results;
}

async function main() {
  await mkdir(JDS_DIR, { recursive: true });
  const raw = await readFile(PIPELINE_PATH, 'utf-8');
  const rows = raw.split('\n').map(parsePipelineLine).filter(Boolean);
  console.log(`pipeline.md: ${rows.length} URLs`);

  const existing = new Set(await readdir(JDS_DIR).catch(() => []));

  let fetched = 0, skipped = 0, failed = 0;

  await pLimit(rows, CONCURRENCY, async (row, idx) => {
    const ats = detectAts(row.url);
    if (!ats) {
      console.log(`[${idx}] SKIP no-ATS: ${row.url}`);
      skipped++;
      return;
    }
    const filename = `${slugify(row.company)}-${ats.id.slice(0, 16)}.md`;
    if (existing.has(filename)) {
      skipped++;
      return;
    }
    try {
      const jd = await fetchJd(row.url);
      if (!jd) {
        console.log(`[${idx}] FAIL parse: ${row.url}`);
        failed++;
        return;
      }
      const postedDays = daysSince(jd.posted_at);
      const updatedDays = daysSince(jd.updated_at);
      const md = [
        `# ${jd.title}`,
        ``,
        `**URL:** ${row.url}`,
        `**Company:** ${row.company}`,
        `**Location:** ${jd.location}`,
        jd.department ? `**Department:** ${jd.department}` : '',
        jd.pay ? `**Compensation:** ${jd.pay}` : '',
        jd.posted_at ? `**Posted:** ${jd.posted_at} (${postedDays} days ago)` : '',
        jd.updated_at && jd.updated_at !== jd.posted_at ? `**Updated:** ${jd.updated_at} (${updatedDays} days ago)` : '',
        ``,
        `---`,
        ``,
        jd.content
      ].filter(Boolean).join('\n');
      await writeFile(path.join(JDS_DIR, filename), md);
      fetched++;
      const ageStr = postedDays !== null ? ` [${postedDays}d old]` : '';
      console.log(`[${idx}] OK ${row.company} | ${jd.title}${ageStr}`);
    } catch (e) {
      console.log(`[${idx}] ERR ${row.url} → ${e.message}`);
      failed++;
    }
  });

  console.log(`\nDone. fetched=${fetched} skipped=${skipped} failed=${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
