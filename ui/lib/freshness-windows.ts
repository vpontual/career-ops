import { readFile } from "fs/promises";
import path from "path";
import { cache } from "react";
import { PipelineRow } from "./pipeline";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";

/**
 * The freshness policy, as projected by export-freshness.mjs.
 *
 * ⚠ THE POLICY IS NOT HERE. It lives in lib/freshness.mjs, which this app
 * cannot import — Dockerfile.ui builds from `COPY ui/ ./`, so the repo root is
 * not in the build context. Writing the windows again in TypeScript is the
 * two-copies-drift bug this repo keeps re-learning, so the nightly exports what
 * the policy decided and this reads it.
 *
 * The parts most likely to drift are deliberately NOT restated here: whale
 * matching (case-insensitive substring over config/whales.yml) and evergreen
 * (n >= 4 and pctAlive >= 80 over employer-closure.json) are both resolved per
 * company on the .mjs side, so this does two map lookups and no matching.
 *
 * The one rule restated is the precedence, and test-freshness-export.mjs
 * asserts it against maxAgeDaysFor() over a matrix including the case where the
 * two could disagree — a whale employer on a track that has its own window.
 */
export interface FreshnessWindows {
  defaultDays: number;
  byTrack: Record<string, number>;
  byCompany: Record<string, number>;
  generatedOn?: string;
}

/**
 * ⚠ null, not a default, when the file is missing or unreadable.
 *
 * "The policy says 21 days" and "nobody has exported a policy" are different
 * facts, and a fallback number here would silently hide roles on a window VP
 * never set — which is the failure this whole area keeps producing. The caller
 * shows everything when this is null.
 */
export const loadFreshnessWindows = cache(async (): Promise<FreshnessWindows | null> => {
  try {
    const raw = await readFile(path.join(DATA_ROOT, "data", "freshness-windows.json"), "utf-8");
    const doc = JSON.parse(raw) as FreshnessWindows;
    if (typeof doc?.defaultDays !== "number") return null;
    return {
      defaultDays: doc.defaultDays,
      byTrack: doc.byTrack ?? {},
      byCompany: doc.byCompany ?? {},
      generatedOn: doc.generatedOn,
    };
  } catch {
    return null;
  }
});

/** Same order as maxAgeDaysFor(): a track window beats whale and evergreen. */
export function windowFor(w: FreshnessWindows, r: Pick<PipelineRow, "track" | "company">): number {
  const byTrack = r.track ? w.byTrack[r.track] : undefined;
  if (typeof byTrack === "number") return byTrack;
  const byCompany = w.byCompany[String(r.company ?? "").toLowerCase()];
  if (typeof byCompany === "number") return byCompany;
  return w.defaultDays;
}

/**
 * Has this role aged out of the window the pipeline would apply to it?
 *
 * ⚠ A role with NO date is never aged out. `effectiveDays` returns 9999 for a
 * row whose JD was never fetched — 8 rows on 2026-09-08 — and treating "we
 * never looked" as "ancient" would hide roles for a reason that is about our
 * scraper rather than about the posting. It sorts last and stays visible.
 *
 * ⚠ Neither is anything VP has acted on. An applied or rejected role is a
 * record, not a lead, and prune-stale already keeps applied rows forever
 * regardless of age for exactly this reason.
 */
export function isAgedOut(
  w: FreshnessWindows | null,
  r: PipelineRow,
  days: number
): boolean {
  if (!w) return false;
  if (days >= 9999) return false;
  if (r.status !== "new") return false;
  return days > windowFor(w, r);
}
