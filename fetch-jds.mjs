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
import crypto from 'crypto';

const PIPELINE_PATH = 'data/pipeline.md';
const JDS_DIR = 'jds';
const CONCURRENCY = 6;

// Hosts that block HTTP-only scraping (Cloudflare JS challenge, login-gated,
// dead URLs). The JSON-LD path can't extract from these without a real
// browser; skip silently so we don't waste 8s per URL on guaranteed failures.
const UNSCRAPEABLE_HOSTS = [
  'lensa.com',           // Cloudflare "Just a moment" challenge
  'www.linkedin.com',    // /jobs/view bounces to login
  'linkedin.com',
  'jobot.com',           // 404s to search page
  'indeed.com',          // bot detection
  'www.indeed.com',
  'glassdoor.com',
  'www.glassdoor.com',
];

function isUnscrapeable(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return UNSCRAPEABLE_HOSTS.includes(host);
  } catch {
    return false;
  }
}

// Hosts whose URLs ship with email-tracking JWT/UTM tokens that the scraping
// path can't follow (the SPA reads ?token to render auth-gated content).
// Strip the query string before fetching — the bare path serves SEO HTML
// with embedded JSON-LD JobPosting.
const QUERY_STRIP_HOSTS = new Set([
  'app.welcometothejungle.com',
]);

function canonicalizeForFetch(url) {
  try {
    const u = new URL(url);
    if (QUERY_STRIP_HOSTS.has(u.hostname.toLowerCase())) {
      u.search = '';
    }
    return u.toString();
  } catch {
    return url;
  }
}

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

// Companies that wrap their Greenhouse postings behind a branded careers
// URL but expose the canonical job ID as gh_jid in the query string.
const BRANDED_GREENHOUSE = {
  'stripe.com': 'stripe',
  'databricks.com': 'databricks',
  'careers.datadoghq.com': 'datadog',
  'www.brex.com': 'brex',
  'brex.com': 'brex',
  'jobs.elastic.co': 'elastic'
};

function detectAts(url) {
  if (/job-boards\.greenhouse\.io|boards\.greenhouse\.io/.test(url)) {
    const m = url.match(/greenhouse\.io\/([a-z0-9-]+)\/jobs\/(\d+)/i);
    if (!m) return null;
    return { type: 'greenhouse', slug: m[1], id: m[2] };
  }
  // Branded careers URL with gh_jid query param
  try {
    const u = new URL(url);
    const slug = BRANDED_GREENHOUSE[u.host];
    const id = u.searchParams.get('gh_jid');
    if (slug && id) return { type: 'greenhouse', slug, id };
  } catch {}
  if (/jobs\.ashbyhq\.com/.test(url)) {
    const m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([a-f0-9-]+)/);
    if (!m) return null;
    return { type: 'ashby', slug: m[1], id: m[2] };
  }
  if (/jobs\.smartrecruiters\.com/.test(url)) {
    const m = url.match(/jobs\.smartrecruiters\.com\/([^/]+)\/(\d+)/);
    if (!m) return null;
    return { type: 'smartrecruiters', slug: m[1], id: m[2] };
  }
  if (/jobs\.lever\.co/.test(url)) {
    const m = url.match(/jobs\.lever\.co\/([^/]+)\/([a-f0-9-]+)/);
    if (!m) return null;
    return { type: 'lever', slug: m[1], id: m[2] };
  }
  return null;
}

async function fetchHtml(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0; +https://github.com/vpontual/career-ops)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Extract schema.org JobPosting from a page's JSON-LD blocks. Google for
// Jobs requires this on any indexed listing, so coverage is high across
// unknown ATSs, branded company career pages, and aggregator landing pages.
function extractJsonLdJobPosting(html) {
  const blocks = [];
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) blocks.push(m[1].trim());

  for (const block of blocks) {
    let parsed;
    try {
      // Collapse runs of raw control chars (unescaped newlines/tabs some sites emit
      // *inside* JSON string values -- invalid JSON that would make JSON.parse
      // throw) to a single space. Printable chars ($ , & - . etc.) are preserved.
      // Written with explicit \u escapes; the range was previously embedded as
      // literal control BYTES, which editors/git/review tools silently mangle.
      parsed = JSON.parse(block.replace(/[\u0000-\u001F]+/g, ' '));
    } catch { continue; }
    const candidates = Array.isArray(parsed) ? parsed
      : parsed['@graph'] ? parsed['@graph']
      : [parsed];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const type = c['@type'];
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (isJob) return c;
    }
  }
  return null;
}

function jobPostingToJd(jp, fallbackUrl) {
  const title = jp.title || '';
  const company = jp.hiringOrganization?.name || jp.hiringOrganization || '';
  const locParts = [];
  const loc = jp.jobLocation;
  const locs = Array.isArray(loc) ? loc : (loc ? [loc] : []);
  for (const l of locs) {
    const a = l?.address || l;
    const parts = [a?.addressLocality, a?.addressRegion, a?.addressCountry].filter(Boolean);
    if (parts.length) locParts.push(parts.join(', '));
  }
  if (jp.jobLocationType) locParts.push(`(${jp.jobLocationType})`);
  if (jp.applicantLocationRequirements) {
    const r = jp.applicantLocationRequirements;
    const arr = Array.isArray(r) ? r : [r];
    for (const x of arr) if (x?.name) locParts.push(`remote: ${x.name}`);
  }
  let pay = '';
  const sal = jp.baseSalary;
  if (sal?.value) {
    const v = sal.value;
    const min = v.minValue ?? v.value ?? '';
    const max = v.maxValue ?? '';
    const cur = sal.currency || v.currency || '';
    const unit = v.unitText || '';
    pay = [min, max && `–${max}`, cur, unit].filter(Boolean).join(' ').trim();
  }
  const description = stripHtml(jp.description || '');
  return {
    title,
    company,
    location: locParts.join(' / '),
    department: jp.industry || '',
    pay,
    content: description,
    posted_at: jp.datePosted || null,
    updated_at: jp.dateModified || null,
    ats_url: jp.url || fallbackUrl,
  };
}

async function fetchJdViaJsonLd(url) {
  const fetchUrl = canonicalizeForFetch(url);
  let html;
  try { html = await fetchHtml(fetchUrl); } catch { return null; }
  const jp = extractJsonLdJobPosting(html);
  if (!jp) return null;
  return jobPostingToJd(jp, url);
}

async function fetchJd(url) {
  const ats = detectAts(url);
  if (!ats) {
    // Fallback path: scrape JSON-LD JobPosting from the rendered page.
    return await fetchJdViaJsonLd(url);
  }

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

  if (ats.type === 'smartrecruiters') {
    // The single-posting endpoint carries the full ad; the list endpoint does
    // not. jobAd.sections holds the prose in named blocks.
    const data = await fetchJson(
      `https://api.smartrecruiters.com/v1/companies/${ats.slug}/postings/${ats.id}`
    );
    const sec = data.jobAd?.sections || {};
    const body = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
      .map((k) => (sec[k]?.title ? `## ${sec[k].title}\n${stripHtml(sec[k].text || '')}` : ''))
      .filter(Boolean)
      .join('\n\n');
    const comp = data.compensation;
    return {
      title: data.name || '',
      company: data.company?.name || '',
      location: [data.location?.city, data.location?.region].filter(Boolean).join(', '),
      department: data.department?.label || '',
      pay: comp?.min && comp?.max ? `${comp.min}–${comp.max} ${comp.currency || ''}`.trim() : '',
      content: body,
      posted_at: data.releasedDate || null,
      updated_at: null,
      ats_url: `https://jobs.smartrecruiters.com/${ats.slug}/${ats.id}`,
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

// Rewrite the `(N days ago)` parenthetical on every existing JD file using a
// fresh computation from its ISO timestamp. fetch-jds.mjs writes the
// parenthetical once when it first creates a file and skips it on subsequent
// runs, so without this pass the human-readable hint drifts further from
// reality every day. The ISO itself is canonical and never changes.
async function refreshExistingDates() {
  const files = await readdir(JDS_DIR).catch(() => []);
  let touched = 0;

  const rewriteOne = (text, label) => {
    const re = new RegExp(`(\\*\\*${label}:\\*\\*\\s+)(\\S+)(\\s*\\()(\\d+)(\\s+days?\\s+ago\\))`);
    const m = text.match(re);
    if (!m) return { text, changed: false };
    const fresh = daysSince(m[2]);
    if (fresh == null || String(fresh) === m[4]) return { text, changed: false };
    return {
      text: text.replace(re, `$1$2$3${fresh}$5`),
      changed: true
    };
  };

  await Promise.all(files.map(async f => {
    if (!f.endsWith('.md')) return;
    const fp = path.join(JDS_DIR, f);
    let text;
    try { text = await readFile(fp, 'utf-8'); } catch { return; }
    let changed = false;
    for (const label of ['Posted', 'Updated']) {
      const r = rewriteOne(text, label);
      if (r.changed) { text = r.text; changed = true; }
    }
    if (changed) {
      await writeFile(fp, text);
      touched++;
    }
  }));

  console.log(`refreshed dates: ${touched}/${files.filter(f => f.endsWith('.md')).length} JD files`);
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
  await refreshExistingDates();
  const raw = await readFile(PIPELINE_PATH, 'utf-8');
  const rows = raw.split('\n').map(parsePipelineLine).filter(Boolean);
  console.log(`pipeline.md: ${rows.length} URLs`);

  const existing = new Set(await readdir(JDS_DIR).catch(() => []));

  let fetched = 0, skipped = 0, failed = 0;

  let unscrapeable = 0;
  await pLimit(rows, CONCURRENCY, async (row, idx) => {
    if (isUnscrapeable(row.url)) {
      unscrapeable++;
      return;
    }
    const ats = detectAts(row.url);
    const company = row.company || 'unknown';
    const idSuffix = ats?.id
      ? ats.id.slice(0, 16)
      : crypto.createHash('sha1').update(row.url).digest('hex').slice(0, 12);
    const filename = `${slugify(company)}-${idSuffix}.md`;
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
      const resolvedCompany = jd.company || row.company || 'Unknown';
      const md = [
        `# ${jd.title}`,
        ``,
        `**URL:** ${row.url}`,
        `**Company:** ${resolvedCompany}`,
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
      const via = ats ? ats.type : 'json-ld';
      console.log(`[${idx}] OK[${via}] ${resolvedCompany} | ${jd.title}${ageStr}`);
    } catch (e) {
      console.log(`[${idx}] ERR ${row.url} → ${e.message}`);
      failed++;
    }
  });

  console.log(`\nDone. fetched=${fetched} skipped=${skipped} unscrapeable=${unscrapeable} failed=${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
