/**
 * Canonical company/title normalization + dedup key — the single source of
 * truth, replacing the drifted inline copies in rank-leads.mjs,
 * stage-applications.mjs, verify-pipeline.mjs, and ui/lib/pipeline.ts.
 *
 * Design note (validated against real jds/ data 2026-07-22): unlike the
 * upstream port, `normalizeTitle` does NOT delete parentheticals — it strips
 * punctuation but KEEPS the words inside them. Dropping "(AI CMO)" /
 * "(Guest Lifecycle)" collapsed genuinely distinct roles at the same company
 * (Owner.com had 3 different Senior PM roles merge into 1). Keeping paren
 * content merges only true formatting variants (e.g. "PM II - X" ≡ "PM II, X")
 * while preserving distinct roles.
 */

/** Lowercase, strip everything non-alphanumeric. Null-safe. */
export function normalizeCompany(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Lowercase, strip non-alphanumeric — but keep parenthetical CONTENT (the words
 * inside `()` survive; only the punctuation is removed). This is the deliberate
 * divergence from the upstream impl. Null-safe.
 */
export function normalizeTitle(title) {
  return String(title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The dedup key: `company::title`. Stable, order-independent within a run. */
export function canonKey(company, title) {
  return `${normalizeCompany(company)}::${normalizeTitle(title)}`;
}
