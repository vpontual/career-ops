/**
 * Canonical job-URL normalization at INGEST — the single source of truth used by
 * all three lead appenders (scan.mjs, fetch-gmail-leads.mjs, resolve-lensa.mjs).
 *
 * Root-cause fix for the URL drift the `company::title` join papers over: the
 * appenders used to strip DIFFERENT tracking params (gmail stripped 24, lensa
 * only 12, scan stripped none), so the same posting landed under several URL
 * variants. Canonicalizing identically at write time collapses them to one row.
 *
 * Design: strip only TRACKING params (utm/click-ids/session/position/etc.);
 * KEEP identifying params (e.g. Greenhouse `gh_jid`, Ashby ids) — those select
 * the actual job. A small host allowlist strips the entire query where the bare
 * path is canonical.
 */

// Tracking-only query params that don't change which job a URL points to.
export const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "token", "position", "count", "jpsi", "ccaon", "jobstop",
  "mc_cid", "mc_eid", "fbclid", "gclid", "msclkid", "_hsenc", "_hsmi",
  "trk", "trkinfo", "refid", "recommendedflavor",
  "ref", "src", "source",
]);

// Hosts where the entire query string is tracking and the bare path is canonical.
// Explicit list because some hosts (Greenhouse via gh_jid) rely on a query param.
export const STRIP_ALL_QUERY_HOSTS = new Set([
  "app.welcometothejungle.com",
  "www.welcometothejungle.com",
]);

/**
 * Return the canonical form of a job URL: tracking params removed, identifying
 * params kept, hash dropped. Returns the input unchanged if it can't be parsed.
 */
export function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (STRIP_ALL_QUERY_HOSTS.has(host)) {
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.set(k, v);
    }
    u.search = keep.toString();
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}
