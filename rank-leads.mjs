#!/usr/bin/env node
// rank-leads.mjs — produce data/inbox-leads.md as a single ranked list of
// fresh, on-target job leads.
//
// Pipeline:
//   1. Read every JD in jds/
//   2. Filter by title (positive/negative substrings from portals.yml)
//   3. Filter by freshness (drop posted_at > MAX_AGE_DAYS)
//   4. Score remaining JDs against cv.md via local Ollama proxy
//      (cached in data/lead-scores.json — only new JDs hit the LLM)
//   5. Write data/inbox-leads.md sorted by score desc
//
// Usage:
//   node rank-leads.mjs               # full run
//   node rank-leads.mjs --dry-run     # don't write, print summary
//   node rank-leads.mjs --rescore     # ignore cache, re-score everything
//   node rank-leads.mjs --limit 25    # only score top N (by recency)

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

dotenv.config();

const ROOT = process.env.CAREER_OPS_ROOT ?? process.cwd();
const JDS_DIR = path.join(ROOT, 'jds');
const PORTALS_PATH = path.join(ROOT, 'portals.yml');
const CV_PATH = path.join(ROOT, 'cv.md');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
const SCORES_PATH = path.join(ROOT, 'data', 'lead-scores.json');
const INBOX_LEADS_PATH = path.join(ROOT, 'data', 'inbox-leads.md');
const LOG_PATH = path.join(ROOT, 'logs', 'rank-leads.log');

const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS ?? '30', 10);
const STALE_AGE_DAYS = parseInt(process.env.STALE_AGE_DAYS ?? '5', 10);
const OLLAMA_URL = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.RANK_MODEL ?? 'Qwen/Qwen3.6-35B-A3B-FP8';

if (!OLLAMA_URL) {
  console.error('ERROR: OLLAMA_URL not set. Add to .env, e.g. OLLAMA_URL=http://localhost:11434');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESCORE = args.includes('--rescore');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();

// ── Load filters and resume ───────────────────────────────────────────────

function loadTitleFilter() {
  const portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const tf = portals.title_filter || {};
  const positive = (tf.positive || []).map(s => s.toLowerCase());
  const negative = (tf.negative || []).map(s => s.toLowerCase());
  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPos = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNeg = negative.some(k => lower.includes(k));
    return { passes: hasPos && !hasNeg, hasPos, hasNeg };
  };
}

async function loadResume() {
  if (!existsSync(CV_PATH)) throw new Error(`cv.md not found at ${CV_PATH}`);
  return await readFile(CV_PATH, 'utf-8');
}

async function loadProfileTargets() {
  if (!existsSync(PROFILE_PATH)) return '';
  const profile = yaml.load(await readFile(PROFILE_PATH, 'utf-8'));
  const lines = [];
  if (profile?.target_roles?.primary) {
    lines.push('Primary target roles:');
    for (const r of profile.target_roles.primary) lines.push(`  - ${r}`);
  }
  if (profile?.target_roles?.archetypes) {
    lines.push('\nArchetypes:');
    for (const a of profile.target_roles.archetypes) {
      lines.push(`  - ${a.name} (${a.fit}): ${a.level}`);
    }
  }
  // Override the raw "Los Angeles (relocating to NYC by July 2026)" string
  // with a clean geo policy. The relocation hedge confuses the LLM into
  // flagging every NYC-friendly role as a "geo mismatch".
  lines.push(`\nGeo policy: open to LA, NYC, or remote-US. Treat any of those (or hybrid in those metros) as full match. Penalize only SF-only / Seattle-only / international.`);
  return lines.join('\n');
}

// ── JD parsing ────────────────────────────────────────────────────────────

function parseJdFile(content, filename) {
  const lines = content.split('\n');
  const jd = { filename, title: '', company: '', location: '', pay: '', posted_at: null, posted_days: null, body: '', url: '' };

  jd.title = (lines[0] || '').replace(/^#\s*/, '').trim();

  for (const line of lines.slice(0, 20)) {
    let m;
    if ((m = line.match(/^\*\*URL:\*\*\s*(.+)/i))) jd.url = m[1].trim();
    else if ((m = line.match(/^\*\*Company:\*\*\s*(.+)/i))) jd.company = m[1].trim();
    else if ((m = line.match(/^\*\*Location:\*\*\s*(.+)/i))) jd.location = m[1].trim();
    else if ((m = line.match(/^\*\*Compensation:\*\*\s*(.+)/i))) jd.pay = m[1].trim();
    else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)\s*\((\d+)\s*days/i))) {
      jd.posted_at = m[1];
      jd.posted_days = parseInt(m[2], 10);
    } else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)/i))) {
      jd.posted_at = m[1];
    }
  }

  const sepIdx = lines.findIndex(l => l.trim() === '---');
  jd.body = sepIdx >= 0 ? lines.slice(sepIdx + 1).join('\n').trim() : content;
  return jd;
}

function freshnessOf(jd) {
  // Prefer recomputing from the ISO timestamp so day counts advance as the
  // calendar moves. `posted_days` is parsed from a frozen `(N days ago)`
  // parenthetical written when fetch-jds.mjs first wrote the file and would
  // otherwise be wrong by one day for every day since.
  if (jd.posted_at) {
    const d = new Date(jd.posted_at);
    if (!isNaN(d.getTime())) {
      return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  return jd.posted_days; // fallback when ISO is missing or unparsable
}

// ── Score cache ───────────────────────────────────────────────────────────

async function loadScores() {
  if (!existsSync(SCORES_PATH)) return {};
  try {
    return JSON.parse(await readFile(SCORES_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveScores(scores) {
  if (DRY_RUN) return;
  await mkdir(path.dirname(SCORES_PATH), { recursive: true });
  await writeFile(SCORES_PATH, JSON.stringify(scores, null, 2), 'utf-8');
}

// ── LLM scoring ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a job-fit scorer. Given a candidate's resume and a job description, return ONLY a JSON object with this exact shape — no prose, no markdown fences:

{
  "score": <number 1-5, where 5 = exceptional fit, 1 = wrong role>,
  "archetype": "<one of: AI Product PM | Founding/Early PM | Senior PM | Director/Head of Product | Other>",
  "verdict": "<one short sentence: why this fit score>",
  "redFlags": "<empty string or 1-2 concerns: geo mismatch, junior level, narrow domain, etc>"
}

Scoring scale:
  5 = perfect match: AI/product PM role, senior IC level, NYC/LA/remote-US, comp likely ≥$150K
  4 = strong match: PM role in target archetype with one secondary concern (geo, comp, niche)
  3 = workable: senior PM but adjacent domain or unclear fit
  2 = weak: title matches but role/level/geo wrong
  1 = drop: misclassified or off-target

Be honest. Most jobs are 2-3. Reserve 4-5 for genuinely strong matches. JSON only.`;

function buildUserPrompt(jd, resume, targets) {
  const body = jd.body.slice(0, 6000);
  return [
    `=== CANDIDATE RESUME ===`,
    resume.slice(0, 8000),
    ``,
    `=== TARGET PROFILE ===`,
    targets,
    ``,
    `=== JOB DESCRIPTION ===`,
    `Title: ${jd.title}`,
    `Company: ${jd.company}`,
    `Location: ${jd.location || '(not stated)'}`,
    `Compensation: ${jd.pay || '(not stated)'}`,
    `Posted: ${jd.posted_at || '(not stated)'} (${jd.posted_days != null ? `${jd.posted_days}d ago` : 'unknown age'})`,
    ``,
    body,
    ``,
    `=== TASK ===`,
    `Return JSON. Score this job for the candidate. /no_think`,
  ].join('\n');
}

function parseLLMJson(text) {
  // Strip <think> blocks and code fences before parsing.
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // Find the outermost {...}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON object in response: ${cleaned.slice(0, 200)}`);
  const slice = cleaned.slice(start, end + 1);
  return JSON.parse(slice);
}

async function scoreOne(jd, resume, targets) {
  const userPrompt = buildUserPrompt(jd, resume, targets);
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      options: { temperature: 0.1, num_predict: 400 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.message?.content ?? '';
  const parsed = parseLLMJson(content);
  return {
    score: Number(parsed.score) || 0,
    archetype: String(parsed.archetype || '').slice(0, 60),
    verdict: String(parsed.verdict || '').slice(0, 240),
    redFlags: String(parsed.redFlags || '').slice(0, 200),
  };
}

// ── Output ────────────────────────────────────────────────────────────────

function buildInboxLeadsMd(scored) {
  const now = new Date().toISOString();
  // Dedup by title+company — same posting can land in pipeline.md under
  // multiple URL variants (digest with ?position=1/2/3, tracking tokens, etc).
  // Keep the freshest, prefer non-tracking-laden URLs as a tiebreaker.
  const seen = new Map();
  for (const s of scored) {
    const key = `${(s.title || '').toLowerCase().trim()} @ ${(s.company || '').toLowerCase().trim()}`;
    const existing = seen.get(key);
    if (!existing) { seen.set(key, s); continue; }
    const newer = (s.posted_days ?? 999) < (existing.posted_days ?? 999);
    const cleaner = (s.url || '').length < (existing.url || '').length;
    if (newer || (s.posted_days === existing.posted_days && cleaner)) {
      seen.set(key, s);
    }
  }
  const deduped = [...seen.values()];

  const sorted = deduped.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.posted_days ?? 999) - (b.posted_days ?? 999);
  });
  const lines = [
    `# Inbox-staged leads — ranked`,
    ``,
    `> Generated: ${now}`,
    `> Filters: title (portals.yml) + freshness (≤${MAX_AGE_DAYS}d) + LLM fit-score`,
    `> Sorted by score desc, then by recency`,
    ``,
  ];
  const grouped = { 5: [], 4: [], 3: [], 2: [], 1: [], 0: [] };
  for (const s of sorted) {
    const tier = Math.max(0, Math.min(5, Math.round(s.score)));
    grouped[tier].push(s);
  }
  for (const tier of [5, 4, 3, 2, 1]) {
    if (grouped[tier].length === 0) continue;
    const labels = { 5: 'Excellent fit (apply now)', 4: 'Strong fit', 3: 'Worth a look', 2: 'Weak fit', 1: 'Probably skip' };
    lines.push(`## Score ${tier} — ${labels[tier]} (${grouped[tier].length})`);
    lines.push('');
    for (const s of grouped[tier]) {
      const ageStr = s.posted_days != null
        ? (s.posted_days <= STALE_AGE_DAYS ? `${s.posted_days}d` : `${s.posted_days}d ⚠`)
        : '?';
      const flags = s.redFlags ? ` — ⚠ ${s.redFlags}` : '';
      const archetype = s.archetype ? ` · ${s.archetype}` : '';
      lines.push(`- [ ] **${s.title}** @ ${s.company} · ${ageStr}${archetype}`);
      lines.push(`      ${s.verdict}${flags}`);
      lines.push(`      ${s.url}`);
      lines.push('');
    }
  }
  if (grouped[0].length > 0) {
    lines.push(`## Unscored (${grouped[0].length})`);
    lines.push('');
    for (const s of grouped[0]) {
      lines.push(`- [ ] ${s.title} @ ${s.company}`);
      lines.push(`      ${s.url}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function writeLog(summary) {
  if (DRY_RUN) return;
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  const line = `[${new Date().toISOString()}] ${JSON.stringify(summary)}\n`;
  const { appendFile } = await import('fs/promises');
  await appendFile(LOG_PATH, line, 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`rank-leads — ${new Date().toISOString()}`);
  console.log(`Model:        ${OLLAMA_MODEL} via ${OLLAMA_URL}`);
  console.log(`Max age:      ${MAX_AGE_DAYS} days`);
  console.log(`Mode:         ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${RESCORE ? ' RESCORE' : ''}${LIMIT ? ` LIMIT=${LIMIT}` : ''}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const titleFilter = loadTitleFilter();
  const resume = await loadResume();
  const targets = await loadProfileTargets();
  const cache = RESCORE ? {} : await loadScores();

  const files = (await readdir(JDS_DIR).catch(() => [])).filter(f => f.endsWith('.md'));
  console.log(`JDs found:    ${files.length}`);

  let titleDropped = 0;
  let staleDropped = 0;
  let unparsedDate = 0;

  const candidates = [];
  for (const f of files) {
    const p = path.join(JDS_DIR, f);
    const raw = await readFile(p, 'utf-8');
    const jd = parseJdFile(raw, f);
    const tf = titleFilter(jd.title);
    if (!tf.passes) { titleDropped++; continue; }
    const days = freshnessOf(jd);
    if (days != null && days > MAX_AGE_DAYS) { staleDropped++; continue; }
    if (days == null) unparsedDate++;
    candidates.push({ ...jd, posted_days: days });
  }

  console.log(`After title:  ${candidates.length + titleDropped} → ${candidates.length} (-${titleDropped})`);
  console.log(`After stale:  ${candidates.length + staleDropped} → ${candidates.length} (-${staleDropped} >${MAX_AGE_DAYS}d)`);
  console.log(`No date:      ${unparsedDate} (kept, ranked at bottom)`);

  // Sort by recency for limit
  candidates.sort((a, b) => (a.posted_days ?? 999) - (b.posted_days ?? 999));
  const toScore = LIMIT ? candidates.slice(0, LIMIT) : candidates;

  let cacheHits = 0;
  let llmCalls = 0;
  let llmErrors = 0;
  const scored = [];

  for (let i = 0; i < toScore.length; i++) {
    const jd = toScore[i];
    if (!RESCORE && cache[jd.filename]) {
      scored.push({ ...jd, ...cache[jd.filename] });
      cacheHits++;
      continue;
    }
    try {
      const result = await scoreOne(jd, resume, targets);
      cache[jd.filename] = { ...result, scored_at: new Date().toISOString() };
      scored.push({ ...jd, ...result });
      llmCalls++;
      if ((llmCalls % 5) === 0) console.log(`  scored ${llmCalls}/${toScore.length - cacheHits}...`);
    } catch (e) {
      console.log(`  ERR ${jd.filename}: ${e.message}`);
      llmErrors++;
      scored.push({ ...jd, score: 0, archetype: '', verdict: `[scorer error: ${e.message.slice(0, 80)}]`, redFlags: '' });
    }
  }

  await saveScores(cache);

  const md = buildInboxLeadsMd(scored);
  if (!DRY_RUN) {
    await mkdir(path.dirname(INBOX_LEADS_PATH), { recursive: true });
    await writeFile(INBOX_LEADS_PATH, md, 'utf-8');
  }

  const tierCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
  for (const s of scored) {
    const t = Math.max(0, Math.min(5, Math.round(s.score)));
    tierCounts[t]++;
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Cache hits:   ${cacheHits}`);
  console.log(`LLM calls:    ${llmCalls} (errors: ${llmErrors})`);
  console.log(`Tier 5/4/3/2/1: ${tierCounts[5]}/${tierCounts[4]}/${tierCounts[3]}/${tierCounts[2]}/${tierCounts[1]}`);
  console.log(`Output:       ${DRY_RUN ? '(dry run)' : INBOX_LEADS_PATH}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  await writeLog({
    jds_total: files.length,
    title_dropped: titleDropped,
    stale_dropped: staleDropped,
    unparsed_date: unparsedDate,
    scored: scored.length,
    cache_hits: cacheHits,
    llm_calls: llmCalls,
    llm_errors: llmErrors,
    tier_counts: tierCounts,
  });
}

main().catch(err => { console.error(err); process.exit(1); });
