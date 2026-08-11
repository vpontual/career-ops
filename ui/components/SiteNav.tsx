import Link from "next/link";
import { cache } from "react";
import { readFile } from "fs/promises";
import path from "path";
import { loadPipeline, PipelineRow } from "@/lib/pipeline";

/**
 * The cross-page navigation, in ONE place, INCLUDING ITS NUMBERS.
 *
 * WHY IT LOADS ITS OWN COUNTS. The first version took counts as a prop, and
 * every page passed something different: the home page passed all five, /review
 * passed only its own, /now and /pack and /role passed none. So the bar was
 * "the same component" and still rendered four different ways - VP put three
 * screenshots side by side and asked whether they had the same nav. They did
 * not. A shared component whose contents depend on what each caller remembers
 * to pass is not shared; it just moves the drift into the call sites.
 *
 * Now nothing is passed. Every page renders the identical bar because none of
 * them can render anything else.
 *
 * The loads are wrapped in React's cache() so the home page, which already
 * calls loadPipeline for its table, pays for it once per request rather than
 * twice.
 */
export type SiteNavId = "review" | "shortlist" | "staged" | "ranked" | "all" | "applied" | "now";

/**
 * The view predicates, shared with page.tsx (ui/lib/views.ts) so the count in
 * the tab and the rows in the table can never disagree about what a view is.
 */
import { VIEW_MATCH } from "@/lib/views";

export const SITE_NAV: { id: SiteNavId; label: string; href: string; accent?: "blue" | "emerald" }[] = [
  // Review queue first: the only view where every card is complete - CV,
  // answers, diligence, a resolved apply URL, a posting confirmed live.
  { id: "review", label: "Review queue", href: "/review", accent: "blue" },
  { id: "shortlist", label: "Shortlist", href: "/?tab=shortlist" },
  { id: "staged", label: "Ready to apply", href: "/?tab=staged" },
  { id: "ranked", label: "Ranked", href: "/?tab=ranked" },
  { id: "all", label: "All roles", href: "/?tab=all" },
  { id: "applied", label: "Applied", href: "/?tab=applied" },
  { id: "now", label: "Get Hired Now", href: "/now", accent: "emerald" },
];

const pendingReviewCount = cache(async (): Promise<number> => {
  try {
    const root = process.env.CAREER_OPS_ROOT ?? "/data";
    const q = JSON.parse(await readFile(path.join(root, "data", "review-queue.json"), "utf-8"));
    return (q.items ?? []).filter((i: { decision?: string | null }) => !i.decision).length;
  } catch {
    return 0;
  }
});

const nowTrackCount = cache(async (): Promise<number> => {
  try {
    const root = process.env.CAREER_OPS_ROOT ?? "/data";
    const q = JSON.parse(await readFile(path.join(root, "data", "review-queue.json"), "utf-8"));
    return (q.items ?? []).filter((i: { decision?: string | null; track?: string }) => !i.decision && i.track === "now").length;
  } catch {
    return 0;
  }
});

const navCounts = cache(async (): Promise<Partial<Record<SiteNavId, number>>> => {
  const out: Partial<Record<SiteNavId, number>> = {};
  out.review = await pendingReviewCount();
  out.now = await nowTrackCount();
  try {
    const data = await loadPipeline();
    const rows: PipelineRow[] = data.rows;
    for (const id of ["shortlist", "staged", "ranked", "all", "applied"] as const) {
      const m = VIEW_MATCH[id];
      if (m) out[id] = rows.filter(m).length;
    }
  } catch {
    // A nav that cannot count is still a nav. Render the labels.
  }
  return out;
});

export default async function SiteNav({
  active,
  params,
}: {
  active: SiteNavId;
  /**
   * The home page's sort/search/fresh state. Its tabs are views OF one page, so
   * switching tab must not silently drop the filter you had applied.
   */
  params?: { sort?: string; q?: string; fresh?: boolean };
}) {
  const counts = await navCounts();
  const withParams = (href: string) => {
    if (!params || !href.startsWith("/?")) return href;
    const u = new URLSearchParams(href.slice(2));
    if (params.sort) u.set("sort", params.sort);
    if (params.q) u.set("q", params.q);
    if (params.fresh) u.set("fresh", "1");
    return `/?${u.toString()}`;
  };
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-1">
      {SITE_NAV.map((item) => {
        const isActive = item.id === active;
        const n = counts[item.id];
        const base = "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ";
        const cls = isActive
          ? base + "bg-slate-800 text-slate-100 ring-1 ring-inset ring-slate-700"
          : item.accent === "blue"
            ? base + "text-blue-300/80 hover:bg-blue-500/10 hover:text-blue-200"
            : item.accent === "emerald"
              ? base + "text-emerald-300/80 hover:bg-emerald-500/10 hover:text-emerald-200"
              : base + "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200";
        return (
          <Link key={item.id} href={withParams(item.href)} className={cls} aria-current={isActive ? "page" : undefined}>
            {item.label}
            {typeof n === "number" && (
              <span className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-300">{n}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
