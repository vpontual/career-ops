import { loadPipeline, PipelineRow, PipelineStatus } from "@/lib/pipeline";
import StatusControl from "@/components/StatusControl";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TABS: { id: string; label: string; match: (r: PipelineRow) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "new", label: "New", match: r => r.status === "new" },
  { id: "scored", label: "Scored", match: r => typeof r.score === "number" },
  { id: "high", label: "High fit (≥4.0)", match: r => typeof r.score === "number" && r.score >= 4.0 },
  { id: "highactive", label: "High + active", match: r => typeof r.score === "number" && r.score >= 4.0 && r.computedLegitimacy !== "ghost-likely" && r.computedLegitimacy !== "ancient" },
  { id: "highfresh", label: "High + fresh (≤5d)", match: r => typeof r.score === "number" && r.score >= 4.0 && effectiveDays(r) <= 5 },
  { id: "highrecent", label: "High + recent (≤30d)", match: r => typeof r.score === "number" && r.score >= 4.0 && effectiveDays(r) <= 30 },
  { id: "staged", label: "Auto-staged", match: r => Boolean(r.stagedSlug) },
  { id: "review", label: "Under review", match: r => r.status === "under_review" },
  { id: "applied", label: "Applied", match: r => r.status === "applied" },
  { id: "rejected", label: "Rejected", match: r => r.status === "rejected" },
  { id: "archived", label: "Archived", match: r => r.status === "archived" }
];

function isNycCompatible(locs: string[]): boolean {
  return locs.some(l => /new york|nyc|manhattan|brooklyn|queens|jersey city|hoboken|stamford/i.test(l));
}
function isLaCompatible(locs: string[]): boolean {
  return locs.some(l => /los angeles|\bLA\b|santa monica|culver|pasadena|el segundo/i.test(l));
}
function isRemote(locs: string[]): boolean {
  return locs.some(l => /remote|anywhere|distributed/i.test(l));
}

function locationBadge(row: PipelineRow) {
  const tags: { label: string; color: string }[] = [];
  if (isNycCompatible(row.locations)) tags.push({ label: "NYC", color: "text-sky-300 border-sky-400/40" });
  if (isLaCompatible(row.locations)) tags.push({ label: "LA", color: "text-orange-300 border-orange-400/40" });
  if (isRemote(row.locations)) tags.push({ label: "REMOTE", color: "text-green-300 border-green-400/40" });
  if (tags.length === 0) tags.push({ label: "OTHER", color: "text-zinc-500 border-zinc-600" });
  return tags;
}

// Color for an age value based on Vitor's freshness scale (≤5d goal,
// ≤30d possible, >30d unlikely, >90d ghost).
function ageColor(days: number): string {
  if (days <= 5)  return "text-green-300 border-green-400/40 bg-green-500/15";
  if (days <= 30) return "text-amber-300 border-amber-400/40 bg-amber-500/10";
  if (days <= 90) return "text-orange-300 border-orange-400/40 bg-orange-500/10";
  return "text-red-300 border-red-400/40 bg-red-500/10";
}

// Returns 1 or 2 pills depending on whether the listing has a meaningful
// Updated date. When Updated is materially more recent than Posted, both
// pills show: the updated one in bold tier color (the "is this listing
// alive?" signal), the posted one muted as background context.
//
// When there's no updated info or updated == posted, just one pill in
// the standard tier color.
function ageBadges(row: PipelineRow): { label: string; color: string; title: string }[] {
  const d = row.postedDaysAgo;
  if (d == null) return [];
  const u = row.updatedDaysAgo;
  const ghost = row.computedLegitimacy === "ghost-likely";

  // No meaningful update info, or update is basically the same as posted
  if (u == null || u >= d - 2) {
    const label = ghost ? `${d}d 👻` : `${d}d`;
    const color = ghost
      ? "text-red-400 border-red-500/50 bg-red-600/15"
      : ageColor(d);
    return [{ label, color, title: `Posted ${d}d ago` }];
  }

  // Updated is materially more recent → show both, lead with updated
  const mutedColor = "text-zinc-500 border-zinc-700 bg-zinc-800/40";
  return [
    { label: `↻ ${u}d`, color: ageColor(u), title: `Updated ${u}d ago — recent activity` },
    { label: `${d}d`, color: mutedColor, title: `Originally posted ${d}d ago` }
  ];
}

function encodeRoleSlug(url: string): string {
  return Buffer.from(url, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Effective freshness = min(updated, posted) when both are present, else
// whichever exists. A role posted 364d ago but updated 6d ago counts as
// 6d fresh, since the listing was demonstrably touched then.
function effectiveDays(r: PipelineRow): number {
  const p = r.postedDaysAgo;
  const u = r.updatedDaysAgo;
  if (p == null && u == null) return 9999;
  if (p == null) return u!;
  if (u == null) return p;
  return Math.min(p, u);
}

const SORTS: { id: string; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "score", label: "Score" },
  { id: "days", label: "Days (newest)" },
  { id: "updated", label: "Updated" },
  { id: "city", label: "City" },
  { id: "title", label: "Title" },
  { id: "company", label: "Company" }
];

// Pull the most relevant city out of the locations array for sorting.
// Prefer NYC > LA > Remote > first listed, so a row with multiple offices
// like "SF · NYC · Remote" sorts under "New York" for someone NYC-based.
function primaryCity(locs: string[]): string {
  if (locs.length === 0) return "~"; // sort empties last
  const nyc = locs.find(l => /new york|nyc|manhattan|brooklyn|queens|jersey city|hoboken|stamford/i.test(l));
  if (nyc) return "0_New York";
  const la = locs.find(l => /los angeles|\bLA\b|santa monica|culver|pasadena|el segundo/i.test(l));
  if (la) return "1_Los Angeles";
  const remote = locs.find(l => /remote|anywhere|distributed/i.test(l));
  if (remote) return "2_Remote";
  return "3_" + locs[0];
}

function applySort(rows: PipelineRow[], sort: string): PipelineRow[] {
  const out = rows.slice();
  switch (sort) {
    case "score":
      return out.sort((a, b) => {
        const d = (b.score ?? -1) - (a.score ?? -1);
        if (d !== 0) return d;
        return (a.postedDaysAgo ?? 9999) - (b.postedDaysAgo ?? 9999);
      });
    case "days":
      return out.sort((a, b) => {
        // Use most-recent-touch so a 364d listing updated 6d ago beats
        // a 30d listing not updated since.
        const da = effectiveDays(a);
        const db = effectiveDays(b);
        if (da !== db) return da - db;
        return (b.score ?? -1) - (a.score ?? -1);
      });
    case "updated":
      // Only show roles with a JD-derived Updated date; sort newest first.
      // Roles whose listing was never re-touched are dropped because the
      // signal of "is this still active" is what we are sorting on.
      return out
        .filter(r => r.updatedDaysAgo != null)
        .sort((a, b) => {
          const da = a.updatedDaysAgo!;
          const db = b.updatedDaysAgo!;
          if (da !== db) return da - db;
          return (b.score ?? -1) - (a.score ?? -1);
        });
    case "city":
      return out.sort((a, b) => {
        const c = primaryCity(a.locations).localeCompare(primaryCity(b.locations));
        if (c !== 0) return c;
        return a.company.localeCompare(b.company);
      });
    case "title":
      return out.sort((a, b) => a.role.localeCompare(b.role));
    case "company":
      return out.sort((a, b) => {
        const c = a.company.localeCompare(b.company);
        if (c !== 0) return c;
        return (b.score ?? -1) - (a.score ?? -1);
      });
    default:
      return out;
  }
}

function RoleRow({ r, showCompany }: { r: PipelineRow; showCompany: boolean }) {
  const ageItems = ageBadges(r);
  const detailsHref = `/role/${encodeRoleSlug(r.url)}`;
  return (
    <li className="flex items-start gap-4 px-4 py-3 rounded-md border border-zinc-800/60 bg-zinc-900/40 hover:bg-zinc-900/80 transition-colors">
      <div className="flex-1 min-w-0">
        {showCompany && (
          <div className="text-xs text-zinc-500 font-mono uppercase tracking-wide mb-1">
            {r.company}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={r.url}
            target="_blank"
            rel="noopener"
            className="text-zinc-100 hover:text-sky-300 font-medium underline-offset-4 hover:underline break-words"
          >
            {r.role}
          </a>
          <Link
            href={detailsHref}
            className="text-[10px] font-mono text-zinc-500 hover:text-sky-300 border border-zinc-700 hover:border-sky-400/60 rounded px-1.5 py-0.5"
            title="Open details (report + JD preview)"
          >
            details →
          </Link>
        </div>
        {r.locations.length > 0 && (
          <div className="mt-1 text-xs text-zinc-500 font-mono">
            {r.locations.join(" · ")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {locationBadge(r).map(tag => (
          <span
            key={tag.label}
            className={`text-[10px] font-mono border rounded px-1.5 py-0.5 ${tag.color}`}
          >
            {tag.label}
          </span>
        ))}
        {ageItems.map((a, i) => (
          <span
            key={i}
            className={`text-[10px] font-mono border rounded px-1.5 py-0.5 ${a.color}`}
            title={a.title}
          >
            {a.label}
          </span>
        ))}
        {r.stagedSlug && (
          <Link
            href={`/pack/${r.stagedSlug}`}
            className="text-[10px] font-mono border rounded px-1.5 py-0.5 text-purple-300 border-purple-400/50 bg-purple-500/15 hover:bg-purple-500/25"
            title="Open application pack"
          >
            📦 PACK
          </Link>
        )}
        {typeof r.score === "number" ? (
          <span
            className={
              "text-xs font-mono px-2 py-0.5 rounded " +
              (r.score >= 4.0
                ? "bg-green-500/15 text-green-300"
                : r.score >= 3.5
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-red-500/15 text-red-300")
            }
          >
            {r.score.toFixed(1)}
          </span>
        ) : (
          <span className="text-xs font-mono text-zinc-600">unscored</span>
        )}
        <StatusControl url={r.url} company={r.company} role={r.role} current={r.status} />
      </div>
    </li>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string; sort?: string }> }) {
  const data = await loadPipeline();
  const { tab = "all", sort: sortParam } = await searchParams;

  const activeTab = TABS.find(t => t.id === tab) ?? TABS[0];
  const filtered = data.rows.filter(activeTab.match);

  // Defaults per tab type when ?sort isn't set:
  //   scored-style tabs → sort by score DESC (then age ASC) in a flat list
  //   everything else  → group by company
  const isScoredTab = activeTab.id === "scored" || activeTab.id === "high" || activeTab.id === "highfresh" || activeTab.id === "highrecent" || activeTab.id === "staged";
  const effectiveSort = sortParam && SORTS.some(s => s.id === sortParam) ? sortParam : (isScoredTab ? "score" : "default");

  // "default" on a non-scored tab means grouped by company. Any explicit sort
  // (including "company") flips to flat-list mode so user always gets a single
  // ordered view when they ask for one.
  const useGroupedView = effectiveSort === "default";

  const flatSorted = useGroupedView ? [] : applySort(filtered, effectiveSort);

  const byCompany = new Map<string, PipelineRow[]>();
  if (useGroupedView) {
    for (const r of filtered) {
      const arr = byCompany.get(r.company) ?? [];
      arr.push(r);
      byCompany.set(r.company, arr);
    }
  }
  const companyGroups = [...byCompany.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <main className="min-h-screen px-6 py-8 md:px-12 md:py-10 max-w-6xl mx-auto">
      <header className="mb-8 border-b border-zinc-800 pb-6">
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Career Ops</h1>
            <p className="text-sm text-zinc-400 mt-1">
              {data.totalCount} roles in pipeline · filtered to {filtered.length}
              {!useGroupedView && flatSorted.length !== filtered.length && (
                <> · showing {flatSorted.length}</>
              )}
            </p>
          </div>
          <div className="text-xs text-zinc-500 font-mono">
            last scan: {data.lastScannedAt ? data.lastScannedAt.toLocaleString() : "never"}
          </div>
        </div>

        <nav className="mt-6 flex flex-wrap gap-2">
          {TABS.map(t => {
            const count = data.rows.filter(t.match).length;
            const isActive = t.id === activeTab.id;
            const href = sortParam ? `?tab=${t.id}&sort=${sortParam}` : `?tab=${t.id}`;
            return (
              <Link
                key={t.id}
                href={href}
                className={
                  "px-3 py-1.5 text-sm rounded-md border transition-colors " +
                  (isActive
                    ? "border-sky-400/60 bg-sky-400/10 text-sky-200"
                    : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")
                }
              >
                {t.label} <span className="text-zinc-600 ml-1">{count}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-500 font-mono uppercase tracking-wider">Sort:</span>
          {SORTS.map(s => {
            const isActive = s.id === effectiveSort || (!sortParam && s.id === "default");
            const href = s.id === "default" ? `?tab=${activeTab.id}` : `?tab=${activeTab.id}&sort=${s.id}`;
            return (
              <Link
                key={s.id}
                href={href}
                className={
                  "px-2 py-1 rounded border font-mono transition-colors " +
                  (isActive
                    ? "border-sky-400/60 bg-sky-400/10 text-sky-200"
                    : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200")
                }
              >
                {s.label}
              </Link>
            );
          })}
        </div>
      </header>

      {filtered.length === 0 ? (
        <p className="text-zinc-500 text-sm">Nothing here yet. Run a scan to populate.</p>
      ) : !useGroupedView ? (
        <ul className="space-y-2">
          {flatSorted.map(r => <RoleRow key={r.url} r={r} showCompany />)}
        </ul>
      ) : (
        <div className="space-y-8">
          {companyGroups.map(([company, rows]) => (
            <section key={company}>
              <h2 className="text-xs font-mono uppercase tracking-wider text-zinc-500 mb-3 border-b border-zinc-800 pb-2">
                {company} <span className="text-zinc-600">({rows.length})</span>
              </h2>
              <ul className="space-y-2">
                {rows.map(r => <RoleRow key={r.url} r={r} showCompany={false} />)}
              </ul>
            </section>
          ))}
        </div>
      )}

      <footer className="mt-12 pt-6 border-t border-zinc-800 text-xs text-zinc-600 font-mono">
        <p>
          Status changes write to <code className="text-zinc-400">data/applications.md</code> via the UI,
          or edit the file directly. Reports live in <code className="text-zinc-400">reports/</code>.
        </p>
      </footer>
    </main>
  );
}
