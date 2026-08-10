#!/usr/bin/env node

/**
 * resolve-via-search.mjs — a SECOND, narrower way to find the employer's own
 * posting, for roles the board-API resolver cannot reach.
 *
 * ── Why this is a separate file ──────────────────────────────────────────
 * `resolve-apply-paths.mjs` earned a safety property: it accepts a guessed slug
 * ONLY when that employer's board carries a posting whose canonical title is
 * EXACTLY the one we want. Measurement on 2026-08-10 showed a search fallback
 * bolted into that file would have weakened it. SWORD Health is on Lever under
 * a slug the guesser already generates; the board path compared
 * `Product Marketing Lead` against `Product Marketing Lead, Enterprise` and
 * `…, Payor`, matched neither, and correctly REFUSED. A laxer search path in the
 * same file would have accepted whichever one search ranked first.
 * So the proven path is not touched. This is additive and strictly narrower.
 *
 * ── What the measurement said ────────────────────────────────────────────
 * A permissive rule ("company name appears on the page, title appears in the
 * <title>") was measured over 51 real rows: 22 resolutions, **4 correct — 18%.**
 * Every failure class the rule existed to stop got through:
 *   - WRONG COMPANY: `Rippling | Product Manager` -> ats.rippling.com/moneyhash/…
 *     which is MoneyHash. ats.rippling.com is Rippling's ATS PRODUCT hosting its
 *     customers' boards. The host proves the vendor, never the employer.
 *   - WRONG REQ: substring title matching took `Sr Digital Product Manager` for
 *     `Digital Product Manager` (Gartner has no such req), and
 *     `Senior Product Manager, Service Delivery` for `Senior Product Manager`
 *     while the exact req sat on the same board.
 *   - DEAD POSTING: a jobright.ai page reading "This job has closed" was accepted.
 *   - NOT A FORM: 14 of 22 accepts were aggregator hosts absent from every
 *     blocklist - teal, ladders, remotive, builtin, dice, shine. Swapping an
 *     Indeed page for a Teal page resolves NOTHING; these rows are unresolved
 *     precisely because there is no form to fill.
 *
 * The 4 correct answers shared one shape: the employer's OWN domain, ranked
 * first (Bank of America, Capital One x2, Citi). So this file accepts only that
 * shape, and restores exact-title equality. A blocklist is an unbounded
 * enumeration and was measured leaking 10 distinct hosts in a 51-row sample;
 * an ALLOWLIST of "the company's own registrable domain" cannot leak that way.
 *
 * ── It never writes to pipeline.md ───────────────────────────────────────
 * Output goes to data/resolve-candidates.md for a human. A wrong row in
 * pipeline.md is close to irreversible: prune-stale only archives on age or
 * ATS-death, and its liveness check understands only greenhouse/ashby/lever, so
 * a wrong-but-live URL on any other host never leaves. Undoing one by hand means
 * editing five files. Precision is not high enough to earn auto-append, and it
 * has to be demonstrated over real runs before it ever could be.
 *
 * Usage: node resolve-via-search.mjs [--dry-run] [--limit N]
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeTitle, normalizeCompany } from './lib/canonical.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

// ⚠ NOT localhost. This runs as `docker compose run --rm applier`, and the
// applier service has no network_mode:host and no extra_hosts, while searxng
// sits on its own docker network published on the HOST. Verified from inside a
// real applier container: localhost:8888 is ECONNREFUSED, the host IP answers
// 200. A design measured over ssh on the host would have shipped resolving zero.
// No default, and deliberately no hardcoded host: this is a PUBLIC fork and the
// pre-commit hook blocks RFC1918 addresses. Set SEARXNG_URL in .env, which the
// applier service loads via env_file and which is gitignored.
const SEARX = process.env.SEARXNG_URL;

// searxng is SHARED with marginalia, agentlens and veephone. Measured: ~60
// queries at 1.5s spacing exhausted every upstream engine (brave, duckduckgo,
// google cse, startpage all "Suspended"), and 24 TooManyRequests landed in its
// log. A 280-query burst would run dry after ~50 rows AND degrade three other
// services. So this drains the backlog over a fortnight instead, from a cursor.
const MAX_QUERIES = Number(process.env.RESOLVE_MAX_QUERIES || 25);
const SPACING_MS = Number(process.env.RESOLVE_SPACING_MS || 2500);
const BUDGET_MS = Number(process.env.RESOLVE_BUDGET_MS || 420000);

const CANDIDATES = path.join(ROOT, 'data', 'resolve-candidates.md');
const LOGFILE = path.join(ROOT, 'data', 'resolve-log.jsonl');
const CURSOR = path.join(ROOT, 'data', 'resolve-search-cursor.json');
const UNRESOLVED = path.join(ROOT, 'data', 'unresolved-apply-paths.md');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Every fetch is bounded. node's fetch has NO default timeout, and nightly.sh
// wraps no step in `timeout(1)` - one hung request hangs the whole 4am chain,
// and the next night's cron would start a second run appending to the same
// unlocked files.
async function get(url, ms = 12000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' },
    signal: AbortSignal.timeout(ms),
  });
  return r.ok ? r : null;
}

/** The registrable domain, minus the public suffix. bankofamerica.com -> bankofamerica */
export function registrable(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length < 2) return '';
  // co.uk, com.br and friends: drop two labels, else one.
  const twoLevel = /^(co|com|net|org|gov|ac)$/.test(parts[parts.length - 2]);
  return parts[parts.length - (twoLevel ? 3 : 2)] || '';
}

/**
 * THE ACCEPTANCE RULE. Both halves are required, and each one alone was
 * measured letting a real wrong answer through.
 *
 *   1. The host's registrable domain must equal the normalized company name.
 *      This is what rejects teal/ladders/remotive/builtin/dice/shine/jobright
 *      without enumerating them, and it is an allowlist so it cannot leak.
 *   2. normalizeTitle EQUALITY, never `includes`. This is what rejects
 *      MoneyHash on ats.rippling.com ("Product Manager [Mid-Level & Senior]
 *      [Remote | EMEA]" != "Product Manager"), Gartner's "Sr Digital Product
 *      Manager", and LawnStarter's "…, Service Delivery".
 */
export function accepts(url, company, wantTitle, titles, hiringOrg = '') {
  let host;
  try { host = new URL(url).hostname; } catch { return { ok: false, why: 'unparseable url' }; }
  const co = normalizeCompany(company);

  // Branch 1 — the employer's OWN domain. This is the shape all 4 correct
  // answers in the measured sample had (Bank of America, Capital One x2, Citi).
  let identity = registrable(host) === co ? `own domain ${host}` : null;

  // Branch 2 — an ATS-hosted board whose SLUG or hiringOrganization names this
  // company. This exists because the unguessable slugs live here and are the
  // whole reason search beats slug-guessing: Affinity's board is
  // jobs.ashbyhq.com/affinity.co, First Due's is greenhouse/
  // localitymediallcdbafirstdue ("Locality Media LLC dba First Due"). The slug
  // check is what stops branch 2 from becoming the MoneyHash bug: searching
  // Rippling returned ats.rippling.com/MONEYHASH/..., whose slug is not
  // Rippling, and ats.rippling.com is Rippling's ATS PRODUCT, not its board.
  if (!identity && ATS_HOST.test(host)) {
    const slugPath = String(new URL(url).pathname || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (co && co.length >= 4 && slugPath.includes(co)) identity = `ats slug matches ${company}`;
    else if (hiringOrg && normalizeCompany(hiringOrg) === co) identity = `hiringOrganization is ${company}`;
  }
  if (!identity) return { ok: false, why: `${host} is neither ${company}'s own domain nor an ATS board naming it` };

  // EQUALITY, never `includes`. Substring matching is what took
  // "Sr Digital Product Manager" for "Digital Product Manager", and
  // "Senior Product Manager, Service Delivery" for "Senior Product Manager"
  // while the exact req sat on the same board. It is also the second guard that
  // rejects MoneyHash, whose title is "Product Manager [Mid-Level & Senior]...".
  const hit = (titles || []).find(t => normalizeTitle(t) === normalizeTitle(wantTitle));
  if (!hit) return { ok: false, why: `no EXACT title match (saw: ${(titles || []).slice(0, 2).join(' | ').slice(0, 80)})` };
  return { ok: true, proof: hit, identity };
}

const ATS_HOST = /(greenhouse\.io|ashbyhq\.com|lever\.co|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|successfactors|jobvite\.com|workable\.com|phenompeople|eightfold\.ai|taleo\.net)$/i;

/** Titles the page claims: JSON-LD JobPosting first, then <title>/<h1>. */
export function hiringOrg(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      for (const node of (Array.isArray(j) ? j : [j, ...(j['@graph'] || [])])) {
        if (node && node['@type'] === 'JobPosting') {
          const n = node.hiringOrganization?.name || node.hiringOrganization;
          if (typeof n === 'string' && n) return n;
        }
      }
    } catch {}
  }
  return '';
}

export function pageTitles(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      for (const node of (Array.isArray(j) ? j : [j, ...(j['@graph'] || [])])) {
        if (node && node['@type'] === 'JobPosting' && node.title) out.push(String(node.title));
      }
    } catch { /* malformed ld+json is common; ignore */ }
  }
  const t = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (t) out.push(t[1].replace(/\s+/g, ' ').trim());
  for (const m of html.matchAll(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/gi)) {
    out.push(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return out.filter(Boolean);
}

/** A closed req still ranks in search. One was accepted in the measured sample. */
export const DEAD = /\b(this (job|position|posting) (has )?(is )?(closed|expired|no longer)|no longer accepting|applications? (are )?closed|position has been filled)\b/i;

async function searxng(q) {
  const r = await get(`${SEARX}/search?q=${encodeURIComponent(q)}&format=json`, 20000);
  if (!r) return { results: [], suspended: true };
  const d = await r.json();
  const unresponsive = d.unresponsive_engines || [];
  // ⚠ searxng answers HTTP 200 with results:[] when its engines are rate
  // limited. That is INDISTINGUISHABLE from an honest "found nothing", which is
  // exactly the invisible-failure class nightly.sh's header was written to end.
  return { results: d.results || [], suspended: unresponsive.length >= 4 && (d.results || []).length === 0 };
}

const main = async () => {
  const started = Date.now();

  // Preflight. Without this the step reports a clean "resolved 0" through a
  // total outage - the network is unreachable from this container by default.
  if (!SEARX) {
    console.error('resolve-via-search: SEARXNG_URL is not set. Add it to .env — it must be ' +
      'reachable FROM THE applier CONTAINER, which cannot see the host\'s localhost.');
    process.exit(1);
  }
  const pre = await searxng('"Staff Product Manager" Vanta').catch(() => null);
  if (!pre || pre.suspended || !pre.results.length) {
    console.error(`resolve-via-search: PREFLIGHT FAILED against ${SEARX} — ` +
      `unreachable or every upstream engine suspended. Refusing to run, because ` +
      `a silent zero here is indistinguishable from an honest miss.`);
    process.exit(1);
  }

  const rows = [];
  if (existsSync(UNRESOLVED)) {
    for (const line of readFileSync(UNRESOLVED, 'utf-8').split('\n')) {
      const m = /^- \[ \] \[(\d)\] (.+?) \| (.+?) \| (\d+)d \| (\S+)/.exec(line.trim());
      if (m) rows.push({ tier: +m[1], company: m[2].trim(), role: m[3].trim(), age: +m[4], url: m[5] });
    }
  }
  let cursor = 0;
  try { cursor = JSON.parse(readFileSync(CURSOR, 'utf-8')).cursor || 0; } catch {}
  if (cursor >= rows.length) cursor = 0;

  const budget = Math.min(MAX_QUERIES, rows.length);
  console.log(`resolve-via-search: ${rows.length} unresolved rows; starting at ${cursor}, ` +
              `${budget} queries this run (searxng is shared - see header)\n`);

  let queried = 0, accepted = 0, rejected = 0;
  const found = [];
  for (let i = 0; i < budget; i++) {
    if (Date.now() - started > BUDGET_MS) { console.log('  time budget reached, stopping cleanly'); break; }
    const row = rows[(cursor + i) % rows.length];
    if (!row) continue;
    if (queried) await sleep(SPACING_MS);
    const q = `"${row.role}" ${row.company}`;
    const { results, suspended } = await searxng(q).catch(() => ({ results: [], suspended: true }));
    queried++;
    if (suspended) {
      console.error('  searxng engines all suspended — stopping so this does not report zero as success');
      process.exitCode = 1;
      break;
    }
    let hit = null;
    const tried = [];
    for (const r of results.slice(0, 8)) {
      if (!r.url) continue;
      let verdict;
      try { verdict = accepts(r.url, row.company, row.role, [r.title || '']); }
      catch { continue; }
      // Cheap domain check first, so we only fetch pages that could possibly pass.
      if (!verdict.ok && /is neither/.test(verdict.why)) { tried.push({ url: r.url, why: verdict.why }); continue; }
      const page = await get(r.url, 12000).catch(() => null);
      if (!page) { tried.push({ url: r.url, why: 'fetch failed' }); continue; }
      const html = await page.text().catch(() => '');
      if (DEAD.test(html)) { tried.push({ url: r.url, why: 'posting reads as closed' }); continue; }
      const v2 = accepts(r.url, row.company, row.role, pageTitles(html), hiringOrg(html));
      if (v2.ok) { hit = { url: r.url, proof: v2.proof, identity: v2.identity }; break; }
      tried.push({ url: r.url, why: v2.why });
    }
    const rec = {
      ts: new Date().toISOString(), query: q, company: row.company, role: row.role,
      sourceUrl: row.url, tier: row.tier, resolved: hit ? hit.url : null,
      proof: hit ? hit.proof : null, candidates: tried.slice(0, 6),
    };
    if (!DRY) await appendFile(LOGFILE, JSON.stringify(rec) + '\n');
    if (hit) {
      accepted++;
      console.log(`  [${row.tier}] ${row.company} | ${row.role.slice(0, 44)}`);
      console.log(`        -> ${hit.url.slice(0, 96)}`);
      console.log(`        proof: exact title "${hit.proof.slice(0, 60)}" on the company's own domain`);
      found.push(`- [ ] [${row.tier}] ${row.company} | ${row.role} | ${hit.url}\n      proof: exact title "${hit.proof}" via ${hit.identity}\n      from: ${row.url}`);
    } else rejected++;
  }

  if (!DRY) {
    await writeFile(CURSOR, JSON.stringify({ cursor: (cursor + queried) % Math.max(1, rows.length), ts: new Date().toISOString() }, null, 2));
    if (found.length) {
      const header = `# Search-resolved candidates — REVIEW BEFORE USE\n\n` +
        `Written by resolve-via-search.mjs on ${new Date().toISOString().slice(0, 10)}.\n\n` +
        `These were found by web search, NOT by the employer's board API. The rule is\n` +
        `narrow (the company's own registrable domain + EXACT title equality) because a\n` +
        `permissive version measured 18% precision. Nothing here is in pipeline.md and\n` +
        `nothing will act on it until a human moves it there.\n\n`;
      const prev = existsSync(CANDIDATES) ? readFileSync(CANDIDATES, 'utf-8').replace(/^#[\s\S]*?\n\n(?=- |\s*$)/, '') : '';
      await writeFile(CANDIDATES, header + found.join('\n') + '\n' + prev);
    }
  }
  console.log(`\nqueried ${queried}, accepted ${accepted}, rejected ${rejected}` +
              `${found.length ? ` — wrote ${found.length} to data/resolve-candidates.md for review` : ''}`);
  console.log(`cursor now at ${(cursor + queried) % Math.max(1, rows.length)} of ${rows.length}`);
};

// Guarded so the acceptance rule can be imported and tested without firing a
// single search - the same pattern rank-leads.mjs uses.
if (process.argv[1] && process.argv[1].endsWith('resolve-via-search.mjs')) {
  main().catch(err => { console.error(err); process.exit(1); });
}
