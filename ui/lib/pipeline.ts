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

async function findReportForUrl(url: string): Promise<{ path: string; score?: number } | null> {
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
      // Extract a global score if present — career-ops writes "**Global:** 4.2/5" or similar
      const scoreMatch = content.match(/(?:Global|Score|Overall)[^0-9]*([1-5](?:\.\d)?)\s*\/\s*5/i);
      return { path: fp, score: scoreMatch ? parseFloat(scoreMatch[1]) : undefined };
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

  const rows: PipelineRow[] = [];
  for (const line of raw.split("\n")) {
    const row = parsePipelineLine(line);
    if (!row) continue;

    // Overlay manual status from applications.md if present
    const manual = manualStatuses.get(row.url);
    if (manual) row.status = manual;

    // Find a matching report if one exists
    const report = await findReportForUrl(row.url);
    if (report) {
      row.reportPath = report.path;
      row.score = report.score;
    }

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
