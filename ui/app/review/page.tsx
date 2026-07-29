import { readFile } from "fs/promises";
import path from "path";
import Link from "next/link";
import ReviewControls from "@/components/ReviewControls";

export const dynamic = "force-dynamic";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";
const QUEUE_PATH = path.join(DATA_ROOT, "data", "review-queue.json");

interface QueueItem {
  slug: string;
  company: string;
  role: string;
  sourceUrl: string;
  applyUrl: string;
  ats: string;
  score: number;
  ageDays: number;
  geo: string;
  coverLetter: "absent" | "optional" | "required" | "unknown";
  cvVariant: string;
  notes: string;
  decision: string | null;
  decidedAt: string | null;
  track?: string;
}

interface Queue {
  batch: string;
  created: string;
  note?: string;
  items: QueueItem[];
  tracks?: Record<string, string>;
}

interface Loaded extends QueueItem {
  answers?: string;
  coverBody?: string;
}

async function loadQueue(): Promise<Queue | null> {
  try {
    const q: Queue = JSON.parse(await readFile(QUEUE_PATH, "utf-8"));
    return q;
  } catch {
    return null;
  }
}

async function hydrate(item: QueueItem): Promise<Loaded> {
  const dir = path.join(DATA_ROOT, "output", item.slug);
  let answers: string | undefined;
  let coverBody: string | undefined;
  try {
    answers = await readFile(path.join(dir, "answers.md"), "utf-8");
  } catch {}
  try {
    const md = await readFile(path.join(dir, "cover-letter.md"), "utf-8");
    coverBody = md.split(/^---\s*$/m).slice(1).join("---").trim();
  } catch {}
  return { ...item, answers, coverBody };
}

// ≤5d is the goal, ≤30d a stretch, >30d probably filled.
function ageColor(days: number): string {
  if (days <= 5) return "text-emerald-300 border-emerald-400/30 bg-emerald-400/10";
  if (days <= 30) return "text-amber-300 border-amber-400/30 bg-amber-400/10";
  return "text-rose-300 border-rose-400/30 bg-rose-400/10";
}

const COVER_BADGE: Record<string, { label: string; color: string }> = {
  absent: { label: "no cover letter field", color: "text-slate-400 border-slate-700 bg-slate-800/40" },
  optional: { label: "cover letter optional — not attaching", color: "text-slate-400 border-slate-700 bg-slate-800/40" },
  required: { label: "cover letter REQUIRED", color: "text-blue-200 border-blue-400/40 bg-blue-500/15" },
  unknown: { label: "cover letter: not yet checked", color: "text-amber-300 border-amber-400/30 bg-amber-400/10" }
};

const DECISION_BADGE: Record<string, { label: string; color: string }> = {
  approved: { label: "APPROVED", color: "text-emerald-200 border-emerald-400/50 bg-emerald-500/20" },
  hold: { label: "ON HOLD", color: "text-amber-200 border-amber-400/50 bg-amber-500/20" },
  rejected: { label: "REJECTED", color: "text-rose-200 border-rose-400/50 bg-rose-500/20" }
};

// VP runs three parallel tracks and asked that the pivots stay visually
// separate from the standard search rather than blended into one list.
const TRACK_ORDER = ["pm", "govtech", "nonprofit", "teaching"];
const TRACK_FALLBACK: Record<string, string> = {
  pm: "PM / PMM — the standard search",
  nonprofit: "Nonprofit / charity",
  teaching: "Teaching",
};

function Badge({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span title={title} className={`px-2 py-0.5 rounded border text-[11px] font-mono ${color}`}>
      {label}
    </span>
  );
}

export default async function ReviewPage() {
  const queue = await loadQueue();

  if (!queue || !queue.items?.length) {
    return (
      <main className="min-h-screen px-6 py-10 max-w-5xl mx-auto">
        <Link href="/" className="text-xs text-slate-500 hover:text-blue-300 font-mono">
          ← back to dashboard
        </Link>
        <h1 className="text-2xl font-semibold mt-3">Review queue</h1>
        <p className="text-slate-400 mt-4 text-sm">
          Nothing waiting for review. When a batch is prepared it lands in{" "}
          <code className="text-slate-300">data/review-queue.json</code>.
        </p>
      </main>
    );
  }

  const items = await Promise.all(queue.items.map(hydrate));
  const grouped: Record<string, Loaded[]> = {};
  for (const it of items) (grouped[it.track || "pm"] ||= []).push(it);
  const counts = {
    approved: items.filter(i => i.decision === "approved").length,
    hold: items.filter(i => i.decision === "hold").length,
    rejected: items.filter(i => i.decision === "rejected").length,
    undecided: items.filter(i => !i.decision).length
  };

  return (
    <main className="min-h-screen px-6 py-8 md:px-12 md:py-10 max-w-5xl mx-auto">
      <header className="mb-8 border-b border-slate-800 pb-6">
        <Link href="/" className="text-xs text-slate-500 hover:text-blue-300 font-mono">
          ← back to dashboard
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Review queue</h1>
        <p className="text-sm text-slate-400 mt-1">{queue.batch}</p>
        {queue.note && <p className="text-xs text-slate-500 mt-2 font-mono">{queue.note}</p>}
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge label={`${counts.undecided} awaiting you`} color="text-blue-200 border-blue-400/40 bg-blue-500/15" />
          <Badge label={`${counts.approved} approved`} color="text-emerald-300 border-emerald-400/30 bg-emerald-400/10" />
          <Badge label={`${counts.hold} on hold`} color="text-amber-300 border-amber-400/30 bg-amber-400/10" />
          <Badge label={`${counts.rejected} rejected`} color="text-rose-300 border-rose-400/30 bg-rose-400/10" />
        </div>
      </header>

      {TRACK_ORDER.filter(t => grouped[t]?.length).map(t => (
        <section key={t} className="mb-10">
          <div className="mb-4 flex items-baseline gap-3 border-b border-slate-800 pb-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
              {queue.tracks?.[t] ?? TRACK_FALLBACK[t] ?? t}
            </h2>
            <span className="text-xs text-slate-600 font-mono">{grouped[t].length}</span>
          </div>
          <div className="space-y-6">
        {grouped[t].map(item => {
          const cover = COVER_BADGE[item.coverLetter] ?? COVER_BADGE.unknown;
          const dec = item.decision ? DECISION_BADGE[item.decision] : null;
          return (
            <article
              key={item.slug}
              className={`rounded-lg border bg-slate-900/40 p-5 transition ${
                item.decision === "approved"
                  ? "border-emerald-400/40"
                  : item.decision === "rejected"
                  ? "border-rose-400/30 opacity-60"
                  : item.decision === "hold"
                  ? "border-amber-400/30"
                  : "border-slate-800"
              }`}
            >
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-slate-100">{item.company}</h2>
                  <p className="text-sm text-slate-300">{item.role}</p>
                </div>
                {dec && <Badge label={dec.label} color={dec.color} />}
              </div>

              <div className="flex flex-wrap gap-2 mt-3">
                <Badge label={`score ${item.score}`} color="text-blue-200 border-blue-400/40 bg-blue-500/15" />
                <Badge label={`${item.ageDays}d old`} color={ageColor(item.ageDays)} />
                <Badge label={item.geo} color="text-sky-300 border-sky-400/30 bg-sky-400/10" />
                <Badge label={`cv: ${item.cvVariant}`} color="text-slate-400 border-slate-700 bg-slate-800/40" />
                <Badge label={cover.label} color={cover.color} />
                <Badge
                  label={item.ats === "unresolved" ? "apply path UNRESOLVED" : item.ats}
                  color={
                    item.ats === "unresolved"
                      ? "text-rose-300 border-rose-400/30 bg-rose-400/10"
                      : "text-slate-400 border-slate-700 bg-slate-800/40"
                  }
                />
              </div>

              {item.notes && <p className="text-xs text-slate-400 mt-3 leading-relaxed">{item.notes}</p>}

              <div className="flex flex-wrap gap-2 mt-4">
                <a
                  href={`/api/files/${item.slug}/cv.pdf`}
                  target="_blank"
                  rel="noopener"
                  className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-md hover:border-blue-400/60 transition text-xs"
                >
                  📄 cv.pdf
                </a>
                <Link
                  href={`/pack/${item.slug}`}
                  className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-md hover:border-blue-400/60 transition text-xs"
                >
                  📦 full pack
                </Link>
                {item.applyUrl ? (
                  <a
                    href={item.applyUrl}
                    target="_blank"
                    rel="noopener"
                    className="px-3 py-1.5 bg-blue-500/15 border border-blue-400/60 text-blue-200 rounded-md hover:bg-blue-500/25 transition text-xs font-medium"
                  >
                    🌐 Open application ↗
                  </a>
                ) : (
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noopener"
                    className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-md hover:border-blue-400/60 transition text-xs"
                  >
                    🔎 source listing ↗
                  </a>
                )}
              </div>

              {item.answers && (
                <details className="mt-4 group" open>
                  <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 font-mono hover:text-blue-300">
                    Application answers
                  </summary>
                  <pre className="mt-2 px-4 py-3 bg-slate-950 border border-slate-800 rounded-md text-xs leading-relaxed text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono">
                    {item.answers}
                  </pre>
                </details>
              )}

              {item.coverBody && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 font-mono hover:text-blue-300">
                    Cover letter on file{" "}
                    <span className="normal-case text-slate-600">
                      ({item.coverLetter === "required" ? "will be attached" : "not being attached"})
                    </span>
                  </summary>
                  <pre className="mt-2 px-4 py-3 bg-slate-950 border border-slate-800 rounded-md text-xs leading-relaxed text-slate-400 overflow-x-auto whitespace-pre-wrap font-mono">
                    {item.coverBody}
                  </pre>
                </details>
              )}

              <div className="mt-5 pt-4 border-t border-slate-800 flex items-center justify-between gap-3 flex-wrap">
                <ReviewControls slug={item.slug} decision={item.decision} />
                {item.decidedAt && (
                  <span className="text-[11px] text-slate-600 font-mono">
                    decided {item.decidedAt.slice(0, 16).replace("T", " ")}
                  </span>
                )}
              </div>
            </article>
          );
        })}
          </div>
        </section>
      ))}

      <footer className="mt-12 pt-6 border-t border-slate-800 text-xs text-slate-600 font-mono">
        <p>
          Approving here does not submit anything. It records your decision in{" "}
          <code className="text-slate-400">data/review-queue.json</code>; submission stays a
          separate, deliberate step.
        </p>
      </footer>
    </main>
  );
}
