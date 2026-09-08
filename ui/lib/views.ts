import { PipelineRow, effectiveDays } from "@/lib/pipeline";
import { FreshnessWindows, isAgedOut } from "@/lib/freshness-windows";

/**
 * What each view MEANS, in one place.
 *
 * page.tsx used to own these predicates and SiteNav took the resulting counts
 * as a prop, so a page that forgot to pass one rendered a tab with no number -
 * which is how the same "shared" nav ended up looking different on four pages.
 * Both the tab count and the table rows now read from here, so a count can
 * never disagree with what clicking it shows.
 */
export const VIEW_MATCH: Record<string, (r: PipelineRow) => boolean> = {
  // A role that REQUIRES living somewhere else is out on every track, full stop
  // (VP, 2026-08-10). Same predicate as enqueue-review.mjs, so the view and the
  // queue cannot drift apart.
  shortlist: r => typeof r.score === "number" && r.score >= 4.0 && r.geo !== "onsite-elsewhere" && r.geo !== "hybrid-elsewhere",
  staged: r => Boolean(r.stagedSlug),
  ranked: r => typeof r.score === "number",
  all: () => true,
  applied: r => r.status === "applied",
};

/**
 * Whether a row is on screen for a view, INCLUDING the age-out.
 *
 * ⚠ THE ONE PLACE THAT DECIDES. VIEW_MATCH was already shared because a count
 * passed as a prop is how five pages drifted; adding the age filter in
 * app/page.tsx alone put the drift straight back, with the nav advertising 811
 * shortlist roles over a page showing 430. Both now call this.
 */
export function isVisible(
  id: string,
  r: PipelineRow,
  windows: FreshnessWindows | null,
  showStale: boolean
): boolean {
  const match = VIEW_MATCH[id];
  if (!match || !match(r)) return false;
  if (showStale) return true;
  return !isAgedOut(windows, r, effectiveDays(r));
}
