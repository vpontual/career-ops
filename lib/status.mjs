/**
 * Canonical application-status normalization — the single source of truth,
 * replacing the six drifted copies (verify-pipeline, followup-cadence,
 * analyze-patterns, dedup-tracker on the reader side; normalize-statuses,
 * merge-tracker on the writer side).
 *
 * THE BUG THIS FIXES (ROADMAP): the copies split into two casing camps —
 * readers canonicalized to lowercase (`applied`), writers to Title-case
 * (`Applied`). They only interoperated because readers `.toLowerCase()` first.
 *
 * THE DISCIPLINE: canonical statuses are **lowercase** internally (matches the
 * readers' many downstream comparisons, so they stay drop-in). `applications.md`
 * remains human-readable Title-case — writers call `toDisplay()` at write time.
 */

// Internal canonical vocabulary — lowercase.
export const CANONICAL_STATUSES = [
  "evaluated", "applied", "responded", "interview",
  "offer", "rejected", "discarded", "skip",
];

// alias (lowercase) → canonical (lowercase). Superset of both former camps.
export const ALIASES = {
  evaluada: "evaluated", condicional: "evaluated", hold: "evaluated", evaluar: "evaluated", verificar: "evaluated",
  aplicado: "applied", enviada: "applied", aplicada: "applied", applied: "applied", sent: "applied",
  respondido: "responded",
  entrevista: "interview",
  oferta: "offer",
  rechazado: "rejected", rechazada: "rejected",
  descartado: "discarded", descartada: "discarded", cerrada: "discarded", cancelada: "discarded",
  "no aplicar": "skip", no_aplicar: "skip", skip: "skip", monitor: "skip", "geo blocker": "skip",
};

// Dedup survivor ranking (higher wins). Canonical + legacy Spanish keys kept for
// backward-compat with existing tracker rows that were never re-normalized.
export const STATUS_RANK = {
  skip: 0, discarded: 0, rejected: 1, evaluated: 2, applied: 3, responded: 4, interview: 5, offer: 6,
  no_aplicar: 0, "no aplicar": 0, descartado: 0, descartada: 0,
  rechazado: 1, rechazada: 1, evaluada: 2, aplicado: 3, respondido: 4, entrevista: 5, oferta: 6,
};

// canonical (lowercase) → display (the exact Title-case spelling on disk).
const DISPLAY = {
  evaluated: "Evaluated", applied: "Applied", responded: "Responded", interview: "Interview",
  offer: "Offer", rejected: "Rejected", discarded: "Discarded", skip: "SKIP",
};

/** Strip markdown bold + trailing date, lowercase, trim. */
function clean(raw) {
  return String(raw ?? "")
    .replace(/\*\*/g, "")
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Simple normalizer (reader path): resolve aliases, else pass through the
 * cleaned lowercase value. Mirrors the old reader `normalizeStatus`.
 */
export function normalizeStatus(raw) {
  const c = clean(raw);
  return ALIASES[c] || c;
}

/** Map a canonical (lowercase) status to its on-disk Title-case display form. */
export function toDisplay(canonical) {
  return DISPLAY[canonical] || canonical;
}

/**
 * Rich classifier (writer path): full regex + alias + canonical resolution.
 * Returns { status: <lowercase canonical | null>, moveToNotes?, unknown? }.
 * Mirrors the old writer `normalize-statuses.mjs` logic, in lowercase.
 */
export function classifyStatus(raw) {
  const s = String(raw ?? "").replace(/\*\*/g, "").trim();

  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) return { status: "discarded", moveToNotes: String(raw).trim() };
  if (/^repost/i.test(s)) return { status: "discarded", moveToNotes: String(raw).trim() };
  if (/^cerrada$/i.test(s) || /^cancelada/i.test(s) || /^descartada$/i.test(s) || /^descartado$/i.test(s)) return { status: "discarded" };
  if (/^rechazada?$/i.test(s) || /^rechazado\s+\d{4}/i.test(s)) return { status: "rejected" };
  if (/^aplicado\s+\d{4}/i.test(s)) return { status: "applied" };
  if (/^(condicional|hold|evaluar|verificar)$/i.test(s)) return { status: "evaluated" };
  if (/^monitor$/i.test(s) || /geo.?blocker/i.test(s)) return { status: "skip" };
  if (s === "—" || s === "-" || s === "") return { status: "discarded" };

  const stripped = clean(s);
  if (CANONICAL_STATUSES.includes(stripped)) return { status: stripped };
  if (ALIASES[stripped]) return { status: ALIASES[stripped] };

  return { status: null, unknown: true };
}

/** Normalize then rank (0 if unknown). Used for dedup survivor selection. */
export function statusRank(raw) {
  return STATUS_RANK[normalizeStatus(raw)] ?? 0;
}
