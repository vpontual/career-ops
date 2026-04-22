import { readFile, stat, readdir } from "fs/promises";
import path from "path";

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

async function readApplicationsMd(): Promise<Map<string, PipelineStatus>> {
  // applications.md is the user's manual tracker. Format is free-form markdown
  // but typically has lines like: "- [x] URL | Company | Role | Applied"
  const statusMap = new Map<string, PipelineStatus>();
  try {
    const content = await readFile(path.join(DATA_ROOT, "data", "applications.md"), "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/(\S+?career\S+|\S+?(ashby|greenhouse|lever)\S+)/i);
      if (!m) continue;
      const url = m[1];
      const lower = line.toLowerCase();
      let s: PipelineStatus = "under_review";
      if (lower.includes("rejected") || lower.includes("pass")) s = "rejected";
      else if (lower.includes("applied") || lower.includes("submitted")) s = "applied";
      else if (lower.includes("archived") || lower.includes("ignore")) s = "archived";
      statusMap.set(url, s);
    }
  } catch {
    // no applications.md yet — everything stays in "new"
  }
  return statusMap;
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

// Cache JD lookups across rows in one request so we only walk jds/ once.
let jdMetaCache: Map<string, { posted?: number; updated?: number; locations?: string[] }> | null = null;
async function loadJdMetaIndex(): Promise<Map<string, { posted?: number; updated?: number; locations?: string[] }>> {
  if (jdMetaCache) return jdMetaCache;
  const map = new Map<string, { posted?: number; updated?: number; locations?: string[] }>();
  try {
    const jdsDir = path.join(DATA_ROOT, "jds");
    const files = await readdir(jdsDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const text = await readFile(path.join(jdsDir, f), "utf-8");
      const urlM = text.match(/\*\*URL:\*\*\s+(\S+)/);
      if (!urlM) continue;
      const postedM = text.match(/\*\*Posted:\*\*[^(]*\((\d+)\s+days?\s+ago\)/i);
      const updatedM = text.match(/\*\*Updated:\*\*[^(]*\((\d+)\s+days?\s+ago\)/i);
      const locationM = text.match(/\*\*Location:\*\*\s+(.+)/);
      const locations = locationM
        ? locationM[1].split(/[|;•]/).map(s => s.trim()).filter(Boolean)
        : undefined;
      map.set(urlM[1], {
        posted: postedM ? parseInt(postedM[1], 10) : undefined,
        updated: updatedM ? parseInt(updatedM[1], 10) : undefined,
        locations
      });
    }
  } catch {}
  jdMetaCache = map;
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
    if (manual) row.status = manual;

    // JD-derived metadata: posted/updated dates and locations. Available even
    // when no scoring report has been generated yet.
    const jdMeta = jdMetaIndex.get(row.url);
    if (jdMeta) {
      row.postedDaysAgo = jdMeta.posted;
      row.updatedDaysAgo = jdMeta.updated;
      if (jdMeta.locations && jdMeta.locations.length > 0) {
        row.locations = jdMeta.locations;
      }
    }
    row.computedLegitimacy = computeLegitimacy(row.postedDaysAgo, row.updatedDaysAgo);

    // Find a matching scoring report if one exists (provides score + tier text)
    const report = await findReportForUrl(row.url);
    if (report) {
      row.reportPath = report.path;
      row.score = report.score;
      // Report's posted/legitimacy override JD-only values when available
      if (report.postedDaysAgo != null) row.postedDaysAgo = report.postedDaysAgo;
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

  const byStatus: Record<PipelineStatus, number> = {
    new: 0,
    under_review: 0,
    applied: 0,
    rejected: 0,
    archived: 0
  };
  for (const r of rows) byStatus[r.status]++;

  return {
    rows,
    lastScannedAt: await maybeStat(pipelinePath),
    totalCount: rows.length,
    byStatus
  };
}
