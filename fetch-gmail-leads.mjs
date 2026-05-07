#!/usr/bin/env node
// Gmail lead poller — scans [Gmail]/All Mail for messages from curated lead
// sources, extracts URLs, resolves redirects, drops obvious noise, and
// appends survivors to data/pipeline.md as `- [ ] URL | ... | source: gmail`.
//
// fetch-jds.mjs picks them up next: it routes known ATS URLs through their
// API and falls back to JSON-LD JobPosting scraping for everything else.
// rank-leads.mjs filters by title + freshness and scores fit against cv.md.
//
// Configuration:
//   config/gmail-sources.yml — sender allowlist + URL noise patterns
//   portals.yml              — title_filter for cheap subject-level pre-filter
//   .env                     — GMAIL_USER, GMAIL_APP_PASSWORD
//
// State:
//   data/.gmail-cursor       — UNIX ts of latest message processed
//
// Run: node fetch-gmail-leads.mjs [--dry-run]
//
// Required env (set in .env):
//   GMAIL_USER             — Gmail address
//   GMAIL_APP_PASSWORD     — Gmail app password (myaccount.google.com/apppasswords)
//
// rank-leads.mjs (run after fetch-jds.mjs) additionally needs:
//   OLLAMA_URL             — http://host:port for an Ollama-compatible scorer
//   RANK_MODEL             — model name (default: Qwen/Qwen3.6-35B-A3B-FP8)

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { writeFile, appendFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

dotenv.config();

const ROOT = process.env.CAREER_OPS_ROOT ?? process.cwd();
const SOURCES_PATH = path.join(ROOT, 'config', 'gmail-sources.yml');
const PORTALS_PATH = path.join(ROOT, 'portals.yml');
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.tsv');
const APPLICATIONS_PATH = path.join(ROOT, 'data', 'applications.md');
const INBOX_LEADS_PATH = path.join(ROOT, 'data', 'inbox-leads.md');
const CURSOR_PATH = path.join(ROOT, 'data', '.gmail-cursor');
const LOG_PATH = path.join(ROOT, 'logs', 'gmail-fetch.log');

const DRY_RUN = process.argv.includes('--dry-run');

function loadSources() {
  return yaml.load(readFileSync(SOURCES_PATH, 'utf-8'));
}

function loadTitleFilter() {
  const portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const tf = portals.title_filter || {};
  const positive = (tf.positive || []).map(s => s.toLowerCase());
  const negative = (tf.negative || []).map(s => s.toLowerCase());
  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPos = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNeg = negative.some(k => lower.includes(k));
    return hasPos && !hasNeg;
  };
}

function loadSeenUrls() {
  const seen = new Set();
  const harvest = (text) => {
    for (const m of text.matchAll(/https?:\/\/[^\s|)<>"']+/g)) seen.add(m[0]);
  };
  for (const p of [PIPELINE_PATH, APPLICATIONS_PATH, INBOX_LEADS_PATH, SCAN_HISTORY_PATH]) {
    if (existsSync(p)) harvest(readFileSync(p, 'utf-8'));
  }
  return seen;
}

function loadCursor(firstRunLookbackDays) {
  if (existsSync(CURSOR_PATH)) {
    const ts = parseInt(readFileSync(CURSOR_PATH, 'utf-8').trim(), 10);
    if (Number.isFinite(ts)) return new Date(ts);
  }
  const d = new Date();
  d.setDate(d.getDate() - firstRunLookbackDays);
  return d;
}

async function saveCursor(date) {
  if (DRY_RUN) return;
  await writeFile(CURSOR_PATH, String(date.getTime()), 'utf-8');
}

function fromMatchesSources(fromHeader, leadSubstrings) {
  const lower = (fromHeader || '').toLowerCase();
  return leadSubstrings.some(s => lower.includes(s.toLowerCase()));
}

const URL_RX = /https?:\/\/[^\s|)<>"'\]\[]+/g;

function extractUrls(text) {
  if (!text) return [];
  const set = new Set();
  for (const m of text.matchAll(URL_RX)) {
    let u = m[0].replace(/[).,;!?\\>]+$/, '');
    set.add(u);
  }
  return [...set];
}

function isNoiseUrl(url, noisePatterns = []) {
  return noisePatterns.some(p => url.includes(p));
}

// Tracking-only query params that don't change which job a URL points to.
// Strip them before dedup so the same posting in a digest at position=1, 2,
// or 3 collapses to one row in pipeline.md.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'token', 'position', 'count', 'jpsi', 'ccaon', 'jobstop',
  'mc_cid', 'mc_eid', 'fbclid', 'gclid', 'msclkid', '_hsenc', '_hsmi',
  'trk', 'trkInfo', 'refId', 'recommendedFlavor',
  'ref', 'src', 'source',
]);

// Hosts where the entire query string is tracking and the bare path is the
// canonical URL. Listed explicitly because some hosts (Greenhouse via gh_jid)
// rely on a query param that we must KEEP.
const STRIP_ALL_QUERY_HOSTS = new Set([
  'app.welcometothejungle.com',
  'www.welcometothejungle.com',
]);

function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (STRIP_ALL_QUERY_HOSTS.has(host)) {
      u.search = '';
      u.hash = '';
      return u.toString();
    }
    // Per-param strip
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.set(k, v);
    }
    u.search = keep.toString();
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

// Hard rule: a URL has to look like a job posting (path contains job/career
// markers) before we pay to fetch its JD. This is the post-resolution filter
// that replaces the old hardcoded ATS-host allowlist.
const JOB_PATH_HINTS = [
  '/jobs/', '/job/', '/careers/', '/career/', '/postings/',
  '/positions/', '/opening/', '/openings/', '/apply/',
  'gh_jid=', '/cgw/', '/jobs?gh_jid', 'lever.co/', 'ashbyhq.com/',
  'workday', 'icims.com/jobs', 'smartrecruiters.com/', 'jobvite.com/',
  'workable.com/', 'bamboohr.com/jobs', 'recruitee.com/o/',
  'teamtailor.com/jobs', 'personio.de/job', 'pinpointhq.com/jobs',
  'linkedin.com/jobs/view', 'linkedin.com/comm/jobs/view',
  'ziprecruiter.com/jobs', 'ziprecruiter.com/job/', 'indeed.com/viewjob',
  'idealist.org/en/job', 'welcometothejungle.com/companies',
  'remoteok.com/remote-jobs', 'wellfound.com/jobs',
];

function looksLikeJobPosting(url) {
  return JOB_PATH_HINTS.some(h => url.toLowerCase().includes(h));
}

async function resolveRedirect(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    } catch {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    }
    return res.url || url;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAll(urls, concurrency, timeoutMs) {
  const out = new Map();
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const u = urls[idx];
      const final = await resolveRedirect(u, timeoutMs);
      if (final) out.set(u, final);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

function inferCompanyFromUrl(url) {
  let m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9-]+)/i);
  if (m) return prettify(m[1]);
  m = url.match(/job-boards\.greenhouse\.io\/([a-z0-9-]+)/i);
  if (m) return prettify(m[1]);
  m = url.match(/ashbyhq\.com\/([a-z0-9-]+)/i);
  if (m) return prettify(m[1]);
  m = url.match(/lever\.co\/([a-z0-9-]+)/i);
  if (m) return prettify(m[1]);
  m = url.match(/\/\/([a-z0-9-]+)\.[a-z0-9-]*\.?(?:my)?workday/i);
  if (m) return prettify(m[1]);
  // Generic: company.com/careers/role-id → "Company"
  try {
    const host = new URL(url).hostname.replace(/^(www\.|jobs\.|careers\.)/, '');
    const stem = host.split('.')[0];
    if (stem && stem.length >= 3 && !['linkedin','indeed','ziprecruiter','lensa','idealist','glassdoor','welcometothejungle','remoteok','wellfound'].includes(stem)) {
      return prettify(stem);
    }
  } catch {}
  return '';
}

function prettify(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function appendToPipeline(rows) {
  if (DRY_RUN || rows.length === 0) return;
  await mkdir(path.dirname(PIPELINE_PATH), { recursive: true });
  const lines = rows.map(r =>
    `- [ ] ${r.url} | ${r.company || 'Unknown'} | ${r.role || 'Unknown'} | source: gmail-${r.sourceDomain} | ${r.date}\n`
  ).join('');
  await appendFile(PIPELINE_PATH, lines, 'utf-8');
}

async function writeLog(summary) {
  if (DRY_RUN) return;
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  const line = `[${new Date().toISOString()}] ${JSON.stringify(summary)}\n`;
  await appendFile(LOG_PATH, line, 'utf-8');
}

async function main() {
  const sources = loadSources();
  const titleFilter = loadTitleFilter();
  const seenUrls = loadSeenUrls();
  const since = loadCursor(sources.first_run_lookback_days ?? 14);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Gmail lead fetch — ${new Date().toISOString()}`);
  console.log(`Cursor since:    ${since.toISOString()}`);
  console.log(`Lead senders:    ${sources.leads.length} patterns`);
  console.log(`Seen URLs:       ${seenUrls.size}`);
  console.log(`Mode:            ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env');
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('[Gmail]/All Mail');
  let scanned = 0;
  let matchedSenders = 0;
  let extractedUrls = 0;
  let jobLikeUrls = 0;
  let titleDropped = 0;
  let alreadySeen = 0;
  const newRows = [];
  let latestSeenDate = since;

  try {
    const uids = await client.search({ since });
    console.log(`Found ${uids.length} messages since cursor.`);

    for await (const msg of client.fetch(uids, { envelope: true, source: true, internalDate: true })) {
      scanned++;
      const fromHeader = (msg.envelope?.from || []).map(a => `${a.name} <${a.address}>`).join(', ');

      if (!fromMatchesSources(fromHeader, sources.leads)) continue;
      matchedSenders++;

      const parsed = await simpleParser(msg.source);
      const subject = parsed.subject || '';

      // Cheap pre-filter: if the email subject names a clearly off-target role
      // (e.g. "Sales Engineer at X"), skip the whole message. Saves dozens of
      // redirect resolutions per digest. Subject is a noisy proxy, so we only
      // SKIP on negative hits — positive miss is not a drop signal.
      if (!titleFilter(subject) && containsNegativeOnly(subject)) {
        titleDropped++;
        continue;
      }

      const body = (parsed.text || '') + '\n' + (parsed.html ? stripHtml(parsed.html) : '');
      const allUrls = extractUrls(body);
      const filtered = allUrls.filter(u => !isNoiseUrl(u, sources.url_noise_patterns));
      const urls = filtered.slice(0, 25);
      extractedUrls += urls.length;
      if (urls.length === 0) continue;

      const fromAddr = msg.envelope?.from?.[0]?.address || 'unknown';
      console.log(`  [${matchedSenders}] ${fromAddr} — ${urls.length} URLs (${subject.slice(0, 70)})`);

      const resolved = await resolveAll(urls, sources.redirect_concurrency ?? 5, sources.redirect_timeout_ms ?? 8000);

      const sourceDomain = (msg.envelope?.from?.[0]?.address || '').split('@')[1] || 'unknown';
      const msgDate = (msg.internalDate || parsed.date || new Date()).toISOString().slice(0, 10);

      for (const [origUrl, finalUrl] of resolved) {
        if (process.env.DEBUG_URLS) console.log(`     → ${origUrl.slice(0, 60)} → ${finalUrl.slice(0, 100)}`);
        if (isNoiseUrl(finalUrl, sources.url_noise_patterns)) continue;
        if (!looksLikeJobPosting(finalUrl)) continue;
        jobLikeUrls++;
        const canonical = canonicalizeUrl(finalUrl);
        if (seenUrls.has(canonical)) { alreadySeen++; continue; }

        seenUrls.add(canonical);
        newRows.push({
          url: canonical,
          company: inferCompanyFromUrl(canonical),
          role: subject.slice(0, 120),
          sourceDomain,
          date: msgDate
        });
      }

      const d = msg.internalDate || parsed.date;
      if (d && d > latestSeenDate) latestSeenDate = d;
    }
  } finally {
    lock.release();
    await client.logout();
  }

  await appendToPipeline(newRows);
  await saveCursor(latestSeenDate);

  const summary = {
    scanned,
    matchedSenders,
    extractedUrls,
    jobLikeUrls,
    titleDropped,
    alreadySeen,
    newLeads: newRows.length,
    cursorAdvancedTo: latestSeenDate.toISOString()
  };
  await writeLog(summary);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Scanned:         ${scanned}`);
  console.log(`Lead-source:     ${matchedSenders}`);
  console.log(`URLs found:      ${extractedUrls}`);
  console.log(`Job-like URLs:   ${jobLikeUrls}`);
  console.log(`Subject-dropped: ${titleDropped}`);
  console.log(`Already seen:    ${alreadySeen}`);
  console.log(`New leads:       ${newRows.length} → pipeline.md`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

// Subject pre-filter is conservative: a positive miss (e.g. unspecific
// "5 new opportunities") doesn't drop, but a negative hit ("Engineering
// Director at X") with no positive match does.
function containsNegativeOnly(subject) {
  try {
    const portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
    const neg = (portals.title_filter?.negative || []).map(s => s.toLowerCase());
    const pos = (portals.title_filter?.positive || []).map(s => s.toLowerCase());
    const lower = (subject || '').toLowerCase();
    const hitsNeg = neg.some(k => lower.includes(k));
    const hitsPos = pos.some(k => lower.includes(k));
    return hitsNeg && !hitsPos;
  } catch {
    return false;
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
