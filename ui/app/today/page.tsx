import { readFile } from "fs/promises";
import path from "path";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteNav from "@/components/SiteNav";
import ReviewControls from "@/components/ReviewControls";
import ApplyButton from "@/components/ApplyButton";

/**
 * /today — the handful of roles worth VP's next ten minutes.
 *
 * WHY THIS PAGE EXISTS, AND WHY IT IS NOT /review. The review queue held 277
 * pending cards on 2026-09-02; 131 were past the window that would refuse to
 * mint them, and it had grown every night since 13 August without a single card
 * ever leaving except by his click. He cleared it by hand once, rejected 57 of
 * 61 on age, and made one decision in the three weeks after. The queue was never
 * broken — it just answers "what exists", and the question he actually has is
 * "what should I do now".
 *
 * ⚠ THIS IS A DIFFERENT VIEW, NOT A SECOND COPY OF THE CARD. It shows something
 * /review cannot: WHY each role was chosen today, in the words of the facts that
 * ordered it. The interactive parts — ReviewControls, ApplyButton — are the
 * shared components, so a decision made here is the same decision made there.
 * Nothing about selection is decided in this file; lib/slate.mjs decides and
 * build-slate.mjs writes data/slate.json.
 */

export const dynamic = "force-dynamic";

interface SlateItem {
  slug: string;
  company: string;
  role: string;
  track: string;
  score: number;
  applyUrl: string;
  sourceUrl: string;
  ats: string;
  decision: string | null;
  why?: string[];
}

interface Owed {
  kind: string;
  slug: string;
  company: string;
  role: string;
  applyUrl: string;
  daysWaiting: number | null;
  liveness?: "active" | "expired" | "uncertain";
  livenessReason?: string;
}

interface Slate {
  date: string;
  items: SlateItem[];
  owed?: Owed[];
  expired?: { slug: string }[];
}

async function loadSlate(): Promise<Slate | null> {
  try {
    const root = process.env.CAREER_OPS_ROOT ?? "/data";
    return JSON.parse(await readFile(path.join(root, "data", "slate.json"), "utf-8"));
  } catch {
    // ⚠ Absent is not empty. A slate that has never been built and a day with
    // nothing to do look identical to a `?? []`, and they mean opposite things.
    return null;
  }
}

const TRACK_LABEL: Record<string, string> = {
  pm: "PM / PMM", civic: "City of NY", nonprofit: "Nonprofit", teaching: "Teaching", now: "Get Hired Now",
};

export default async function TodayPage() {
  const slate = await loadSlate();
  const today = new Date().toISOString().slice(0, 10);
  const stale = slate != null && slate.date !== today;
  const owedAll = slate?.owed ?? [];
  const owedDead = owedAll.filter((o) => o.liveness === "expired");
  const owedLive = owedAll.filter((o) => o.liveness !== "expired");

  return (
    <>
      <SiteHeader active="review" />
      <main className="mx-auto min-h-screen max-w-4xl px-6 py-8 md:px-10">
        <SiteNav active="today" />

        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Today</h1>
          <p className="mt-1 text-xs text-slate-500">
            Chosen from everything that qualifies. Nothing is submitted from here — approving records a decision only.
          </p>
          {stale && (
            <p className="mt-2 rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 font-mono text-xs text-amber-200">
              This slate was built on {slate?.date}, not today. The nightly has not run since.
            </p>
          )}
        </header>

        {slate == null ? (
          <p className="rounded border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-400">
            No slate has been built yet. It is written by <code className="font-mono text-slate-300">build-slate.mjs</code>,
            which runs in the nightly.
          </p>
        ) : slate.items.length === 0 ? (
          <p className="rounded border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-400">
            Nothing today. That is a real answer, not a failure — everything fresh has been decided.
          </p>
        ) : (
          <ol className="space-y-4">
            {slate.items.map((item, i) => (
              <li key={item.slug}>
                <article className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-base font-medium text-slate-100">
                      <span className="mr-2 font-mono text-xs text-slate-600">{i + 1}</span>
                      {item.company} — {item.role}
                    </h2>
                    <span className="rounded border border-slate-700 bg-slate-800/40 px-2 py-0.5 font-mono text-[11px] text-slate-400">
                      {TRACK_LABEL[item.track] ?? item.track}
                    </span>
                  </div>

                  {/* The whole point of the page: the reasons, in the words of
                      the facts that produced the ordering. */}
                  {item.why?.length ? (
                    <ul className="mt-3 flex flex-wrap gap-x-2 gap-y-1">
                      {item.why.map((w, k) => (
                        <li key={k} className="rounded border border-slate-700/60 bg-slate-800/30 px-2 py-0.5 font-mono text-[11px] text-slate-400">
                          {w}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <ApplyButton url={item.applyUrl || item.sourceUrl} company={item.company} role={item.role} />
                    <ReviewControls slug={item.slug} decision={item.decision} />
                    <Link href={`/pack/${item.slug}`} className="rounded-md px-2.5 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-200">
                      the pack →
                    </Link>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        )}

        {/* ⚠ A CLOSED REQUISITION IS NOT OWED, AND SAYING IT IS COSTS THE WHOLE
            SECTION ITS CREDIBILITY. The nightly report told VP two approved
            packs were "confirmed open" for three weeks while both were closed.
            The dead ones are listed separately and never counted. */}
        {owedLive.length ? (
          <section className="mt-10">
            <h2 className="text-sm font-medium text-slate-300">Owed</h2>
            <p className="mt-1 text-xs text-slate-600">
              Already approved and already built. Nothing else in the pipeline will move these.
            </p>
            <ul className="mt-3 space-y-2">
              {owedLive.map((o) => (
                <li key={o.slug} className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-slate-800 bg-slate-900/30 px-4 py-3">
                  <span className="text-sm text-slate-200">{o.company} — {o.role}</span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {o.liveness === "active" ? "open" : "unconfirmed"}
                    {o.daysWaiting != null ? ` · waiting ${o.daysWaiting}d` : ""}
                    {" · "}
                    <Link href={`/pack/${o.slug}`} className="text-slate-400 hover:text-slate-200">pack</Link>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {owedDead.length ? (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-slate-500">Closed before you submitted</h2>
            <ul className="mt-3 space-y-2">
              {owedDead.map((o) => (
                <li key={o.slug} className="rounded border border-slate-800/60 bg-slate-900/20 px-4 py-3">
                  <div className="text-sm text-slate-500">{o.company} — {o.role}</div>
                  <div className="font-mono text-[11px] text-slate-600">{o.livenessReason}</div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="mt-10 text-xs text-slate-600">
          <Link href="/review" className="text-slate-400 hover:text-slate-200">Everything else →</Link>
        </p>
      </main>
    </>
  );
}
