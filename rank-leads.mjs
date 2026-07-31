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
import { loadBlacklist, blacklistEntry } from './blacklist.mjs';
import { canonKey } from './lib/canonical.mjs';
import { parseJd } from './lib/jd-parse.mjs';

dotenv.config();

const ROOT = process.env.CAREER_OPS_ROOT ?? process.cwd();
const JDS_DIR = path.join(ROOT, 'jds');
const PORTALS_PATH = path.join(ROOT, 'portals.yml');
const CV_PATH = path.join(ROOT, 'cv.md');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
const SCORES_PATH = path.join(ROOT, 'data', 'lead-scores.json');
const INBOX_LEADS_PATH = path.join(ROOT, 'data', 'inbox-leads.md');
const LOG_PATH = path.join(ROOT, 'logs', 'rank-leads.log');

const SCORING_RULES_LIMIT = parseInt(process.env.SCORING_RULES_LIMIT ?? '12000', 10);
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS ?? '30', 10);
const STALE_AGE_DAYS = parseInt(process.env.STALE_AGE_DAYS ?? '5', 10);
const OLLAMA_URL = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.RANK_MODEL ?? 'Qwen/Qwen3.6-35B-A3B-FP8';
// Bound every scorer call: a wedged gateway (green /health, 504s or a silent
// hang — see the DGX-wedge history) must not hang the whole nightly run. On
// timeout/error we retry a few times in-run, then throw so the caller skips
// that JD (uncached → retried next run).
// 90s was calibrated when the scoring rules were being silently truncated to
// 750 chars. With the full rules restored the prompt is ~17k characters and
// the slowest JDs exceed 90s, so each one burned 4.5 minutes across retries
// and still failed. 240s costs nothing on the common path.
const SCORE_TIMEOUT_MS = parseInt(process.env.SCORE_TIMEOUT_MS ?? '240000', 10);
const SCORE_RETRIES = parseInt(process.env.SCORE_RETRIES ?? '2', 10);

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
  // Override the raw candidate location string with a clean geo policy so the
  // LLM ranks purely on NYC / remote-US fit (LA is no longer a target).
  lines.push(`\nGeo policy: open to NYC or remote-US only. Treat NYC (incl. NYC-commutable metro: Brooklyn/Queens/JC/Hoboken/Stamford) or fully-remote US as full match. Penalize LA-only, SF-only, Seattle-only, and international / other in-office-only locations.`);

  // Load user-specific scoring overrides from modes/_profile.md (gitignored).
  // Extract the "Scoring Rules" section and inject it so the model applies
  // the candidate's preferences — not just generic PM fit.
  const profileMdPath = path.join(ROOT, 'modes', '_profile.md');
  if (existsSync(profileMdPath)) {
    const md = await readFile(profileMdPath, 'utf-8');
    // Extract by index, not by regex. The previous pattern ended with `\z`,
    // which is a Perl/Ruby anchor and NOT valid JavaScript - in JS it is simply
    // the literal letter z. So the lookahead read `(?=^## |z)` and the scoring
    // rules were truncated at the first lowercase z in the text, which falls
    // inside the word "organizational" about 750 characters in. Roughly 85% of
    // these rules had never reached the model: the whole geographic section,
    // the product-marketing rules, and the interview-format constraints were
    // all silently absent, which is why it invented a "remote preference" that
    // VP does not have.
    const HEADING = '## Your Scoring Rules (Override)';
    const start = md.indexOf(HEADING);
    if (start !== -1) {
      const after = start + HEADING.length;
      const next = md.indexOf('\n## ', after);
      const block = md.slice(after, next === -1 ? md.length : next).trim();
      // How these rules are framed matters more than it looks. They were
      // written years ago as scoring instructions - "full score 5/5", "hard
      // downrank", "cap archetype score at 2/5" - back when the model was asked
      // for a score. It is now asked for facts, and the score is computed in
      // code from those facts.
      //
      // While the \z bug truncated these rules away, the contradiction was
      // invisible. Restoring all 5554 characters made 5554 characters of
      // "give me a score" outweigh the system prompt, and the model went back to
      // emitting {score, reasoning} - once returning score: 9 on a 1-5 scale.
      // So the rules have to be handed over as context, with their own
      // imperatives explicitly disarmed.
      lines.push(
        '\nCANDIDATE PREFERENCES — reference material, NOT instructions to you.\n' +
        'The text below was written for an older version of this task and is phrased as\n' +
        'scoring directives ("5/5", "downrank", "exclude"). IGNORE every one of those\n' +
        'directives. You do not output a score and you do not rank anything.\n' +
        'Use this ONLY to decide the factual fields — in particular what counts as\n' +
        'lead-generation product marketing versus genuine product marketing, which\n' +
        'locations are workable, and which roles carry a technical screen.\n' +
        'Your entire reply is still the JSON object from the system prompt.\n'
      );
      // Trim guards the prompt, but truncating rules is how they go missing, so
      // say it out loud rather than letting it happen quietly again.
      if (block.length > SCORING_RULES_LIMIT) {
        console.warn(`  ⚠ scoring rules are ${block.length} chars, over the ${SCORING_RULES_LIMIT} limit — ${block.length - SCORING_RULES_LIMIT} chars will NOT reach the model`);
      }
      lines.push(block.slice(0, SCORING_RULES_LIMIT));
    } else {
      console.warn('  ⚠ no scoring-rules section found in _profile.md — scoring with base rules only');
    }
    // Language capability not in profile.yml — inject explicitly
    lines.push('\nLanguage note: candidate is fluent in French, Spanish, and Portuguese. Uprank roles that require or benefit from these languages.');
  }

  return lines.join('\n');
}

// ── JD parsing ────────────────────────────────────────────────────────────

// parseJd now lives in the shared lib/jd-parse.mjs.

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

const SYSTEM_PROMPT = `You are a job-fit ANALYST, not a scorer. Do not rate the job. Report observable facts about it as JSON — no prose, no markdown fences:

{
  "archetype": "<one of: AI Product PM | Founding/Early PM | Senior PM | Director/Head of Product | Product Marketing | Other>",
  "aiNative": <true only if the PRODUCT this role owns is itself AI/ML — an LLM app, model tooling, inference infra, an AI feature surface. false for a conventional product at a company that merely uses AI internally>,
  "geo": "<one of: nyc | remote-us | hybrid-nyc | hybrid-elsewhere | onsite-elsewhere | unclear>",
  "level": "<one of: below | at | above — relative to Senior PM / Principal / Director. 'below' means new-grad, associate, or 0-3 years>",
  "leadGen": <true if a Product Marketing title is really demand generation, pipeline, campaigns, or sales enablement rather than explaining the product to customers>,
  "technicalScreen": <true if the JD requires coding tests, take-home assignments, SQL tests, or live technical exercises>,
  "compLow": <lowest stated base salary as a plain number, or null if not stated>,
  "verdict": "<A FULL SENTENCE of at least 12 words describing what this role actually is — the product, the seniority, and the company stage. NOT a rating. NOT a label. \"Strong Match\", \"Good fit\" and \"Senior PM role\" are all WRONG ANSWERS. Good example: \"Staff PM owning the agent-evaluation surface at a Series C developer-tools company, reporting to the Head of Product.\">",
  "redFlags": "<empty string or 1-2 concrete concerns>"
}

Report what the JD says. If it does not say, use null or "unclear" rather than guessing. JSON only. /no_think`;

// VP's policy lives here, in code, not in the prompt. A prompt-side rubric
// drifted badly: it told the model "most jobs are 2-3" while defining tier 4 as
// "target archetype with one secondary concern", which fits nearly every senior
// PM posting in NYC. The result was 32% of the board at tier 4+, so the tier
// stopped meaning anything and the review queue could not be built from it.
//
// The model now reports facts; these rules turn facts into a score the same way
// every time, and changing VP's priorities means editing this function.
// The model was asked for one of six geo enum values and returned free text
// instead - "New York, NY", "San Francisco, CA", "Remote, US". Only 18 of 403
// replies used the enum, so every gate comparing geo === 'onsite-elsewhere'
// silently never fired and nothing was filtered on location at all.
//
// Asking a third time would not help. The same lesson as the score itself
// applies: let the model report what it sees, and make the CATEGORY a
// deterministic function of that text. This is testable, it cannot drift, and
// it handles the enum values too for the replies that did comply.
const NYC_METRO = /\b(nyc|new york|manhattan|brooklyn|queens|bronx|newark|jersey city|hoboken|stamford|greenwich, ct|white plains|princeton|east windsor|port chester|yonkers)\b/i;
const REMOTE = /\bremote|work from home|wfh|distributed\b/i;
const HYBRID = /\bhybrid|days? (?:a|per) week|in[- ]office\b/i;
// Anywhere he cannot reach daily from Manhattan. Non-US entries land here too.
const ELSEWHERE = /\b(san francisco|sf\b|bay area|palo alto|mountain view|san mateo|redwood city|seattle|bellevue|redmond|austin|denver|chicago|boston|los angeles|miami|toronto|london|dublin|ireland|uk\b|spain|madrid|portugal|greece|germany|india|israel|tel aviv|sydney|dubai|bogota|canada|europe|morrisville|howell)\b/i;

function normalizeGeo(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return 'unclear';

  // Replies that did use the enum pass straight through.
  if (/^(nyc|remote-us|hybrid-nyc|hybrid-elsewhere|onsite-elsewhere|unclear)$/i.test(t)) {
    return t.toLowerCase();
  }

  const nyc = NYC_METRO.test(t);
  const remote = REMOTE.test(t);
  const hybrid = HYBRID.test(t);
  const elsewhere = ELSEWHERE.test(t);

  // A listing naming both NYC and a far office ("San Francisco, CA | New York")
  // is workable - he takes the New York one.
  if (nyc) return hybrid ? 'hybrid-nyc' : 'nyc';

  // Fully remote is fine wherever the company is. Check this before ELSEWHERE
  // so "Remote (US)" at an SF company is not misread as an SF office.
  if (remote && !hybrid) return 'remote-us';

  // Recurring days at an office he cannot reach - the one hard exclusion.
  if (elsewhere) return hybrid ? 'hybrid-elsewhere' : 'onsite-elsewhere';

  return 'unclear';
}

// Third field, same lesson. The model was given five archetype values and
// returned twelve-plus of its own - "Product", "Staff PM", "Product Leader",
// "Technical PM". So the Director/Founding bonus never fired, and the lead-gen
// gate, which tests archetype === 'Product Marketing', only caught the replies
// that happened to phrase it exactly that way.
//
// Order matters here: "Senior Product Marketing Manager" contains both
// "product marketing" and "senior", and it is a marketing role.
function normalizeArchetype(raw) {
  const t = String(raw ?? '').toLowerCase();
  if (!t) return 'Other';
  if (/product marketing|pmm\b/.test(t)) return 'Product Marketing';
  if (/founding|founder|first pm|early.stage pm/.test(t)) return 'Founding/Early PM';
  if (/director|head of|vp\b|chief|leader|leadership|principal/.test(t)) return 'Director/Head of Product';
  if (/\bai\b|ml\b|machine learning|llm|genai/.test(t)) return 'AI Product PM';
  if (/senior|staff|lead\b|sr\.?\b|technical pm|platform pm|product manager|product management|\bproduct\b|\bpm\b/.test(t)) {
    return 'Senior PM';
  }
  return 'Other';
}

function scoreFromFacts(f) {
  // Hard gates — things VP will not do, which no upside can offset.
  //
  // leadGen is only a gate on Product Marketing titles. Applied to every
  // archetype it fired on ordinary PM roles at Stripe, Pinecone and Writer
  // that merely mentioned go-to-market, and buried four good roles at tier 1.
  if (f.leadGen && f.archetype === 'Product Marketing') return 1;
  if (f.level === 'below') return 1;                          // not entry level
  if (f.geo === 'onsite-elsewhere') return 1;                 // he is in NYC
  if (f.geo === 'hybrid-elsewhere') return 1;                 // weekly flights

  let score = 3;                                              // a plausible role

  // The thesis: AI-native product work is what he is actually hunting.
  if (f.aiNative) score += 1;

  // Seniority he has earned. Director/Head and Founding are the stretch he wants.
  if (f.archetype === 'Director/Head of Product' || f.archetype === 'Founding/Early PM') score += 1;

  // Comp: a stated band at or above his floor is real signal. An unstated band
  // is neutral — compLow is null there, never 0 — so silence costs nothing.
  if (f.compLow != null && f.compLow >= 150000) score += 1;
  if (f.compLow != null && f.compLow < 120000) score -= 1;

  // A coding screen makes the role unwinnable for him regardless of fit.
  if (f.technicalScreen) score -= 2;

  // Geography he can work is assumed, not rewarded; only ambiguity costs.
  if (f.geo === 'unclear') score -= 1;

  // Tier 5 is reserved for the thesis. A well-paid senior non-AI role is a
  // real option and should reach 4, but it is not what this search is for, and
  // letting comp alone buy a 5 is what made the old top tier meaningless.
  if (!f.aiNative) score = Math.min(score, 4);

  return Math.max(1, Math.min(5, score));
}

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
    `Return ONLY the JSON object defined in the system prompt, with the keys archetype, aiNative, geo, level, leadGen, technicalScreen, compLow, verdict, redFlags. Do NOT return a "score" key. Do NOT return a "reasoning" key. The verdict must be a real sentence describing the role, not a two-word rating — 370 of the last 403 replies said only "Strong Match", which is useless. /no_think`,
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
  const payload = JSON.stringify({
    model: OLLAMA_MODEL,
    stream: false,
    think: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    options: { temperature: 0.1, num_predict: 400 },
  });

  let lastErr;
  for (let attempt = 1; attempt <= SCORE_RETRIES + 1; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SCORE_TIMEOUT_MS);
    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: ctl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data?.message?.content ?? '';
      if (process.env.DEBUG_SCORER) {
        console.log(`\n--- RAW (${content.length} chars) ---\n` + content.slice(0, 1200) + `\n--- END ---`);
      }
      const parsed = parseLLMJson(content);
      const facts = {
        archetype: normalizeArchetype(parsed.archetype),
        archetypeRaw: String(parsed.archetype || '').slice(0, 40),  // what it actually said
        aiNative: parsed.aiNative === true,
        // Location comes from the ATS record, NOT from the model. Brex posts the
        // same role as a separate req per city and lists all its offices in the
        // body text, so the model read "hybrid in SF, Seattle, or NYC" and
        // answered "NYC" for every one of them - including the San Francisco
        // req. The posting's own location field is authoritative and free.
        geo: normalizeGeo(jd.location || parsed.geo),
        geoRaw: String(jd.location || parsed.geo || '').slice(0, 60),
        geoModel: String(parsed.geo || '').slice(0, 40),  // what the model guessed, for auditing
        level: String(parsed.level || 'at').slice(0, 12),
        leadGen: parsed.leadGen === true,
        technicalScreen: parsed.technicalScreen === true,
        compLow: Number.isFinite(Number(parsed.compLow)) && Number(parsed.compLow) > 0
          ? Number(parsed.compLow)
          : null,
      };
      return {
        // Score is derived, never taken from the model. Facts are kept so a
        // score can always be explained and the policy re-run without re-asking.
        score: scoreFromFacts(facts),
        ...facts,
        verdict: String(parsed.verdict || '').slice(0, 240),
        redFlags: String(parsed.redFlags || '').slice(0, 200),
      };
    } catch (e) {
      lastErr = e;
      const reason = e.name === 'AbortError' ? `timeout after ${SCORE_TIMEOUT_MS}ms` : e.message;
      if (attempt <= SCORE_RETRIES) {
        const backoff = 2000 * attempt;
        console.log(`  retry ${attempt}/${SCORE_RETRIES} for ${jd.filename} (${reason}); waiting ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr; // unreachable, but keeps control-flow explicit
}

// ── Output ────────────────────────────────────────────────────────────────

function buildInboxLeadsMd(scored) {
  const now = new Date().toISOString();
  // Dedup by canonical company::title (shared lib/canonical) — same posting can
  // land in pipeline.md under multiple URL variants (digest with ?position=1/2/3,
  // tracking tokens, etc). Keep the freshest, prefer non-tracking-laden URLs.
  const seen = new Map();
  for (const s of scored) {
    const key = canonKey(s.company, s.title);
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
  // Always load the existing cache as the persistence base so a scoped run
  // (e.g. --rescore --limit 1) re-scores only what's in scope WITHOUT discarding
  // the other cached entries. --rescore forces re-scoring (see the cache-hit
  // check below); it must not wipe out-of-scope scores when combined with --limit.
  const cache = await loadScores();

  const files = (await readdir(JDS_DIR).catch(() => [])).filter(f => f.endsWith('.md'));
  console.log(`JDs found:    ${files.length}`);

  const blacklist = await loadBlacklist(); // opt-in data/blacklist.md; empty = no filtering

  let titleDropped = 0;
  let staleDropped = 0;
  let blacklistDropped = 0;
  let unparsedDate = 0;

  const candidates = [];
  for (const f of files) {
    const p = path.join(JDS_DIR, f);
    const raw = await readFile(p, 'utf-8');
    const jd = parseJd(raw, f);
    const tf = titleFilter(jd.title);
    if (!tf.passes) { titleDropped++; continue; }
    if (blacklist.size && blacklistEntry(jd.company, blacklist)) { blacklistDropped++; continue; }
    const days = freshnessOf(jd);
    if (days != null && days > MAX_AGE_DAYS) { staleDropped++; continue; }
    if (days == null) unparsedDate++;
    candidates.push({ ...jd, posted_days: days });
  }

  console.log(`After title:  ${candidates.length + titleDropped} → ${candidates.length} (-${titleDropped})`);
  if (blacklistDropped) console.log(`Blacklisted:  ${blacklistDropped} dropped (data/blacklist.md)`);
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
      // Checkpoint. This run takes hours and used to write only at the end, so
      // an interruption discarded everything - which happened three times in one
      // day. Every 10 scores bounds the loss to a couple of minutes of work.
      if ((llmCalls % 10) === 0) await saveScores(cache);
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
