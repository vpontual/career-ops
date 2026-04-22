import { loadPipeline, PipelineRow, PipelineStatus } from "@/lib/pipeline";
import StatusControl from "@/components/StatusControl";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TABS: { id: string; label: string; match: (r: PipelineRow) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "new", label: "New", match: r => r.status === "new" },
  { id: "scored", label: "Scored", match: r => typeof r.score === "number" },
  { id: "high", label: "High fit (≥4.0)", match: r => typeof r.score === "number" && r.score >= 4.0 },
  { id: "highfresh", label: "High + fresh (≤5d)", match: r => typeof r.score === "number" && r.score >= 4.0 && (r.postedDaysAgo ?? 999) <= 5 },
  { id: "highrecent", label: "High + recent (≤30d)", match: r => typeof r.score === "number" && r.score >= 4.0 && (r.postedDaysAgo ?? 999) <= 30 },
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

// Vitor's freshness scale: ≤5d = goal, ≤30d = old-but-possible, >30d = irrelevant, >90d = ghost.
function ageBadge(row: PipelineRow) {
  const d = row.postedDaysAgo;
  if (d == null) return null;
  if (d <= 5)  return { label: `${d}d`,    color: "text-green-300 border-green-400/40 bg-green-500/15" };
  if (d <= 30) return { label: `${d}d`,    color: "text-amber-300 border-amber-400/40 bg-amber-500/10" };
  if (d <= 90) return { label: `${d}d`,    color: "text-red-300 border-red-400/40 bg-red-500/10" };
  return { label: `${d}d 👻`, color: "text-red-400 border-red-500/50 bg-red-600/15" };
}

function encodeRoleSlug(url: string): string {
  return Buffer.from(url, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function RoleRow({ r, showCompany }: { r: PipelineRow; showCompany: boolean }) {
  const age = ageBadge(r);
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
        {age && (
          <span
            className={`text-[10px] font-mono border rounded px-1.5 py-0.5 ${age.color}`}
            title={r.legitimacyTier ? `Legitimacy: ${r.legitimacyTier}` : undefined}
          >
            {age.label}
          </span>
        )}
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

export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const data = await loadPipeline();
  const { tab = "all" } = await searchParams;

  const activeTab = TABS.find(t => t.id === tab) ?? TABS[0];
  const filtered = data.rows.filter(activeTab.match);

  // For score-based tabs, show a flat list sorted by score DESC then age ASC
  // rather than grouping by company. Group-by-company for other views.
  const isScoredView = activeTab.id === "scored" || activeTab.id === "high" || activeTab.id === "highfresh" || activeTab.id === "highrecent" || activeTab.id === "staged";

  const flatSorted = isScoredView
    ? filtered.slice().sort((a, b) => {
        const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return (a.postedDaysAgo ?? 9999) - (b.postedDaysAgo ?? 9999);
      })
    : [];

  const byCompany = new Map<string, PipelineRow[]>();
  if (!isScoredView) {
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
            return (
              <Link
                key={t.id}
                href={`?tab=${t.id}`}
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
      </header>

      {filtered.length === 0 ? (
        <p className="text-zinc-500 text-sm">Nothing here yet. Run a scan to populate.</p>
      ) : isScoredView ? (
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
