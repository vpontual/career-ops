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
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { loadBlacklist, blacklistEntry } from './blacklist.mjs';
import { canonKey } from './lib/canonical.mjs';
import { parseJd } from './lib/jd-parse.mjs';
import { detectTrack, titlePassesForTrack, trackFacts, scoreTeaching, scoreNonprofit, scoreNow } from './lib/track.mjs';
import { screenVerdict, findReportableFormats } from './lib/screen-evidence.mjs';
import { compBand } from './lib/comp-band.mjs';
import { skillGate, defaultLacks } from './lib/skill-gate.mjs';

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
// Track C only. See the drop site for why the 30-day rule cannot apply to a
// school-year requisition.
const TEACHING_MAX_AGE_DAYS = parseInt(process.env.TEACHING_MAX_AGE_DAYS ?? '150', 10);
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

// What a product role is CALLED, as a shape rather than a list of 24 exact
// strings. This is the filter VP was actually complaining about on 2026-08-10 -
// "why are we limiting based on the extra words in the title?" - and he was
// right: it runs BEFORE the model is ever called (see the titleDropped branch in
// main()), so scoreFromFacts cannot rescue a posting this drops. It is the only
// title rule in the system that is a true gate rather than a score adjustment.
//
// portals.yml's `positive` list required an EXACT substring. It carried
// "Director, Product Management" and "Director of Product Management" but not a
// bare "Product Management", so this was silently discarded:
//
//     "Senior Manager, Product Management: Agentic Software Delivery"
//
// - agentic AI product management, dropped on word order. "Product Builder" went
// the same way. Measured over the 1,904 JDs on disk: this regex admits exactly
// those 2 and loses NOTHING the 24-string list admitted (verified 0 regressions).
//
// The NEGATIVE list is untouched and still wins. It encodes real _profile.md
// exclusions - growth/demand-gen/sales/engineering - and those are judgements
// about the work, not about title formatting.
const PRODUCT_ROLE = /\b(?:head|director|vp|svp|gvp|chief)\s+(?:of\s+)?product\b|\bproduct\s+(?:manager|management|owner|lead|leader|director|marketing|strategy|builder)\b|\b(?:senior|staff|principal|group|lead|founding)\s+pm\b/i;

function loadTitleFilter() {
  const portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const tf = portals.title_filter || {};
  const positive = (tf.positive || []).map(s => s.toLowerCase());
  const negative = (tf.negative || []).map(s => s.toLowerCase());
  return (title) => {
    // '_' and '/' are word characters to a regex, so "Product Manager_Product
    // Studio" fails \bmanager\b. Normalising separators is the difference
    // between 0 regressions and 1.
    const norm = String(title || '').replace(/[_/|]+/g, ' ');
    const lower = norm.toLowerCase();
    // The list survives as a user-editable extension point; the regex is what
    // actually does the work now.
    const hasPos = PRODUCT_ROLE.test(norm) || positive.some(k => lower.includes(k));
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
  "functionArea": "<the discipline this role actually belongs to, one of: product | program | operations | strategy | partnerships | customer-success | consulting | research | teaching | general-management | engineering | design | sales | marketing-demand | finance | legal | hr | security | clinical | support | other>",
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
// Princeton and East Windsor NJ were in this list and are not daily-commutable;
// VP never named them. Removed. Added the Metro-North and LIRR towns the mission
// explicitly calls the tractable part of Track C - "Harrison and New Rochelle on
// Metro-North" - plus Westchester, Nassau and Suffolk generally, because all 5
// OLAS Business-teacher vacancies normalised to `unclear`, lost a point, and were
// then dropped outright by the enqueue geo gate.
const NYC_METRO = /\b(nyc|new york|manhattan|brooklyn|queens|bronx|staten island|newark|jersey city|hoboken|stamford|greenwich, ct|white plains|port chester|yonkers|harrison|new rochelle|scarsdale|rye|mamaroneck|mount vernon|tarrytown|westchester|hempstead|garden city|mineola|nassau county|suffolk county|long island|patchogue|wyandanch|babylon|huntington|mastic|hicksville|valley stream)\b/i;
const REMOTE = /\bremote|work from home|wfh|distributed\b/i;
const HYBRID = /\bhybrid|days? (?:a|per) week|in[- ]office\b/i;
// Anywhere he cannot reach daily from Manhattan. Non-US entries land here too.
const ELSEWHERE = /\b(san francisco|sf\b|bay area|palo alto|mountain view|san mateo|redwood city|seattle|bellevue|redmond|austin|denver|chicago|boston|los angeles|miami|toronto|london|dublin|ireland|uk\b|spain|madrid|portugal|greece|germany|india|israel|tel aviv|sydney|dubai|bogota|canada|europe|morrisville|howell)\b/i;

// Countries and non-US metros. ELSEWHERE above is a mix of US cities and foreign
// ones, which is fine for the onsite test but useless for the question "is this
// remote role inside the US". This list is only consulted for remote postings.
const NON_US = /\b(france|paris|brazil|brasil|s[aã]o paulo|rio de janeiro|belo horizonte|porto alegre|curitiba|recife|bras[ií]lia|campinas|florian[oó]polis|buenos aires|montevideo|guadalajara|monterrey|medell[ií]n|ciudad de m[eé]xico|cdmx|netherlands|amsterdam|singapore|india|bangalore|bengaluru|hyderabad|pune|philippines|manila|romania|bucharest|turkey|istanbul|mexico|argentina|colombia|bogota|chile|peru|poland|warsaw|krakow|japan|tokyo|china|shanghai|korea|seoul|vietnam|thailand|indonesia|nigeria|kenya|egypt|south africa|australia|sydney|melbourne|new zealand|berlin|munich|hamburg|barcelona|madrid|spain|lisbon|portugal|greece|athens|london|manchester|dublin|ireland|u\.?k\.?|united kingdom|england|scotland|germany|austria|vienna|switzerland|zurich|sweden|stockholm|norway|denmark|copenhagen|finland|helsinki|belgium|brussels|czech|prague|hungary|budapest|ukraine|israel|tel aviv|dubai|u\.?a\.?e\.?|saudi|qatar|canada|toronto|vancouver|montreal|ottawa|europe|emea|latam|apac|anz)\b/i;

// An explicit US signal beats a foreign mention, so multi-region postings that
// include the US stay eligible.
const US_SIGNAL = /\b(u\.?s\.?a?\b|united states|nationwide|anywhere in the (?:us|united states)|us[- ]based|us[- ]remote)\b/i;

// The model was given below|at|above and returned free text in 785 of 806
// records - "Senior", "Staff", "Mid", "L6", "AVP", "Individual C". So
// `if (f.level === 'below') return 1` has NEVER FIRED in the system's life.
// Same failure as geo and archetype, missed when those two were normalised.
//
// ⚠ "Individual Contributor" appears 48 times and is NOT junior - a Staff or
// Principal PM is an IC. Mapping it to 'below' would hard-reject 48 senior
// roles, which is the opposite of the point.
//
// 'below' is defined by the scoring prompt as "new-grad, associate, or 0-3
// years". "Mid" is deliberately NOT below: it is 3-5+ years and outside the
// stated definition, so gating on it would be inventing a rule VP did not set.
const LEVEL_BELOW = /\b(entry|entry[- ]level|junior|jr\b|new[- ]?grad|graduate|associate|intern|internship|apprentice|trainee|assistant|early[- ]career)\b/i;
const LEVEL_ABOVE = /\b(director|vp\b|vice president|head\b|chief|executive|principal|staff|senior|sr\b|lead\b|expert|l[5-9]\b|avp)\b/i;

export function normalizeLevel(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return 'at';
  if (/^(below|at|above)$/i.test(t)) return t.toLowerCase();
  // Order matters: "Senior Associate" and "Early Career Director" both exist.
  // Seniority wins, because a false 'below' hard-rejects and a false 'at' merely
  // declines to reject - the asymmetry should favour not burying a real role.
  if (LEVEL_ABOVE.test(t)) return 'above';
  if (LEVEL_BELOW.test(t)) return 'below';
  return 'at';
}

function normalizeGeo(raw) {
  // Diacritics are stripped before ANY matching. "Ciudad de Mexico" is in the
  // vocabulary; "Ciudad de México" - which is what Nubank's ATS actually
  // sends - is not, and matched nothing.
  const t = String(raw ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!t) return 'unclear';

  // Replies that did use the enum pass straight through.
  if (/^(nyc|remote-us|hybrid-nyc|hybrid-elsewhere|onsite-elsewhere|unclear)$/i.test(t)) {
    return t.toLowerCase();
  }

  const nyc = NYC_METRO.test(t);
  const remote = REMOTE.test(t);
  const hybrid = HYBRID.test(t);
  // ⚠ BOTH vocabularies, not just ELSEWHERE. This is the bug that put Nubank's
  // Sao Paulo and Ciudad de Mexico roles on VP's board on 2026-08-10.
  //
  // There were two lists doing one job. NON_US is the comprehensive foreign
  // vocabulary but was consulted ONLY on the remote branch below, while
  // ELSEWHERE - which gates the on-site branch - is US-city-focused and has no
  // Brazil, no Mexico, no Colombia. So "Brazil (Remote)" resolved correctly to
  // onsite-elsewhere while a bare "Sao Paulo" fell through to 'unclear', and
  // 'unclear' is tolerated on the 'now' track. Same posting, same country, two
  // different answers depending on whether the word "remote" appeared.
  const elsewhere = ELSEWHERE.test(t) || (NON_US.test(t) && !US_SIGNAL.test(t));

  // A listing naming both NYC and a far office ("San Francisco, CA | New York")
  // is workable - he takes the New York one.
  if (nyc) return hybrid ? 'hybrid-nyc' : 'nyc';

  // Fully remote is fine wherever the company is. Check this before ELSEWHERE
  // so "Remote (US)" at an SF company is not misread as an SF office.
  //
  // But "wherever the company is" only holds INSIDE the US. This returned
  // 'remote-us' for "Remote, France", "Remote, Bangalore", "Remote, Singapore"
  // and "Brazil (Remote)" - 9 records - because ELSEWHERE was never reached and
  // had no entry for most of those countries anyway. GitLab's Senior Deal Desk
  // Analyst, Philippines was enqueued as remote-us on 2026-08-05. VP cannot take
  // a role in another country's payroll and time zone; the mission's three
  // acceptable modes are NYC, fully-remote US, and hybrid NYC.
  //
  // A listing naming both ("Remote, Canada; Remote, US") keeps remote-us - he
  // takes the US one - which is why this tests for a US signal rather than
  // simply rejecting on any foreign mention.
  if (remote && !hybrid) {
    return NON_US.test(t) && !US_SIGNAL.test(t) ? 'onsite-elsewhere' : 'remote-us';
  }

  // Recurring days at an office he cannot reach - the one hard exclusion.
  if (elsewhere) return hybrid ? 'hybrid-elsewhere' : 'onsite-elsewhere';

  return 'unclear';
}

// The model returns things like 1 and 124 for compLow. Treated as a real salary,
// 1 is below every floor and silently caps a good role: it costs -1 for being
// under $120k AND hard-caps the score at 3 for being under $150k. 32 such values
// were live when this guard was written at EXTRACTION time - and 29 survived it,
// because rank-leads cache-hits on an already-scored JD (877 hits to 9 LLM calls
// on a typical night) and recompute-scores re-applies policy to the STORED facts.
// A guard that only runs on new intake cannot heal the corpus, so this lives in
// one exported place and BOTH paths call it.
//
// Anything under $10k is not a US base salary, so it reads as "not stated" rather
// than as a number - and silence costs nothing, by design.
export function sanitizeCompLow(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10000 ? n : null;
}

// Third field, same lesson. The model was given five archetype values and
// returned twelve-plus of its own - "Product", "Staff PM", "Product Leader",
// "Technical PM". So the Director/Founding bonus never fired, and the lead-gen
// gate, which tests archetype === 'Product Marketing', only caught the replies
// that happened to phrase it exactly that way.
//
// Order matters here: "Senior Product Marketing Manager" contains both
// "product marketing" and "senior", and it is a marketing role.
function normalizeArchetype(raw, title = '') {
  // The TITLE is authoritative for seniority, the same discipline geo already
  // uses: the ATS record says what the role IS, the model says what it thought.
  // Reading the model alone missed 'Head of Product Management - Intelligence
  // Ventures' (Spectrum, NYC, AI-native, $263K-$394K stated) because the model
  // answered the free text 'Platform PM', which falls through to Senior PM and
  // forfeits the Director/Head +1. 73 records carried a Head/Director/VP title
  // against a non-Director archetype.
  const t = `${String(raw ?? '')} ${String(title ?? '')}`.trim().toLowerCase();
  if (!t) return 'Other';
  if (/product marketing|pmm\b/.test(t)) return 'Product Marketing';
  if (/founding|founder|first pm|early.stage pm/.test(t)) return 'Founding/Early PM';
  // \bdirector\b, not /director/: 'Sr Product Manager, Provider Directory
  // Products' is not a director role, and the unbounded pattern read it as one.
  if (/\bdirector\b|\bhead of\b|\b[gse]?vp\b|chief|leader|leadership|principal/.test(t)) return 'Director/Head of Product';
  if (/\bai\b|ml\b|machine learning|llm|genai/.test(t)) return 'AI Product PM';
  if (/senior|staff|lead\b|sr\.?\b|technical pm|platform pm|product manager|product management|\bproduct\b|\bpm\b/.test(t)) {
    return 'Senior PM';
  }
  return 'Other';
}

// Fourth field to need this, and for the same reason as geo and archetype: the
// model is given an enum and answers in its own words. This one replaces four
// rounds of keyword exclusions on Track D. A keyword list cannot express "a job
// VP could actually do" - it let through Deal Desk Analyst, Lead Designer, SOX
// PMO, Regional Sales Director and Systems Engineer, one round at a time - so
// the model reports the DISCIPLINE and the policy lives in code.
const FUNCTION_AREA = [
  ['engineering', /engineer|developer|programmer|devops|\bsre\b|machine learning|data scien|architect/i],
  ['teaching', /teacher|teaching|instructor|lecturer|adjunct|faculty|curriculum|instructional/i],
  ['design', /\bdesign(er)?\b|\bux\b|\bui\b|visual|creative|art director/i],
  ['sales', /\bsales\b|account executive|account manager|quota|business development rep|deal desk|renewals|pipeline/i],
  // Widened 2026-08-06. 'Paid Media Manager (B2B)' normalised to 'other', so the
  // lead-gen gate - which already lists marketing-demand - never saw it, and a
  // demand-generation role reached tier 5 and a review card. Paid media, paid
  // search/social, SEM, PPC and programmatic ARE demand generation.
  ['marketing-demand', /demand gen|growth marketing|performance marketing|performance media|paid media|media buying|paid social|paid search|\bsem\b|\bppc\b|programmatic|campaign|\bseo\b|lifecycle marketing|field marketing|brand marketing|acquisition marketing/i],
  ['finance', /financ|accounting|accountant|\btax\b|audit|treasury|controller|payroll|fp&a|\bsox\b|billing|\bsec (analyst|report)/i],
  ['legal', /legal|counsel|attorney|lawyer|paralegal|compliance officer|regulatory affairs/i],
  ['hr', /human resources|\bhr\b|people ops|people operations|talent acquisition|recruit|compensation|benefits|hrbp|people business partner/i],
  ['security', /information security|security engineer|\bsoc\b|\bgrc\b|infosec|cyber/i],
  ['clinical', /clinical|medical|nurse|physician|patient care/i],
  ['support', /technical support|help ?desk|support engineer|tier [123]|director,? support|head of support/i],
  ['customer-success', /customer success|client success|customer experience|onboarding manager/i],
  ['partnerships', /partnership|alliances|channel|business development(?! rep)/i],
  ['consulting', /consultant|consulting|advisory|advisor/i],
  ['research', /research|insights|competitive intelligence|analyst relations/i],
  ['program', /program manager|project manager|delivery manager|\bpmo\b|portfolio manager/i],
  ['operations', /operations|\bops\b|business operations/i],
  ['strategy', /strategy|strategic|corporate development|chief of staff/i],
  ['general-management', /general manager|country manager|managing director/i],
  // Widened after an audit: 47 tier-4+ roles were landing in 'other' and nearly
  // all of them were Director of Product, Director Product Management or VP of
  // Product. The pattern matched 'product manager' but not 'product management',
  // and not 'director of product' - so it missed exactly the senior titles VP
  // most wants. Not harmful (other is allowed through) but wrong, and it would
  // have mattered the moment anything keyed off the label.
  ['product', /product manage(r|ment)|product marketing|product lead|head of product|product owner|product director|(director|vp|vice president|chief)[, ]+(of )?product|chief product officer/i],
];

export function normalizeFunctionArea(raw, title = '') {
  const t = String(raw ?? '').trim().toLowerCase();
  const known = new Set(FUNCTION_AREA.map((x) => x[0]).concat(['other']));
  if (known.has(t)) return t;
  // The model answered in prose, or not at all. Fall back to the title, which is
  // the same authority the rest of this file trusts over the model's wording.
  const hay = `${t} ${title}`;

  // An unambiguous product-management title wins over any DOMAIN word in the
  // rest of the title, because FUNCTION_AREA is first-match-wins and the domain
  // categories are listed first. "Staff Product Manager, RevOps & Finance
  // Systems" matched /financ/ and classified as `finance`, which Track D's
  // CANNOT_DO then hard-rejected to 1 - a role VP had personally APPROVED. A PM
  // who owns finance systems is a PM, not an accountant. Same for "Product
  // Manager, Security", "PM, Support Platform" and every other domain PM role.
  //
  // Product MARKETING is deliberately excluded here and left to fall through, so
  // the marketing-demand test above keeps its say on the lead-gen trap.
  if (/\bproduct (manager|management|lead|owner|director)\b|\bhead of product\b|\bchief product officer\b/i.test(hay)
      && !/product marketing/i.test(hay)) {
    return 'product';
  }

  for (const [name, re] of FUNCTION_AREA) if (re.test(hay)) return name;
  return 'other';
}

function scoreFromFacts(f) {
  // Hard gates — things VP will not do, which no upside can offset.
  //
  // The lead-gen trap, gated on the DISCIPLINE rather than on the model's
  // judgement call. It used to read `f.leadGen && f.archetype === 'Product
  // Marketing'`, which failed in both directions: 81 records carry leadGen and
  // the gate fired on only 53, so GitLab's Enablement Content Manager (raw
  // archetype "Sales Enablement" - the thing the mission rejects by name) sailed
  // through at 4; while Mercury's Senior PMM, Cards & Spend was gated to 1 and
  // VP APPROVED IT ANYWAY. That approval is the strongest evidence available
  // that the model's leadGen boolean is not a policy input.
  //
  // functionArea is normalised in code from the title, so it says what the role
  // IS. leadGen is retained as a card flag, not a gate.
  if (f.functionArea === 'marketing-demand') return 1;
  // `level === 'below'` used to `return 1` here. It is derived from TITLE WORDS
  // (LEVEL_BELOW = associate|assistant|trainee|graduate), so it was a title word
  // producing a hard reject - the exact thing VP ruled out on 2026-08-10: "i dont
  // care if its senior, director, principla, co founding they all count, even
  // regular pm counts because every company does titles differently." Live
  // casualty: Ancestry's "Associate Technical Product Manager", aiNative and
  // remote-US, scored a hard 1 on the word "Associate". It is now a -1 applied
  // below, which a genuinely junior role cannot outrun but a mistitled senior one can.
  if (f.geo === 'onsite-elsewhere') return 1;                 // he is in NYC
  if (f.geo === 'hybrid-elsewhere') return 1;                 // weekly flights

  let score = 3;                                              // a plausible role

  // The thesis: AI-native product work is what he is actually hunting.
  if (f.aiNative) score += 1;

  // NO TITLE BONUS. This used to be:
  //   if (archetype === 'Director/Head of Product' || 'Founding/Early PM') score += 1
  // Removed 2026-08-10 on VP's instruction. `modes/_profile.md` has always opened
  // with "Scoring axis: CLOSENESS TO PRODUCT, not title height - a Senior IC with
  // direct product ownership beats a VP managing managers, even at higher comp",
  // and this line was the opposite of that rule, written into the scorer.
  //
  // Measured before removal: it was the ONLY thing holding 36 roles at tier 4 -
  // Mastercard, JPMorganChase x3, US Bank, CenterWell, Availity, Progyny - almost
  // all non-AI-native BigCo director reqs with no stated comp, i.e. verbatim the
  // "VP of Product at BigCo with no direct product surface" that _profile.md lists
  // as explicitly NOT a match. A job title can no longer buy a tier.
  //
  // Closeness to product is the axis that SHOULD sit here, and it is not
  // implemented. Three candidate signals were measured on 2026-08-10 and all three
  // were rejected as noise: a `hands-on` regex fired on 50% of VP's approvals vs
  // 33% of his rejections against a 29% base rate, matched "hands-on experience
  // with AWS" and a school named "Founding", and disagreed with itself on 13% of
  // requisitions scraped twice. Do not reintroduce it as a keyword test. It needs
  // sentence-scoped extraction storing the verbatim quote it fired on, the way
  // lib/screen-evidence.mjs does, validated against VP's own decisions.
  if (f.level === 'below') score -= 1;

  // Comp: a stated band at or above his floor is real signal. An unstated band
  // is neutral — compLow is null there, never 0 — so silence costs nothing.
  if (f.compLow != null && f.compLow >= 150000) score += 1;
  if (f.compLow != null && f.compLow < 120000) score -= 1;

  // The `< 150000` CAP that used to sit here is GONE (2026-08-10, VP's call):
  //   if (f.compLow < 150000) score = Math.min(score, 3)
  // It was a BLOCK - no combination of other evidence could lift a below-floor
  // role to tier 4 - and VP ruled that out: "if i want 150k why would we block
  // 250k? 1M? thats dumb and we shouldnt block below 15[0]k automatically either
  // because the other aspects of it can help prop up the role."
  //
  // The -1 above survives, because a -1 is not a block: it is one point another
  // signal can outweigh, which is exactly what he asked for.
  //
  // KNOWN CONFLICT, surfaced to VP 2026-08-10 rather than resolved in code. This
  // cap was originally added BECAUSE VP had rejected GitHub, Indeed, Bloomberg x2
  // and Addepar at stated bases of $124K-$142K. Removing it re-admits 23 such
  // roles (Bloomberg PM Enterprise AI $140K, Harvey $137.6K, Datadog $123K).
  // His instruction is newer than those rejections, so the instruction wins - but
  // if the queue fills with $130K roles he says no to, this is the line to revisit,
  // and the right fix is probably to stop re-enqueueing what he already declined,
  // not to reinstate a cap.

  // A coding screen makes the role unwinnable for him regardless of fit, and the
  // mission states it twice. That rule is unchanged. What changed (2026-08-06) is
  // WHICH FACT it fires on.
  //
  // The mission's rule has two halves: "check the interview process before
  // shortlisting WHERE IT IS KNOWABLE; FLAG THE RISK WHERE IT IS NOT." Only the
  // first was implemented. This gated on `technicalScreen`, a boolean the LLM
  // returns - and employers essentially never publish interview format, so the
  // model was inferring a screen from technical vocabulary in the body. Measured
  // over the corpus: it set the flag on 176 of 806 records, and **0 of those 176
  // postings contain any statement of a screen**; across all 1,593 JDs on disk,
  // zero state a disqualifying one. Two scrapes of the same requisition disagreed
  // about 20% of the time - Datadog's Bits Agent Builder scored 1 from Datadog's
  // own ATS and 5 from Indeed. An inference was being treated as knowledge and
  // hard-rejecting to tier 1, burying a $240K Google GenAI GPM role and three of
  // the six roles in the mission's own PREPARED ledger.
  //
  // So: gate on evidence, flag on inference. `technicalScreenStated` is set in
  // CODE by lib/screen-evidence.mjs, which finds the verbatim phrase in the
  // posting or returns nothing - the same facts-in-code discipline as geo. It
  // also honours the mission's exception (a role that explicitly allows building
  // through AI does not gate) which was previously listed as a known gap.
  // `technicalScreen` is retained as the model's raw claim and surfaces as a card
  // flag, so the risk is reported rather than silently priced in.
  // A REQUIRED skill VP does not have is a hard no - he cannot do the job. This
  // is evidence-gated the same way technicalScreenStated is: the skill must
  // appear inside a requirements section (or a requirement-worded sentence),
  // never merely somewhere in the body, and a degree-major list does not count.
  // Nice-to-haves surface as a card warning instead and cost nothing.
  if (Array.isArray(f.skillBlocked) && f.skillBlocked.length) return 1;

  if (f.technicalScreenStated) return 1;

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
    `Return ONLY the JSON object defined in the system prompt, with the keys archetype, aiNative, geo, level, leadGen, technicalScreen, functionArea, compLow, verdict, redFlags. Do NOT return a "score" key. Do NOT return a "reasoning" key. The verdict must be a real sentence describing the role, not a two-word rating — 370 of the last 403 replies said only "Strong Match", which is useless. /no_think`,
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
        archetype: normalizeArchetype(parsed.archetype, jd.title),
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
        level: normalizeLevel(parsed.level),
        levelRaw: String(parsed.level || '').slice(0, 24),   // what it actually said
        leadGen: parsed.leadGen === true,
        functionArea: normalizeFunctionArea(parsed.functionArea, jd.title),
        functionAreaRaw: String(parsed.functionArea || '').slice(0, 40),
        // The model's raw claim, kept for the card flag and for auditing.
        technicalScreen: parsed.technicalScreen === true,
        // The fact policy actually gates on, decided in CODE against the posting
        // text rather than by the model - same discipline as geo above. Reads the
        // verbatim phrase out of the JD, and honours the mission's exception for
        // roles that explicitly allow building through AI.
        ...(() => {
          const v = screenVerdict(`${jd.title || ''}\n${jd.body || ''}`, parsed.technicalScreen === true);
          return {
            technicalScreenStated: v.action === 'gate',
            technicalScreenEvidence: v.phrase || '',
            interviewFormats: findReportableFormats(`${jd.title || ''}\n${jd.body || ''}`).join('; '),
          };
        })(),
        // Comp comes from the POSTING, not the model - the fourth fact to learn
        // that lesson after geo, level and functionArea. The model returned 1
        // for a posting printing "$263,200.00 and $393,800.00". The model's
        // answer is kept as a fallback for phrasings the parser misses, and as
        // compLowRaw so the two can be compared.
        ...(() => {
          // A skill VP does not have, weighed by WHERE the posting asks for it.
          // His rule, 2026-08-10: "IF its a requirement, block it. if its in the
          // nice to haves section, show it with a warning."
          const sg = skillGate(`${jd.title || ''}\n${jd.body || ''}`, defaultLacks());
          return {
            skillBlocked: sg.blocked.map(b => b.skill),
            skillBlockedEvidence: sg.blocked.map(b => `${b.skill}: ${b.evidence}`).join(' | '),
            skillWarnings: sg.warned.map(w => w.skill),
          };
        })(),
        ...(() => {
          const band = compBand(`${jd.title || ''}\n${jd.body || ''}`);
          const modelSaid = sanitizeCompLow(parsed.compLow);
          return {
            compLow: band.compLow ?? modelSaid,
            compLowRaw: modelSaid,
            compSource: band.compLow != null ? 'posting' : (modelSaid != null ? 'model' : 'unstated'),
            compEvidence: band.evidence || '',
          };
        })(),
      };
      // Which of the three searches this belongs to, and the extra facts that
      // rubric needs - both read off the posting in code, so neither costs
      // prompt surface. The scoring prompt is already 5,554 of its 6,000
      // characters and has silently truncated before.
      const track = jd.track || detectTrack(jd);
      const extra = trackFacts(track, jd);
      const allFacts = { ...facts, ...extra, track };
      const score = track === 'teaching' ? scoreTeaching(allFacts)
                  : track === 'nonprofit' ? scoreNonprofit(allFacts)
                  : track === 'now' ? scoreNow(allFacts)
                  : scoreFromFacts(allFacts);

      return {
        // Score is derived, never taken from the model. Facts are kept so a
        // score can always be explained and the policy re-run without re-asking.
        score,
        ...allFacts,
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
    // Track A keeps portals.yml's PM/PMM filter untouched. Tracks B and C are
    // additive: a Business Teacher vacancy has no PM title and was dropped here
    // before it could ever be scored, which is why Track C had zero scored roles
    // while its JDs sat on disk.
    const track = detectTrack(jd);
    const tf = titleFilter(jd.title);
    if (!tf.passes && !titlePassesForTrack(track, jd.title)) { titleDropped++; continue; }
    if (blacklist.size && blacklistEntry(jd.company, blacklist)) { blacklistDropped++; continue; }
    const days = freshnessOf(jd);
    // Schools hire on a school year, not a sprint. A charter runs one evergreen
    // requisition for a whole season: 68 of 82 teaching JDs are over 90 days old
    // and 27 of 28 Success Academy reqs - open SY2026-27 postings - were dropped
    // as stale, which is why Track C's dominant employer was invisible. The 30-day
    // "assume filled" rule is a tech-req rule and does not transfer.
    const maxAge = track === 'teaching' ? TEACHING_MAX_AGE_DAYS : MAX_AGE_DAYS;
    if (days != null && days > maxAge) { staleDropped++; continue; }
    if (days == null) unparsedDate++;
    candidates.push({ ...jd, posted_days: days, track });
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

// Import-safe. Scoring 700+ roles against the gateway must be an explicit
// invocation, never a side effect of `import`. Same guard as tailor-cv.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}

// The policy functions, exported so they can be replayed and tested against the
// corpus rather than re-derived. recompute-scores.mjs previously reached in and
// sliced these out of this file's SOURCE TEXT to avoid drifting from them - which
// works until a brace moves. Importing is the same guarantee without the fragility.
export { normalizeGeo, normalizeArchetype, scoreFromFacts, PRODUCT_ROLE };
