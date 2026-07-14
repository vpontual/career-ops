import { readFile, stat, readdir } from "fs/promises";
import path from "path";
import { loadInboxLeads } from "./inbox-leads";

// Path to the career-ops repo root, mounted from docker-compose.
// Inside the container we see it at /data (compose bind-mount).
const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";

export type PipelineStatus = "new" | "under_review" | "applied" | "rejected" | "archived";

export interface PipelineRow {
  url: string;
  company: string;
  role: string;
  locations: string[];
  status: PipelineStatus;
  checked: boolean;
  score?: number; // present once a report has been written
  reportPath?: string;
  postedDaysAgo?: number;       // from the JD's Posted line (or report if no JD)
  updatedDaysAgo?: number;      // from the JD's Updated line, when present
  legitimacyTier?: string;      // legacy field (from scoring report when present)
  computedLegitimacy?: "fresh" | "mature" | "stale" | "ancient" | "reposted" | "ghost-likely";
  stagedSlug?: string;          // present if output/{slug}/cover-letter.md exists for this URL
  ats?: "greenhouse" | "ashby" | "lever" | "other";
  appliedAt?: string;           // ISO date parsed from applications.md (e.g. "2026-05-13")

  // Fields joined from inbox-leads.md (rank-leads.mjs output). Present only on
  // rows the ranker has decided to include — the "Ranked" tab on the home
  // page renders these inline so /ranked doesn't need to be a separate route.
  tier?: number;        // 1-5 from the markdown's "## Score N" section
  archetype?: string;   // e.g. "Senior PM" / "AI Product PM"
  verdict?: string;     // one-sentence fit summary
  redFlags?: string;    // text after the "— ⚠" split, when present
}

export interface PipelineData {
  rows: PipelineRow[];
  lastScannedAt: Date | null;
  totalCount: number;
  byStatus: Record<PipelineStatus, number>;
}

// Parses lines like:
//   - [ ] https://job-boards.greenhouse.io/foo/123 | Company | Role Title | NYC | Remote
function parsePipelineLine(line: string): PipelineRow | null {
  const match = line.match(/^-\s*\[(x|\s)\]\s*(\S+)\s*\|\s*(.+)$/);
  if (!match) return null;

  const checked = match[1] === "x";
  const url = match[2];
  const rest = match[3].split("|").map(s => s.trim()).filter(Boolean);
  if (rest.length < 2) return null;

  const [company, role, ...locationParts] = rest;
  const locations = locationParts.flatMap(l =>
    // Some listings pipe-join multiple locations in a single field ("SF; NYC")
    l.split(/[;•]/).map(x => x.trim()).filter(Boolean)
  );

  return {
    url,
    company,
    role,
    locations,
    status: checked ? "applied" : "new",
    checked
  };
}

async function maybeStat(p: string): Promise<Date | null> {
  try {
    const s = await stat(p);
    return s.mtime;
  } catch {
    return null;
  }
}

async function readApplicationsMd(): Promise<Map<string, { status: PipelineStatus; appliedAt?: string }>> {
  const map = new Map<string, { status: PipelineStatus; appliedAt?: string }>();
  try {
    const content = await readFile(path.join(DATA_ROOT, "data", "applications.md"), "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/(https?:\/\/\S+)/);
      if (!m) continue;
      const url = m[1];
      const lower = line.toLowerCase();
      let status: PipelineStatus = "under_review";
      if (lower.includes("rejected") || lower.includes("pass")) status = "rejected";
      else if (lower.includes("applied") || lower.includes("submitted")) status = "applied";
      else if (lower.includes("archived") || lower.includes("ignore")) status = "archived";
      // Parse the date appended by /api/status: "Applied 2026-05-13" or "Applied 2026-05-13 — note"
      const dateM = line.match(/(\d{4}-\d{2}-\d{2})/);
      const appliedAt = status === "applied" && dateM ? dateM[1] : undefined;
      map.set(url, { status, appliedAt });
    }
  } catch {
    // no applications.md yet
  }
  return map;
}

// Cache: maps URL -> staged slug so we only walk output/ once per request.
let stagedCache: Map<string, string> | null = null;
async function loadStagedIndex(): Promise<Map<string, string>> {
  if (stagedCache) return stagedCache;
  const map = new Map<string, string>();
  try {
    const outputDir = path.join(DATA_ROOT, "output");
    const dirs = await readdir(outputDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const mdPath = path.join(outputDir, d.name, "cover-letter.md");
      try {
        const content = await readFile(mdPath, "utf-8");
        const m = content.match(/\*\*URL:\*\*\s+(\S+)/);
        if (m) map.set(m[1], d.name);
      } catch {
        // no cover letter in this dir
      }
    }
  } catch {}
  stagedCache = map;
  return map;
}

function detectAts(url: string): "greenhouse" | "ashby" | "lever" | "other" {
  if (/greenhouse\.io/.test(url)) return "greenhouse";
  if (/ashbyhq\.com/.test(url)) return "ashby";
  if (/lever\.co/.test(url)) return "lever";
  return "other";
}

// Cross-request pipeline cache. Invalidated by:
//   - mtime of pipeline.md (rewritten by scan/rank 4am cron + /api/leads)
//   - mtime of applications.md (manual status edits via /api/status)
//   - the local date string — because rows hold computed `postedDaysAgo` /
//     `updatedDaysAgo` values that need to advance at midnight even when no
//     underlying file has changed. Without this, a cache built at 11pm would
//     keep serving yesterday's age numbers all of today.
let pipelineCache: {
  data: PipelineData;
  pipelineMtime: number;
  appsMtime: number;
  inboxMtime: number;
  dayKey: string;
} | null = null;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fileMtime(p: string): Promise<number> {
  try { return (await stat(p)).mtimeMs; } catch { return 0; }
}

// Cache JD lookups so we don't walk jds/ on every request. Day-keyed so
// `posted`/`updated` (computed from Date.now()) advance at midnight even if
// loadPipeline's per-request reset never fires (e.g. /ranked only call site).
type JdMeta = { posted?: number; updated?: number; locations?: string[]; score?: number; verdict?: string; redFlags?: string };
let jdMetaCache: Map<string, JdMeta> | null = null;
let jdMetaCacheDay: string | null = null;

// Compute days between an ISO timestamp and now. Returns undefined if the
// string isn't a valid date. Floored, never negative.
function daysAgo(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const ms = Date.now() - t;
  if (ms < 0) return 0;
  return Math.floor(ms / 86400000);
}

export async function loadJdMetaIndex(): Promise<Map<string, JdMeta>> {
  const today = todayKey();
  if (jdMetaCache && jdMetaCacheDay === today) return jdMetaCache;
  const map = new Map<string, JdMeta>();

  // rank-leads.mjs's score cache, keyed by JD filename. This is the single
  // scoring authority (score-all.mjs and its reports/ dir were retired); the
  // UI must read scores from here or every freshly-scored role shows "unscored".
  let leadScores: Record<string, { score?: number; verdict?: string; redFlags?: string }> = {};
  try {
    leadScores = JSON.parse(await readFile(path.join(DATA_ROOT, "data", "lead-scores.json"), "utf-8"));
  } catch { /* no scores yet */ }

  try {
    const jdsDir = path.join(DATA_ROOT, "jds");
    const files = await readdir(jdsDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const text = await readFile(path.join(jdsDir, f), "utf-8");
      const urlM = text.match(/\*\*URL:\*\*\s+(\S+)/);
      if (!urlM) continue;
      const sc = leadScores[f];

      // Prefer the ISO timestamp in `**Posted:** 2025-11-14T13:25:57-05:00 (158 days ago)`
      // and recompute days against today. The parenthetical was frozen at fetch
      // time and is wrong by 1 day for every day since first fetch.
      const postedIsoM = text.match(/\*\*Posted:\*\*\s+(\d{4}-\d{2}-\d{2}(?:T\S+)?)/);
      const updatedIsoM = text.match(/\*\*Updated:\*\*\s+(\d{4}-\d{2}-\d{2}(?:T\S+)?)/);
      const postedFrozenM = text.match(/\*\*Posted:\*\*[^(]*\((\d+)\s+days?\s+ago\)/i);
      const updatedFrozenM = text.match(/\*\*Updated:\*\*[^(]*\((\d+)\s+days?\s+ago\)/i);

      const posted =
        daysAgo(postedIsoM?.[1]) ??
        (postedFrozenM ? parseInt(postedFrozenM[1], 10) : undefined);
      const updated =
        daysAgo(updatedIsoM?.[1]) ??
        (updatedFrozenM ? parseInt(updatedFrozenM[1], 10) : undefined);

      const locationM = text.match(/\*\*Location:\*\*\s+(.+)/);
      const locations = locationM
        ? locationM[1].split(/[|;•]/).map(s => s.trim()).filter(Boolean)
        : undefined;
      map.set(urlM[1], {
        posted, updated, locations,
        score: typeof sc?.score === "number" ? sc.score : undefined,
        verdict: sc?.verdict,
        redFlags: sc?.redFlags
      });
    }
  } catch {}
  jdMetaCache = map;
  jdMetaCacheDay = today;
  return map;
}

// Compute a legitimacy tier from posted + updated days. Updated date matters
// because a 200-day-old listing that was updated last week is almost certainly
// still active, while one that was last touched 200 days ago is dead.
function computeLegitimacy(posted: number | undefined, updated: number | undefined): PipelineRow["computedLegitimacy"] {
  if (posted == null) return undefined;
  // Fresh / mature / stale based on whichever signal is most recent
  const effective = updated != null && updated < posted ? updated : posted;
  if (posted > 90 && (updated == null || updated > 30)) {
    return posted > 180 ? "ghost-likely" : "ancient";
  }
  if (posted > 30 && updated != null && updated <= 30) {
    return "reposted"; // old original posting but recently re-touched
  }
  if (effective <= 5) return "fresh";
  if (effective <= 30) return "mature";
  return "stale";
}

async function findReportForUrl(url: string): Promise<{
  path: string;
  score?: number;
  postedDaysAgo?: number;
  legitimacyTier?: string;
  locations?: string[];
} | null> {
  // Reports are generated with various filename schemes depending on the mode.
  // For P1 we just glob reports/ and look for any file that mentions this URL.
  try {
    const reportsDir = path.join(DATA_ROOT, "reports");
    const entries = await readdir(reportsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const fp = path.join(reportsDir, entry);
      const content = await readFile(fp, "utf-8");
      if (!content.includes(url)) continue;
      const scoreMatch = content.match(/(?:Global|Score|Overall)[^0-9]*([1-5](?:\.\d)?)\s*\/\s*5/i);
      const daysMatch = content.match(/\((\d+)\s+days\s+ago\)/i);
      const tierMatch = content.match(/\*\*Legitimacy tier:\*\*\s+(\S+)/);
      const locMatch = content.match(/\*\*Location \(from JD\):\*\*\s+(.+)/);
      const locations = locMatch
        ? locMatch[1].split(/[|;•]/).map(s => s.trim()).filter(Boolean)
        : undefined;
      return {
        path: fp,
        score: scoreMatch ? parseFloat(scoreMatch[1]) : undefined,
        postedDaysAgo: daysMatch ? parseInt(daysMatch[1], 10) : undefined,
        legitimacyTier: tierMatch ? tierMatch[1] : undefined,
        locations
      };
    }
  } catch {
    // reports/ may be empty
  }
  return null;
}

export async function loadPipeline(): Promise<PipelineData> {
  const pipelinePath = path.join(DATA_ROOT, "data", "pipeline.md");
  const appsPath = path.join(DATA_ROOT, "data", "applications.md");
  const inboxPath = path.join(DATA_ROOT, "data", "inbox-leads.md");

  const [pipelineMtime, appsMtime, inboxMtime] = await Promise.all([
    fileMtime(pipelinePath),
    fileMtime(appsPath),
    fileMtime(inboxPath)
  ]);
  const dayKey = todayKey();

  if (
    pipelineCache &&
    pipelineCache.pipelineMtime === pipelineMtime &&
    pipelineCache.appsMtime === appsMtime &&
    pipelineCache.inboxMtime === inboxMtime &&
    pipelineCache.dayKey === dayKey &&
    pipelineMtime !== 0
  ) {
    return pipelineCache.data;
  }

  let raw = "";
  try {
    raw = await readFile(pipelinePath, "utf-8");
  } catch {
    return {
      rows: [],
      lastScannedAt: null,
      totalCount: 0,
      byStatus: { new: 0, under_review: 0, applied: 0, rejected: 0, archived: 0 }
    };
  }

  const manualStatuses = await readApplicationsMd();
  stagedCache = null; // reset per-request
  jdMetaCache = null; // reset per-request
  const stagedIndex = await loadStagedIndex();
  const jdMetaIndex = await loadJdMetaIndex();

  const rows: PipelineRow[] = [];
  for (const line of raw.split("\n")) {
    const row = parsePipelineLine(line);
    if (!row) continue;

    // Overlay manual status from applications.md if present
    const manual = manualStatuses.get(row.url);
    if (manual) {
      row.status = manual.status;
      if (manual.appliedAt) row.appliedAt = manual.appliedAt;
    }

    // JD-derived metadata: posted/updated dates and locations. Available even
    // when no scoring report has been generated yet.
    const jdMeta = jdMetaIndex.get(row.url);
    if (jdMeta) {
      row.postedDaysAgo = jdMeta.posted;
      row.updatedDaysAgo = jdMeta.updated;
      if (jdMeta.locations && jdMeta.locations.length > 0) {
        row.locations = jdMeta.locations;
      }
      // Score from the live scorer (lead-scores.json). This is the authoritative
      // source now that score-all.mjs/reports/ are retired.
      if (typeof jdMeta.score === "number") {
        row.score = jdMeta.score;
        row.tier = jdMeta.score;
        if (jdMeta.verdict) row.verdict = jdMeta.verdict;
        if (jdMeta.redFlags) row.redFlags = jdMeta.redFlags;
      }
    }
    row.computedLegitimacy = computeLegitimacy(row.postedDaysAgo, row.updatedDaysAgo);

    // Legacy fallback: a matching score-all report (reports/) if this row wasn't
    // scored by rank-leads. Only fills score when jdMeta didn't already.
    const report = await findReportForUrl(row.url);
    if (report) {
      row.reportPath = report.path;
      if (row.score == null) row.score = report.score;
      // Report's legitimacy tier text is authoritative when present, but we
      // intentionally do NOT take report.postedDaysAgo — that field is parsed
      // from a frozen "(X days ago)" parenthetical written at scoring time and
      // would freeze ages permanently. Always prefer the JD-meta value which
      // is recomputed from the Posted ISO timestamp on every request.
      if (report.legitimacyTier) row.legitimacyTier = report.legitimacyTier;
      if (report.locations && report.locations.length > 0) {
        row.locations = report.locations;
      }
    }

    // Match staged application pack
    const slug = stagedIndex.get(row.url);
    if (slug) row.stagedSlug = slug;
    row.ats = detectAts(row.url);

    rows.push(row);
  }

  // Join rank-leads.mjs output (data/inbox-leads.md) onto matching rows. The
  // "Ranked" tab on the home page renders these fields inline so we no longer
  // need a separate /ranked route. Failures are swallowed — inbox-leads.md
  // may not exist on a fresh install or before the first rank-leads run.
  try {
    const inbox = await loadInboxLeads();
    const byUrl = new Map(inbox.leads.map(l => [l.url, l]));
    for (const row of rows) {
      const lead = byUrl.get(row.url);
      if (!lead) continue;
      row.tier = lead.tier;
      if (lead.archetype) row.archetype = lead.archetype;
      if (lead.verdict) row.verdict = lead.verdict;
      if (lead.redFlags) row.redFlags = lead.redFlags;
    }
  } catch { /* inbox-leads.md unavailable — ranked tab will simply be empty */ }

  const byStatus: Record<PipelineStatus, number> = {
    new: 0,
    under_review: 0,
    applied: 0,
    rejected: 0,
    archived: 0
  };
  for (const r of rows) byStatus[r.status]++;

  const data: PipelineData = {
    rows,
    lastScannedAt: await maybeStat(pipelinePath),
    totalCount: rows.length,
    byStatus
  };
  pipelineCache = { data, pipelineMtime, appsMtime, inboxMtime, dayKey };
  return data;
}
