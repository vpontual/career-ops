import { loadPipeline, PipelineRow } from "@/lib/pipeline";
import StatusControl from "@/components/StatusControl";
import SearchFilter from "@/components/SearchFilter";
import Link from "next/link";
import { readFile } from "fs/promises";
import path from "path";

// Count of prepared applications still awaiting VP's approve/reject in /review.
// Never throws: a missing or malformed queue just means "nothing to review".
async function pendingReviewCount(): Promise<number> {
  try {
    const root = process.env.CAREER_OPS_ROOT ?? "/data";
    const q = JSON.parse(await readFile(path.join(root, "data", "review-queue.json"), "utf-8"));
    return (q.items ?? []).filter((i: { decision?: string | null }) => !i.decision).length;
  } catch {
    return 0;
  }
}

export const dynamic = "force-dynamic";

type View = { id: string; label: string; hint?: string; match: (r: PipelineRow) => boolean };

// Primary workflow stages — always visible. Ordered by what matters most:
// the roles worth applying to, the ones already packaged, then everything.
const CORE_VIEWS: View[] = [
  // A role that REQUIRES living somewhere else is out on every track, full stop
  // (VP, 2026-08-10). enqueue-review.mjs enforces exactly that, which is why the
  // review queue has none - but this list had NO geography gate of any kind, so
  // the same roles it refuses to card still rendered here at 5.0: a Staff PM in
  // Brazil, Nubank in Bogota, Wellhub "Brazil only. Candidate is in the US."
  // Being PAID from elsewhere is fine; being REQUIRED TO RESIDE elsewhere is not,
  // and no amount of tier-5 fit buys that back. Same predicate as the enqueue
  // gate, so the two layers cannot drift apart.
  { id: "shortlist", label: "Shortlist", hint: "Scored 4+ — worth applying to", match: r => typeof r.score === "number" && r.score >= 4.0 && r.geo !== "onsite-elsewhere" && r.geo !== "hybrid-elsewhere" },
  { id: "staged", label: "Ready to apply", hint: "Application pack generated", match: r => Boolean(r.stagedSlug) },
  { id: "ranked", label: "Ranked", hint: "Every scored role, grouped by fit tier", match: r => typeof r.score === "number" },
  { id: "all", label: "All roles", hint: "Everything in the pipeline", match: () => true }
];

// Outcome stages — shown only when they actually contain something, so the
// filter bar isn't a wall of zeros before you've started applying.
const STATUS_VIEWS: View[] = [
  { id: "applied", label: "Applied", match: r => r.status === "applied" },
  { id: "review", label: "Under review", match: r => r.status === "under_review" },
  { id: "rejected", label: "Rejected", match: r => r.status === "rejected" },
  { id: "archived", label: "Archived", match: r => r.status === "archived" }
];

const ALL_VIEWS = [...CORE_VIEWS, ...STATUS_VIEWS];

const SORTS: { id: string; label: string }[] = [
  { id: "score", label: "Best fit" },
  { id: "days", label: "Newest" },
  { id: "company", label: "Company" }
];

function isNycCompatible(locs: string[]): boolean {
  return locs.some(l => /new york|nyc|manhattan|brooklyn|queens|jersey city|hoboken|stamford/i.test(l));
}
function isRemote(locs: string[]): boolean {
  return locs.some(l => /remote|anywhere|distributed/i.test(l));
}

function locationBadge(row: PipelineRow) {
  const tags: { label: string; color: string }[] = [];
  if (isNycCompatible(row.locations)) tags.push({ label: "NYC", color: "text-sky-300 border-sky-400/30 bg-sky-400/10" });
  if (isRemote(row.locations)) tags.push({ label: "Remote", color: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10" });
  if (tags.length === 0) tags.push({ label: "Other", color: "text-slate-500 border-slate-700 bg-slate-800/40" });
  return tags;
}

// Freshness scale (≤5d goal, ≤30d possible, >30d unlikely, >90d ghost).
function ageColor(days: number): string {
  if (days <= 5)  return "text-emerald-300 border-emerald-400/30 bg-emerald-400/10";
  if (days <= 30) return "text-amber-300 border-amber-400/30 bg-amber-400/10";
  if (days <= 90) return "text-orange-300 border-orange-400/30 bg-orange-400/10";
  return "text-rose-300 border-rose-400/30 bg-rose-400/10";
}

function ageBadges(row: PipelineRow): { label: string; color: string; title: string }[] {
  const d = row.postedDaysAgo;
  if (d == null) return [];
  const u = row.updatedDaysAgo;
  const ghost = row.computedLegitimacy === "ghost-likely";
  if (u == null || u >= d - 2) {
    const label = ghost ? `${d}d · stale` : `${d}d`;
    const color = ghost ? "text-rose-300 border-rose-400/40 bg-rose-500/15" : ageColor(d);
    return [{ label, color, title: ghost ? `Posted ${d}d ago — likely a ghost listing` : `Posted ${d}d ago` }];
  }
  const mutedColor = "text-slate-500 border-slate-700 bg-slate-800/40";
  return [
    { label: `↻ ${u}d`, color: ageColor(u), title: `Updated ${u}d ago` },
    { label: `${d}d`, color: mutedColor, title: `Originally posted ${d}d ago` }
  ];
}

function encodeRoleSlug(url: string): string {
  return Buffer.from(url, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function effectiveDays(r: PipelineRow): number {
  const p = r.postedDaysAgo;
  const u = r.updatedDaysAgo;
  if (p == null && u == null) return 9999;
  if (p == null) return u!;
  if (u == null) return p;
  return Math.min(p, u);
}

function daysApplied(r: PipelineRow): number {
  if (!r.appliedAt) return 0;
  const t = Date.parse(r.appliedAt);
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function applySort(rows: PipelineRow[], sort: string): PipelineRow[] {
  const out = rows.slice();
  switch (sort) {
    case "days":
      return out.sort((a, b) => {
        const da = effectiveDays(a), db = effectiveDays(b);
        if (da !== db) return da - db;
        return (b.score ?? -1) - (a.score ?? -1);
      });
    case "company":
      return out.sort((a, b) => {
        const c = a.company.localeCompare(b.company);
        if (c !== 0) return c;
        return (b.score ?? -1) - (a.score ?? -1);
      });
    case "score":
    default:
      return out.sort((a, b) => {
        const d = (b.score ?? -1) - (a.score ?? -1);
        if (d !== 0) return d;
        return effectiveDays(a) - effectiveDays(b);
      });
  }
}

function scoreStyles(score: number): string {
  if (score >= 4.5) return "bg-emerald-400/15 text-emerald-200 ring-1 ring-emerald-400/30";
  if (score >= 4.0) return "bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20";
  if (score >= 3.5) return "bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/20";
  return "bg-slate-700/30 text-slate-400 ring-1 ring-slate-600/40";
}

// ── Ranked-tab tier grouping ──────────────────────────────────────────────
// The Ranked view groups every scored role into a fit tier (5 = exceptional …
// 1 = poor). Score is a float (e.g. 4.5); the tier is its floor, clamped 1-5.
function scoreTier(score: number): number {
  return Math.max(1, Math.min(5, Math.floor(score)));
}

const TIER_META: Record<number, { label: string; accent: string }> = {
  5: { label: "Exceptional fit", accent: "text-emerald-200 border-emerald-400/30 bg-emerald-400/10" },
  4: { label: "Strong fit", accent: "text-emerald-300 border-emerald-400/20 bg-emerald-400/[0.07]" },
  3: { label: "Possible fit", accent: "text-amber-300 border-amber-400/25 bg-amber-400/10" },
  2: { label: "Weak fit", accent: "text-orange-300 border-orange-400/25 bg-orange-400/10" },
  1: { label: "Poor fit", accent: "text-rose-300 border-rose-400/25 bg-rose-400/10" }
};

function groupByTier(rows: PipelineRow[]): { tier: number; rows: PipelineRow[] }[] {
  const groups = new Map<number, PipelineRow[]>();
  for (const r of rows) {
    if (typeof r.score !== "number") continue;
    const t = scoreTier(r.score);
    (groups.get(t) ?? groups.set(t, []).get(t)!).push(r);
  }
  return [5, 4, 3, 2, 1].filter(t => groups.has(t)).map(t => ({ tier: t, rows: groups.get(t)! }));
}

function RoleRow({ r }: { r: PipelineRow }) {
  const ageItems = ageBadges(r);
  const detailsHref = `/role/${encodeRoleSlug(r.url)}`;
  const applied = r.status === "applied";
  const followUp = applied && daysApplied(r) >= 7;
  return (
    <li className="group relative flex items-stretch gap-4 rounded-xl border border-slate-800/70 bg-slate-900/40 px-4 py-3.5 transition-all hover:border-slate-700 hover:bg-slate-900/70">
      {/* Score rail */}
      <div className="flex w-12 shrink-0 flex-col items-center justify-center">
        {typeof r.score === "number" ? (
          <span className={`flex h-11 w-11 items-center justify-center rounded-lg text-lg font-semibold tabular-nums ${scoreStyles(r.score)}`}>
            {r.score.toFixed(1)}
          </span>
        ) : (
          <span className="flex h-11 w-11 items-center justify-center rounded-lg text-[10px] uppercase tracking-wide text-slate-600 ring-1 ring-slate-800">
            —
          </span>
        )}
      </div>

      {/* Main */}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">{r.company}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={r.url}
            target="_blank"
            rel="noopener"
            className="font-medium text-slate-100 underline-offset-4 hover:text-indigo-300 hover:underline break-words"
          >
            {r.role}
          </a>
          {r.archetype && (
            <span className="rounded-md bg-slate-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              {r.archetype}
            </span>
          )}
          {/* Each track scores on its OWN 1-5 scale, so a score is comparable
              only within a track: 5 on "now" means fastest time-to-income, 5 on
              "pm" means best NYC product fit. Rendering both as a bare "5.0"
              with nothing to tell them apart is what made a Get-Hired-Now role
              read as a top NYC recommendation. "pm" is unlabelled because it is
              the default search and labelling every card would be noise. */}
          {r.track && r.track !== "pm" && (
            <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300/80">
              {r.track === "now" ? "get hired now" : r.track}
            </span>
          )}
        </div>
        {r.verdict && <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{r.verdict}</p>}
        {r.redFlags && <p className="mt-1 text-xs leading-relaxed text-amber-300/80">⚠ {r.redFlags}</p>}
        {r.locations.length > 0 && (
          <div className="mt-1.5 truncate text-xs text-slate-500">{r.locations.join(" · ")}</div>
        )}
      </div>

      {/* Meta rail */}
      <div className="flex shrink-0 flex-col items-end justify-between gap-2">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {locationBadge(r).map(tag => (
            <span key={tag.label} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${tag.color}`}>
              {tag.label}
            </span>
          ))}
          {ageItems.map((a, i) => (
            <span key={i} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${a.color}`} title={a.title}>
              {a.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {followUp && (
            <span className="rounded-md border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300" title={r.appliedAt ? `Applied ${r.appliedAt}` : "Applied"}>
              follow up · {daysApplied(r)}d
            </span>
          )}
          {r.stagedSlug && (
            <Link
              href={`/pack/${r.stagedSlug}`}
              className="rounded-md border border-indigo-400/40 bg-indigo-500/15 px-2 py-0.5 text-[10px] font-medium text-indigo-200 hover:bg-indigo-500/25"
              title="Open the generated application pack"
            >
              Pack ↗
            </Link>
          )}
          <Link
            href={detailsHref}
            className="rounded-md border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
            title="Open details (report + JD preview)"
          >
            Details
          </Link>
          <StatusControl url={r.url} company={r.company} role={r.role} current={r.status} />
        </div>
      </div>
    </li>
  );
}

function TabLink({
  view, active, count, sortParam, q, fresh
}: { view: View; active: boolean; count: number; sortParam?: string; q: string; fresh: boolean }) {
  const params = new URLSearchParams();
  params.set("tab", view.id);
  if (sortParam) params.set("sort", sortParam);
  if (q) params.set("q", q);
  if (fresh) params.set("fresh", "1");
  return (
    <Link
      href={`?${params.toString()}`}
      title={view.hint}
      className={
        "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-all " +
        (active
          ? "bg-indigo-500/15 text-indigo-200 ring-1 ring-inset ring-indigo-400/40"
          : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200")
      }
    >
      {view.label}
      <span className={"rounded-md px-1.5 py-0.5 text-[11px] tabular-nums " + (active ? "bg-indigo-400/20 text-indigo-200" : "bg-slate-800 text-slate-500")}>
        {count}
      </span>
    </Link>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string; sort?: string; q?: string; fresh?: string }> }) {
  const data = await loadPipeline();
  const pendingReview = await pendingReviewCount();
  const { tab = "shortlist", sort: sortParam, q: rawQ, fresh: freshParam } = await searchParams;
  const q = (rawQ ?? "").trim().toLowerCase();
  const fresh = freshParam === "1";

  const activeView = ALL_VIEWS.find(t => t.id === tab) ?? CORE_VIEWS[0];

  const count = (v: View) => data.rows.filter(v.match).length;
  const visibleStatusViews = STATUS_VIEWS.filter(v => count(v) > 0);

  let filtered = data.rows.filter(activeView.match);
  if (fresh) filtered = filtered.filter(r => effectiveDays(r) <= 30);
  if (q) filtered = filtered.filter(r => `${r.company} ${r.role}`.toLowerCase().includes(q));

  const effectiveSort = sortParam && SORTS.some(s => s.id === sortParam)
    ? sortParam
    : (activeView.id === "all" ? "days" : "score");
  const sorted = applySort(filtered, effectiveSort);

  const shortlistCount = count(CORE_VIEWS[0]);
  const stagedCount = count(CORE_VIEWS[1]);

  return (
    <main className="min-h-screen">
      {/* ambient glow */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-64 bg-gradient-to-b from-indigo-500/10 to-transparent" />

      <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-6 md:px-10">
          {/* top bar */}
          <div className="flex items-center gap-4 py-4">
            <Link href="/" className="flex shrink-0 items-center gap-2.5">
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
              <div className="tabular-nums text-slate-400">{data.lastScannedAt ? data.lastScannedAt.toLocaleString() : "never"}</div>
            </div>
          </div>

          {/* views + controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <nav className="flex flex-wrap items-center gap-1">
              {CORE_VIEWS.map(v => (
                <TabLink key={v.id} view={v} active={v.id === activeView.id} count={count(v)} sortParam={sortParam} q={q} fresh={fresh} />
              ))}
              {visibleStatusViews.length > 0 && <span className="mx-1 h-5 w-px bg-slate-800" />}
              {visibleStatusViews.map(v => (
                <TabLink key={v.id} view={v} active={v.id === activeView.id} count={count(v)} sortParam={sortParam} q={q} fresh={fresh} />
              ))}
              <span className="mx-1 h-5 w-px bg-slate-800" />
              <Link
                href="/review"
                className={"flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors " + (pendingReview > 0 ? "bg-blue-500/15 text-blue-200 ring-1 ring-inset ring-blue-400/40 hover:bg-blue-500/25" : "text-slate-500 hover:text-slate-300")}
              >
                Review queue
                {pendingReview > 0 && (
                  <span className="rounded bg-blue-400/20 px-1.5 py-0.5 text-[10px] tabular-nums text-blue-100">{pendingReview}</span>
                )}
              </Link>
              <Link
                href="/now"
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-emerald-300/80 transition-colors hover:bg-emerald-500/10 hover:text-emerald-200"
              >
                Get Hired Now
              </Link>
            </nav>

            <div className="flex items-center gap-2">
              <FreshToggle active={fresh} tab={activeView.id} sortParam={sortParam} q={q} />
              <div className="flex items-center rounded-lg bg-slate-900/60 p-0.5 ring-1 ring-inset ring-slate-800">
                {SORTS.map(s => {
                  const isActive = s.id === effectiveSort;
                  const params = new URLSearchParams();
                  params.set("tab", activeView.id);
                  params.set("sort", s.id);
                  if (q) params.set("q", q);
                  if (fresh) params.set("fresh", "1");
                  return (
                    <Link
                      key={s.id}
                      href={`?${params.toString()}`}
                      className={"rounded-md px-2.5 py-1 text-xs font-medium transition-colors " + (isActive ? "bg-slate-700/60 text-slate-100" : "text-slate-500 hover:text-slate-300")}
                    >
                      {s.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8 md:px-10">
        {/* context line */}
        <div className="mb-5 flex items-baseline justify-between text-sm">
          <p className="text-slate-400">
            <span className="font-semibold text-slate-200">{sorted.length}</span> {activeView.label.toLowerCase()}
            {fresh && <span className="text-slate-500"> · fresh only</span>}
            {q && <span className="text-slate-500"> · matching “{q}”</span>}
          </p>
          <p className="hidden text-xs text-slate-500 sm:block">
            {shortlistCount} worth applying to · {stagedCount} ready · {data.totalCount} tracked
          </p>
        </div>

        {sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 px-6 py-16 text-center">
            <p className="text-sm text-slate-400">
              {(fresh || q)
                ? <>No {activeView.label.toLowerCase()} match{fresh && <> the <span className="text-emerald-300">≤30d fresh</span> filter</>}{fresh && q && " and"}{q && <> “{q}”</>}. Try clearing filters.</>
                : activeView.id === "shortlist"
                  ? "No roles scored 4+ yet. The nightly scan scores new roles automatically."
                  : activeView.id === "staged"
                    ? "No application packs generated yet. High-fit roles get staged after the nightly scoring."
                    : "Nothing here yet."}
            </p>
          </div>
        ) : activeView.id === "ranked" ? (
          <div className="space-y-8">
            {groupByTier(sorted).map(({ tier, rows }) => (
              <section key={tier}>
                <div className="mb-3 flex items-center gap-3">
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums ${TIER_META[tier].accent}`}>
                    Score {tier}
                  </span>
                  <h2 className="text-sm font-medium text-slate-300">{TIER_META[tier].label}</h2>
                  <span className="text-xs tabular-nums text-slate-600">{rows.length}</span>
                  <span className="h-px flex-1 bg-slate-800/70" />
                </div>
                <ul className="space-y-2.5">
                  {rows.map(r => <RoleRow key={r.url} r={r} />)}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {sorted.map(r => <RoleRow key={r.url} r={r} />)}
          </ul>
        )}

        <footer className="mt-14 border-t border-slate-800/70 pt-6 text-xs text-slate-600">
          Status changes write to <code className="text-slate-500">data/applications.md</code>. Reports live in <code className="text-slate-500">reports/</code>.
        </footer>
      </div>
    </main>
  );
}

function FreshToggle({ active, tab, sortParam, q }: { active: boolean; tab: string; sortParam?: string; q: string }) {
  const params = new URLSearchParams();
  params.set("tab", tab);
  if (sortParam) params.set("sort", sortParam);
  if (q) params.set("q", q);
  if (!active) params.set("fresh", "1");
  return (
    <Link
      href={`?${params.toString()}`}
      title="Only roles posted or updated within 30 days"
      className={
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ring-1 ring-inset " +
        (active
          ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30"
          : "bg-slate-900/60 text-slate-400 ring-slate-800 hover:text-slate-200")
      }
    >
      <span className={"h-1.5 w-1.5 rounded-full " + (active ? "bg-emerald-400" : "bg-slate-600")} />
      Fresh ≤30d
    </Link>
  );
}
