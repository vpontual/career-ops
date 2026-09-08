/**
 * Turn jobspy's `job_url_direct` into an apply URL worth carrying.
 *
 * WHY THIS EXISTS. 61% of qualifying discovery arrives via Indeed, and 351
 * tier-4+ roles sat in data/unresolved-apply-paths.md because an Indeed
 * `viewjob` link has no form on it. resolve-apply-paths.mjs spent ~43 minutes a
 * night (04:05→04:48) guessing employer board slugs to reconstruct the apply URL
 * and resolved 24 of 459. Meanwhile the scrape already carried the answer and
 * threw it away: jobspy sets `job_url_direct` to the employer's own link —
 * 40 of 40 rows on a live query, 12 of 12 on 2026-09-02.
 *
 * What that raw value looks like, measured 2026-09-02:
 *   - a Greenhouse short link  `https://grnh.se/c69kr3zi1us`
 *       → 301 → job-boards.greenhouse.io/<board>/jobs/<id>?gh_src=<code>
 *   - a `*.contacthr.com/<n>` link → 302 → d.hodes.com pixel tracker → Oracle HCM
 *   - `jsv3.recruitics.com/redirect?…rx_url=…` → 302 → employer, plus a
 *     per-request `rx_viewer` token that differs on every hop
 *   - already-direct Ashby / Google / eightfold / icims / Workday URLs, dressed
 *     in utm_* and `indeed-apply-token` noise.
 * grnh.se and contacthr both answered HEAD and GET identically, but the HEAD →
 * GET fallback stays: many hosts reject HEAD and a 405 must not become "unknown".
 *
 * ⚠ THE DISTINCTION THAT MATTERS: a NEGATIVE ("this resolves to a page with no
 * form") is a verdict about the data and is cached for good. An UNKNOWN ("we
 * could not find out" — timeout, DNS, reset, 5xx, 429, a dead short link) is a
 * verdict about tonight's network and is NEVER cached as a negative. Recording a
 * network failure as a fact about the posting is this repo's single most
 * expensive recurring bug; check-liveness.mjs's header and
 * test-liveness-verdict.mjs both exist because of it.
 *
 * ⚠ TWO COPIES OF ONE RULE. `NOT_A_FORM` below is character-for-character the
 * regex in enqueue-review.mjs. Two copies of a rule drifting silently is a
 * documented recurring bug class here (prune-stale vs stage-applications,
 * gmail vs lensa vs scan tracking params). enqueue-review's copy should
 * collapse onto `isApplyableHost` from this module; it was out of scope for
 * the change that added this file.
 *
 * Network I/O is injectable (`opts.fetchImpl`) so the tests run offline, and
 * requests are SEQUENTIAL — never fan out; project rule, same as Playwright.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { canonicalizeUrl } from './url-canonical.mjs';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CACHE_PATH = resolvePath(ROOT, 'data', 'apply-url-cache.json');

// Aggregator pages: no form on them. Identical to enqueue-review.mjs — see header.
export const NOT_A_FORM = /(^|\.)(indeed\.com|glassdoor\.com|linkedin\.com|ziprecruiter\.com|lensa\.com|jobot\.com)$/i;

// Hosts whose only job is to redirect. Landing on one with a 200 means the hop
// was a JS/meta redirect we cannot follow, and a 4xx from one means the link
// itself is broken — neither is "the employer blocked our bot".
export const REDIRECTOR_HOSTS = /(^|\.)(grnh\.se|appcast\.io|contacthr\.com|recruitics\.com|hodes\.com)$/i;

// Params the REDIRECT HOP itself adds, which url-canonical.mjs does not yet
// know. `gh_src` is Greenhouse's source tag (the short-link code, so the same
// job reached via two Indeed rows gets two URLs); `rx_viewer` changes per
// request; the icims trio is Indeed's apply hand-off.
// ⚠ These belong in TRACKING_PARAMS in lib/url-canonical.mjs. That file was out
// of scope for this change; move them there and delete this set — do not let
// it grow into a second canonicalizer.
// (Moved into TRACKING_PARAMS in lib/url-canonical.mjs on 2026-09-02, so
// canonicalizeUrl strips them for every caller rather than just this one.
// Two copies of a stripping rule drifting apart is the documented bug that
// produced 168 pipeline rows for 49 postings.)

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/** Hostname of a URL or a bare hostname; '' if unparseable. */
export function hostOf(urlOrHost) {
  const s = String(urlOrHost ?? '').trim();
  if (!s) return '';
  try { return new URL(s).hostname.toLowerCase(); } catch { /* not a URL */ }
  return /^[a-z0-9.-]+$/i.test(s) ? s.toLowerCase() : '';
}

/** True when a form can plausibly live on this host. Accepts a URL or a hostname. */
export function isApplyableHost(urlOrHost) {
  const h = hostOf(urlOrHost);
  return !!h && !NOT_A_FORM.test(h);
}

function isRedirector(url) {
  return REDIRECTOR_HOSTS.test(hostOf(url));
}

/** Absolute http(s) URL or null. Never throws: mailto:, relative, ftp, junk → null. */
function parseHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u;
  } catch { return null; }
}

function clean(url) {
  return canonicalizeUrl(url);
}

// ── cache ───────────────────────────────────────────────────────────────────
//
// One JSON object keyed by the cleaned raw URL. Entry shapes:
//   { verdict: 'resolved',   url, final, hops, at }
//   { verdict: 'not-a-form', url: null, final, reason, at }   ← cached negative
//   { verdict: 'unknown',    attempts, lastError, at }         ← NOT a negative;
//                                                                always retried
// Absent key = never seen. `unknown` is written only so the nightly report can
// see how often a link is failing; lookups treat it exactly like absent.

export function openCache(path = DEFAULT_CACHE_PATH) {
  let entries = {};
  try {
    const text = readFileSync(path, 'utf-8');
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed;
  } catch {
    // ⚠ Missing, empty or corrupt: start fresh. A cache that throws takes the
    // whole enqueue step down with it, and this file is a memo, not a record.
    entries = {};
  }
  const cache = {
    path,
    entries,
    dirty: false,
    get(key) { return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined; },
    set(key, entry) { entries[key] = entry; cache.dirty = true; },
    save() {
      if (!cache.dirty) return true;
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(entries, null, 1));
        renameSync(tmp, path);
        cache.dirty = false;
        return true;
      } catch (err) {
        console.error(`apply-url: could not save cache ${path}: ${err.message}`);
        return false;
      }
    },
  };
  return cache;
}

let defaultCache = null;
function cacheFor(opts) {
  if (opts.cache === false) return null;
  if (opts.cache) return opts.cache;
  if (!defaultCache) defaultCache = openCache(opts.cachePath ?? DEFAULT_CACHE_PATH);
  return defaultCache;
}

// ── network ─────────────────────────────────────────────────────────────────

async function request(fetchImpl, url, method, timeoutMs) {
  const res = await fetchImpl(url, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' },
  });
  // We never read a body; release it so undici does not hold the socket.
  try { await res.body?.cancel?.(); } catch { /* fake or already consumed */ }
  return res;
}

// HEAD first, GET on anything that looks like "HEAD not welcome". A 4xx on HEAD
// is retried as GET because hosts answer 403/404/405 to HEAD and 200 to GET.
async function probe(fetchImpl, url, timeoutMs) {
  let res = await request(fetchImpl, url, 'HEAD', timeoutMs);
  if (res.status >= 400) res = await request(fetchImpl, url, 'GET', timeoutMs);
  return res;
}

/**
 * Follow redirects from `start`. Returns
 *   { ok: true,  final, hops }                      landed on a 2xx (or a 4xx that
 *                                                   reads as bot-blocking on an
 *                                                   employer host)
 *   { ok: false, unknown: true,  reason, final? }   could not find out
 *   { ok: false, unknown: false, reason, final }    a definite dead end
 */
async function follow(start, { fetchImpl, timeoutMs, maxHops }) {
  const seen = new Set();
  let url = start;
  for (let hops = 0; hops <= maxHops; hops++) {
    if (seen.has(url)) return { ok: false, unknown: true, reason: 'redirect loop', final: url };
    seen.add(url);

    let res;
    try {
      res = await probe(fetchImpl, url, timeoutMs);
    } catch (err) {
      // ⚠ Timeout, DNS, reset, TLS — WE failed. Not a fact about the link.
      return { ok: false, unknown: true, reason: `network error: ${String(err?.message ?? err).split('\n')[0]}`, final: url };
    }
    const status = res.status;

    if (status >= 300 && status < 400) {
      const loc = res.headers?.get?.('location');
      if (!loc) return { ok: false, unknown: true, reason: `${status} without Location`, final: url };
      let next;
      try { next = new URL(loc, url).toString(); }
      catch { return { ok: false, unknown: true, reason: `unparseable Location ${loc}`, final: url }; }
      url = next;
      continue;
    }

    if (status >= 200 && status < 300) {
      if (isRedirector(url)) {
        // The tracker served a page instead of a redirect (JS or meta refresh).
        // That is the server's answer, not a network failure: a definite dead end.
        return { ok: false, unknown: false, reason: 'landed on a redirector', final: url };
      }
      return { ok: true, final: url, hops };
    }

    if (status === 401 || status === 403) {
      // Bot-blocking on an employer host (Workday, Cloudflare fronts) — the URL
      // is the form; liveness is another gate's job. On a redirector it means
      // we could not get through, which is not knowledge.
      if (isRedirector(url)) return { ok: false, unknown: true, reason: `${status} from redirector`, final: url };
      return { ok: true, final: url, hops };
    }

    // 404/410 on a short link is "gone today", not "no form" — Greenhouse blips
    // and a re-check costs one request. 429/5xx are the host's bad night.
    return { ok: false, unknown: true, reason: `HTTP ${status}`, final: url };
  }
  return { ok: false, unknown: true, reason: `more than ${maxHops} redirects`, final: url };
}

// ── public ──────────────────────────────────────────────────────────────────

/**
 * Full result:
 *   { url, verdict: 'resolved' | 'not-a-form' | 'unknown' | 'invalid', reason, cached }
 * `url` is non-null only for 'resolved'.
 */
export async function resolveApplyPath(raw, opts = {}) {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return { url: null, verdict: 'invalid', reason: 'not an absolute http(s) URL', cached: false };

  const key = clean(parsed.toString());
  const cache = cacheFor(opts);
  const hit = cache?.get(key);
  if (hit && (hit.verdict === 'resolved' || hit.verdict === 'not-a-form')) {
    return { url: hit.url ?? null, verdict: hit.verdict, reason: hit.reason ?? 'cache', cached: true };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxHops = opts.maxHops ?? 10;
  const at = (opts.now ?? (() => new Date()))().toISOString();

  const r = await follow(key, { fetchImpl, timeoutMs, maxHops });

  let entry, out;
  if (r.ok) {
    const url = clean(r.final);
    if (isApplyableHost(url)) {
      entry = { verdict: 'resolved', url, final: r.final, hops: r.hops, at };
      out = { url, verdict: 'resolved', reason: r.hops ? `${r.hops} redirect(s)` : 'direct', cached: false };
    } else {
      entry = { verdict: 'not-a-form', url: null, final: url, reason: `aggregator ${hostOf(url)}`, at };
      out = { url: null, verdict: 'not-a-form', reason: entry.reason, cached: false };
    }
  } else if (r.unknown) {
    entry = { verdict: 'unknown', attempts: (hit?.attempts ?? 0) + 1, lastError: r.reason, at };
    out = { url: null, verdict: 'unknown', reason: r.reason, cached: false };
  } else {
    entry = { verdict: 'not-a-form', url: null, final: r.final, reason: r.reason, at };
    out = { url: null, verdict: 'not-a-form', reason: r.reason, cached: false };
  }

  if (cache) { cache.set(key, entry); cache.save(); }
  return out;
}

/**
 * The employer's real apply URL, or null. Null covers both "no form there"
 * and "could not find out tonight" — use resolveApplyPath when the difference
 * matters (it does for anything that writes a decision down).
 */
export async function resolveApplyUrl(raw, opts = {}) {
  return (await resolveApplyPath(raw, opts)).url;
}

/** Resolve many, one at a time. Never fans out. */
export async function resolveApplyPaths(raws, opts = {}) {
  const out = [];
  for (const raw of raws ?? []) out.push(await resolveApplyPath(raw, opts));
  return out;
}
