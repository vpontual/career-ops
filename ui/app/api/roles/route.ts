import { NextResponse } from "next/server";
import { loadPipeline, PipelineRow, PipelineStatus } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

const STATUSES: PipelineStatus[] = ["new", "under_review", "applied", "rejected", "archived"];

function parseStatusFilter(raw: string | null): Set<PipelineStatus> | null {
  if (!raw) return null;
  const wanted = new Set<PipelineStatus>();
  for (const part of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    if ((STATUSES as string[]).includes(part)) wanted.add(part as PipelineStatus);
  }
  return wanted.size ? wanted : null;
}

function effectiveAge(row: PipelineRow): number | undefined {
  if (row.updatedDaysAgo != null && row.postedDaysAgo != null) {
    return Math.min(row.updatedDaysAgo, row.postedDaysAgo);
  }
  return row.updatedDaysAgo ?? row.postedDaysAgo;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const statusFilter = parseStatusFilter(url.searchParams.get("status"));
  const minScore = parseFloat(url.searchParams.get("min_score") ?? "");
  const freshDays = parseInt(url.searchParams.get("fresh_days") ?? "", 10);
  const company = (url.searchParams.get("company") ?? "").trim().toLowerCase();
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const stagedOnly = url.searchParams.get("staged_only") === "true";
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : null;

  const data = await loadPipeline();
  let rows = data.rows;

  if (statusFilter) rows = rows.filter(r => statusFilter.has(r.status));
  if (Number.isFinite(minScore)) rows = rows.filter(r => (r.score ?? 0) >= minScore);
  if (Number.isFinite(freshDays)) {
    rows = rows.filter(r => {
      const age = effectiveAge(r);
      return age != null && age <= freshDays;
    });
  }
  if (company) rows = rows.filter(r => r.company.toLowerCase().includes(company));
  if (q) rows = rows.filter(r => `${r.company} ${r.role}`.toLowerCase().includes(q));
  if (stagedOnly) rows = rows.filter(r => !!r.stagedSlug);

  const filteredCount = rows.length;
  if (limit) rows = rows.slice(0, limit);

  return NextResponse.json({
    rows,
    filteredCount,
    totalCount: data.totalCount,
    byStatus: data.byStatus,
    lastScannedAt: data.lastScannedAt
  });
}
