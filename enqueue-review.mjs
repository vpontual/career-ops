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
import { fileURLToPath, pathToFileURL } from 'url';
import { canonKey } from './lib/canonical.mjs';
import { resolveApplyPath, openCache, DEFAULT_CACHE_PATH } from './lib/apply-url.mjs';
import { loadReposts, repostNote } from './lib/repost.mjs';
import { updateQueue } from './lib/queue-file.mjs';
import { stripOffTrackClaims, cleanNotesForTrack } from './lib/off-track-prose.mjs';
import { detectTrack, TRACK_LABELS } from './lib/track.mjs';
import { cvVariantFor } from './lib/cv-variant.mjs';
import { parseBlacklist, blacklistEntry } from './blacklist.mjs';
import { canonicalizeUrl } from './lib/url-canonical.mjs';
import { parseJd } from './lib/jd-parse.mjs';
import { readCoverLetterFinding } from './lib/cover-letter-requirement.mjs';
import {
  loadFreshnessPolicy,
  recencyDays,
  describeWindows,
} from './lib/freshness.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JDS_DIR = path.join(ROOT, 'jds');
const SCORES = path.join(ROOT, 'data', 'lead-scores.json');
const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const BLACKLIST = path.join(ROOT, 'data', 'blacklist.md');
// prune-stale.mjs's ledger of rows it took off the board, with the reason. The
// only PERSISTED record anywhere of a requisition observed dead - nightly-report
// classifies liveness in memory and writes nothing back to the card.
const ARCHIVE = path.join(ROOT, 'data', 'pipeline-archive.md');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const argN = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const MIN_SCORE = argN('--min-score', Number(process.env.MIN_SCORE || 4));
const MAX_AGE_DAYS = argN('--max-age', Number(process.env.MAX_AGE_DAYS || 30));
// FRESHNESS lives in lib/freshness.mjs, with the survival-curve measurement
// that produced it. It is shared, not copied, because this file and
// stage-applications.mjs applied two different versions of it for four days:
// this one carded a role at 21 days, staging built the pack it needs at 14, and
// everything in between became a permanent resident of data/held-no-pack.md.
// See the header of lib/freshness.mjs for the whole incident.

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
// MOVED to lib/cv-variant.mjs — rank-leads.mjs needs the same answer at
// scoring time, and a second copy of this function is exactly what the comment
// above is about. Imported at the top of this file.

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

/**
 * Decide which slug a new card should take. Pure, so it can be tested - the bug
 * this replaces was a one-line collision guard that nothing exercised.
 *
 * Rules, in order of authority:
 *   1. A slug already held by a CARD is never reused.
 *   2. A free name is taken.
 *   3. A DIRECTORY alone is not a conflict. It is this role's pack when its
 *      pack-meta.json canonKey matches, and adoptable when it carries no marker
 *      at all (every pack staged before pack-meta.json existed) - that is the
 *      orphan case that produced 25 dead `-N` cards.
 *   4. Only a directory marked as a DIFFERENT role pushes to the next suffix.
 *
 * @param {{base:string, canon:string, claimedByCard:Set<string>,
 *          outputDirs:Set<string>, packKeys:Map<string,string|null>}} o
 */
export function chooseSlug({ base, canon, claimedByCard, outputDirs, packKeys }) {
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (claimedByCard.has(slug)) continue;
    if (!outputDirs.has(slug)) return slug;
    const key = packKeys.get(slug) ?? null;
    if (key === null || key === canon) return slug;
  }
  return `${base}-${Date.now()}`;   // pathological; never seen, but never loop forever
}

// ── Expiry and revival ─────────────────────────────────────────────────────
//
// The queue was a RATCHET. `ageDays` was written once at mint, and the re-gate
// in main() re-checked score and geo from lead-scores.json every night but
// never recency - so from 2026-08-13 to 2026-09-02 not one undecided card left
// the queue except by VP's click. Measured on the 277 pending cards that
// morning: the badge trailed reality by a median 19 days (p90 26, max 28); 131
// were past the window that would have refused to MINT them, 58 over 30 days;
// the first cards on the page were minted 5-6 August and read "1d". VP's own
// rule (lib/freshness.mjs) was applied at mint and at staging and then never
// again.
//
// Rules, in order of authority:
//
//   1. A DECISION IS VP'S RECORD. Only a card with NO decision can expire, and
//      only `expired` can be revived. approved / rejected / hold are never
//      touched: the reasoning on a rejection is the most useful thing about it
//      later, and the record is what stops a role being re-added by a scan.
//   2. FAILING TO OBSERVE IS NOT A VERDICT. No JD on disk, an unparseable JD, a
//      posting with no date at all: the card is left exactly as it is, badge
//      included. Recording a failure to observe as a fact about the data is
//      this repo's most expensive recurring bug (check-liveness.mjs's header,
//      test-liveness-verdict.mjs, prune-stale.mjs all exist because of it), and
//      a missing JD must never expire a live role.
//   3. THE WINDOW IS lib/freshness.mjs's - per track AND per employer (whale,
//      evergreen) - passed in by the caller. There is no copy of it here.
//   4. FRESH EVIDENCE BEATS A DEATH RECORD, as long as it comes from a posting
//      the record does not cover. The caller discards evidence from any URL
//      prune-stale has already seen die BEFORE it is weighed; that is what stops
//      a card expiring one night on the death record and reviving the next on
//      the same dead req's JD, for ever.
//   5. EXPIRY IS REVERSIBLE and nothing is deleted. The UI's `clear` un-decides
//      an expired card exactly as it un-decides an approval; the card is then
//      pending again and subject to the same rule on the next run.
//
// Pure, so test-queue-expiry.mjs can exercise every branch without a queue.

// prune-stale.mjs's reasons that are a POSITIVE observation of death: the ATS
// API said the req is gone, or a browser read the page and it said so (a
// navigation error is never written as `page:` - see prune-stale). `age Nd`,
// `no JD after Nd` and `not a posting` are NOT death and are excluded.
export const POSITIVE_DEATH = /^(ats: req gone|page: )/;

/**
 * URLs prune-stale has recorded as dead, from the text of data/pipeline-archive.md.
 * @param {string} text
 * @returns {Map<string,string>} canonical URL -> reason, e.g. "ats: req gone (pipeline-archive 2026-08-06)"
 */
export function knownDeadFromArchive(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^- (\d{4}-\d{2}-\d{2}) \| ([^|]+?) \| (\S+) \|/.exec(line);
    if (!m) continue;
    const reason = m[2].trim();
    if (!POSITIVE_DEATH.test(reason)) continue;
    out.set(canonicalizeUrl(m[3]), `${reason} (pipeline-archive ${m[1]})`);
  }
  return out;
}

/**
 * What should happen to this card, given what could be observed about it.
 *
 * @param {object} card   a review-queue item (decision, track, company, notes, ...)
 * @param {{ageDays:number, postedAt?:string|null, updatedAt?:string|null}|null} obs
 *        the LIVE recency, or null when nothing could be observed
 * @param {{maxAgeDays:number, now:string, deadReason?:string, relistNote?:string}} o
 *        maxAgeDays from lib/freshness.mjs's maxAgeDaysFor(card); now = ISO
 *        timestamp; deadReason = the archive's reason when the card's own URL
 *        is known dead; relistNote = lib/repost.mjs's repostNote() or ''.
 * @returns {{action:'none'|'refresh'|'expire'|'revive', expects:string|null, patch?:object, why?:string}}
 *        `expects` is the decision the card had when this was decided; the
 *        writer applies the patch only if the live card still carries it.
 */
export function decideExpiry(card, obs, { maxAgeDays, now, deadReason = '', relistNote = '' }) {
  const expects = card.decision ?? null;
  if (expects !== null && expects !== 'expired') return { action: 'none', expects, why: 'decided' };
  if (!Number.isFinite(maxAgeDays)) return { action: 'none', expects, why: 'no window' };

  const observed = !!obs && Number.isFinite(obs.ageDays);
  const fresh = observed && obs.ageDays <= maxAgeDays;
  const today = String(now).slice(0, 10);
  const age = observed
    ? { ageDays: obs.ageDays, postedAt: obs.postedAt ?? null, updatedAt: obs.updatedAt ?? null }
    : {};
  const differs = (patch) => Object.entries(patch).some(([k, v]) => (card[k] ?? null) !== (v ?? null));

  if (expects === 'expired') {
    if (!fresh) {
      // Still past its window, or unobservable: stays expired. The badge is
      // kept honest when it can be.
      return differs(age)
        ? { action: 'refresh', expects, patch: age, why: 'expired, age corrected' }
        : { action: 'none', expects, why: observed ? 'still past window' : 'unobserved' };
    }
    const was = `was expired ${String(card.decidedAt || '').slice(0, 10) || 'earlier'}`
      + (card.expiredWhy ? ` (${card.expiredWhy})` : '');
    // repost.mjs's note when scan-history saw the relist; otherwise the recency
    // itself is the evidence - the employer touched the requisition.
    const note = relistNote
      || `↻ RELISTED: the employer touched this requisition after it expired here — it is ${obs.ageDays}d old again, inside its ${maxAgeDays}d window.`;
    return {
      action: 'revive', expects,
      why: `${obs.ageDays}d <= ${maxAgeDays}d; ${was}`,
      patch: {
        ...age,
        decision: null, decidedAt: null, expiredWhy: null, revivedAt: today,
        notes: `${note} Revived ${today}; ${was}. ${card.notes || ''}`.trim(),
      },
    };
  }

  // Pending.
  if (fresh) {
    // A cleared card keeps its old expiredWhy (the UI's clear touches only
    // decision/decidedAt); a fresh pending card should not wear a stale one.
    const patch = { ...age, ...(card.expiredWhy ? { expiredWhy: null } : {}) };
    return differs(patch)
      ? { action: 'refresh', expects, patch, why: 'age corrected' }
      : { action: 'none', expects, why: 'fresh' };
  }
  if (deadReason) {
    const why = `known dead: ${deadReason}`;
    return { action: 'expire', expects, why,
             patch: { ...age, decision: 'expired', decidedAt: now, expiredWhy: why } };
  }
  if (observed) {
    const why = `${obs.ageDays}d old, past the ${maxAgeDays}d window for ${card.track || 'this track'}`;
    return { action: 'expire', expects, why,
             patch: { ...age, decision: 'expired', decidedAt: now, expiredWhy: why } };
  }
  return { action: 'none', expects, why: 'unobserved' };
}

/**
 * Apply a decision to the LIVE card inside the updateQueue callback. Refuses
 * when VP decided the card between the read at the top of the run and the
 * locked re-read here - his click wins, always.
 * @returns {boolean} whether the patch was applied
 */
export function applyExpiryDecision(live, d) {
  if (!live || !d || d.action === 'none' || !d.patch) return false;
  if ((live.decision ?? null) !== d.expects) return false;
  Object.assign(live, d.patch);
  return true;
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
  // config/whales.yml and data/employer-closure.json are read live inside the
  // policy so VP can edit the first and re-measure the second without a deploy.
  // --max-age overrides the WHALE window only, which is what it has always
  // meant here; the ordinary window is FRESH_MAX_AGE_DAYS.
  const freshness = await loadFreshnessPolicy(ROOT, { whaleMaxAgeDays: MAX_AGE_DAYS });
  const reposts = loadReposts(path.join(ROOT, 'data', 'scan-history.tsv'));

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
  // ── Re-gate the cards already sitting in the queue ───────────────────────
  // This file's header promises "scores are read live from lead-scores.json on
  // every run, never copied and frozen", and records that the 07-31 batch froze
  // its scores and by 08-04 six were wrong IN VP'S FAVOUR - "the worst direction
  // for them to be wrong". That was fixed for cards being WRITTEN and never
  // applied to cards already written: pass 2 below skips any known key outright,
  // so a card minted before a scoring fix keeps its old number forever.
  //
  // Live proof, 2026-08-10: Wellhub "Staff Product Manager" sat in front of VP at
  // 5.0 / geo remote-us. Its record reads geoRaw "Brazil (Remote)", which
  // normalizeGeo resolves to onsite-elsewhere and scoreFromFacts hard-gates to 1.
  // The model had even written redFlags "Location restriction: Brazil only.
  // Candidate is in the US." Every part of the system knew except the card.
  //
  // Only PENDING cards are touched. A decided card is VP's record and is never
  // rewritten - and the pull is deliberately one-directional: a card can be
  // retired when it no longer qualifies, but nothing here promotes or re-scores
  // upward, so this can only ever narrow what he is asked to read.
  const retiredSlugs = new Set();
  const stale = [];
  for (const it of queue.items) {
    if (it.decision) continue;                       // decided = VP's record
    const live = it.scoreSource ? scores[it.scoreSource] : null;
    if (!live || typeof live !== 'object' || !('aiNative' in live)) continue;
    const liveScore = Number(live.score);
    const geoBad = !GEO_OK.has(String(live.geo || 'unclear'));
    const tierBad = Number.isFinite(liveScore) && liveScore < MIN_SCORE;
    if (!geoBad && !tierBad) {
      if (liveScore !== Number(it.score)) it.score = liveScore;   // keep it honest
      continue;
    }
    stale.push({ it, why: geoBad ? `geo is now ${live.geo}` : `tier is now ${liveScore}` });
  }
  const retiredKeys = new Set();
  if (stale.length) {
    const drop = new Set(stale.map(x => x.it.slug));
    for (const sl of drop) retiredSlugs.add(sl);
    // Remember what was retired. Without this, pass 2 stops seeing the card in
    // `known`, decides it is a brand-new role and re-mints it on the SAME run -
    // a drop/re-add loop that churns the queue every night and fixes nothing.
    for (const { it } of stale) retiredKeys.add(canonKey(it.company || '', it.role || ''));
    queue.items = queue.items.filter(i => !drop.has(i.slug) || i.decision);
    console.log(`re-gated ${stale.length} pending card(s) that no longer qualify:`);
    for (const { it, why } of stale.slice(0, 12)) {
      console.log(`  - [${it.score}] ${it.company} | ${String(it.role).slice(0, 44)} — ${why}`);
    }
    if (stale.length > 12) console.log(`  ...and ${stale.length - 12} more`);
    console.log('');
  }

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
                  blacklisted: 0, already: 0, noApplyPath: 0,
                  aggregatorOther: 0, legacyNoFacts: 0 };

  // Resolved Indeed apply URLs, one lookup per posting EVER (write-through, on
  // disk). Opened once here rather than per call so a run does not re-read the
  // file 2,500 times.
  const applyCache = openCache(DEFAULT_CACHE_PATH);
  let applyResolved = 0, applyStillDead = 0;

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
      // RECENCY = the employer's most recent activity on this requisition, not
      // merely when it appeared. Greenhouse publishes updated_at alongside
      // first_published, fetch-jds has always written it into the JD, and
      // nothing parsed it until 2026-08-06 — so the best available signal of
      // "is anyone still working this" sat unread next to the one every gate
      // used instead. 607 of 684 reqs carrying it were touched MORE RECENTLY
      // than they were posted.
      //
      // VP's framing: "freshness should be at whatever means the role is
      // actually open and being considered, not just sitting there." A 20-day-old
      // req the employer edited yesterday is being worked. A 2-day-old repost on
      // an evergreen board is not.
      days: recencyDays(jd),
      postedDays: jd.posted_days,
      updatedDays: jd.updated_days,
      // The employer's own timestamps, carried onto the card at mint. Without
      // them a card minted tonight has only a frozen `ageDays`, which is honest
      // for exactly one day and then drifts until the next re-gate picks it up.
      // The re-gate already writes these for existing cards; setting them here
      // closes the one-day window rather than leaving a card that lies briefly.
      postedAt: jd.posted_at || null,
      updatedAt: jd.updated_at || null,
      postedAt: jd.posted_at ?? null,     // carried onto the card by the expiry pass
      updatedAt: jd.updated_at ?? null,
      role: jd.title || '',
      url: jd.url || '',
      // WHERE THE FORM ACTUALLY IS. `url` stays the identity everything joins
      // on; this is the employer's own apply URL, recovered from the
      // `**Apply:**` line fetch-indeed.py now writes from jobspy's
      // `job_url_direct`. Before 2026-09-02 the field was discarded at ingest,
      // so 351 tier-4+ roles were "aggregator-only" while the real URL sat in
      // the scrape, and resolve-apply-paths.mjs spent ~43 min a night guessing
      // board slugs to reconstruct it (24 of 459 last night).
      //
      // ⚠ RESOLVED ONLY WHEN THE PRIMARY URL HAS NO FORM. That is precisely the
      // population this fixes, and it keeps a nightly run from making ~2,500
      // needless HEAD requests. Resolution is cached forever per posting.
      // ⚠ `unknown` (a timeout, a 5xx) is NOT `not-a-form`. It leaves the role
      // exactly where it was — recorded as unresolved and retried tomorrow —
      // because recording a network failure as a verdict about the data is this
      // repo's most expensive recurring bug.
      ...(await (async () => {
        const primaryOk = isApplyable(jd.url);
        if (primaryOk || !jd.apply_url) {
          return { applyable: primaryOk, applyUrl: jd.url || '' };
        }
        const r = await resolveApplyPath(jd.apply_url, { cache: applyCache });
        if (r.verdict === 'resolved' && r.url) {
          applyResolved++;
          return { applyable: true, applyUrl: r.url };
        }
        if (r.verdict === 'not-a-form') applyStillDead++;
        return { applyable: false, applyUrl: jd.url || '' };
      })()),
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
      // ⚠ THIS FIELD WAS NEVER CARRIED, so the "Listed as preferred, not
      // required" note below it — written on 2026-08-10 to VP's spec, "it
      // doesnt have to be a loud warning, just a normal warning" — could not
      // fire once. skillWarnings was computed by lib/skill-gate.mjs, stored in
      // lead-scores.json, read by nothing, and rendered never. 339 postings
      // carried at least one at the time this was found.
      skillWarnings: rec.skillWarnings || [],
      cvCoverageMissing: rec.cvCoverageMissing || [],
      cvCoverageRatio: rec.cvCoverageRatio ?? null,
      cvCoverageGap: rec.cvCoverageGap === true,
    });
  }

  // ── Recency: honest age, expiry, revival of the cards already in the queue ─
  // See decideExpiry() above for the rules and the measurement. This pass only
  // DECIDES; every write happens inside the updateQueue callback at the bottom,
  // beside the retirements, for the reason that callback's own comment gives.
  const knownDead = existsSync(ARCHIVE) ? knownDeadFromArchive(await readFile(ARCHIVE, 'utf-8')) : new Map();
  const deadFor = (u) => (u ? knownDead.get(canonicalizeUrl(String(u))) : undefined) || '';

  // The freshest EMPLOYER-HOSTED posting of each canonical role seen this run.
  // A role relisted under a new URL arrives as a new JD that pass 2 correctly
  // refuses to re-mint (its key is known, as an expired card), so this is the
  // only place the relist can register. Aggregator copies are excluded on
  // purpose - Indeed's date is Indeed's, not the employer's - and so is any URL
  // prune-stale has recorded dead (rule 4 in decideExpiry).
  const freshestByKey = new Map();
  for (const [key, variants] of groups) {
    for (const v of variants) {
      if (!v.applyable || v.days == null || deadFor(v.url)) continue;
      const cur = freshestByKey.get(key);
      if (!cur || v.days < cur.ageDays) {
        freshestByKey.set(key, { ageDays: v.days, postedAt: v.postedAt, updatedAt: v.updatedAt, via: v.file });
      }
    }
  }

  const jdFiles = new Set(files);
  // The card's own JD (via scoreSource) and the freshest relist of the same
  // role; whichever is more recent. null = nothing observable, which is NOT a
  // verdict (rule 2).
  async function observeRecency(it) {
    let own = null;
    if (it.scoreSource && jdFiles.has(it.scoreSource)) {
      try {
        const jd = parseJd(await readFile(path.join(JDS_DIR, it.scoreSource), 'utf-8'), it.scoreSource);
        const days = recencyDays(jd);
        if (days != null && !deadFor(jd.url)) {
          own = { ageDays: days, postedAt: jd.posted_at ?? null, updatedAt: jd.updated_at ?? null, via: it.scoreSource };
        }
      } catch { /* unreadable JD = unobserved, never expiry */ }
    }
    const relist = freshestByKey.get(canonKey(it.company || '', it.role || ''));
    const alt = relist && relist.via !== it.scoreSource ? relist : null;
    if (own && alt) return alt.ageDays < own.ageDays ? alt : own;
    return own || alt;
  }

  const now = new Date().toISOString();
  const expiry = new Map();   // slug -> decideExpiry() result, applied under lock below
  const exp = { expire: [], revive: [], refresh: 0, unobserved: 0, knownDead: 0, byTrack: {} };
  for (const it of queue.items) {
    if (it.decision != null && it.decision !== 'expired') continue;   // rule 1
    const d = decideExpiry(it, await observeRecency(it), {
      maxAgeDays: freshness.maxAgeDaysFor(it),       // per track AND per employer
      now,
      deadReason: deadFor(it.applyUrl) || deadFor(it.sourceUrl),
      relistNote: repostNote(reposts, it.company, it.role),
    });
    if (d.action === 'none') { if (d.why === 'unobserved') exp.unobserved++; continue; }
    expiry.set(it.slug, d);
    if (d.action === 'expire') {
      exp.expire.push({ it, why: d.why });
      const t = it.track || '?';
      exp.byTrack[t] = (exp.byTrack[t] || 0) + 1;
      if (/^known dead/.test(d.why)) exp.knownDead++;
    } else if (d.action === 'revive') {
      exp.revive.push({ it, why: d.why });
    } else {
      exp.refresh++;
    }
  }

  // ── Pass 2: one representative per role, then the gates ───────────────────
  const cand = [];
  const unresolved = [];

  for (const [key, variants] of groups) {
    if (retiredKeys.has(key)) { stats.already++; continue; }   // retired this run
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

    // BLACKLIST FIRST, ahead of every other gate.
    //
    // It used to sit after the aggregator branch below, so a blacklisted company
    // that was aggregator-only never reached it: the seven Information Technology
    // Senior Management Forum rows were counted as "no apply path", written into
    // data/unresolved-apply-paths.md, and re-listed every night while the gate
    // reported "0 blacklisted". A gate that a row can be routed around is not a
    // gate. Blacklisted means gone from EVERYWHERE - no card, no unresolved row,
    // no nightly re-resolution attempt.
    //
    // ITSMF is the case that motivated this: it is a reposter shell, not an
    // employer. Its rows are other companies' requisitions - seven Capital One
    // Travel reqs carried under the ITSMF name - so they are unresolvable by
    // construction, because the board that would prove a title match belongs to
    // a company that is not doing the hiring.
    if (blacklist.size && blacklistEntry(rep.company, blacklist)) { stats.blacklisted++; continue; }

    if (!applyable.length) {
      // Known only from an aggregator. Recorded, never enqueued - a card with no
      // form behind it cannot be filled, and 99 of those is a queue nobody reads.
      // THE LAST HARDCODED PER-TRACK WINDOW IN THE PIPELINE, removed 2026-08-11.
      // This read `rep.track === 'teaching' ? TEACHING_MAX_AGE_DAYS : MAX_AGE_DAYS`
      // - a second, private copy of the per-track rule, sitting three hundred
      // lines below the one that imports lib/freshness.mjs. It was already a
      // straggler: when the windows became per-employer this branch stayed
      // per-track-only, and when Track E and Track B got their own windows it
      // would have kept applying 30 days to both while the gate below applied 60
      // and 35. Copies are the defect, and this was the copy.
      //
      // Math.max, not a plain substitution, because this path is DELIBERATELY
      // looser than the card gate and must stay that way. Recording an
      // aggregator-only role in data/unresolved-apply-paths.md costs one
      // resolution attempt, not a Gemini call and a tailored CV, so it has
      // always run to the 30-day whale window rather than the 21-day ordinary
      // one. Taking the wider of {this role's real window, 30} keeps that floor
      // intact for pm and now, and lets civic/teaching/nonprofit open it further.
      const unresolvedMaxAge = Math.max(freshness.maxAgeDaysFor(rep), MAX_AGE_DAYS);
      if (rep.score >= MIN_SCORE && GEO_OK.has(String(rep.geo || 'unclear')) &&
          rep.days != null && rep.days <= unresolvedMaxAge) {
        unresolved.push(rep);
        stats.noApplyPath++;
      } else {
        // Aggregator-only AND failing some other gate. This branch used to
        // `continue` with no counter at all, so the printed stats were
        // arithmetically incomplete by ~250 roles a run - the block VP reads to
        // reason about coverage did not add up, in a file whose own header says
        // "a role that is scored but not enqueued is invisible, and invisible is
        // the same as not found".
        stats.aggregatorOther++;
      }
      continue;
    }

    // A pre-2026-07-31 record carries no geo and no functionArea, so every gate
    // below compares against undefined and it is dropped as a GEOGRAPHY failure.
    // That is a lie about the cause: 207 such records exist, 58 at tier 4+, and
    // none of them can be recovered by a policy change because they have no
    // facts to re-derive from. Counted honestly and separately. Measured
    // 2026-08-06: 0 of the 207 has a JD under 30 days old, so this is a
    // reporting fix, not a recovery - they are already unreachable on age.
    const repFacts = scores[rep.file] ?? {};
    const repIsLegacy = (repFacts.facts ?? repFacts).geo === undefined
      && (repFacts.facts ?? repFacts).functionArea === undefined;
    if (repIsLegacy) { stats.legacyNoFacts++; continue; }

    if (!(rep.score >= MIN_SCORE)) { stats.lowScore++; continue; }
    // Track D has no geography gate by design. The brief was "few constraints,
    // the important thing is a good path to income" - another country and
    // another currency are the point, not a problem.
    // A role that REQUIRES living somewhere else is out on every track, full
    // stop. VP, 2026-08-10: "we shouldnt [be] having ... a job that requires the
    // person to be living in another country."
    //
    // This used to be skipped entirely for track 'now', on the reasoning that
    // "another country and another currency are the point, not a problem". That
    // conflated two different things. Being PAID from elsewhere is fine; being
    // REQUIRED TO RESIDE elsewhere is not, and it is not a trade-off any amount
    // of tier-5 fit can buy back. It put Wellhub's "Staff Product Manager |
    // Partners" - geoRaw "Brazil (Remote)", model redFlags "Location
    // restriction: Brazil only. Candidate is in the US." - in front of VP at 5.0.
    const repGeo = String(rep.geo || 'unclear');
    if (repGeo === 'onsite-elsewhere' || repGeo === 'hybrid-elsewhere') { stats.geo++; continue; }
    // Every track needs a geography VP can actually work in - no 'now' exemption
    // for 'unclear' either.
    //
    // The exemption existed for thin OLAS-style postings that genuinely do not
    // state a location. In practice 'unclear' meant FOREIGN: Nubank's Ciudad de
    // Mexico and Sao Paulo roles rode it onto VP's board twice. It also put the
    // minting gate at odds with the re-gate above, which has no track exemption -
    // so a card was retired on one run and re-minted on the next, for ever. Two
    // gates disagreeing about the same card is a churn loop, not a policy.
    //
    // An unlocatable posting can still be scored and sit in inbox-leads; it just
    // does not earn a review card until someone can say where the job is.
    if (!GEO_OK.has(repGeo)) { stats.geo++; continue; }
    const maxAge = freshness.maxAgeDaysFor(rep);
    if (rep.days == null || rep.days > maxAge) { stats.stale++; continue; }
    // parseBlacklist returns a MAP. `.length` on a Map is undefined, so this gate
    // has never blocked anything. rank-leads.mjs:647 tests `.size` and works.
    // Currently masked because data/blacklist.md does not exist — but the moment
    // VP creates one, the scorer would honour it and this would not, and the
    // comment above states this is "the only gate that can stop a company
    // already present in lead-scores.json", because rank-leads filters before
    // scoring and never removes an entry cached before the company was listed.


    const conflict = variants.find(v => v !== rep && v.score !== rep.score);
    cand.push({ ...rep, altScore: conflict ? conflict.score : null, altFile: conflict ? conflict.file : null });
  }

  const fresh = cand.sort((a, b) => b.score - a.score || a.days - b.days);

  // The banner names EVERY window, from the same table the gate reads. It used
  // to name two of the five by hand, so a role dropped under a window the
  // operator could not see was indistinguishable from a role dropped for cause.
  console.log(`enqueue-review: tier >= ${MIN_SCORE}, geo in {${[...GEO_OK].join(', ')}}, freshness per lib/freshness.mjs (${describeWindows({ whaleMaxAgeDays: MAX_AGE_DAYS })})`);
  console.log(`scanned ${stats.scanned} scored JDs → ${groups.size} distinct roles`);
  console.log(`  dropped: ${stats.lowScore} below tier, ${stats.geo} geo, ${stats.stale} stale, ` +
              `${stats.blacklisted} blacklisted, ${stats.already} already in queue,`);
  console.log(`           ${stats.noJd} no JD on disk, ${stats.badCompany} unusable company name, ` +
              `${stats.noApplyPath} aggregator-only (no form to fill)`);
  console.log(`           ${stats.aggregatorOther} aggregator-only AND failing another gate, ` +
              `${stats.legacyNoFacts} pre-audit records with no facts to score`);
  // The numbers must reconcile, or they cannot be used to reason about coverage.
  const accounted = stats.lowScore + stats.geo + stats.stale + stats.blacklisted + stats.already +
                    stats.noApplyPath + stats.aggregatorOther + stats.legacyNoFacts + fresh.length;
  if (accounted !== groups.size) {
    console.log(`           ⚠ ${groups.size - accounted} role(s) UNACCOUNTED — the drop counters do not sum to ${groups.size}`);
  }
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

  // ⚠ REPORTED AND SAVED BEFORE THE DRY-RUN RETURN. The cache is a memo, not a
  // record — a --dry-run that resolves 55 redirects and throws the answers away
  // makes every subsequent run pay for them again, and the point of the file is
  // that a posting is resolved once, ever.
  if (applyResolved || applyStillDead) {
    console.log(`apply-url: ${applyResolved} aggregator-only role(s) gained a real form, ${applyStillDead} led nowhere`);
  }
  applyCache.save();

  // What the recency pass decided, in the idiom of the re-gate block, so the
  // nightly log shows it. Printed in dry-run too - a wildly different count from
  // the measurement (131 past-window of 277 on 2026-09-02) means the windows
  // are being read differently, and that has to be visible BEFORE it writes.
  const would = DRY ? 'would ' : '';
  const byTrack = Object.entries(exp.byTrack).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ');
  console.log(`\nexpiry: ${exp.expire.length} pending card(s) ${would}expire` +
              ` (${byTrack || 'none'}${exp.knownDead ? `; ${exp.knownDead} known dead` : ''}),` +
              ` ${exp.revive.length} expired card(s) ${would}revive,` +
              ` ${exp.refresh} age badge(s) ${would}refresh,` +
              ` ${exp.unobserved} unobserved (no readable JD or no date) left untouched`);
  for (const { it, why } of exp.expire.slice(0, 12)) {
    console.log(`  - [${it.score}] ${it.company} | ${String(it.role).slice(0, 44)} — ${why}`);
  }
  if (exp.expire.length > 12) console.log(`  ...and ${exp.expire.length - 12} more`);
  for (const { it, why } of exp.revive) {
    console.log(`  ↻ [${it.score}] ${it.company} | ${String(it.role).slice(0, 44)} — ${why}`);
  }

  if (DRY) { console.log('\n--dry-run, queue not written'); return; }

  // ⚠ ALWAYS WRITTEN, EVEN WHEN EMPTY. This used to run only when the list
  // was non-empty, so the file froze at its last non-empty state — 2026-08-18 —
  // and nightly-report.mjs went on counting it as live every night for a
  // fortnight. An absent write is indistinguishable from "nothing changed",
  // which is the same silent-absence trap as a card whose age never updates.
  await writeFile(
    path.join(ROOT, 'data', 'unresolved-apply-paths.md'),
    `# Roles that score well but have no form behind them\n\n` +
    `Written by enqueue-review.mjs on ${new Date().toISOString().slice(0, 10)}. Each of these is\n` +
    `tier ${MIN_SCORE}+, geo-clean and fresh, but is known only from an aggregator listing, so\n` +
    `there is nothing to fill. Resolving the employer's own posting promotes it into the queue.\n\n` +
    (unresolved.length
      ? unresolved.map(u => `- [ ] [${u.score}] ${u.company} | ${u.role} | ${u.days}d | ${u.url}`).join('\n') + '\n'
      : 'None — every qualifying role has a form behind it.\n')
  );
  console.log(`\nrecorded ${unresolved.length} unresolved roles in data/unresolved-apply-paths.md`);


  // ⚠ THIRD exit that skipped the writer. There are three ways this function
  // can decide it has no new cards - no candidates at all (here), everything
  // held for a missing CV, and written===0 - and every one of them used to
  // return before updateQueue(). Retirement is a WRITE: a night that adds
  // nothing can still need to remove a role that stopped qualifying. Fixing
  // only the first two left Nubank's Ciudad de Mexico and Wellhub's Sao Paulo
  // roles on VP's board through two more "successful" runs, each of which
  // printed "re-gated 4 pending cards" and persisted none of them.
  //
  // ⚠ AND A FOURTH KIND OF WRITE, 2026-09-02: expiry. Recomputing a card's age
  // and expiring or reviving it is a write exactly like retiring it, and it is
  // needed most on the nights that mint nothing. So there is now NO early
  // return between here and the single updateQueue() below - the two exits that
  // used to live here (one of them running its own retirement-only writer, with
  // no backup and without the coverLetter refresh) are gone. Everything that
  // needs persisting is gathered first and the ONE guard before the writer asks
  // "is there anything at all to write".
  if (!fresh.length) console.log('nothing new to enqueue');

  // output/<slug>/ is a directory, so two roles sharing a slug would share a
  // pack. Indeed lists "Product Manager II" and "Product Manager II
  // (Responsible AI)" at the same employer; both slugify identically.
  // output/ holds 249 directories against 54 queue slugs, so checking the queue
  // alone left 190 invisible: a new card taking one of those names would write
  // into an already-staged application pack.
  // A slug already claimed by a CARD is a real conflict. A DIRECTORY in output/
  // is not, by itself: stage-applications.mjs runs earlier in the same nightly
  // and builds this role's pack there. Treating that as a collision is what
  // produced 25 `-N` slugs pointing at empty directories while the CV sat in the
  // un-suffixed sibling, and 404'd every file link on 8 of 9 pending cards.
  //
  // So identity, not name-avoidance: a directory belongs to THIS role when its
  // pack-meta.json carries the same canonical key. Packs staged before
  // pack-meta.json existed have no marker, and for those the honest fallback is
  // that an un-owned orphan directory is adoptable - which is exactly the
  // historical case - while an owned one is not.
  const claimedByCard = new Set(queue.items.map(i => i.slug));
  const outputDirs = new Set(await readdir(path.join(ROOT, 'output')).catch(() => []));

  async function packCanonKey(slug) {
    try {
      const m = JSON.parse(await readFile(path.join(ROOT, 'output', slug, 'pack-meta.json'), 'utf-8'));
      return m.canonKey ?? null;
    } catch { return null; }
  }

  // Resolve the slug a card should use: its own pack when there is one, a fresh
  // suffixed name only when the directory demonstrably belongs to someone else.
  async function resolveSlug(c) {
    const base = slugify(`${c.company}-${c.role}`);
    const mine = canonKey(c.company, c.role);
    const keys = new Map();
    for (let n = 1; n <= 50; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      if (outputDirs.has(slug)) keys.set(slug, await packCanonKey(slug));
    }
    return chooseSlug({ base, canon: mine, claimedByCard, outputDirs, packKeys: keys });
  }

  const held = [];
  for (const c of fresh) {
    const slug = await resolveSlug(c);

    // VP's standing rule (2026-08-06, the second time he had to say it): a role
    // that reaches the Review Queue MUST have a completed CV. A card he cannot
    // act on is worse than a card that never appeared - it costs a click, breaks
    // trust in every other card, and hides the roles that are genuinely ready.
    // Enqueueing and rendering the pack are one unit of work; if the pack is not
    // there, the role waits rather than becoming a dead card.
    if (!existsSync(path.join(ROOT, 'output', slug, 'cv.pdf'))) {
      held.push({ ...c, slug });
      continue;
    }

    claimedByCard.add(slug);
    outputDirs.add(slug);
    // A relisted role is an unfilled req the employer is still spending on —
    // the strongest positive signal of hiring intent available, and one every
    // layer above was discarding as a duplicate.
    const relisted = repostNote(reposts, c.company, c.role);
    const notes = [
      relisted,
      // ⚠ THE SCORER'S PROSE IS TRACK A'S, ON EVERY TRACK. There is one scoring
      // prompt and it asks about VP's NYC product search, so on a teaching or
      // civic card the model is answering a question this card is not asking:
      // an Achievement First teaching role, scored 4 by the TEACHING rubric,
      // rendered "RED FLAGS: Role is a Teacher position, not a Product
      // Marketing role." Both true, neither a defect, and the card argued
      // against its own number. 84 of 287 pending cards carried prose like it.
      //
      // Stripped per CLAUSE, so the half that says what the role IS survives.
      // Display only — hasCaveat still reads the raw redFlags and still caps a
      // 5 to a 4. See the header of lib/off-track-prose.mjs.
      (() => { const v = stripOffTrackClaims(c.track, c.verdict); return v ? `SCORER: ${v}` : ''; })(),
      (() => { const f = stripOffTrackClaims(c.track, c.redFlags); return f ? `RED FLAGS: ${f}` : ''; })(),
      // Nice-to-have skills VP does not have. A normal warning, not a block -
      // his words: "it doesnt have to be a loud warning, just a normal warning".
      (c.skillWarnings || []).length ? `Listed as preferred, not required: ${(c.skillWarnings || []).join(', ')}` : '',
      // VP, 2026-08-10: "workday sucks because each company's version requires a
      // different user account for that single application". Greenhouse, Ashby
      // and Lever accept an upload; Workday makes you register with the employer
      // before you can submit anything. That friction belongs on the card, not
      // discovered at apply time after the pack is already built.
      /myworkdayjobs\.com/i.test(String(c.applyUrl || c.url || ''))
        ? 'WORKDAY: requires creating an account with this employer before you can apply.'
        : '',
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
      // ⚠ THIS IS ABOUT THE DOCUMENT, NOT ABOUT VP, and the wording carries
      // that. "Your CV does not mention SCIM" is checkable and fixable in an
      // afternoon; "you do not know SCIM" is a claim this pipeline has no
      // standing to make and has made by accident before - see the header of
      // lib/cv-coverage.mjs and skill-gate's note that cv.md omits Kubernetes
      // while VP runs a k3s cluster.
      //
      // It has to RENDER, not just cap the score. A 5 quietly becoming a 4 with
      // nothing on the card explaining why is the same incoherence the caveat
      // cap was introduced to remove.
      c.cvCoverageGap
        ? `CV COVERAGE: the posting names ${(c.cvCoverageMissing || []).join(', ')} and the CV variant that would be sent does not mention ${(c.cvCoverageMissing || []).length > 1 ? 'them' : 'it'}. This is about the DOCUMENT, not about what you can do - fix the CV or ignore the flag.`
        : '',
      'ON ME: Glassdoor and interview-process research not yet done for this role - auto-enqueued from the nightly score.',
    ].filter(Boolean).join(' ');

    queue.items.push({
      slug,
      company: c.company,
      role: c.role,
      sourceUrl: c.url,
      applyUrl: c.applyUrl || c.url,
      ats: atsOf(c.applyUrl || c.url),
      score: c.score,
      ageDays: c.days,
      postedAt: c.postedAt ?? null,
      updatedAt: c.updatedAt ?? null,
      geo: c.geo,
      // ⚠ THIS WAS THE LITERAL STRING 'unknown', ALWAYS (fixed 2026-08-11).
      // Staging had already resolved the requirement and written it into the
      // pack, and the card threw that away: counted on the 2026-08-11 queue, all
      // 104 pending cards read "unknown" while 17 of the packs behind them
      // recorded a determined answer. Read the pack's finding instead; 'unknown'
      // is now what we say when we genuinely do not know.
      coverLetter: (await readCoverLetterFinding(path.join(ROOT, 'output', slug)))?.value || 'unknown',
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

  // Roles that qualified but have no rendered pack. These are NOT dropped - they
  // are recorded so the gap is visible and so the next staging run can pick them
  // up. Silently discarding them would trade one invisible failure for another.
  // ⚠ ALWAYS WRITTEN, EVEN WHEN EMPTY. This used to run only when the list
  // was non-empty, so the file froze at its last non-empty state — 2026-08-18 —
  // and nightly-report.mjs went on counting it as live every night for a
  // fortnight. An absent write is indistinguishable from "nothing changed",
  // which is the same silent-absence trap as a card whose age never updates.
  await writeFile(
    path.join(ROOT, 'data', 'held-no-pack.md'),
    `# Qualified roles held back for a missing CV\n\n` +
    `Written by enqueue-review.mjs on ${new Date().toISOString().slice(0, 10)}. Each of these\n` +
    `passed every gate but has no output/<slug>/cv.pdf, so it was NOT enqueued: per VP's\n` +
    `standing rule, a card in the review queue must have a completed CV. Run\n` +
    `stage-applications.mjs and re-run enqueue to promote them.\n\n` +
    (held.length
      ? held.map(h => `- [ ] [${h.score}] ${h.company} | ${h.role} | ${h.days}d | output/${h.slug}/ | ${h.url}`).join('\n') + '\n'
      : 'None — every qualified role has a rendered CV.\n')
  );
  if (held.length) {
    console.log(`\n⚠ HELD ${held.length} qualified role(s) with no rendered CV — see data/held-no-pack.md`);
    for (const h of held.slice(0, 10)) console.log(`    [${h.score}] ${h.company} | ${String(h.role).slice(0, 52)}`);
  }

  // A card's coverLetter is set once, when it is MINTED, and almost every
  // pending card was minted before the requirement could be resolved at all -
  // so 103 of 104 read "unknown" while their packs on disk now carry a settled
  // finding. Refresh from the pack here. Computed BEFORE updateQueue because
  // readCoverLetterFinding is async and the writer callback is not.
  //
  // Only ever overwrite with a DETERMINED value: 'unknown' from a pack that has
  // not been re-read must not clobber a real finding already on the card.
  const clRefresh = new Map();
  for (const it of queue.items) {
    if (it.decision) continue;
    const found = (await readCoverLetterFinding(path.join(ROOT, 'output', it.slug)))?.value;
    if (found && found !== 'unknown' && found !== it.coverLetter) clRefresh.set(it.slug, found);
  }

  // ── CV coverage, same problem, same fix ───────────────────────────────────
  // Does the CV we would actually send mention the concrete things the posting
  // names? lib/cv-coverage.mjs answers it, rank-leads.mjs has written the answer
  // into lead-scores.json for every scored role since 2026-08-14, and the card
  // mints the fields (see the card build above) — but a card is minted ONCE, so
  // every card older than that change carries nothing. Measured 2026-09-02: 276
  // of 277 pending cards had a scored record with coverage, and 0 cards showed
  // it. The CV COVERAGE note below, written after Harvey's rejection, could not
  // fire on a single card in the queue.
  //
  // ⚠ NULL IS NOT ZERO. cvCoverage returns ratio: null when the posting names no
  // extractable terms — 1,683 of 2,502 records — which means "not measurable
  // here", not "the CV covers nothing". Only a measured value is copied across,
  // so an unmeasurable posting leaves the card exactly as it was.
  const covRefresh = new Map();
  for (const it of queue.items) {
    if (it.decision) continue;
    const rec = it.scoreSource ? scores[it.scoreSource] : null;
    if (!rec || typeof rec !== 'object') continue;
    if (rec.cvCoverageRatio == null) continue;
    if (it.cvCoverageRatio === rec.cvCoverageRatio) continue;
    covRefresh.set(it.slug, {
      cvCoverageRatio: rec.cvCoverageRatio,
      cvCoverageMissing: rec.cvCoverageMissing || [],
      cvCoverageGap: rec.cvCoverageGap === true,
    });
  }
  if (covRefresh.size) {
    const gaps = [...covRefresh.values()].filter((v) => v.cvCoverageGap).length;
    console.log(`CV coverage: ${covRefresh.size} existing card(s) gain a measured ratio (${gaps} with a gap)`);
  }

  const written = fresh.length - held.length;
  if (fresh.length && !written) console.log('\nno cards written (every qualifying role was held for a missing CV)');

  // ⚠ THE ONE GUARD BEFORE THE ONE WRITER. It has skipped the writer three
  // separate ways before this - no candidates, everything held for a missing
  // CV, written===0 - and each time a run printed a success line ("re-gated 11
  // cards") while persisting nothing: 7 non-US roles stayed on VP's board
  // through two more "successful" nights. Every kind of edit to an existing
  // card is a WRITE exactly like minting one - retirement, the coverLetter
  // refresh, and now expiry/revival/age - and each is needed most on the
  // nights that mint nothing. Add a new kind of edit here, never a new return.
  const edits = [
    retiredSlugs.size && `${retiredSlugs.size} retirement(s)`,
    clRefresh.size && `${clRefresh.size} coverLetter refresh(es)`,
    covRefresh.size && `${covRefresh.size} CV-coverage refresh(es)`,
    expiry.size && `${expiry.size} expiry/revival/age update(s)`,
  ].filter(Boolean);
  if (!written && !edits.length) { console.log('\nnothing to persist; queue not written'); return; }
  if (!written) console.log(`\nno new cards, but there is something to persist: ${edits.join(', ')}`);

  // Backed up before EVERY write, whichever kind. The retirement-only path used
  // to reach its own writer without this.
  await copyFile(QUEUE, `${QUEUE}.bak-enqueue-${new Date().toISOString().slice(0, 10)}`);

  // Append the new cards to a FRESHLY read queue, under an exclusive lock. This
  // used to write the copy loaded at the top of the run, so a decision VP made
  // in the UI during the nightly was silently reverted - and vice versa, the
  // UI's write could drop a whole night's new cards.
  // `slice(-0)` is the WHOLE array, so written===0 must be spelled out.
  const appended = written ? queue.items.slice(-written) : [];
  const final = await updateQueue(QUEUE, (fresh) => {
    // Restate the track legend from lib/track.mjs every run. It was a hand-
    // written literal that had not been touched since govtech and venture were
    // retired: the UI prints `queue.tracks[active]` under the tab bar, so civic
    // and now — 83 of 287 pending cards — showed no description while two dead
    // tracks had one. Written before anything else so a mid-callback return
    // cannot skip it.
    fresh.tracks = { ...TRACK_LABELS };

    // Re-clean the scorer's prose on every PENDING card, not just the ones
    // minted tonight. 84 cards were already on the board carrying Track-A prose
    // when this shipped, and they would have carried it until they expired.
    // Idempotent by construction (test-off-track-prose.mjs pins that), so it
    // runs every night instead of needing a one-off migration — which also
    // covers any card minted by an older build.
    //
    // Decided cards are left exactly as they are: the reasoning on a rejection
    // is the record of why, and rewriting history to look tidier is not this
    // script's business.
    {
      let n = 0;
      for (const i of fresh.items) {
        if (i.decision) continue;
        const cleaned = cleanNotesForTrack(i.track, i.notes || '');
        if (cleaned !== (i.notes || '')) { i.notes = cleaned; n++; }
      }
      if (n) console.log(`cleaned off-track scorer prose on ${n} card(s)`);
    }
    // ⚠ RETIREMENT MUST HAPPEN HERE, not on the snapshot loaded at the top of
    // the run. `queue` is a read-only copy used to build the `known` index;
    // updateQueue re-reads the file under lock and writes THIS object. The first
    // version of the re-gate filtered the snapshot, printed "re-gated 11
    // cards", and discarded every one of them - 7 non-US cards were still on
    // VP's board afterwards. The surrounding comment already warned that
    // writing the loaded copy loses the UI's concurrent decisions; the same
    // reference trap runs in the other direction.
    if (retiredSlugs.size) {
      const before = fresh.items.length;
      fresh.items = fresh.items.filter((i) => i.decision || !retiredSlugs.has(i.slug));
      const removed = before - fresh.items.length;
      if (removed) console.log(`retired ${removed} pending card(s) that no longer qualify`);
    }
    if (clRefresh.size) {
      let n = 0;
      for (const i of fresh.items) {
        if (i.decision) continue;
        const v = clRefresh.get(i.slug);
        if (v && i.coverLetter !== v) { i.coverLetter = v; n++; }
      }
      if (n) console.log(`refreshed coverLetter on ${n} existing card(s)`);
    }
    if (covRefresh.size) {
      let n = 0;
      for (const i of fresh.items) {
        if (i.decision) continue;
        const v = covRefresh.get(i.slug);
        if (!v) continue;
        Object.assign(i, v);
        n++;
      }
      if (n) console.log(`refreshed CV coverage on ${n} existing card(s)`);
    }
    // ⚠ EXPIRY IS APPLIED HERE, to the locked re-read, for the same reason
    // retirement is. The snapshot was only ever consulted; the decisions carry
    // the decision each card had at the time, and a card VP decided in the UI
    // meanwhile is skipped - his click wins. Nothing is removed: an expired
    // card stays in the file under decision "expired", reversible by `clear`.
    if (expiry.size) {
      const n = { expire: 0, revive: 0, refresh: 0, skipped: 0 };
      for (const i of fresh.items) {
        const d = expiry.get(i.slug);
        if (!d) continue;
        if (applyExpiryDecision(i, d)) n[d.action]++; else n.skipped++;
      }
      console.log(`expired ${n.expire} pending card(s) past their window, revived ${n.revive} relisted card(s), ` +
                  `corrected the age on ${n.refresh} other(s)` +
                  (n.skipped ? ` — ${n.skipped} skipped, VP decided them during the run` : ''));
    }
    const have = new Set(fresh.items.map((i) => i.slug));
    for (const card of appended) if (!have.has(card.slug)) fresh.items.push(card);
    if (written) {
      fresh.note = `${fresh.note || ''} | auto-enqueued ${written} on ${new Date().toISOString().slice(0, 10)}`.replace(/^ \| /, '');
    }
  });
  console.log(`\nwrote ${written} new cards to data/review-queue.json`);
  const finalItems = final?.items || [];
  console.log(`queue now: ${finalItems.filter(i => !i.decision).length} pending, ` +
              `${finalItems.filter(i => i.decision === 'expired').length} expired, ${finalItems.length} total`);
};

// Only run when invoked directly (node enqueue-review.mjs ...), so the pure
// functions above can be imported by tests without firing the nightly step.
// Same idiom as check-liveness.mjs. test-slug-identity.mjs has imported
// chooseSlug from here since 2026-08-06, and until this guard that import RAN
// main() against the live queue.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
