import { loadInboxLeads, tierColor, ageColor, type RankedLead } from "@/lib/inbox-leads";
import Link from "next/link";

export const dynamic = "force-dynamic";

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function LeadRow({ lead }: { lead: RankedLead }) {
  const age = ageColor(lead.ageDays);
  return (
    <li className="px-4 py-3 rounded-md border border-slate-800/60 bg-slate-900/40 hover:bg-slate-900/80 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <a
              href={lead.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-100 hover:text-blue-300 font-medium underline-offset-4 hover:underline"
            >
              {lead.title}
            </a>
            <span className="text-slate-500">@</span>
            <span className="text-slate-300 font-medium">{lead.company}</span>
            {lead.archetype && (
              <span className="text-[10px] uppercase tracking-wide font-mono text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">
                {lead.archetype}
              </span>
            )}
          </div>
          {lead.verdict && (
            <p className="mt-1.5 text-sm text-slate-300 leading-relaxed">{lead.verdict}</p>
          )}
          {lead.redFlags && (
            <p className="mt-1 text-xs text-amber-300/90 leading-relaxed">⚠ {lead.redFlags}</p>
          )}
          <div className="mt-1.5 text-xs text-slate-500 font-mono break-all">{hostOf(lead.url)}</div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {lead.ageDays != null && (
            <span className={`text-[10px] font-mono border rounded px-1.5 py-0.5 ${age}`}>
              {lead.ageDays}d{lead.ageWarning ? " ⚠" : ""}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export default async function RankedPage() {
  const snap = await loadInboxLeads();
  const leads = snap.leads;
  const counts = [5, 4, 3, 2, 1, 0].map(t => ({ tier: t, n: leads.filter(l => l.tier === t).length }));

  return (
    <main className="min-h-screen px-6 py-8 md:px-12 md:py-10 max-w-6xl mx-auto bg-slate-950 text-slate-100">
      <header className="mb-8 border-b border-slate-700 pb-6">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold">Ranked leads</h1>
            <p className="mt-1 text-sm text-slate-400">
              Auto-ingested from Gmail, scored against your resume.
            </p>
          </div>
          <Link
            href="/"
            className="text-sm text-slate-400 hover:text-blue-300 underline underline-offset-4"
          >
            ← back to pipeline
          </Link>
        </div>
        <div className="mt-3 text-xs text-slate-500 font-mono">
          {snap.generatedAt && <>Generated: {snap.generatedAt}</>}
          {snap.filtersLine && <> · {snap.filtersLine}</>}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {counts.filter(c => c.n > 0).map(c => {
            const col = tierColor(c.tier);
            return (
              <span
                key={c.tier}
                className={`text-xs font-mono border rounded px-2 py-1 ${col.fg} ${col.border} ${col.bg}`}
              >
                {c.tier > 0 ? `Tier ${c.tier}` : "Unscored"} · {col.label} · {c.n}
              </span>
            );
          })}
        </div>
      </header>

      {leads.length === 0 ? (
        <p className="text-slate-400">
          No ranked leads yet. Run <code className="text-slate-300">node rank-leads.mjs</code> after fetching JDs.
        </p>
      ) : (
        [5, 4, 3, 2, 1, 0].map(tier => {
          const subset = leads.filter(l => l.tier === tier);
          if (subset.length === 0) return null;
          const col = tierColor(tier);
          return (
            <section key={tier} className="mb-8">
              <h2 className={`text-lg font-semibold mb-3 ${col.fg}`}>
                {tier > 0 ? `Score ${tier}` : "Unscored"}
                <span className="ml-2 text-slate-500 font-normal text-sm">— {col.label} ({subset.length})</span>
              </h2>
              <ul className="space-y-2">
                {subset.map((lead, i) => <LeadRow key={`${tier}-${i}`} lead={lead} />)}
              </ul>
            </section>
          );
        })
      )}
    </main>
  );
}
