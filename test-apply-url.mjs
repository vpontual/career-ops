#!/usr/bin/env node

/**
 * test-apply-url.mjs — jobspy's `job_url_direct` becomes an apply URL, once.
 *
 * WHY THIS EXISTS. 351 tier-4+ Indeed roles sat unresolvable while the scrape
 * already carried the employer's own link; resolving it means following short
 * links and trackers, and the one thing that must never happen while doing so
 * is a timeout being written down as "there is no form here". The cache makes
 * that mistake permanent, so the negative-vs-unknown split is tested harder
 * than anything else in here.
 *
 * Fully offline: every fetch is a fake, and every test asserts on the fake's
 * call log, so a real network call would show up as a wrong count.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveApplyUrl, resolveApplyPath, resolveApplyPaths, isApplyableHost, hostOf,
  openCache, NOT_A_FORM,
} from './lib/apply-url.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

// A fake fetch built from a route table: { [url]: { [method]: response | [responses...] } }
// where a response is { status, location?, throws? }. Records every call.
function fakeFetch(routes) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const fn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
    const table = routes[url];
    let spec = table?.[method] ?? table?.ANY;
    if (Array.isArray(spec)) spec = spec.length > 1 ? spec.shift() : spec[0];
    if (!spec) return { status: 404, headers: { get: () => null } };
    if (spec.throws) throw spec.throws;
    return {
      status: spec.status,
      headers: { get: (n) => (n.toLowerCase() === 'location' ? spec.location ?? null : null) },
      body: { cancel: async () => {} },
    };
  };
  fn.calls = calls;
  fn.maxInFlight = () => maxInFlight;
  return fn;
}

// Fresh in-memory cache (a scratch file that does not exist yet).
const dir = mkdtempSync(join(tmpdir(), 'apply-url-'));
const scratch = (name) => join(dir, name);
const mem = () => openCache(scratch(`c-${Math.random().toString(36).slice(2)}.json`));

const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

// ── the headline case: a grnh.se short link ─────────────────────────────────
{
  const f = fakeFetch({
    'https://grnh.se/c69kr3zi1us': { ANY: { status: 301, location: 'https://job-boards.greenhouse.io/yipitdatajobs/jobs/7447264?gh_src=c69kr3zi1us' } },
    'https://job-boards.greenhouse.io/yipitdatajobs/jobs/7447264?gh_src=c69kr3zi1us': { ANY: { status: 200 } },
  });
  const cache = mem();
  const url = await resolveApplyUrl('https://grnh.se/c69kr3zi1us', { fetchImpl: f, cache });
  eq('grnh.se resolves to the Greenhouse job', url, 'https://job-boards.greenhouse.io/yipitdatajobs/jobs/7447264');
  eq('the short-link code (gh_src) is not carried', /gh_src/.test(url), false);
  eq('HEAD is tried first', f.calls[0], 'HEAD https://grnh.se/c69kr3zi1us');

  // Same raw again: nothing is fetched.
  const before = f.calls.length;
  const again = await resolveApplyUrl('https://grnh.se/c69kr3zi1us', { fetchImpl: f, cache });
  eq('a second resolution is a cache hit', again, url);
  eq('and it fetched nothing', f.calls.length, before);
  eq('the cache entry is a positive', cache.get('https://grnh.se/c69kr3zi1us').verdict, 'resolved');
  eq('the cache hit reports itself', (await resolveApplyPath('https://grnh.se/c69kr3zi1us', { fetchImpl: f, cache })).cached, true);
}

// ── a tracker that lands on an aggregator ───────────────────────────────────
{
  const f = fakeFetch({
    'https://click.appcast.io/track/abc': { ANY: { status: 302, location: 'https://www.indeed.com/viewjob?jk=abc' } },
    'https://www.indeed.com/viewjob?jk=abc': { ANY: { status: 200 } },
  });
  const cache = mem();
  const r = await resolveApplyPath('https://click.appcast.io/track/abc', { fetchImpl: f, cache });
  eq('an aggregator landing is null', r.url, null);
  eq('and it is a NEGATIVE verdict', r.verdict, 'not-a-form');
  eq('the negative is cached', cache.get('https://click.appcast.io/track/abc').verdict, 'not-a-form');
  const n = f.calls.length;
  await resolveApplyUrl('https://click.appcast.io/track/abc', { fetchImpl: f, cache });
  eq('a cached negative is not re-fetched', f.calls.length, n);
  eq('a cached negative is distinguishable from never-seen', cache.get('https://click.appcast.io/never') === undefined, true);
}

// ── already-direct URLs pass through ────────────────────────────────────────
{
  const ashby = 'https://jobs.ashbyhq.com/alternativepayments/b9c61b40-eef8-415d-95d3-d986c5be4e6b';
  const wd = 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/New-York/Product-Manager_R123';
  const f = fakeFetch({ [ashby]: { ANY: { status: 200 } }, [wd]: { ANY: { status: 200 } } });
  eq('a direct Ashby URL is unchanged', await resolveApplyUrl(ashby, { fetchImpl: f, cache: mem() }), ashby);
  eq('a direct Workday URL is unchanged', await resolveApplyUrl(wd, { fetchImpl: f, cache: mem() }), wd);
  eq('its jobspy noise is stripped first',
    await resolveApplyUrl(ashby + '?utm_source=6ZDr7J12vq', { fetchImpl: f, cache: mem() }), ashby);
}

// ── HEAD rejected → GET ─────────────────────────────────────────────────────
{
  const f = fakeFetch({
    'https://short.example/x': { HEAD: { status: 405 }, GET: { status: 301, location: 'https://boards.greenhouse.io/acme/jobs/1' } },
    'https://boards.greenhouse.io/acme/jobs/1': { HEAD: { status: 405 }, GET: { status: 200 } },
  });
  const url = await resolveApplyUrl('https://short.example/x', { fetchImpl: f, cache: mem() });
  eq('a 405 to HEAD falls back to GET', url, 'https://boards.greenhouse.io/acme/jobs/1');
  eq('the call order is HEAD, GET, HEAD, GET', f.calls.join(' | '),
    'HEAD https://short.example/x | GET https://short.example/x | HEAD https://boards.greenhouse.io/acme/jobs/1 | GET https://boards.greenhouse.io/acme/jobs/1');
}

// ── a redirect chain (the real contacthr → hodes → Oracle shape) ────────────
{
  const oracle = 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775939';
  const f = fakeFetch({
    'https://jpmorganchase.contacthr.com/153328409': { ANY: { status: 302, location: 'https://d.hodes.com/r/tp2?e=se&u=x' } },
    'https://d.hodes.com/r/tp2?e=se&u=x': { ANY: { status: 302, location: oracle + '?utm_medium=jobboard&utm_source=Indeed_Organic' } },
    [oracle + '?utm_medium=jobboard&utm_source=Indeed_Organic']: { ANY: { status: 200 } },
  });
  const r = await resolveApplyPath('https://JPMorganChase.contacthr.com/153328409', { fetchImpl: f, cache: mem() });
  eq('a three-hop chain lands on the employer', r.url, oracle);
  eq('the chain is reported', r.reason, '2 redirect(s)');
}

// ── a relative Location ─────────────────────────────────────────────────────
{
  const f = fakeFetch({
    'https://careers.example.com/go/7': { ANY: { status: 302, location: '/jobs/7?ref=indeed' } },
    'https://careers.example.com/jobs/7?ref=indeed': { ANY: { status: 200 } },
  });
  eq('a relative Location is resolved against the current URL',
    await resolveApplyUrl('https://careers.example.com/go/7', { fetchImpl: f, cache: mem() }),
    'https://careers.example.com/jobs/7');
}

// ── ⚠ the expensive one: a network failure is UNKNOWN, never a cached negative ─
{
  const f = fakeFetch({ 'https://grnh.se/slow': { ANY: { throws: timeoutErr } } });
  const cache = mem();
  const r = await resolveApplyPath('https://grnh.se/slow', { fetchImpl: f, cache });
  eq('a timeout returns no url', r.url, null);
  eq('a timeout is UNKNOWN', r.verdict, 'unknown');
  eq('and is definitely not a negative', r.verdict === 'not-a-form', false);
  eq('the reason names the cause', /network error/.test(r.reason), true);
  eq('the cache does not hold a negative for it', cache.get('https://grnh.se/slow')?.verdict, 'unknown');
  const n = f.calls.length;
  const r2 = await resolveApplyPath('https://grnh.se/slow', { fetchImpl: f, cache });
  eq('the next night tries again', f.calls.length > n, true);
  eq('and counts the attempt', cache.get('https://grnh.se/slow').attempts, 2);
  eq('a retried unknown is not reported as a cache hit', r2.cached, false);

  // Once the network recovers, the same key resolves and the unknown is replaced.
  const ok = fakeFetch({
    'https://grnh.se/slow': { ANY: { status: 301, location: 'https://boards.greenhouse.io/x/jobs/9' } },
    'https://boards.greenhouse.io/x/jobs/9': { ANY: { status: 200 } },
  });
  eq('a recovered link resolves on the next attempt',
    await resolveApplyUrl('https://grnh.se/slow', { fetchImpl: ok, cache }), 'https://boards.greenhouse.io/x/jobs/9');
  eq('and the unknown entry becomes a positive', cache.get('https://grnh.se/slow').verdict, 'resolved');
}

{
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND grnh.se'), { code: 'ENOTFOUND' });
  const f = fakeFetch({ 'https://grnh.se/dns': { ANY: { throws: dns } } });
  eq('a DNS failure is unknown', (await resolveApplyPath('https://grnh.se/dns', { fetchImpl: f, cache: mem() })).verdict, 'unknown');
}

{
  // A 5xx, a 429 and a dead short link are all "not tonight", not "no form".
  const f = fakeFetch({
    'https://grnh.se/five': { ANY: { status: 503 } },
    'https://grnh.se/rate': { ANY: { status: 429 } },
    'https://grnh.se/gone': { ANY: { status: 404 } },
  });
  const cache = mem();
  for (const k of ['five', 'rate', 'gone']) {
    const r = await resolveApplyPath(`https://grnh.se/${k}`, { fetchImpl: f, cache });
    eq(`an HTTP ${r.reason} answer is unknown`, r.verdict, 'unknown');
  }
}

{
  // A 403 on an EMPLOYER host is bot-blocking; the URL is still the form.
  // A 403 on a redirector is a wall we could not see past.
  const wd = 'https://acme.wd1.myworkdayjobs.com/External/job/NYC/PM_R1';
  const f = fakeFetch({ [wd]: { ANY: { status: 403 } }, 'https://grnh.se/blocked': { ANY: { status: 403 } } });
  eq('a 403 from Workday still passes the URL through', await resolveApplyUrl(wd, { fetchImpl: f, cache: mem() }), wd);
  eq('a 403 from a redirector is unknown',
    (await resolveApplyPath('https://grnh.se/blocked', { fetchImpl: f, cache: mem() })).verdict, 'unknown');
}

{
  // A redirector that serves a 200 page (JS redirect we cannot follow) is a
  // definite dead end — the server answered — and is cached so it is not
  // fetched nightly.
  const f = fakeFetch({ 'https://click.appcast.io/js': { ANY: { status: 200 } } });
  const cache = mem();
  const r = await resolveApplyPath('https://click.appcast.io/js', { fetchImpl: f, cache });
  eq('landing on a redirector is a negative', r.verdict, 'not-a-form');
  eq('with a reason a human can read', r.reason, 'landed on a redirector');
  eq('which is cached', cache.get('https://click.appcast.io/js').verdict, 'not-a-form');
}

{
  // Loops and runaway chains are unknown (cheap to retry, never a fact).
  const f = fakeFetch({
    'https://a.example/1': { ANY: { status: 302, location: 'https://a.example/2' } },
    'https://a.example/2': { ANY: { status: 302, location: 'https://a.example/1' } },
  });
  eq('a redirect loop is unknown', (await resolveApplyPath('https://a.example/1', { fetchImpl: f, cache: mem() })).verdict, 'unknown');
  const routes = {};
  for (let i = 0; i < 20; i++) routes[`https://b.example/${i}`] = { ANY: { status: 302, location: `https://b.example/${i + 1}` } };
  eq('too many hops is unknown', (await resolveApplyPath('https://b.example/0', { fetchImpl: fakeFetch(routes), cache: mem(), maxHops: 5 })).verdict, 'unknown');
  const noloc = fakeFetch({ 'https://c.example/x': { ANY: { status: 302 } } });
  eq('a 3xx without Location is unknown', (await resolveApplyPath('https://c.example/x', { fetchImpl: noloc, cache: mem() })).verdict, 'unknown');
}

// ── canonicalization is the shared one, actually applied ────────────────────
{
  const f = fakeFetch({
    'https://grnh.se/gh': { ANY: { status: 301, location: 'https://boards.greenhouse.io/acme/jobs/4?gh_jid=4&gh_src=gh&utm_source=indeed&fbclid=zzz' } },
    'https://boards.greenhouse.io/acme/jobs/4?gh_jid=4&gh_src=gh&utm_source=indeed&fbclid=zzz': { ANY: { status: 200 } },
  });
  const url = await resolveApplyUrl('https://grnh.se/gh', { fetchImpl: f, cache: mem() });
  eq('tracking params are stripped and gh_jid is kept', url, 'https://boards.greenhouse.io/acme/jobs/4?gh_jid=4');

  const rx = 'https://www.metacareers.com/jobs/1380781410053356/';
  const g = fakeFetch({
    'https://jsv3.recruitics.com/redirect?rx_url=x': { ANY: { status: 302, location: rx + '?rx_viewer=0a0f856f' } },
    [rx + '?rx_viewer=0a0f856f']: { ANY: { status: 200 } },
  });
  eq('a per-request rx_viewer token is dropped', await resolveApplyUrl('https://jsv3.recruitics.com/redirect?rx_url=x', { fetchImpl: g, cache: mem() }), rx);

  // Two raw spellings of one link share one cache entry.
  const h = fakeFetch({ [rx]: { ANY: { status: 200 } } });
  const cache = mem();
  await resolveApplyUrl(rx + '?utm_source=indeed', { fetchImpl: h, cache });
  await resolveApplyUrl(rx + '?utm_campaign=jobs', { fetchImpl: h, cache });
  eq('the cache is keyed on the cleaned input', h.calls.length, 1);
}

// ── the cache file ──────────────────────────────────────────────────────────
{
  const path = scratch('persist.json');
  const f = fakeFetch({ 'https://jobs.ashbyhq.com/acme/1': { ANY: { status: 200 } } });
  await resolveApplyUrl('https://jobs.ashbyhq.com/acme/1', { fetchImpl: f, cache: openCache(path) });
  eq('the cache is written through', existsSync(path), true);
  eq('and is valid JSON', typeof JSON.parse(readFileSync(path, 'utf-8')), 'object');
  const reopened = openCache(path);
  const g = fakeFetch({});
  eq('a reopened cache answers without fetching',
    await resolveApplyUrl('https://jobs.ashbyhq.com/acme/1', { fetchImpl: g, cache: reopened }), 'https://jobs.ashbyhq.com/acme/1');
  eq('zero calls', g.calls.length, 0);
}

{
  const corrupt = scratch('corrupt.json'); writeFileSync(corrupt, '{ not json');
  const empty = scratch('empty.json'); writeFileSync(empty, '');
  const array = scratch('array.json'); writeFileSync(array, '[1,2]');
  eq('a corrupt cache file starts fresh', Object.keys(openCache(corrupt).entries).length, 0);
  eq('an empty cache file starts fresh', Object.keys(openCache(empty).entries).length, 0);
  eq('a cache file of the wrong shape starts fresh', Object.keys(openCache(array).entries).length, 0);
  eq('a missing cache file starts fresh', Object.keys(openCache(scratch('nope/none.json')).entries).length, 0);
  eq('an untouched cache is not saved', openCache(scratch('nope/none.json')).save() && !existsSync(scratch('nope/none.json')), true);
  const f = fakeFetch({ 'https://jobs.ashbyhq.com/acme/2': { ANY: { status: 200 } } });
  const c = openCache(corrupt);
  await resolveApplyUrl('https://jobs.ashbyhq.com/acme/2', { fetchImpl: f, cache: c });
  eq('a corrupt file is overwritten with a good one', Object.keys(JSON.parse(readFileSync(corrupt, 'utf-8'))).length, 1);
  eq('a missing parent directory is created', (await resolveApplyPath('https://jobs.ashbyhq.com/acme/2', { fetchImpl: f, cache: openCache(scratch('deep/er/cache.json')) })).verdict, 'resolved');
}

// ── degenerate inputs never throw and never fetch ───────────────────────────
{
  const f = fakeFetch({});
  for (const bad of [null, undefined, '', '   ', '/jobs/1', 'mailto:hr@acme.com', 'not a url', 'ftp://acme.com/j', 'javascript:alert(1)', 123, {}, 'https://']) {
    let got;
    try { got = await resolveApplyUrl(bad, { fetchImpl: f, cache: mem() }); } catch (e) { got = `THREW ${e.message}`; }
    eq(`garbage input ${JSON.stringify(bad)} is null`, got, null);
  }
  eq('garbage input never fetches', f.calls.length, 0);
  eq('garbage input is reported as invalid', (await resolveApplyPath('mailto:x@y', { fetchImpl: f, cache: mem() })).verdict, 'invalid');
}

// ── the host predicate is enqueue-review's rule, verbatim ───────────────────
eq('indeed.com is not a form', isApplyableHost('https://www.indeed.com/viewjob?jk=1'), false);
eq('a bare indeed hostname is not a form', isApplyableHost('indeed.com'), false);
eq('glassdoor, linkedin, ziprecruiter, lensa, jobot are not forms',
  ['glassdoor.com', 'www.linkedin.com', 'ziprecruiter.com', 'lensa.com', 'jobot.com'].some(isApplyableHost), false);
eq('a host that merely CONTAINS the word is fine', isApplyableHost('https://myindeed.example.com/j/1'), true);
eq('Ashby is a form', isApplyableHost('https://jobs.ashbyhq.com/x/y'), true);
eq('an empty host is not applyable', isApplyableHost(''), false);
eq('garbage is not applyable', isApplyableHost(null), false);
eq('hostOf lowercases', hostOf('https://JPMorganChase.contacthr.com/1'), 'jpmorganchase.contacthr.com');
eq('the pattern is the one in enqueue-review.mjs', NOT_A_FORM.source,
  '(^|\\.)(indeed\\.com|glassdoor\\.com|linkedin\\.com|ziprecruiter\\.com|lensa\\.com|jobot\\.com)$');

// ── batches are sequential ──────────────────────────────────────────────────
{
  const routes = {};
  for (let i = 0; i < 6; i++) routes[`https://jobs.ashbyhq.com/acme/${i}`] = { ANY: { status: 200 } };
  const f = fakeFetch(routes);
  const rs = await resolveApplyPaths(Object.keys(routes), { fetchImpl: f, cache: mem() });
  eq('every row is resolved', rs.filter(r => r.verdict === 'resolved').length, 6);
  eq('never more than one request in flight', f.maxInFlight(), 1);
  eq('a null list is an empty result', (await resolveApplyPaths(null, { fetchImpl: f, cache: mem() })).length, 0);
}

rmSync(dir, { recursive: true, force: true });

let pass = 0, fail = 0;
console.log('\napply-url — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nA timeout cached as "no form" buries a live role for good; an aggregator cached as a form hands VP a card he cannot fill in.');
  process.exitCode = 1;
}
