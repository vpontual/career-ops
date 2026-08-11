import Link from "next/link";
import { cache } from "react";
import SearchFilter from "@/components/SearchFilter";
import SiteNav, { SiteNavId } from "@/components/SiteNav";
import { loadPipeline } from "@/lib/pipeline";

/**
 * The chrome above the nav, in one place: brand, search, last-scan, nav.
 *
 * WHY. Until now every page drew its own. The pipeline page had the CareerOps
 * mark, a search box and LAST SCAN; /review had a bare title; /now had a
 * different logo in a different colour with its own two-item nav beside it. So
 * "the same site" looked like three sites depending on where you stood, and
 * the search box - the one control you reach for reflexively - existed on
 * exactly one page.
 *
 * Page identity now lives BELOW this, as a heading in the page's own content,
 * which is where it belongs. The bar itself is the same everywhere.
 *
 * `children` is for controls that genuinely belong to one page - the sort and
 * freshness toggles filter the pipeline table and mean nothing on /review or a
 * pack page. Navigation is shared; page controls are not.
 */
const lastScan = cache(async (): Promise<Date | null> => {
  try {
    const d = await loadPipeline();
    return d.lastScannedAt ?? null;
  } catch {
    return null;
  }
});

export default async function SiteHeader({
  active,
  q = "",
  params,
  children,
}: {
  active: SiteNavId;
  q?: string;
  params?: { sort?: string; q?: string; fresh?: boolean };
  children?: React.ReactNode;
}) {
  const scanned = await lastScan();
  return (
    <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
      <div className="mx-auto max-w-6xl px-6 md:px-10">
        <div className="flex items-center gap-4 py-4">
          {/* The mark links to /review, which is the landing page. Linking it to
              "/" would bounce through the redirect for no reason. */}
          <Link href="/review" className="flex shrink-0 items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-400 to-violet-500 text-sm font-bold text-white shadow-lg shadow-indigo-500/20">C</span>
            <span className="flex flex-col leading-none">
              <span className="text-[15px] font-semibold tracking-tight text-slate-100">CareerOps</span>
              <span className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">AI job pipeline</span>
            </span>
          </Link>
          <div className="mx-auto w-full max-w-md">
            <SearchFilter initial={q} />
          </div>
          <div className="hidden shrink-0 text-right text-[11px] text-slate-500 sm:block">
            <div className="uppercase tracking-wider">Last scan</div>
            <div className="tabular-nums text-slate-400">{scanned ? scanned.toLocaleString() : "never"}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
          <SiteNav active={active} params={params} />
          {children}
        </div>
      </div>
    </header>
  );
}
