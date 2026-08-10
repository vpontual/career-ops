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
import { loadReposts, repostNote } from './lib/repost.mjs';
import { updateQueue } from './lib/queue-file.mjs';
import { detectTrack } from './lib/track.mjs';
import { classifyArchetype } from './tailor-cv.mjs';
import { parseBlacklist, blacklistEntry } from './blacklist.mjs';
import { canonicalizeUrl } from './lib/url-canonical.mjs';
import yaml from 'js-yaml';
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
// FRESHNESS — rewritten 2026-08-06 from measurement, superseding the flat 3-day
// rule.
//
// The old rule came from VP on 2026-08-05, after he rejected 57 of 61 cards on
// age: "if i saw 4 or more days i just rejected it." He then superseded it on
// 2026-08-06: "freshness should be at whatever means the role is actually open
// and being considered, not just sitting there... you are supposed to become an
// expert on it and know."
//
// So it was measured. measure-req-lifespan.mjs asks the Greenhouse and Ashby
// board APIs which of 711 tracked postings are still open, giving a survival
// curve by age at first sighting:
//
//     0-3 d   97% still open        22-30 d   93%
//     4-7 d   91%                   46-60 d   67%
//     8-14 d  86%                   61-90 d   36%
//
// A posting stays open for WEEKS. The cliff is at 45-60 days, not at 3. The old
// gate was discarding roles with an ~86-93% chance of still being live - it cost
// 67 tier-4/5 roles including Brex, Vanta, Spotify, Airtable and Datadog.
//
// But being OPEN is not the same as being actively filled, which is the thing VP
// actually asked for, so the second signal is the employer's own closure
// behaviour: of their postings watched 30+ days, how many are still open?
//
//     Intercom 9%   Crusoe 20%   Harvey 24%   Ramp 25%   Anthropic 38%
//     ... these close requisitions, which means they fill them
//     Sierra 94%    Figma 75%    Decagon 64%
//     ... these do not; an old posting on that board signals nothing
//
// So the window is wide by default, and stays tight for employers whose boards
// are demonstrably evergreen. Measurements live in data/employer-closure.json
// and are refreshed by re-running measure-req-lifespan.mjs.
const FRESH_MAX_AGE_DAYS = Number(process.env.FRESH_MAX_AGE_DAYS || 21);
// An evergreen board's old postings carry no hiring signal, so they must be
// genuinely new to be worth a review slot.
const EVERGREEN_MAX_AGE_DAYS = Number(process.env.EVERGREEN_MAX_AGE_DAYS || 7);
const EVERGREEN_PCT = Number(process.env.EVERGREEN_PCT || 80);
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

const main = async () => {
  const scores = JSON.parse(await readFile(SCORES, 'utf-8'));
  const queue = JSON.parse(await readFile(QUEUE, 'utf-8'));
  const files = await readdir(JDS_DIR);

  // data/blacklist.md is a markdown TABLE, and this used to parse it as bullets,
  // so it silently matched nothing. Use the project's own parser - it is the only
  // gate that can stop a company already present in lead-scores.json, because
  // rank-leads filters blacklisted companies before scoring and never removes
  // entries scored before the company was blacklisted.
  // Read live from config/whales.yml so VP can edit it without a deploy.
  let whales = [];
  try {
    const wraw = await readFile(path.join(ROOT, 'config', 'whales.yml'), 'utf-8');
    whales = (yaml.load(wraw)?.whales || []).map((w) => String(w).toLowerCase());
  } catch { /* no list is fine, everything is then held to the fresh window */ }
  // Employers whose requisitions demonstrably do not close. Read live so a
  // re-measurement takes effect without a deploy; absent file means nobody is
  // treated as evergreen, which fails open rather than hiding roles.
  const reposts = loadReposts(path.join(ROOT, 'data', 'scan-history.tsv'));
  let closure = {};
  try {
    closure = JSON.parse(await readFile(path.join(ROOT, 'data', 'employer-closure.json'), 'utf-8')).employers || {};
  } catch { /* not measured yet */ }
  const isEvergreen = (company) => {
    const e = closure[String(company || '').toLowerCase()];
    return Boolean(e && e.n >= 4 && e.pctAlive >= EVERGREEN_PCT);
  };

  const isWhale = (company) => {
    const c = String(company || '').toLowerCase();
    return whales.some((w) => c.includes(w));
  };

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
      days: Math.min(
        jd.posted_days ?? Number.POSITIVE_INFINITY,
        jd.updated_days ?? Number.POSITIVE_INFINITY,
      ) === Number.POSITIVE_INFINITY ? jd.posted_days
        : Math.min(jd.posted_days ?? Infinity, jd.updated_days ?? Infinity),
      postedDays: jd.posted_days,
      updatedDays: jd.updated_days,
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

    if (!applyable.length) {
      // Known only from an aggregator. Recorded, never enqueued - a card with no
      // form behind it cannot be filled, and 99 of those is a queue nobody reads.
      const unresolvedMaxAge = rep.track === 'teaching' ? TEACHING_MAX_AGE_DAYS : MAX_AGE_DAYS;
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
    // 'unclear' is still tolerated on the 'now' track only, where a thin OLAS-style
    // posting genuinely may not say - but a KNOWN elsewhere never reaches here.
    if (rep.track !== 'now' && !GEO_OK.has(repGeo)) { stats.geo++; continue; }
    const maxAge = rep.track === 'teaching' ? TEACHING_MAX_AGE_DAYS
                 : isWhale(rep.company) ? MAX_AGE_DAYS
                 : isEvergreen(rep.company) ? EVERGREEN_MAX_AGE_DAYS
                 : FRESH_MAX_AGE_DAYS;
    if (rep.days == null || rep.days > maxAge) { stats.stale++; continue; }
    // parseBlacklist returns a MAP. `.length` on a Map is undefined, so this gate
    // has never blocked anything. rank-leads.mjs:647 tests `.size` and works.
    // Currently masked because data/blacklist.md does not exist — but the moment
    // VP creates one, the scorer would honour it and this would not, and the
    // comment above states this is "the only gate that can stop a company
    // already present in lead-scores.json", because rank-leads filters before
    // scoring and never removes an entry cached before the company was listed.
    if (blacklist.size && blacklistEntry(rep.company, blacklist)) { stats.blacklisted++; continue; }

    const conflict = variants.find(v => v !== rep && v.score !== rep.score);
    cand.push({ ...rep, altScore: conflict ? conflict.score : null, altFile: conflict ? conflict.file : null });
  }

  const fresh = cand.sort((a, b) => b.score - a.score || a.days - b.days);

  console.log(`enqueue-review: tier >= ${MIN_SCORE}, geo in {${[...GEO_OK].join(', ')}}, <= ${FRESH_MAX_AGE_DAYS}d (whales <= ${MAX_AGE_DAYS}d, teaching <= ${TEACHING_MAX_AGE_DAYS}d)`);
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
      c.verdict ? `SCORER: ${c.verdict}.` : '',
      c.redFlags ? `RED FLAGS: ${c.redFlags}` : '',
      // Nice-to-have skills VP does not have. A normal warning, not a block -
      // his words: "it doesnt have to be a loud warning, just a normal warning".
      (c.skillWarnings || []).length ? `Listed as preferred, not required: ${(c.skillWarnings || []).join(', ')}` : '',
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

  // Roles that qualified but have no rendered pack. These are NOT dropped - they
  // are recorded so the gap is visible and so the next staging run can pick them
  // up. Silently discarding them would trade one invisible failure for another.
  if (held.length) {
    await writeFile(
      path.join(ROOT, 'data', 'held-no-pack.md'),
      `# Qualified roles held back for a missing CV\n\n` +
      `Written by enqueue-review.mjs on ${new Date().toISOString().slice(0, 10)}. Each of these\n` +
      `passed every gate but has no output/<slug>/cv.pdf, so it was NOT enqueued: per VP's\n` +
      `standing rule, a card in the review queue must have a completed CV. Run\n` +
      `stage-applications.mjs and re-run enqueue to promote them.\n\n` +
      held.map(h => `- [ ] [${h.score}] ${h.company} | ${h.role} | ${h.days}d | output/${h.slug}/ | ${h.url}`).join('\n') + '\n'
    );
    console.log(`\n⚠ HELD ${held.length} qualified role(s) with no rendered CV — see data/held-no-pack.md`);
    for (const h of held.slice(0, 10)) console.log(`    [${h.score}] ${h.company} | ${String(h.role).slice(0, 52)}`);
  }

  const written = fresh.length - held.length;
  if (!written && !retiredSlugs.size) {
    console.log('\nno cards written (every qualifying role was held for a missing CV)');
    return;
  }
  // ⚠ Do NOT return early when there is nothing to add but something to REMOVE.
  // A night can legitimately produce zero new cards while still needing to
  // retire ones that stopped qualifying, and returning here skipped the writer
  // entirely: the run printed "re-gated 11 cards", wrote nothing, and left 7
  // non-US roles on VP's board. Retirement is a write like any other.
  if (!written) console.log('\nno new cards, but there are retirements to persist');

  // Append the new cards to a FRESHLY read queue, under an exclusive lock. This
  // used to write the copy loaded at the top of the run, so a decision VP made
  // in the UI during the nightly was silently reverted - and vice versa, the
  // UI's write could drop a whole night's new cards.
  const appended = queue.items.slice(-written);
  await updateQueue(QUEUE, (fresh) => {
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
    const have = new Set(fresh.items.map((i) => i.slug));
    for (const card of appended) if (!have.has(card.slug)) fresh.items.push(card);
    fresh.note = `${fresh.note || ''} | auto-enqueued ${written} on ${new Date().toISOString().slice(0, 10)}`.replace(/^ \| /, '');
  });
  console.log(`\nwrote ${written} new cards to data/review-queue.json`);
  console.log(`queue now: ${queue.items.filter(i => !i.decision).length} pending, ${queue.items.length} total`);
};

main().catch((e) => { console.error(e); process.exit(1); });
