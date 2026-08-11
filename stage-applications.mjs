#!/usr/bin/env node
/**
 * stage-applications.mjs — Level A automation.
 *
 * For every role scored >= MIN_SCORE that enqueue-review could still card
 * (freshness window and recency both from lib/freshness.mjs — see there), it
 * generates:
 *   1. A tailored cover letter (Gemini call against profile.yml + cv.md + JD)
 *   2. A CV PDF (uses career-ops' cv-template.html + cv.md, no per-JD tailoring in v1)
 *   3. A cover letter PDF
 * All saved to output/{slug}/
 *
 * Designed to run inside the `applier` container which has Chromium.
 *
 * Flags:
 *   --list / --dry-run   show what WOULD be staged, generate nothing
 *   --slug a,b,c         stage only these packs (comma-separated)
 *
 * Tunables (env overrides):
 *   MIN_SCORE=4.0
 *   MAX_CONCURRENT=2
 *   GEMINI_MODEL=gemini-2.5-flash
 *   freshness windows: FRESH_MAX_AGE_DAYS / MAX_AGE_DAYS (whales) /
 *   EVERGREEN_MAX_AGE_DAYS / TEACHING_MAX_AGE_DAYS — all in lib/freshness.mjs,
 *   because they must be the same numbers enqueue-review uses. Do NOT
 *   reintroduce a local one here; that is the bug lib/freshness.mjs exists for.
 */

import { readFile, writeFile, mkdir, stat, unlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { chromium } from 'playwright';
import { checkUrl } from './check-liveness.mjs';
import { checkFacts } from './verify-cv-facts.mjs';
import { classifyArchetype } from './tailor-cv.mjs';
import { canonKey } from './lib/canonical.mjs';
import { greenhouseRef } from './lib/branded-boards.mjs';
import {
  resolveCoverLetterRequirement, loadPackFormEvidence,
  readCoverLetterFinding, writeCoverLetterFinding, renderSkipMarkdown,
} from './lib/cover-letter-requirement.mjs';
import { parseJd } from './lib/jd-parse.mjs';
import {
  loadFreshnessPolicy, recencyDays,
  FRESH_MAX_AGE_DAYS, WHALE_MAX_AGE_DAYS, EVERGREEN_MAX_AGE_DAYS, TEACHING_MAX_AGE_DAYS,
} from './lib/freshness.mjs';
import { renderCvHtml, renderCoverLetterHtml } from './lib/render.mjs';

try {
  const { config } = await import('dotenv');
  config();
} catch {}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIN_SCORE = parseFloat(process.env.MIN_SCORE || '4.0');
// THE FRESHNESS WINDOW IS NOT DECLARED HERE ANY MORE, and must not be again.
//
// It was, twice, and both times it was a copy of a rule that had already moved
// on. First a flat window against enqueue-review's 150-day teaching window: a
// teaching card 31-150 days old got a review card that could never get an
// application pack. That was patched with a second constant, which held until
// the windows became per-employer as well as per-track — and then the same
// trap-state reopened one band lower, at 15-21 days, where it caught nine
// tier-4/5 City of New York roles (2026-08-10). Staging cannot promise less
// than enqueue promises, so it no longer gets its own opinion: both import
// lib/freshness.mjs, whose header carries the full incident.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1', 10);  // free tier = 5 RPM
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY missing in .env');
  process.exit(1);
}

const ai = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: GEMINI_MODEL });

// Candidate scores now come from rank-leads.mjs's nightly cache (the single
// scoring authority) rather than the retired score-all.mjs report snapshots.
const SCORES_PATH = path.join(ROOT, 'data', 'lead-scores.json');
const JDS_DIR = path.join(ROOT, 'jds');
const OUTPUT_DIR = path.join(ROOT, 'output');
const CV_PATH = path.join(ROOT, 'cv.md');
const VARIANTS_DIR = path.join(ROOT, 'cv-variants');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
const CV_TEMPLATE = path.join(ROOT, 'templates', 'cv-template.html');
const PROFILE_OVERRIDES = path.join(ROOT, 'modes', '_profile.md');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// Strip non-ASCII typography an ATS parser can garble (em/en dashes, smart
// quotes, ellipsis, zero-width spaces, nbsp) out of LLM-generated prose before
// it lands in a shipped PDF/.md. Mirrors generate-pdf.mjs's normalizeTextForATS
// pass, applied at the plain-text level (safer than regexing rendered HTML).
function sanitizeAtsText(text) {
  if (!text) return text;
  return text
    .replace(/[\u2014\u2013]/g, '-')                    // em / en dash
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')       // smart double quotes
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")       // smart single quotes
    .replace(/\u2026/g, '...')                          // ellipsis
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')  // zero-width / BOM
    .replace(/\u00A0/g, ' ');                           // non-breaking space
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
          console.error(`[${idx}] ERROR ${items[idx].slug}: ${e.message}`);
        }
      }
    })
  );
  return results;
}

// Parse the front-matter that fetch-jds.mjs writes at the top of every jds/*.md.
// Thin adapter over the shared lib/jd-parse.mjs — preserves this file's field
// names (postedIso/postedDays) so downstream code is unchanged.
//
// `days` is recencyDays(), the same call enqueue makes, and it reads **Updated:**
// as well as **Posted:**. This file used to derive age from posted_at alone,
// which is a different question from the one the card gate asks: measured
// 2026-08-10, 8 roles were 6-12 days old to enqueue and 31-34 days old here,
// four of them GitLab reqs the employer had edited that week. Matching the
// windows would not have reached any of them — only matching the measurement does.
function parseJdMeta(jdContent) {
  const jd = parseJd(jdContent);
  return {
    title: jd.title, url: jd.url, company: jd.company,
    postedIso: jd.posted_at, postedDays: jd.posted_days,
    days: recencyDays(jd),
  };
}

async function loadCandidates() {
  // rank-leads.mjs is the single scoring authority. Its cache is keyed by JD
  // filename → { score, verdict, ... }. Join it to the live jds/*.md files so
  // freshness is recomputed against today (not frozen at scoring time).
  let scores;
  try {
    scores = JSON.parse(await readFile(SCORES_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`Cannot read scores at ${SCORES_PATH} (run rank-leads.mjs first): ${e.message}`);
  }

  const out = [];
  for (const [filename, rec] of Object.entries(scores)) {
    const score = Number(rec?.score) || 0;
    if (score < MIN_SCORE) continue;              // tier gate up front — skip cheaply

    const jdPath = path.join(JDS_DIR, filename);
    let jdContent = '';
    try { jdContent = await readFile(jdPath, 'utf-8'); }
    catch { continue; }                           // JD pruned/gone → drop silently
    const meta = parseJdMeta(jdContent);

    const days = meta.days;

    out.push({
      reportFile: filename,
      jdPath,
      jdContent,
      url: meta.url,
      company: meta.company,
      role: meta.title,
      score,
      days,
      verdict: rec?.verdict || '',
      // Needed by the age filter below: the window is per-track AND per-employer
      // (teaching 150, whale 30, evergreen 7, everything else 21), so the filter
      // needs both of these carried through. Without the track it silently fell
      // back to the flat cap for every track, which is how the teaching band
      // broke the first time.
      track: rec?.track || 'pm',
      slug: slugify(`${meta.company}-${meta.title}`),
    });
  }

  // Dedup by company+title — the same posting can appear under several JD
  // filenames / URL variants (e.g. two Harvey "Staff PM, Vault" listings that
  // slugify identically). Keep the highest score, then the freshest. Mirrors
  // rank-leads.mjs's inbox dedup so staging never double-generates or races on
  // one output dir (was a latent bug at MAX_CONCURRENT>1).
  const best = new Map();
  for (const r of out) {
    const key = canonKey(r.company, r.role);
    const cur = best.get(key);
    if (!cur || r.score > cur.score || (r.score === cur.score && (r.days ?? 999) < (cur.days ?? 999))) {
      best.set(key, r);
    }
  }
  // THE INVARIANT: anything enqueue-review can card, this step can build. Same
  // policy object, same numbers, one definition — so a role can no longer pass
  // the card gate and fail the pack gate, which is the state that puts it in
  // data/held-no-pack.md with a remedy that cannot work.
  const freshness = await loadFreshnessPolicy(ROOT);
  return [...best.values()].filter(r => r.days != null && r.days <= freshness.maxAgeDaysFor(r));
}

async function callGeminiWithRetry(prompt, maxAttempts = 6) {
  let attempt = 0;
  while (true) {
    try {
      const r = await model.generateContent(prompt);
      return r.response.text().trim();
    } catch (e) {
      attempt++;
      const msg = String(e?.message || e);
      const retryMatch = msg.match(/retry in ([\d.]+)s/);
      const wait = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : Math.min(60, 5 * Math.pow(2, attempt));
      if (!/429|Too Many Requests|quota|RetryInfo/i.test(msg) || attempt >= maxAttempts) throw e;
      console.log(`  rate-limited, sleeping ${wait}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
}

// Is a cover letter actually wanted? VP's rule (MISSION-nyc-job.md, 2026-07-29):
// "If the cover letter is optional, do not submit one at all. If it is required,
// keep it short and specific to that role." Staging ignored that and wrote a
// Gemini letter for every pack - work he will not send, on a free-tier quota of
// 5 requests a minute.
//
// Greenhouse is authoritative and free: ?questions=true returns every field with
// a `required` flag.
//
// ⚠ UNKNOWN NO LONGER GETS A LETTER (changed 2026-08-06). This used to say
// "unknown still gets a letter, because losing one he needed is worse than
// writing one he did not" - which was me overriding a rule VP had stated and
// writing the justification into the source. His rule, recorded verbatim: "If
// the cover letter is optional, do not submit one. Not a short one, not a good
// one. None."
//
// The result of the override, counted on 2026-08-06: 275 cover letters on disk
// against 29 skips, and across 108 queue cards the coverLetter field reads
// absent 20, optional 9, unknown 79 - and ZERO required. Every one of those 275
// was work VP did not ask for, on a free-tier quota of 5 requests a minute, and
// six of them render a literal [Date] into the PDF.
//
// A default of "write it anyway" also removed the incentive to detect properly.
//
// ⚠ THE DETECTION ITSELF NOW LIVES IN lib/cover-letter-requirement.mjs (moved
// 2026-08-11). What used to be here read exactly one ATS and said "could not be
// determined for this ATS" about everything else — 72 of 104 pending cards.
// A third of those were Greenhouse roles the board API answers on request; the
// function was simply handed the wrong URL, because loadCandidates() dedups
// across jds/*.md and can keep the Indeed variant of a role whose review card
// holds the real board link. It also never looked at the form generate-answers
// had already enumerated for the same pack, nor at the JD, where NYC's civic
// postings state the requirement in plain English ("Applications submitted
// without a cover letter will not be considered"). The full incident, and the
// evidence rules that keep this honest, are in that file's header.
async function coverLetterRequirement(c, dir) {
  return resolveCoverLetterRequirement({
    url: c.url,
    // Staging's URL and the card's apply URL are not always the same link to the
    // same requisition, and only one of them may be answerable.
    cardUrl: cardUrlFor(c),
    jdText: c.jdContent || '',
    formEvidence: await loadPackFormEvidence(dir),
    greenhouseRef,
  });
}

// The review queue is the only place the resolved ATS apply URL is recorded, and
// staging runs before enqueue — so on a role's first night there is no card yet
// and this returns null, which is fine. From the second night on it is the
// better of the two URLs.
let REVIEW_CARDS = null;
async function loadReviewCards() {
  if (REVIEW_CARDS) return REVIEW_CARDS;
  REVIEW_CARDS = new Map();
  try {
    const q = JSON.parse(await readFile(path.join(ROOT, 'data', 'review-queue.json'), 'utf-8'));
    for (const it of q.items || []) {
      const u = it.applyUrl || it.sourceUrl;
      if (it.slug && u) REVIEW_CARDS.set(it.slug, u);
    }
  } catch {}
  return REVIEW_CARDS;
}
function cardUrlFor(c) {
  return (REVIEW_CARDS && REVIEW_CARDS.get(c.slug)) || null;
}

async function generateCoverLetter(candidate, profile, cv, profileOverrides) {
  const prompt = `You are writing a one-page cover letter for Vitor Pontual applying to a job.
Constraints:
- Cite SPECIFIC details from the job description (mission, product, team).
- Cite SPECIFIC achievements from Vitor's CV with numbers (e.g., $15M Series A, scaled 20→100+ brands).
- Open with a hook that reflects his unique combination: PM who builds his own AI infra (homelab: Proxmox, k3s, Ollama fleet).
- 280-380 words. Three paragraphs max.
- No corporate filler. No "passionate about", "leveraged", "spearheaded", "results-oriented", "synergies".
- US English. Plain text. No markdown, no headers, no bullets.
- Address to "Hiring Team at <Company>" if no specific name is in the JD.
- Sign off with "— Vitor Pontual".
- Do NOT invent companies, customers, or metrics that aren't in the CV. Stay strictly factual.

=== Candidate Profile (config/profile.yml) ===
${profile.slice(0, 4000)}

=== Candidate CV (cv.md) ===
${cv}

=== Candidate scoring rules / framing (modes/_profile.md, optional context) ===
${profileOverrides.slice(0, 2500)}

=== Job Description ===
Company: ${candidate.company}
Role: ${candidate.role}
URL: ${candidate.url}
Scored ${candidate.score}/5 by Claude against Vitor's rules.

JD body:
${candidate.jdContent.slice(0, 8000)}

Now write the cover letter.`;

  return callGeminiWithRetry(prompt);
}

async function renderPdf(html, outPath, browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: outPath,
    format: 'Letter',
    margin: { top: '0.5in', bottom: '0.5in', left: '0.6in', right: '0.6in' },
    printBackground: true
  });
  await ctx.close();
}

// htmlForCv / htmlForCoverLetter now live in the shared lib/render.mjs.

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const profile = await readFile(PROFILE_PATH, 'utf-8');
  const cv = await readFile(CV_PATH, 'utf-8');
  // Fact-check source of truth + optional allow/forbid config for cover letters.
  const factSource = `${cv}\n${profile}`;
  let cvFacts = { allow_metrics: [], forbidden_phrases: [] };
  try { cvFacts = JSON.parse(await readFile(path.join(ROOT, 'config', 'cv-facts.json'), 'utf-8')); } catch {}
  let profileOverrides = '';
  try { profileOverrides = await readFile(PROFILE_OVERRIDES, 'utf-8'); } catch {}

  let candidates = await loadCandidates();

  // --slug a,b,c — run the chain for named packs only. There was no way to
  // exercise staging against a handful of real roles: the only options were the
  // full 335-candidate set (a browser liveness probe per role, then Gemini at 5
  // requests a minute) or nothing, so every change to this file was verified by
  // reading it. A change to what goes onto a live application deserves better.
  const slugArg = (() => { const i = process.argv.indexOf('--slug'); return i >= 0 ? process.argv[i + 1] : null; })();
  if (slugArg) {
    const want = new Set(slugArg.split(',').map(s => s.trim()).filter(Boolean));
    const before = candidates.length;
    candidates = candidates.filter(c => want.has(c.slug));
    console.log(`--slug: ${candidates.length} of ${before} candidate(s) selected`);
    for (const s of want) if (!candidates.some(c => c.slug === s)) console.log(`  ⚠ not a current candidate: ${s}`);
  }
  console.log(`\nstage-applications: score>=${MIN_SCORE}, freshness per lib/freshness.mjs `
    + `(<=${FRESH_MAX_AGE_DAYS}d, whales <=${WHALE_MAX_AGE_DAYS}d, evergreen <=${EVERGREEN_MAX_AGE_DAYS}d, `
    + `teaching <=${TEACHING_MAX_AGE_DAYS}d) → ${candidates.length} candidates\n`);

  // --list / --dry-run: show what WOULD be staged and exit (no Gemini, no PDFs).
  if (process.argv.includes('--list') || process.argv.includes('--dry-run')) {
    for (const c of candidates.sort((a, b) => b.score - a.score || (a.days ?? 999) - (b.days ?? 999))) {
      console.log(`  [${c.score}] ${c.days ?? '?'}d  ${c.company} | ${c.role}  → output/${c.slug}/`);
    }
    console.log('\n(dry run — nothing generated)');
    return;
  }

  if (!candidates.length) {
    console.log('Nothing to stage.');
    return;
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // Liveness prune — skip only CONFIDENTLY expired roles (HTTP error, expired
  // redirect, hard "posting closed" copy) before spending Gemini calls. Never
  // drop 'uncertain'/'active', nor a role we simply couldn't reach (transient
  // network blips) — those keep flowing through to staging.
  const liveCandidates = [];
  {
    const probe = await browser.newPage();
    for (const c of candidates) {          // sequential — never Playwright in parallel
      if (!c.url) { liveCandidates.push(c); continue; }
      try {
        const { result, reason } = await checkUrl(probe, c.url);
        if (result === 'expired') {
          console.log(`  prune (expired): ${c.company} | ${c.role} — ${reason}`);
          continue;
        }
      } catch { /* unreachable right now → keep, don't silently drop */ }
      liveCandidates.push(c);
    }
    await probe.close();
  }
  console.log(`Liveness: ${liveCandidates.length}/${candidates.length} still live\n`);
  if (!liveCandidates.length) {
    console.log('Nothing live to stage.');
    await browser.close();
    return;
  }

  // Render the CV PDF once (no per-JD tailoring in v1)
  const sharedCvPdf = path.join(OUTPUT_DIR, 'cv.pdf');
  console.log(`Rendering shared CV PDF → ${sharedCvPdf}`);
  await renderPdf(renderCvHtml(cv), sharedCvPdf, browser);

  // ONE cover-letter generator, used by both the first-staging path and the
  // revisit path below. There is deliberately no second one: the fact check, the
  // sanitiser and the PDF render are part of producing a letter, and a second
  // copy of this is how a letter ships without one of them.
  async function produceCoverLetter(c, dir, finding, idx) {
    const letterText = sanitizeAtsText(await generateCoverLetter(c, profile, cv, profileOverrides));

    // Fact check: flag metric-like claims in the letter that aren't in cv.md/
    // profile.yml (Gemini invention guard, zero extra LLM calls). Warn, don't
    // block — a human reviews every letter before submitting.
    // The JD is passed as context so a number the letter QUOTES from the
    // employer's own posting is not reported as a hallucinated metric. Measured
    // 2026-08-06: the checker fired on 109 of 275 letters and every one I opened
    // was either that, or the "100 brands" phrasing mismatch against cv.md. A
    // gate that is wrong 40% of the time is one VP learns to skip.
    const fc = checkFacts(letterText, factSource, cvFacts, { jdText: c.jdContent || c.body || '' });
    let factNote = '';
    if (fc.quoted?.length) {
      console.log(`  [${idx}] fact check: ${fc.quoted.length} figure(s) quoted from the posting (not flagged)`);
    }
    if (!fc.ok) {
      const bits = [...fc.invented.map(m => `unverified metric "${m}"`), ...fc.forbidden.map(p => `forbidden phrase "${p}"`)];
      factNote = `\n> ⚠ **FACT CHECK — review before sending:** ${bits.join('; ')}\n`;
      console.log(`  [${idx}] ⚠ fact check: ${bits.join('; ')}`);
    }
    // The letter records WHY it exists. "Cover letter field: required" was a
    // claim with nothing behind it; this quotes the observation instead, so VP
    // can check the requirement without re-opening the posting.
    await writeFile(path.join(dir, 'cover-letter.md'),
      `# Cover letter — ${c.company}: ${c.role}\n\n**URL:** ${c.url}\n`
      + `**Generated:** ${new Date().toISOString()}\n**Days old at staging:** ${c.days}\n`
      + `**Score:** ${c.score}\n**Cover letter is required — determined from:** ${finding.evidence}`
      + `${finding.observedOn ? ` (observed ${finding.observedOn})` : ''}\n${factNote}\n---\n\n${letterText}\n`);
    await renderPdf(renderCoverLetterHtml(letterText, profile, `Re: ${c.role} - ${c.company}`),
      path.join(dir, 'cover-letter.pdf'), browser);
  }

  // A pack that is already staged but whose cover-letter question was never
  // ANSWERED gets asked again, with whatever evidence exists tonight. This is
  // cheap: no Gemini call unless the answer turns out to be 'required', and at
  // most one Greenhouse API request. A pack whose finding is already settled is
  // left completely alone — including the ones VP has letters for.
  // The marker VP reads must agree with the finding beside it. Cheap and
  // network-free, so it runs even for a pack whose answer is already settled:
  // 98 of the markers on disk came from the 2026-08-06 retraction pass and say
  // "could not be determined for this ATS" about packs that ARE determined.
  async function syncMarker(c, dir, finding, hasLetter) {
    const p = path.join(dir, 'cover-letter-skipped.md');
    if (finding.value === 'required') {
      if (!hasLetter) return false;
      try { await unlink(p); return true; } catch { return false; }
    }
    const want = renderSkipMarkdown({ company: c.company, role: c.role, url: c.url, finding, existingLetter: hasLetter });
    let have = null;
    try { have = await readFile(p, 'utf-8'); } catch {}
    if (have === want) return false;
    await writeFile(p, want);
    return true;
  }

  async function revisitCoverLetter(c, dir, idx) {
    const prior = await readCoverLetterFinding(dir);
    let hasLetter = false;
    try { await stat(path.join(dir, 'cover-letter.md')); hasLetter = true; } catch {}

    if (prior && prior.value !== 'unknown') {
      // Settled. No network, no Gemini — but keep the prose honest.
      const fixed = await syncMarker(c, dir, prior, hasLetter);
      return fixed ? `cover-letter marker corrected to "${prior.value}" (${prior.source})` : null;
    }

    const finding = await coverLetterRequirement(c, dir);
    await writeCoverLetterFinding(dir, finding);

    if (finding.value === 'required' && !hasLetter) {
      console.log(`[${idx}] cover letter now REQUIRED (${finding.source}) for ${c.company} | ${c.role}`);
      await produceCoverLetter(c, dir, finding, idx);
      try { await unlink(path.join(dir, 'cover-letter-skipped.md')); } catch {}
      return `cover letter GENERATED — required per ${finding.source}`;
    }
    if (finding.value === 'required') {
      await syncMarker(c, dir, finding, hasLetter);
      return `cover letter: required (${finding.source}) — one already exists, left as is`;
    }

    await syncMarker(c, dir, finding, hasLetter);
    if (finding.value === 'unknown') return null;
    return hasLetter
      ? `cover letter: ${finding.value} (${finding.source}) — a letter exists; VP's rule says do not send it`
      : `cover letter: ${finding.value} (${finding.source}), was undetermined`;
  }

  await loadReviewCards();

  let staged = 0;
  const results = await pLimit(liveCandidates, MAX_CONCURRENT, async (c, idx) => {
    const dir = path.join(OUTPUT_DIR, c.slug);
    await mkdir(dir, { recursive: true });

    // Record WHAT THIS PACK IS FOR, so enqueue-review can tell a pack it just
    // built for this same role from a different role that happens to slugify
    // identically. Without it, enqueue treated every existing output/ directory
    // as a name collision - including the one staged minutes earlier in the same
    // nightly run - and minted the card as <slug>-2 pointing at an empty
    // directory while the CV sat in <slug>. 8 of 9 pending cards were in that
    // state on 2026-08-06 and every file link on them 404'd.
    await writeFile(path.join(dir, 'pack-meta.json'), JSON.stringify({
      company: c.company,
      role: c.role,
      canonKey: canonKey(c.company, c.role),
      url: c.url ?? null,
      scoreSource: c.file ?? null,
      stagedAt: new Date().toISOString(),
    }, null, 2));

    // Skip if already staged (rerun-friendly)
    // A pack that correctly has NO cover letter must still count as staged, or it
    // is regenerated every single night and the skip never fires.
    const coverMdPath = path.join(dir, 'cover-letter.md');
    const coverSkipPath = path.join(dir, 'cover-letter-skipped.md');
    let already = false;
    for (const p of [coverMdPath, coverSkipPath]) {
      try { await stat(p); already = true; break; } catch {}
    }

    // ⚠ A PACK WITHOUT A CV IS NOT STAGED, whatever markers it carries.
    //
    // This tested only for a cover letter or a skip marker, and the CV is
    // rendered LAST — so any failure between the two (a Gemini quota trip is the
    // common one, on a free tier of 5 requests a minute) left a directory
    // holding cover-letter-skipped.md and no cv.pdf. Every subsequent run then
    // said "SKIP (already staged)" and the CV was never rendered. With the CV
    // gate added 2026-08-06 that is now permanent invisibility: no CV means
    // enqueue holds the role, and staging refuses to fix it.
    //
    // Caught on the first full unattended run: Innovid, Chainguard, Amazon,
    // Scale AI and GitLab were all stuck in exactly this state, and re-running
    // staging could not recover them.
    if (already) {
      try { await stat(path.join(dir, 'cv.pdf')); }
      catch {
        already = false;
        console.log(`[${idx}] RESTAGING — has a cover-letter marker but no cv.pdf: ${c.slug}`);
      }
    }

    if (already) {
      // ⚠ NOT A NO-OP ANY MORE (2026-08-11). "Already staged" used to end the
      // role's night, which meant the cover-letter question was answered ONCE,
      // on the pack's first night — before generate-answers had ever enumerated
      // the form, and therefore with the least evidence this pipeline will ever
      // have about that role. The answer was 'unknown' 72 times out of 104 and
      // could never be revisited, so a pack that became determinable on night two
      // stayed "could not be determined" forever.
      const note = await revisitCoverLetter(c, dir, idx);
      console.log(`[${idx}] SKIP (already staged): ${c.slug}${note ? ` — ${note}` : ''}`);
      staged++;
      return;
    }

    const finding = await coverLetterRequirement(c, dir);
    await writeCoverLetterFinding(dir, finding);
    if (finding.value !== 'required') {
      // Record the finding so the review card can say so, and move on. No Gemini
      // call, no PDF, nothing for VP to read and discard.
      await writeFile(path.join(dir, 'cover-letter-skipped.md'),
        renderSkipMarkdown({ company: c.company, role: c.role, url: c.url, finding }));
      console.log(`[${idx}] no cover letter needed (${finding.value}, from ${finding.source}): ${c.company} | ${c.role}`);
    } else {
      console.log(`[${idx}] generating cover letter (required, from ${finding.source}) for ${c.company} | ${c.role} (${c.days}d, score ${c.score})`);
      await produceCoverLetter(c, dir, finding, idx);
    }

    // Per-role tailored CV: classify the JD's archetype (tailor-cv.mjs) and render
    // the matching cv-variants/cv-{variant}.md into this packet instead of copying
    // the generic CV. Falls back to cv.md if the variant file is missing.
    const variant = classifyArchetype(c.jdContent || '');
    // NEVER fall back to cv.md: it is the truth SUPERSET, runs 3 pages (failing
    // batch/cv-pages.py) and carries internal guard comments. Fall back to the
    // AI-product variant, which is a real submittable document.
    let cvMd = cv, variantUsed = 'cv.md';
    try { cvMd = await readFile(path.join(VARIANTS_DIR, 'cv-ai-product.md'), 'utf-8'); variantUsed = 'ai-product'; } catch {}
    try { cvMd = await readFile(path.join(VARIANTS_DIR, `cv-${variant}.md`), 'utf-8'); variantUsed = variant; } catch {}
    await renderPdf(renderCvHtml(cvMd), path.join(dir, 'cv.pdf'), browser);
    await writeFile(path.join(dir, 'cv-variant.txt'), variantUsed + '\n');
    console.log(`  [${idx}] CV variant: ${variantUsed}`);

    staged++;
    console.log(`[${idx}] staged: ${dir}`);
  });

  await browser.close();
  const failed = results.filter(r => r && r.error).length;
  console.log(`\nDone. staged=${staged} failed=${failed}`);
  console.log(`\nReview: ls -la ${OUTPUT_DIR}/`);
}

main().catch(e => { console.error(e); process.exit(1); });
