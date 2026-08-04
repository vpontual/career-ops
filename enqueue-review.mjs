#!/usr/bin/env node

/**
 * enqueue-review.mjs — carry what the scorer found into the review queue.
 *
 * This is the step that was missing. `rank-leads` scored faithfully every night
 * and `review-queue.json` was written by hand, so between 2026-07-31 and
 * 2026-08-04 tier 5 went 44 → 50 and tier 4 went 76 → 93 and VP saw none of it.
 * A role that is scored but not enqueued is invisible, and invisible is the same
 * as not found.
 *
 * What earns a card: tier >= MIN_SCORE, a geography VP can actually work in,
 * posted within MAX_AGE_DAYS, not blacklisted, and not already in the queue
 * under any decision.
 *
 * That last clause is the one that matters. Matching on the canonical
 * company+title key rather than the slug means a role VP already REJECTED does
 * not reappear tomorrow under an Indeed-flavoured filename - which is exactly
 * how an auto-enqueue turns into noise and stops being read.
 *
 * Scores are read live from lead-scores.json on every run, never copied and
 * frozen. The 07-31 batch froze its scores mid-debug and by 08-04 six of them
 * were wrong in VP's favour, which is the worst direction for them to be wrong.
 *
 * Usage: node enqueue-review.mjs [--dry-run] [--min-score N] [--max-age N]
 */

import { readFile, writeFile, readdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canonKey } from './lib/canonical.mjs';
import { detectTrack } from './lib/track.mjs';
import { classifyArchetype } from './tailor-cv.mjs';
import { parseBlacklist, blacklistEntry } from './blacklist.mjs';
import { canonicalizeUrl } from './lib/url-canonical.mjs';
import { parseJd } from './lib/jd-parse.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JDS_DIR = path.join(ROOT, 'jds');
const SCORES = path.join(ROOT, 'data', 'lead-scores.json');
const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const BLACKLIST = path.join(ROOT, 'data', 'blacklist.md');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const argN = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const MIN_SCORE = argN('--min-score', Number(process.env.MIN_SCORE || 4));
const MAX_AGE_DAYS = argN('--max-age', Number(process.env.MAX_AGE_DAYS || 30));
// Must agree with rank-leads' TEACHING_MAX_AGE_DAYS or the scorer admits a
// school-year requisition and this immediately drops it again as stale.
const TEACHING_MAX_AGE_DAYS = Number(process.env.TEACHING_MAX_AGE_DAYS || 150);

// The three modes VP can actually work in. `unclear` is deliberately excluded:
// the mission's standing rule is to flag an undetermined location rather than
// spend a review slot on it.
const GEO_OK = new Set(['nyc', 'remote-us', 'hybrid-nyc']);

// Aggregator pages. You cannot fill in an Indeed viewjob link - there is no form
// on it - so a card pointing at one is a card VP cannot action, which is the
// failure this whole step exists to end. The first run of this script enqueued
// 117 roles and 99 of them pointed here.
const NOT_A_FORM = /(^|\.)(indeed\.com|glassdoor\.com|linkedin\.com|ziprecruiter\.com|lensa\.com|jobot\.com)$/i;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function isApplyable(url) {
  const h = hostOf(url);
  return !!h && !NOT_A_FORM.test(h);
}

// Which CV goes out. Use tailor-cv.mjs's own classifier - it is the thing that
// actually renders the PDF, and it is exported for exactly this reason.
//
// The hand-rolled version this replaces invented a variant called 'leadership'
// for any Director/Head title, and a later change forced EVERY Track D card to
// it. cv-variants/cv-leadership.md does not exist and never did, so 22 of 69
// cards pointed at a missing file - and tailor-cv.mjs does not fall back, it
// returns "variant cv-leadership.md not found" and renders nothing. Same lesson
// as the slug and the track: one source of truth, imported, not re-implemented.
function cvVariantFor(jdContent, track) {
  if (track === 'teaching') return 'teaching';
  try {
    return classifyArchetype(jdContent) || 'ai-product';
  } catch {
    return 'ai-product';
  }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function atsOf(url) {
  const u = String(url || '');
  if (/greenhouse\.io/.test(u)) return 'greenhouse';
  if (/ashbyhq\.com/.test(u)) return 'ashby';
  if (/lever\.co/.test(u)) return 'lever';
  if (/amazon\.jobs/.test(u)) return 'amazon';
  if (/olasjobs\.org/.test(u)) return 'olas';
  return 'other';
}

const main = async () => {
  const scores = JSON.parse(await readFile(SCORES, 'utf-8'));
  const queue = JSON.parse(await readFile(QUEUE, 'utf-8'));
  const files = await readdir(JDS_DIR);

  // data/blacklist.md is a markdown TABLE, and this used to parse it as bullets,
  // so it silently matched nothing. Use the project's own parser - it is the only
  // gate that can stop a company already present in lead-scores.json, because
  // rank-leads filters blacklisted companies before scoring and never removes
  // entries scored before the company was blacklisted.
  const blacklist = existsSync(BLACKLIST)
    ? parseBlacklist(await readFile(BLACKLIST, 'utf-8'))
    : [];

  // Every canonical key already represented in the queue, whatever its decision.
  // A rejected role must not come back.
  // Two keys, because one is not enough. canonKey(company, role) breaks the
  // moment a queue card's role text is hand-edited: 4 of the 11 rejected items
  // no longer match their own JD, including "Indeed | Product Manager II
  // (Responsible AI)" whose JD canonicalises to "productmanagerii". A rejected
  // role reappearing is the failure that makes an auto-enqueued queue unreadable,
  // so the apply URL is indexed as well.
  const known = new Map();
  const knownUrls = new Set();
  for (const it of queue.items) {
    known.set(canonKey(it.company || '', it.role || ''), it.decision || 'pending');
    // canonicalizeUrl, NOT a bare query strip. Stripe posts every role at
    // stripe.com/jobs/search?gh_jid=NNNN, so dropping the query string collapsed
    // all of them to one URL and suppressed 366 roles as "already in queue".
    // canonicalizeUrl removes tracking params and keeps identifying ones.
    for (const u of [it.applyUrl, it.sourceUrl]) {
      if (u) knownUrls.add(canonicalizeUrl(String(u)));
    }
  }

  const stats = { scanned: 0, noJd: 0, badCompany: 0, lowScore: 0, geo: 0, stale: 0,
                  blacklisted: 0, already: 0, noApplyPath: 0 };

  // ── Pass 1: every scored JD, grouped by the canonical role it describes ────
  // The same posting arrives from several places - the company's Greenhouse
  // board and an Indeed scrape of it - and the copies disagree. They disagree on
  // the SCORE (Datadog Bits Agent Builder is a 3 from its ATS record and a 5
  // from Indeed) and they disagree on whether there is a form at the other end.
  // Grouping first, then choosing one representative per role, is what makes
  // both answers deterministic instead of a function of iteration order.
  const groups = new Map();

  for (const [file, rec] of Object.entries(scores)) {
    if (!rec || typeof rec !== 'object') continue;
    stats.scanned++;
    if (!files.includes(file)) { stats.noJd++; continue; }

    const jd = parseJd(await readFile(path.join(JDS_DIR, file), 'utf-8'), file);
    const company = (jd.company || '').trim();
    // pandas NaN leaking out of the Indeed fetch as a literal company name.
    if (!company || /^(nan|unknown|none|null)$/i.test(company)) { stats.badCompany++; continue; }

    const key = canonKey(company, jd.title || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      key, file, company,
      score: Number(rec.score),
      days: jd.posted_days,
      role: jd.title || '',
      url: jd.url || '',
      applyable: isApplyable(jd.url),
      jdContent: `${jd.title}\n${jd.body}`.slice(0, 20000),
      track: rec.track || detectTrack(jd),
      geo: rec.geo,
      archetype: rec.archetype || '',
      verdict: rec.verdict || '',
      redFlags: rec.redFlags || '',
      technicalScreen: rec.technicalScreen === true,
      certRequired: rec.certRequired === true,
      cteEligible: rec.cteEligible === true,
      compLow: rec.compLow ?? null,
    });
  }

  // ── Pass 2: one representative per role, then the gates ───────────────────
  const cand = [];
  const unresolved = [];

  for (const [key, variants] of groups) {
    if (known.has(key)) { stats.already++; continue; }
    if (variants.some(v => v.url && knownUrls.has(canonicalizeUrl(String(v.url))))) {
      stats.already++; continue;
    }

    // A real ATS posting always beats an aggregator scrape of it: it is the form
    // VP will actually fill, and its score is computed from the employer's own
    // text rather than Indeed's reformatting of it.
    const applyable = variants.filter(v => v.applyable);
    const pool = applyable.length ? applyable : variants;
    const rep = pool.slice().sort((a, b) =>
      (b.score - a.score) || ((a.days ?? 999) - (b.days ?? 999)))[0];

    if (!applyable.length) {
      // Known only from an aggregator. Recorded, never enqueued - a card with no
      // form behind it cannot be filled, and 99 of those is a queue nobody reads.
      const unresolvedMaxAge = rep.track === 'teaching' ? TEACHING_MAX_AGE_DAYS : MAX_AGE_DAYS;
      if (rep.score >= MIN_SCORE && GEO_OK.has(String(rep.geo || 'unclear')) &&
          rep.days != null && rep.days <= unresolvedMaxAge) {
        unresolved.push(rep);
        stats.noApplyPath++;
      }
      continue;
    }

    if (!(rep.score >= MIN_SCORE)) { stats.lowScore++; continue; }
    // Track D has no geography gate by design. The brief was "few constraints,
    // the important thing is a good path to income" - another country and
    // another currency are the point, not a problem.
    if (rep.track !== 'now' && !GEO_OK.has(String(rep.geo || 'unclear'))) { stats.geo++; continue; }
    const maxAge = rep.track === 'teaching' ? TEACHING_MAX_AGE_DAYS : MAX_AGE_DAYS;
    if (rep.days == null || rep.days > maxAge) { stats.stale++; continue; }
    if (blacklist.length && blacklistEntry(rep.company, blacklist)) { stats.blacklisted++; continue; }

    const conflict = variants.find(v => v !== rep && v.score !== rep.score);
    cand.push({ ...rep, altScore: conflict ? conflict.score : null, altFile: conflict ? conflict.file : null });
  }

  const fresh = cand.sort((a, b) => b.score - a.score || a.days - b.days);

  console.log(`enqueue-review: tier >= ${MIN_SCORE}, geo in {${[...GEO_OK].join(', ')}}, <= ${MAX_AGE_DAYS}d`);
  console.log(`scanned ${stats.scanned} scored JDs → ${groups.size} distinct roles`);
  console.log(`  dropped: ${stats.lowScore} below tier, ${stats.geo} geo, ${stats.stale} stale, ` +
              `${stats.blacklisted} blacklisted, ${stats.already} already in queue,`);
  console.log(`           ${stats.noJd} no JD on disk, ${stats.badCompany} unusable company name, ` +
              `${stats.noApplyPath} aggregator-only (no form to fill)`);
  console.log(`\nNEW CARDS: ${fresh.length}\n`);

  for (const c of fresh) {
    console.log(`  [${c.score}] ${String(c.days).padStart(2)}d  ${c.company} | ${c.role.slice(0, 58)}`);
    console.log(`        ${c.geo} | ${c.archetype}${c.technicalScreen ? ' | ⚠ technical screen' : ''}` +
                `${c.altScore != null ? ` | ⚠ a duplicate scored ${c.altScore}` : ''}`);
  }

  if (unresolved.length) {
    console.log(`\nWOULD QUALIFY BUT HAVE NO APPLY FORM (${unresolved.length}) — aggregator listing only:`);
    for (const u of unresolved.slice(0, 15)) {
      console.log(`  [${u.score}] ${u.company} | ${u.role.slice(0, 55)}`);
    }
    if (unresolved.length > 15) console.log(`  ... and ${unresolved.length - 15} more`);
    console.log('  These need the employer\'s own posting resolved before they can be filled.');
  }

  if (DRY) { console.log('\n--dry-run, queue not written'); return; }

  if (unresolved.length) {
    await writeFile(
      path.join(ROOT, 'data', 'unresolved-apply-paths.md'),
      `# Roles that score well but have no form behind them\n\n` +
      `Written by enqueue-review.mjs on ${new Date().toISOString().slice(0, 10)}. Each of these is\n` +
      `tier ${MIN_SCORE}+, geo-clean and fresh, but is known only from an aggregator listing, so\n` +
      `there is nothing to fill. Resolving the employer's own posting promotes it into the queue.\n\n` +
      unresolved.map(u => `- [ ] [${u.score}] ${u.company} | ${u.role} | ${u.days}d | ${u.url}`).join('\n') + '\n'
    );
    console.log(`\nrecorded ${unresolved.length} unresolved roles in data/unresolved-apply-paths.md`);
  }

  if (!fresh.length) { console.log('nothing new to enqueue'); return; }

  await copyFile(QUEUE, `${QUEUE}.bak-enqueue-${new Date().toISOString().slice(0, 10)}`);

  // output/<slug>/ is a directory, so two roles sharing a slug would share a
  // pack. Indeed lists "Product Manager II" and "Product Manager II
  // (Responsible AI)" at the same employer; both slugify identically.
  // output/ holds 249 directories against 54 queue slugs, so checking the queue
  // alone left 190 invisible: a new card taking one of those names would write
  // into an already-staged application pack.
  const usedSlugs = new Set(queue.items.map(i => i.slug));
  for (const d of await readdir(path.join(ROOT, 'output')).catch(() => [])) usedSlugs.add(d);

  for (const c of fresh) {
    let slug = slugify(`${c.company}-${c.role}`);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);
    const notes = [
      c.verdict ? `SCORER: ${c.verdict}.` : '',
      c.redFlags ? `RED FLAGS: ${c.redFlags}` : '',
      c.compLow ? `Comp floor seen: $${c.compLow.toLocaleString()}.` : '',
      c.technicalScreen
        ? '⚠ SCORER FLAGGED A TECHNICAL SCREEN - confirm the format before VP engages. See the interview-format rule in MISSION-nyc-job.md.'
        : '',
      c.altScore != null
        ? `⚠ SCORE CONFLICT: a duplicate listing of this role (${c.altFile}) scores ${c.altScore}. This card uses the employer's own posting.`
        : '',
      c.certRequired && c.cteEligible
        ? 'CERTIFICATION: the posting asks for NYS certification VP does not hold. Not a blocker for a CTE subject - NYSED Transitional A is nominated BY the hiring district and is the designed route for industry professionals (2 years experience required; he has 15). But the district must agree to nominate, so confirm early.'
        : '',
      'ON ME: Glassdoor and interview-process research not yet done for this role - auto-enqueued from the nightly score.',
    ].filter(Boolean).join(' ');

    queue.items.push({
      slug,
      company: c.company,
      role: c.role,
      sourceUrl: c.url,
      applyUrl: c.url,
      ats: atsOf(c.url),
      score: c.score,
      ageDays: c.days,
      geo: c.geo,
      coverLetter: 'unknown',
      cvVariant: cvVariantFor(c.jdContent || `${c.role}\n${c.company}`, c.track),
      notes,
      decision: null,
      decidedAt: null,
      track: c.track,
      glassdoor: null,
      autoEnqueued: true,
      enqueuedAt: new Date().toISOString().slice(0, 10),
      scoreSource: c.file,
    });
  }

  queue.note = `${queue.note || ''} | auto-enqueued ${fresh.length} on ${new Date().toISOString().slice(0, 10)}`.replace(/^ \| /, '');
  await writeFile(QUEUE, JSON.stringify(queue, null, 2));
  console.log(`\nwrote ${fresh.length} new cards to data/review-queue.json`);
  console.log(`queue now: ${queue.items.filter(i => !i.decision).length} pending, ${queue.items.length} total`);
};

main().catch((e) => { console.error(e); process.exit(1); });
