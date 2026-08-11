import Link from "next/link";

/**
 * The cross-page navigation, in ONE place.
 *
 * WHY THIS EXISTS. `/review` became the landing page on 2026-08-11, and it
 * shipped carrying only a "← back to dashboard" link: you arrived at the front
 * door and could not reach Shortlist, Ranked or Get Hired Now without a detour
 * through a page you had just been redirected away from. VP caught it
 * immediately.
 *
 * The obvious fix - paste the nav into the review page - is how the two drift.
 * This repo has been bitten by exactly that shape more than once today alone
 * (three copies of the branded-board host map had drifted; stage and enqueue
 * each hand-wrote a freshness banner and each listed a different subset of the
 * windows). So the ITEMS live here and every page renders from this list.
 *
 * `/` (page.tsx) keeps its own richer renderer because its tabs must preserve
 * sort/search/fresh query state, which a plain cross-page link must not carry.
 * It reads its labels and order from SITE_NAV all the same.
 */
export type SiteNavId = "review" | "shortlist" | "staged" | "ranked" | "all" | "now";

export const SITE_NAV: { id: SiteNavId; label: string; href: string; accent?: "blue" | "emerald" }[] = [
  // Review queue first: it is the only view where every card is complete - CV,
  // answers, diligence, a resolved apply URL, a posting confirmed live.
  { id: "review", label: "Review queue", href: "/review", accent: "blue" },
  { id: "shortlist", label: "Shortlist", href: "/?tab=shortlist" },
  { id: "staged", label: "Ready to apply", href: "/?tab=staged" },
  { id: "ranked", label: "Ranked", href: "/?tab=ranked" },
  { id: "all", label: "All roles", href: "/?tab=all" },
  { id: "now", label: "Get Hired Now", href: "/now", accent: "emerald" },
];

export default function SiteNav({
  active,
  counts = {},
}: {
  active: SiteNavId;
  counts?: Partial<Record<SiteNavId, number>>;
}) {
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
          <Link key={item.id} href={item.href} className={cls} aria-current={isActive ? "page" : undefined}>
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
