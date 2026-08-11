import { readFile, stat } from "fs/promises";
import path from "path";
import Link from "next/link";
import ReviewControls from "@/components/ReviewControls";
import SiteNav from "@/components/SiteNav";

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
  glassdoor?: Glassdoor;
}

interface Glassdoor {
  rating: number | null;
  reviews: number | null;
  scope?: string;
  recommend: number | null;
  workLife: number | null;
  culture: number | null;
  career: number | null;
  interview: {
    positive: number;
    difficulty: number | null;
    reviews: number | null;
    role: string;
  } | null;
  url: string;
  note?: string;
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
  hasCv?: boolean;
}

async function loadQueue(): Promise<Queue | null> {
  try {
    return JSON.parse(await readFile(QUEUE_PATH, "utf-8")) as Queue;
  } catch {
    return null;
  }
}

async function hydrate(item: QueueItem): Promise<Loaded> {
  const dir = path.join(DATA_ROOT, "output", item.slug);
  // Whether a CV EXISTS, asked of the filesystem. The cv.pdf link used to be
  // gated on item.cvVariant, which enqueue-review writes from the JD text at
  // enqueue time - a statement of intent, never of fact. On 2026-08-06 the badge
  // read "cv: ai-infra" on eight cards whose cv.pdf 404'd.
  let hasCv = false;
  try { await stat(path.join(dir, "cv.pdf")); hasCv = true; } catch {}
  let answers: string | undefined;
  let coverBody: string | undefined;
  try {
    answers = await readFile(path.join(dir, "answers.md"), "utf-8");
  } catch {}
  try {
    const md = await readFile(path.join(dir, "cover-letter.md"), "utf-8");
    coverBody = md.split(/^---\s*$/m).slice(1).join("---").trim();
  } catch {}
  return { ...item, answers, coverBody, hasCv };
}

// Tabs need short labels; the long description belongs under the tab bar, once.
const TRACK_ORDER = ["pm", "now", "govtech", "nonprofit", "teaching", "venture"];
const TRACK_LABEL: Record<string, string> = {
  pm: "PM / PMM",
  govtech: "Government",
  nonprofit: "Nonprofit",
  teaching: "Teaching",
  venture: "Venture",
};

// ≤5d is the goal, ≤30d a stretch, >30d probably filled.
function ageColor(days: number): string {
  if (days <= 5) return "text-emerald-300 border-emerald-400/30 bg-emerald-400/10";
  if (days <= 30) return "text-amber-300 border-amber-400/30 bg-amber-400/10";
  return "text-rose-300 border-rose-400/30 bg-rose-400/10";
}

const COVER_BADGE: Record<string, { label: string; color: string }> = {
  absent: { label: "no cover letter field", color: "text-slate-400 border-slate-700 bg-slate-800/40" },
  optional: { label: "cover letter optional", color: "text-slate-400 border-slate-700 bg-slate-800/40" },
  required: { label: "cover letter REQUIRED", color: "text-blue-200 border-blue-400/40 bg-blue-500/15" },
  unknown: { label: "cover letter unchecked", color: "text-amber-300 border-amber-400/30 bg-amber-400/10" },
};

const DECISION_BADGE: Record<string, { label: string; color: string }> = {
  approved: { label: "APPROVED", color: "text-emerald-200 border-emerald-400/50 bg-emerald-500/20" },
  hold: { label: "ON HOLD", color: "text-amber-200 border-amber-400/50 bg-amber-500/20" },
  rejected: { label: "REJECTED", color: "text-rose-200 border-rose-400/50 bg-rose-500/20" },
};

function Badge({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span
      title={title ?? label}
      className={`inline-block max-w-[22rem] truncate rounded border px-2 py-0.5 align-middle font-mono text-[11px] ${color}`}
    >
      {label}
    </span>
  );
}

// Notes are authored as "LABEL: text || LABEL: text". Rendering that as one
// paragraph made the risk warnings invisible, so each segment becomes its own
// callout and anything flagged RISK / EXCLUDED / DILIGENCE gets colour.
// Glassdoor is two separate judgements and they disagree often enough to be
// worth showing side by side: what it is like to WORK there, and what it is
// like to be INTERVIEWED there. Suno is 3.7 to work at and 22% positive to
// interview with; a single blended number would hide exactly that.
function stars(n: number) {
  return n >= 4.0
    ? "text-emerald-300 border-emerald-400/30 bg-emerald-400/10"
    : n >= 3.5
    ? "text-amber-300 border-amber-400/30 bg-amber-400/10"
    : "text-rose-300 border-rose-400/30 bg-rose-400/10";
}

function pct(n: number) {
  return n >= 70
    ? "text-emerald-300 border-emerald-400/30 bg-emerald-400/10"
    : n >= 40
    ? "text-amber-300 border-amber-400/30 bg-amber-400/10"
    : "text-rose-300 border-rose-400/30 bg-rose-400/10";
}

function GlassdoorPanel({ gd }: { gd: Glassdoor }) {
  const sub = [
    gd.workLife != null ? ["work/life", gd.workLife] as const : null,
    gd.culture != null ? ["culture", gd.culture] as const : null,
    gd.career != null ? ["career", gd.career] as const : null,
  ].filter(Boolean) as (readonly [string, number])[];

  // A company with no Glassdoor presence is not a neutral result — it means no
  // salary, culture or turnover signal exists to check — so it gets its own
  // rendering rather than an empty panel or a crash on a null rating.
  if (gd.rating == null) {
    return (
      <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[11px] uppercase tracking-wider font-mono text-slate-500">
            Glassdoor
          </span>
          <span className="px-2 py-0.5 rounded border text-xs text-slate-400 border-slate-700 bg-slate-800/40">
            no presence — nothing to check
          </span>
        </div>
        {gd.note && <p className="mt-2 text-xs leading-relaxed text-slate-400">{gd.note}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <a
          href={gd.url}
          target="_blank"
          rel="noopener"
          className="text-[11px] uppercase tracking-wider font-mono text-slate-500 hover:text-blue-300"
        >
          Glassdoor ↗
        </a>

        <span className={`px-2 py-0.5 rounded border text-xs ${stars(gd.rating)}`}>
          working here {gd.rating.toFixed(1)}/5
          {gd.reviews != null && <span className="text-slate-500"> · {gd.reviews} reviews</span>}
        </span>

        {gd.scope && gd.scope !== "company" && (
          <span className="px-2 py-0.5 rounded border text-xs text-violet-300 border-violet-400/30 bg-violet-400/10">
            rated by {gd.scope}
          </span>
        )}

        {gd.recommend != null && (
          <span className={`px-2 py-0.5 rounded border text-xs ${pct(gd.recommend)}`}>
            {gd.recommend}% recommend
          </span>
        )}

        {gd.interview ? (
          <span className={`px-2 py-0.5 rounded border text-xs ${pct(gd.interview.positive)}`}>
            interview {gd.interview.positive}% positive
            {gd.interview.difficulty != null && (
              <span className="text-slate-500"> · {gd.interview.difficulty}/5 hard</span>
            )}
            <span className="text-slate-500"> · {gd.interview.role}</span>
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded border text-xs text-slate-500 border-slate-700 bg-slate-800/40">
            no interview rating for this role
          </span>
        )}
      </div>

      {sub.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-slate-500">
          {sub.map(([label, value]) => (
            <span key={label}>
              {label} <span className={value >= 4.0 ? "text-emerald-400" : value >= 3.5 ? "text-amber-400" : "text-rose-400"}>{value.toFixed(1)}</span>
            </span>
          ))}
        </div>
      )}

      {gd.note && <p className="mt-2 text-xs leading-relaxed text-slate-400">{gd.note}</p>}
    </div>
  );
}

function NoteBlocks({ notes }: { notes: string }) {
  const segments = notes.split("||").map(s => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {segments.map((seg, i) => {
        // Split on the COLON only. A non-greedy match that also accepted "-"
        // chopped "TAKE-HOME RISK: ..." into label "TAKE" + body "HOME: ...",
        // which silently stripped the danger colour off the risk callouts.
        const m = seg.match(/^([A-Z][A-Z0-9 \-/&']{2,60}):\s*(.*)$/s);
        const label = m ? m[1].trim() : null;
        const body = m ? m[2].trim() : seg;
        // Ownership has to be obvious. A card in VP's queue showing Claude's
        // own chores as "TO DO" read like a task list for him.
        const danger = /RISK|EXCLUD|DILIGENCE|READ THIS|FLAG/i.test(label ?? seg);
        const needsYou = /NEEDS YOU|DECIDE|YOUR CALL/i.test(label ?? "");
        const onMe = /ON ME|NOT YET|UNRESOLVED|UNKNOWN/i.test(label ?? "");
        const tone = danger
          ? "border-l-rose-400/60 bg-rose-500/[0.06]"
          : needsYou
          ? "border-l-blue-400/60 bg-blue-500/[0.07]"
          : onMe
          ? "border-l-slate-700 bg-slate-900/30 opacity-70"
          : "border-l-slate-700 bg-slate-900/40";
        const labelTone = danger
          ? "text-rose-300"
          : needsYou
          ? "text-blue-300"
          : "text-slate-500";
        return (
          <div key={i} className={`rounded-r border-l-2 py-2 pl-3 pr-3 ${tone}`}>
            {label && (
              <div className={`mb-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider ${labelTone}`}>
                {label}
                {onMe && (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] normal-case text-slate-500">
                    Claude&apos;s job, not yours
                  </span>
                )}
                {needsYou && (
                  <span className="rounded bg-blue-400/20 px-1.5 py-0.5 text-[9px] normal-case text-blue-100">
                    needs your input
                  </span>
                )}
              </div>
            )}
            <p className="text-[13px] leading-relaxed text-slate-300">{body}</p>
          </div>
        );
      })}
    </div>
  );
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string; decided?: string }>;
}) {
  const { track: trackParam, decided: decidedParam } = await searchParams;
  const queue = await loadQueue();

  if (!queue || !queue.items?.length) {
    return (
      <main className="mx-auto min-h-screen max-w-5xl px-6 py-10">
        <SiteNav active="review" />
        <h1 className="mt-3 text-2xl font-semibold">Review queue</h1>
        <p className="mt-4 text-sm text-slate-400">
          Nothing waiting. Batches land in <code className="text-slate-300">data/review-queue.json</code>.
        </p>
      </main>
    );
  }

  const items = await Promise.all(queue.items.map(hydrate));
  const grouped: Record<string, Loaded[]> = {};
  for (const it of items) (grouped[it.track || "pm"] ||= []).push(it);

  // A decided role is finished business. Leaving approved and rejected cards in
  // the list means the queue only ever grows, and the two roles dropped today
  // for having the wrong location would sit among the live ones forever.
  //
  // They are hidden, not deleted: the reasoning on a rejection is the most
  // useful thing about it later, and keeping the record is also what stops the
  // same role being re-added by a future scan.
  const showDecided = decidedParam === "1";
  const visible = (t: string) => (grouped[t] ?? []).filter(i => showDecided || !i.decision);

  const present = TRACK_ORDER.filter(t => visible(t).length);
  const active = present.includes(trackParam ?? "") ? (trackParam as string) : present[0] ?? "pm";
  const shown = visible(active);
  const decidedCount = items.filter(i => i.decision).length;
  const pendingIn = (t: string) => (grouped[t] ?? []).filter(i => !i.decision).length;
  const totalPending = items.filter(i => !i.decision).length;

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-8 md:px-10">
      <header className="mb-6">
        <SiteNav active="review" />
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Review queue</h1>
          </div>
          <p className="font-mono text-xs text-slate-500">
            <span className="text-blue-200">{totalPending}</span> awaiting you · {queue.batch}
          </p>
        </div>
        <p className="mt-1 text-xs text-slate-600">
          Nothing is submitted from here. Approving records a decision only.
        </p>
      </header>

      <nav className="flex flex-wrap items-center gap-1 border-b border-slate-800">
        {present.map(t => {
          const isActive = t === active;
          const pending = pendingIn(t);
          return (
            <Link
              key={t}
              href={`/review?track=${t}${showDecided ? "&decided=1" : ""}`}
              className={
                "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition " +
                (isActive
                  ? "border-blue-400 text-slate-100"
                  : "border-transparent text-slate-500 hover:text-slate-300")
              }
            >
              {TRACK_LABEL[t] ?? t}
              <span
                className={
                  "rounded px-1.5 py-0.5 text-[10px] tabular-nums " +
                  (pending > 0 ? "bg-blue-400/20 text-blue-100" : "bg-slate-800 text-slate-500")
                }
              >
                {/* pending, not the all-time total. This rendered grouped[t].length
                    - which includes 91 rejected roles - so the PM tab advertised
                    61 while the page header correctly said "9 awaiting you". */}
                {pending}
              </span>
            </Link>
          );
        })}
      </nav>

      {queue.tracks?.[active] && (
        <p className="mb-6 mt-3 text-sm text-slate-500">{queue.tracks[active]}</p>
      )}

      {decidedCount > 0 && (
        <p className="mb-5 text-xs text-slate-500">
          {showDecided ? (
            <>
              Showing {decidedCount} decided role{decidedCount === 1 ? "" : "s"} alongside the live queue.{" "}
              <Link href={`/review?track=${active}`} className="text-blue-300 hover:text-blue-200">
                hide them
              </Link>
            </>
          ) : (
            <>
              {decidedCount} decided role{decidedCount === 1 ? "" : "s"} hidden (applied, rejected, on hold).{" "}
              <Link href={`/review?track=${active}&decided=1`} className="text-blue-300 hover:text-blue-200">
                show
              </Link>
            </>
          )}
        </p>
      )}

      <div className="space-y-5">
        {shown.map(item => {
          const cover = COVER_BADGE[item.coverLetter] ?? COVER_BADGE.unknown;
          const dec = item.decision ? DECISION_BADGE[item.decision] : null;
          return (
            <article
              key={item.slug}
              className={
                "rounded-lg border bg-slate-900/40 p-5 transition " +
                (item.decision === "approved"
                  ? "border-emerald-400/40"
                  : item.decision === "rejected"
                  ? "border-rose-400/30 opacity-50"
                  : item.decision === "hold"
                  ? "border-amber-400/30"
                  : "border-slate-800")
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-slate-100">{item.company}</h2>
                  <p className="text-sm text-slate-400">{item.role}</p>
                </div>
                <div className="flex items-center gap-2">
                  {dec && <Badge label={dec.label} color={dec.color} />}
                  <ReviewControls slug={item.slug} decision={item.decision} />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {item.score > 0 && (
                  <Badge label={`fit ${item.score}`} color="text-blue-200 border-blue-400/40 bg-blue-500/15" />
                )}
                {item.ageDays > 0 && <Badge label={`${item.ageDays}d`} color={ageColor(item.ageDays)} />}
                <Badge label={item.geo} color="text-sky-300 border-sky-400/30 bg-sky-400/10" />
                <Badge label={cover.label} color={cover.color} />
                {item.cvVariant && item.cvVariant !== "none yet" && (
                  <Badge label={`cv: ${item.cvVariant}`} color="text-slate-400 border-slate-700 bg-slate-800/40" />
                )}
                {item.cvVariant === "none yet" && (
                  <Badge label="no CV yet" color="text-amber-300 border-amber-400/30 bg-amber-400/10" />
                )}
                <Badge
                  label={item.ats === "unresolved" ? "apply path UNRESOLVED" : item.ats}
                  color={
                    item.ats === "unresolved"
                      ? "text-rose-300 border-rose-400/30 bg-rose-400/10"
                      : "text-slate-500 border-slate-700 bg-slate-800/40"
                  }
                />
              </div>

              {item.glassdoor && <GlassdoorPanel gd={item.glassdoor} />}

              {item.notes && <NoteBlocks notes={item.notes} />}

              <div className="mt-4 flex flex-wrap gap-2">
                {item.hasCv ? (
                  <a
                    href={`/api/files/${item.slug}/cv.pdf`}
                    target="_blank"
                    rel="noopener"
                    className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs transition hover:border-blue-400/60"
                  >
                    cv.pdf
                  </a>
                ) : (
                  <span
                    title="No cv.pdf on disk for this card"
                    className="cursor-not-allowed rounded-md border border-red-500/40 bg-slate-950 px-3 py-1.5 text-xs text-red-300/80"
                  >
                    ⚠ no cv.pdf
                  </span>
                )}
                <Link
                  href={`/pack/${item.slug}`}
                  className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs transition hover:border-blue-400/60"
                >
                  full pack
                </Link>
                <a
                  href={item.applyUrl || item.sourceUrl}
                  target="_blank"
                  rel="noopener"
                  className="rounded-md border border-blue-400/60 bg-blue-500/15 px-3 py-1.5 text-xs font-medium text-blue-200 transition hover:bg-blue-500/25"
                >
                  {item.applyUrl ? "Open application ↗" : "Source listing ↗"}
                </a>
                {item.decidedAt && (
                  <span className="self-center font-mono text-[11px] text-slate-600">
                    decided {item.decidedAt.slice(0, 16).replace("T", " ")}
                  </span>
                )}
              </div>

              {(item.answers || item.coverBody) && (
                <div className="mt-4 space-y-2 border-t border-slate-800 pt-3">
                  {item.answers && (
                    <details>
                      <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-slate-500 hover:text-blue-300">
                        Application answers
                      </summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-950 px-4 py-3 font-mono text-xs leading-relaxed text-slate-300">
                        {item.answers}
                      </pre>
                    </details>
                  )}
                  {item.coverBody && (
                    <details>
                      <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-slate-500 hover:text-blue-300">
                        Cover letter on file{" "}
                        <span className="normal-case text-slate-600">
                          ({item.coverLetter === "required" ? "will be attached" : "not being attached"})
                        </span>
                      </summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-950 px-4 py-3 font-mono text-xs leading-relaxed text-slate-400">
                        {item.coverBody}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}
