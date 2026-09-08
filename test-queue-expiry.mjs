#!/usr/bin/env node

/**
 * test-queue-expiry.mjs — a card's age is live, expiry is reversible, and
 * failing to observe is never a verdict.
 *
 * WHY THIS EXISTS. The review queue was a ratchet: from 2026-08-13 to
 * 2026-09-02 no undecided card ever left it except by VP's click. `ageDays`
 * was written once at mint, and the nightly re-gate re-checked score and geo
 * but never recency. On 2026-09-02, 131 of 277 pending cards were past the
 * window that would have refused to MINT them, the badge trailed reality by a
 * median 19 days, and the first cards on the page were minted 5-6 August and
 * read "1d".
 *
 * The rules pinned here, in order of authority:
 *   1. only an UNDECIDED card can expire; approved/rejected/hold are VP's record
 *   2. an unreadable JD or a posting with no date leaves the card exactly as is
 *   3. the window is lib/freshness.mjs's, per track and per employer
 *   4. an expired card whose live recency is back inside its window revives
 *      with a RELISTED note - and a rejection never revives
 *   5. expiry is reversible by the UI's `clear`, and nothing is deleted
 */

import { decideExpiry, applyExpiryDecision, knownDeadFromArchive } from './enqueue-review.mjs';
import { maxAgeDaysFor, FRESH_MAX_AGE_DAYS, CIVIC_MAX_AGE_DAYS, EVERGREEN_MAX_AGE_DAYS } from './lib/freshness.mjs';
import { loadReposts, repostNote } from './lib/repost.mjs';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

const NOW = '2026-09-02T04:17:00.000Z';
const card = (o = {}) => ({
  slug: 'acme-senior-pm', company: 'Acme', role: 'Senior Product Manager',
  applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
  score: 5, ageDays: 1, track: 'pm', notes: 'SCORER: fine.', decision: null, decidedAt: null, ...o,
});
const obs = (ageDays, extra = {}) => ({ ageDays, postedAt: '2026-08-01', updatedAt: null, ...extra });
const pm = (c) => maxAgeDaysFor(c);   // the shared table, not a private copy
const opts = (c, extra = {}) => ({ maxAgeDays: pm(c), now: NOW, ...extra });

// ── 1. A card past its window expires; one inside it does not ─────────────
{
  const c = card();
  const d = decideExpiry(c, obs(pm(c) + 1), opts(c));
  eq('a pm card one day past the 21d window expires', d.action, 'expire');
  eq('it is marked expired', d.patch.decision, 'expired');
  eq('decidedAt is stamped', d.patch.decidedAt, NOW);
  eq('expiredWhy names the age and the window', /22d old, past the 21d window for pm/.test(d.patch.expiredWhy), true);
  eq('the honest age is written with it', d.patch.ageDays, 22);
  eq('it expects the card to still be undecided when applied', d.expects, null);

  const inside = decideExpiry(card({ ageDays: 3 }), obs(pm(c)), opts(c));
  eq('a card exactly AT the window does not expire', inside.action === 'expire', false);
  eq('but its age badge is corrected', inside.action, 'refresh');
  eq('to the live recency', inside.patch.ageDays, pm(c));
  eq('with no decision change', 'decision' in inside.patch, false);

  const same = decideExpiry(card({ ageDays: 5, postedAt: '2026-08-01', updatedAt: null }), obs(5), opts(c));
  eq('a badge that is already right is left alone', same.action, 'none');
}

// ── 2. Per-track windows differ — the table in lib/freshness.mjs decides ──
{
  const civic = card({ track: 'civic', company: 'DEPARTMENT OF FINANCE' });
  const pmc = card({ track: 'pm' });
  eq('the civic window is wider than pm (precondition)', CIVIC_MAX_AGE_DAYS > FRESH_MAX_AGE_DAYS, true);
  eq('a 40-day civic card survives', decideExpiry(civic, obs(40), opts(civic)).action !== 'expire', true);
  eq('a 40-day pm card does not', decideExpiry(pmc, obs(40), opts(pmc)).action, 'expire');
  // Per-employer, too: a whale gets 30, an evergreen board 7.
  const policy = { isWhale: (n) => /anthropic/i.test(n), isEvergreen: (n) => /sierra/i.test(n) };
  const whale = card({ company: 'Anthropic' });
  const ever = card({ company: 'Sierra' });
  eq('a 25-day whale card survives its 30d window',
     decideExpiry(whale, obs(25), { maxAgeDays: maxAgeDaysFor(whale, policy), now: NOW }).action !== 'expire', true);
  eq('a 10-day card on an evergreen board expires at 7d',
     decideExpiry(ever, obs(10), { maxAgeDays: maxAgeDaysFor(ever, policy), now: NOW }).action, 'expire');
  eq('(and 7 really is the evergreen window)', maxAgeDaysFor(ever, policy), EVERGREEN_MAX_AGE_DAYS);
}

// ── 3. A decision is VP's record. Never expire approved / rejected / hold ──
{
  for (const decision of ['approved', 'rejected', 'hold']) {
    const c = card({ decision, decidedAt: '2026-08-10T00:00:00.000Z' });
    const d = decideExpiry(c, obs(90), opts(c));
    eq(`a ${decision} card 90 days old is never expired`, d.action, 'none');
    eq(`...and carries no patch at all`, d.patch, undefined);
    // Even a known-dead requisition does not touch a decided card.
    eq(`a ${decision} card known dead is still untouched`,
       decideExpiry(c, obs(90), opts(c, { deadReason: 'ats: req gone (pipeline-archive 2026-08-20)' })).action, 'none');
  }
}

// ── 4. Failing to observe is not a verdict ───────────────────────────────
{
  const c = card({ ageDays: 1 });
  eq('an unreadable JD (null observation) leaves the card untouched', decideExpiry(c, null, opts(c)).action, 'none');
  eq('...and says why', decideExpiry(c, null, opts(c)).why, 'unobserved');
  eq('a JD with no date (null recency) leaves the card untouched', decideExpiry(c, obs(null), opts(c)).action, 'none');
  eq('a NaN recency leaves the card untouched', decideExpiry(c, obs(NaN), opts(c)).action, 'none');
  eq('an unobserved card is not even re-badged', decideExpiry(c, null, opts(c)).patch, undefined);
  eq('no window at all (NaN) is not a verdict either', decideExpiry(c, obs(500), { maxAgeDays: NaN, now: NOW }).action, 'none');
  // The one thing that CAN expire an unobservable pending card is a positive
  // death record from prune-stale - an observation, not the absence of one.
  const dead = decideExpiry(c, null, opts(c, { deadReason: 'ats: req gone (pipeline-archive 2026-08-20)' }));
  eq('a known-dead req expires even with no readable JD', dead.action, 'expire');
  eq('...and expiredWhy carries the evidence', /known dead: ats: req gone/.test(dead.patch.expiredWhy), true);
  eq('...without inventing an age it never observed', 'ageDays' in dead.patch, false);
}

// ── 5. Revival clears `expired` and notes RELISTED ───────────────────────
{
  const c = card({ decision: 'expired', decidedAt: '2026-08-20T04:17:00.000Z', ageDays: 30,
                   expiredWhy: '30d old, past the 21d window for pm' });
  const d = decideExpiry(c, obs(2, { updatedAt: '2026-08-31' }), opts(c));
  eq('an expired card back inside its window revives', d.action, 'revive');
  eq('decision returns to null', d.patch.decision, null);
  eq('decidedAt is cleared', d.patch.decidedAt, null);
  eq('expiredWhy is cleared', d.patch.expiredWhy, null);
  eq('revivedAt is stamped', d.patch.revivedAt, '2026-09-02');
  eq('the live age is written', d.patch.ageDays, 2);
  eq('updatedAt is carried onto the card', d.patch.updatedAt, '2026-08-31');
  eq('the note says RELISTED', /RELISTED/.test(d.patch.notes), true);
  eq('the note records when it had expired', /was expired 2026-08-20/.test(d.patch.notes), true);
  eq('the original notes survive', /SCORER: fine\./.test(d.patch.notes), true);
  eq('it expects the card to still be expired when applied', d.expects, 'expired');

  // With scan-history evidence of a relist, lib/repost.mjs's own note is used
  // rather than a second wording of it.
  const dir = mkdtempSync(path.join(tmpdir(), 'expiry-'));
  const tsv = path.join(dir, 'scan-history.tsv');
  writeFileSync(tsv, ['url\tfirst_seen\tcompany\ttitle',
    'https://x/1\t2026-07-01\tAcme\tSenior Product Manager',
    'https://x/2\t2026-08-30\tAcme\tSenior Product Manager'].join('\n') + '\n');
  const reposts = loadReposts(tsv);
  unlinkSync(tsv);
  const note = repostNote(reposts, 'Acme', 'Senior Product Manager');
  eq('(precondition) repost.mjs sees the relist', /RELISTED/.test(note), true);
  const viaRepost = decideExpiry(c, obs(2), opts(c, { relistNote: note }));
  eq('the repost note is reused verbatim', viaRepost.patch.notes.startsWith(note), true);

  // Still past the window: stays expired, badge kept honest.
  const still = decideExpiry(c, obs(45), opts(c));
  eq('an expired card still past its window stays expired', still.action, 'refresh');
  eq('...with no decision change', 'decision' in still.patch, false);
  eq('...but an honest age', still.patch.ageDays, 45);
  eq('an expired card with nothing observable is untouched', decideExpiry(c, null, opts(c)).action, 'none');
}

// ── 6. Revival never resurrects a rejection ──────────────────────────────
{
  const r = card({ decision: 'rejected', decidedAt: '2026-08-20T00:00:00.000Z', notes: 'REJECTED: comp too low.' });
  const d = decideExpiry(r, obs(1, { updatedAt: '2026-09-01' }), opts(r, { relistNote: '↻ RELISTED: ...' }));
  eq('a rejected role relisted yesterday stays rejected', d.action, 'none');
  eq('...with no patch', d.patch, undefined);
  const a = card({ decision: 'approved', decidedAt: '2026-08-20T00:00:00.000Z' });
  eq('an approved role is not "revived" either', decideExpiry(a, obs(1), opts(a)).action, 'none');
}

// ── 7. Expiry is reversible by `clear` — and nothing is deleted ──────────
{
  const c = card();
  const d = decideExpiry(c, obs(40), opts(c));
  const live = { ...c };
  eq('the patch applies to the live card', applyExpiryDecision(live, d), true);
  eq('the card is expired', live.decision, 'expired');
  eq('the card is still there, same slug', live.slug, 'acme-senior-pm');
  eq('its notes are intact', live.notes, 'SCORER: fine.');
  // Exactly what ui/app/api/review/route.ts does on `clear`.
  live.decision = null; live.decidedAt = null;
  eq('after clear the card is undecided again', live.decision, null);
  // Back inside its window (the employer touched it): a plain pending card,
  // and the stale expiredWhy is cleaned off it.
  const again = decideExpiry(live, obs(3), opts(live));
  eq('a cleared card back inside its window is not re-expired', again.action, 'refresh');
  eq('...and the stale expiredWhy is cleared', again.patch.expiredWhy, null);
  // Still past its window: it is pending, so the rule applies again next run.
  eq('a cleared card still past its window is subject to the rule again',
     decideExpiry(live, obs(40), opts(live)).action, 'expire');
}

// ── 8. The writer refuses when VP got there first ────────────────────────
{
  const c = card();
  const d = decideExpiry(c, obs(40), opts(c));
  const clickedMeanwhile = { ...c, decision: 'rejected', decidedAt: NOW };
  eq('a card VP rejected during the run is NOT expired over him', applyExpiryDecision(clickedMeanwhile, d), false);
  eq('...and keeps his decision', clickedMeanwhile.decision, 'rejected');
  const e = card({ decision: 'expired', decidedAt: '2026-08-20T00:00:00.000Z' });
  const rev = decideExpiry(e, obs(2), opts(e));
  const clearedMeanwhile = { ...e, decision: null, decidedAt: null };
  eq('a revival is skipped when the card was already cleared', applyExpiryDecision(clearedMeanwhile, rev), false);
  eq('a none-decision applies nothing', applyExpiryDecision({ ...c }, { action: 'none', expects: null }), false);
}

// ── 9. Only a POSITIVE death in pipeline-archive.md counts as known dead ─
{
  const archive = `# Pipeline archive

- 2026-07-31 | age 120d | https://job-boards.greenhouse.io/anthropic/jobs/1 | Anthropic | PM
- 2026-08-06 | ats: req gone | https://job-boards.greenhouse.io/successacademy/jobs/2 | Success Academy | Teacher
- 2026-08-12 | no JD after 8d | https://jobot.com/x/3 | Jobot | Head of Product
- 2026-07-31 | not a posting (search url) | https://stripe.com/jobs/search | Stripe | PM
- 2026-08-15 | page: The job you are looking for is no longer open | https://jobs.lever.co/acme/4?utm_source=x | Acme | PM
`;
  const dead = knownDeadFromArchive(archive);
  eq('ats: req gone is known dead', [...dead.keys()].some((u) => /successacademy\/jobs\/2/.test(u)), true);
  eq('a positive page verdict is known dead', [...dead.keys()].some((u) => /lever\.co\/acme\/4/.test(u)), true);
  eq('the reason carries the archive date', [...dead.values()].some((r) => /ats: req gone \(pipeline-archive 2026-08-06\)/.test(r)), true);
  eq('age alone is NOT death', [...dead.keys()].some((u) => /anthropic/.test(u)), false);
  eq('a never-fetched JD is NOT death', [...dead.keys()].some((u) => /jobot/.test(u)), false);
  eq('a search URL is NOT death', [...dead.keys()].some((u) => /stripe/.test(u)), false);
  eq('exactly two deaths', dead.size, 2);
  eq('empty text is an empty map', knownDeadFromArchive('').size, 0);
}

let pass = 0;
const fails = [];
for (const [l, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  x ${l}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`\nqueue-expiry — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log('\nExpiring a live role, or a decided one, is worse than leaving a stale card up.\n'); process.exit(1); }
console.log('');
