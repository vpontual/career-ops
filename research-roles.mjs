#!/usr/bin/env node

/**
 * research-roles.mjs — employer diligence from sources that are actually readable.
 *
 * This replaces the Glassdoor step, which cannot be automated: Glassdoor sits
 * behind Cloudflare and returns 403 to a real headless browser, not just to curl
 * ("Humans only... advanced security systems"). The options were to fake a
 * finding, which turns VP's diligence gate into a rubber stamp, or to change the
 * signal. VP chose to change the signal.
 *
 * What actually matters in his rules is not a star rating. It is:
 *   1. Will this interview include something he cannot pass - live coding, a SQL
 *      exercise - or something he refuses, i.e. an unpaid take-home?
 *   2. What does it pay?
 * Both are answerable from the posting itself, which is already on disk.
 *
 * ⚠ The naive version of this is a grep for "interview process", and it is
 * useless: 282 of the JDs contain that phrase and almost all of them are
 * boilerplate about disability accommodations or recruiting-fraud warnings. So
 * every signal here is matched with its surrounding sentence and boilerplate
 * contexts are discarded explicitly.
 *
 * Comp comes from the posting rather than levels.fyi. NYC pay-transparency law
 * requires a range on the posting, which makes it authoritative and free, and it
 * avoids guessing a levels.fyi company slug - the mistake that put eight wrong
 * companies in the venture config.
 *
 * Usage: node research-roles.mjs [--slug X] [--limit N] [--dry-run]
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseJd } from './lib/jd-parse.mjs';
import { canonicalizeUrl } from './lib/url-canonical.mjs';
import { extractFindings, isSubstantive } from './lib/jd-findings.mjs';
import { updateQueue } from './lib/queue-file.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const SCORES = path.join(ROOT, 'data', 'lead-scores.json');
const JDS = path.join(ROOT, 'jds');
const OUT = path.join(ROOT, 'output');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = (() => { const i = args.indexOf('--slug'); return i >= 0 ? args[i + 1] : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : null; })();

// Sentences that merely contain the words. Every one of these was a false
// positive in the first pass.
const BOILERPLATE = /(reasonable accommodation|accommodations? (throughout|during)|equal (employment )?opportunity|does not discriminate|will never (ask|request)|recruiting (team|fraud)|social security number|@ ?[a-z0-9-]+\.com email|e-verify|background check will)/i;

// Ordered by severity. `kind` drives the verdict.
const SIGNALS = [
  { kind: 'blocker', label: 'live coding',
    re: /\b(live[- ]coding|coding (challenge|exercise|assessment|interview|screen)|pair[- ]program\w*|whiteboard cod\w+|leetcode|hackerrank|codility)\b/i },
  { kind: 'blocker', label: 'SQL exercise',
    re: /\b(sql (test|exercise|assessment|challenge|screen)|write sql|sql proficiency (test|assessment))\b/i },
  { kind: 'refuse', label: 'take-home / unpaid work product',
    re: /\b(take[- ]home|homework assignment|written exercise to complete|complete an? (assignment|exercise|project) (at home|on your own)|unpaid (project|assignment)|sample (project|assignment) )\b/i },
  { kind: 'check', label: 'case study or presentation',
    re: /\b(case (study|interview)|presentation to the (team|panel)|present (your |a )?(findings|strategy|plan)|portfolio review|work sample)\b/i },
  { kind: 'info', label: 'stated round structure',
    re: /\b((two|three|four|five|\d+)[- ](stage|round|step) (interview|process)|first round|final round|onsite (interview|loop)|hiring manager screen|recruiter screen)\b/i },
];

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n{2,}/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function scanInterview(body) {
  const hits = [];
  for (const s of sentences(body)) {
    if (BOILERPLATE.test(s)) continue;
    for (const sig of SIGNALS) {
      if (sig.re.test(s)) {
        hits.push({ kind: sig.kind, label: sig.label, quote: s.slice(0, 260) });
        break;
      }
    }
  }
  // de-dup by label, keep the first (usually the clearest) quote
  const seen = new Set();
  return hits.filter(h => (seen.has(h.label) ? false : seen.add(h.label)));
}

function verdictOf(hits) {
  if (hits.some(h => h.kind === 'blocker')) return { code: 'BLOCKER', text: 'The posting describes a coding or SQL exercise. Per the standing rule this is not a candidate however good the fit.' };
  if (hits.some(h => h.kind === 'refuse')) return { code: 'TAKE-HOME RISK', text: 'The posting mentions unpaid work product. VP does not do take-homes - ask the recruiter to confirm the format before engaging.' };
  if (hits.some(h => h.kind === 'check')) return { code: 'CHECK FORMAT', text: 'A case study or presentation is mentioned. Live and time-boxed is fine; prepared unpaid work is not. Confirm which at the recruiter screen.' };
  if (hits.length) return { code: 'LOOKS CLEAR', text: 'The posting describes its process and names nothing VP cannot pass.' };
  // 41 of 42 postings land here, which is the honest state of the world rather
  // than a failure of the scan: employers very rarely publish their format. It
  // does NOT mean "researched and safe" - it means the question moves to the
  // recruiter screen, which is what the mission already instructs.
  return { code: 'NOT STATED', text: 'The posting says nothing about interview format. That is normal and not a red flag, but it is unresolved - ask at first recruiter contact, before investing in rounds.' };
}

const main = async () => {
  const queue = JSON.parse(await readFile(QUEUE, 'utf-8'));
  const scores = JSON.parse(await readFile(SCORES, 'utf-8'));
  const jdFiles = await readdir(JDS);

  // JD lookup by CANONICALISED url — not by chopping the query string.
  //
  // This said "canonicalised" and did `url.split('?')[0]`, which is the exact
  // bug enqueue-review.mjs documents having fixed on its own dedup: Stripe posts
  // every role at stripe.com/jobs/search?gh_jid=NNNN, so dropping the query
  // collapses the whole board to ONE key. Measured across the corpus: 45
  // stripped URLs collide over 674 JD files — 436 Indeed onto one key, 67
  // Stripe, 36 Elastic, 35 Databricks. Last file read wins, so a card was handed
  // a DIFFERENT requisition's posting text, and since research.md's header is
  // written from the CARD it named the right company while the interview
  // verdict, comp figure and location came from another job.
  //
  // canonicalizeUrl strips tracking parameters and KEEPS identifying ones, which
  // is the distinction that matters here.
  const byUrl = new Map();
  for (const f of jdFiles) {
    const jd = parseJd(await readFile(path.join(JDS, f), 'utf-8'), f);
    if (jd.url) byUrl.set(canonicalizeUrl(String(jd.url)), { f, jd });
  }

  let cards = queue.items.filter(i => !i.decision);
  if (ONLY) cards = cards.filter(c => c.slug === ONLY);
  if (LIMIT) cards = cards.slice(0, LIMIT);

  let done = 0, nojd = 0;
  const noteEdits = new Map();   // slug -> notes, re-applied under the lock
  const tally = {};

  for (const c of cards) {
    let hit = null;
    // scoreSource FIRST. It is the JD filename enqueue-review recorded for this
    // exact card, so it is an identity rather than a lookup. It was previously
    // only a fallback and could never fire, because the URL map above always
    // "found" something — the wrong thing.
    if (c.scoreSource && jdFiles.includes(c.scoreSource)) {
      hit = { f: c.scoreSource, jd: parseJd(await readFile(path.join(JDS, c.scoreSource), 'utf-8'), c.scoreSource) };
    }
    for (const u of hit ? [] : [c.applyUrl, c.sourceUrl]) {
      if (!u) continue;
      hit = byUrl.get(canonicalizeUrl(String(u)));
      if (hit) break;
    }
    if (!hit) { nojd++; continue; }

    const rec = scores[hit.f] || {};
    const hits = scanInterview(hit.jd.body);
    const v = verdictOf(hits);
    // What the posting ACTUALLY says, beyond interview format. Without this the
    // document was a template: 73 of 74 files said only "NOT STATED" and the
    // rest of the page was byte-identical across every role.
    const findings = extractFindings(hit.jd.body);
    const substantive = isSubstantive(findings, hits);
    tally[v.code] = (tally[v.code] || 0) + 1;

    const comp = rec.compLow
      ? `$${Number(rec.compLow).toLocaleString()}+ (from the posting${hit.jd.pay ? `: ${hit.jd.pay}` : ''})`
      : (hit.jd.pay || '_not stated on the posting_');

    const md = `# Diligence — ${c.company}: ${c.role}

**Researched: ${new Date().toISOString().slice(0, 10)}** from the employer's own posting.
**Apply:** ${c.applyUrl}

## INTERVIEW PROCESS — ${v.code}

${v.text}

${hits.length
  ? hits.map(h => `- **${h.label}** (${h.kind})\n  > ${h.quote}`).join('\n')
  : '_No interview-format language in the posting._'}

${v.code === 'NOT STATED' || v.code === 'CHECK FORMAT' || v.code === 'TAKE-HOME RISK' ? `## Ask this at the recruiter screen

The mission's standing rule: an unknown format is not a reason to skip the role,
it is a reason to ask early — "apply, then ask at first recruiter contact, before
investing in rounds." Verbatim wording to use:

> Before we go further, could you walk me through the full interview process?
> I'd like to plan around it - how many rounds, who's in each, and whether any
> of them involve work outside the interview itself, like a take-home or a
> project.

If the answer is yes:

> I don't do take-home assignments, but I'm glad to do a live working session
> of the same length - happy to dig into a real problem with your team on a call.

` : ''}## What the posting states

${findings.length
  ? findings.map(f => `- **${f.label}:** ${f.value}\n  > ${f.quote}`).join('\n')
  : '_Nothing extractable. This posting states no compensation, no experience bar,\nno office requirement and no sponsorship stance — which is itself worth knowing\nbefore spending a slot on it._'}

## Compensation

${comp}

${rec.geo ? `## Location\n\n\`${rec.geo}\`${rec.geoRaw ? ` — posting says: ${rec.geoRaw}` : ''}\n` : ''}
${substantive ? '' : `> ⚠ **NOT DILIGENCE.** This file exists but the posting yielded nothing
> decision-changing: no stated comp, no experience bar, no interview format, no
> office requirement. Treat this role as unresearched. It is recorded so the gap
> is visible rather than passing a readiness check by existing — which is exactly
> how the Glassdoor gate it replaced became a rubber stamp.
`}
---

_Glassdoor is not used. It sits behind Cloudflare and returns 403 to a real
browser, so any "no presence found" note would be fiction rather than a finding.
This reads the employer's own words instead — which is where a take-home or a
coding screen is actually disclosed._
`;

    if (!DRY) {
      await mkdir(path.join(OUT, c.slug), { recursive: true });
      await writeFile(path.join(OUT, c.slug, 'research.md'), md);
      // The card carries the verdict so ready-check and the UI can see it, and
      // the "work still owed" marker is cleared because it no longer is.
      c.research = { verdict: v.code, signals: hits.map(h => h.label), researchedAt: new Date().toISOString().slice(0, 10) };
      // IDEMPOTENT. This prepended its verdict on every run with no check for one
      // already there, and nothing skips an already-researched card, so notes
      // grew by ~600 characters per pending card per night: one card carried
      // FIVE identical copies of the same paragraph, and 54 of 108 cards had
      // verbatim-duplicated segments. ready-check.py greps these notes.
      const verdictLine = `INTERVIEW PROCESS — ${v.code}: ${v.text}${hits.length ? ' Signals: ' + hits.map(h => h.label).join(', ') + '.' : ''}`;
      const rest = String(c.notes || '')
        .replace(/ON ME:[^|]*?(?:auto-enqueued from the nightly score\.|not yet done[^|]*?\.)\s*(?:\|\|\s*)?/i, '')
        // drop any previous INTERVIEW PROCESS segment, however many there are
        .split('||')
        .map((seg) => seg.trim())
        .filter((seg) => seg && !/^INTERVIEW PROCESS —/.test(seg))
        .join(' || ');
      c.notes = rest ? `${verdictLine} || ${rest}` : verdictLine;
      noteEdits.set(c.slug, c.notes);
    }
    done++;
    console.log(`  ${String(v.code).padEnd(15)} ${c.company.slice(0, 26).padEnd(26)} ${c.role.slice(0, 42)}`);
  }

  // Re-apply the note edits to a FRESHLY read queue, under an exclusive lock.
  // Writing the copy loaded minutes ago would silently discard any decision VP
  // made in the UI while this was running - and this runs at 04:17, when the
  // enqueue step is writing the same file.
  if (!DRY && noteEdits.size) {
    await updateQueue(QUEUE, (fresh) => {
      for (const it of fresh.items) {
        if (noteEdits.has(it.slug)) it.notes = noteEdits.get(it.slug);
      }
    });
  }
  console.log(`\nresearched ${done}, no JD on disk for ${nojd}${DRY ? ' (dry run)' : ''}`);
  console.log('verdicts:', JSON.stringify(tally));
};

main().catch(e => { console.error(e); process.exit(1); });
