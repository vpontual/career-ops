import { readFile } from "fs/promises";
import SiteNav from "@/components/SiteNav";
import path from "path";
import Link from "next/link";

export const dynamic = "force-dynamic";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";
const QUEUE_PATH = path.join(DATA_ROOT, "data", "review-queue.json");
const PLAN_PATH = path.join(DATA_ROOT, "data", "get-hired-now.md");

interface QueueItem {
  slug: string;
  company: string;
  role: string;
  applyUrl: string;
  sourceUrl: string;
  score: number;
  ageDays: number;
  geo: string;
  notes: string;
  decision: string | null;
  track?: string;
}

async function loadRoles(): Promise<QueueItem[]> {
  try {
    const raw = JSON.parse(await readFile(QUEUE_PATH, "utf-8"));
    return (raw.items as QueueItem[])
      .filter(i => i.track === "now" && !i.decision)
      .sort((a, b) => b.score - a.score || (a.ageDays ?? 999) - (b.ageDays ?? 999));
  } catch {
    return [];
  }
}

// The plan is read live from data/get-hired-now.md, so editing that file needs no
// rebuild. There is no markdown dependency in this app and adding one for a
// single page is not worth it, so this handles the subset the file actually uses.
function inline(s: string, key: string) {
  const nodes: React.ReactNode[] = [];
  const rx = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = rx.exec(s))) {
    if (m.index > last) nodes.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) nodes.push(<strong key={`${key}-b${i}`} className="font-semibold text-slate-100">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) nodes.push(<code key={`${key}-c${i}`} className="break-all rounded bg-slate-800/80 px-1.5 py-0.5 text-[12px] text-indigo-200">{t.slice(1, -1)}</code>);
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      nodes.push(<a key={`${key}-a${i}`} href={mm[2]} target="_blank" rel="noreferrer" className="text-indigo-300 underline underline-offset-2 hover:text-indigo-200">{mm[1]}</a>);
    }
    last = m.index + t.length;
    i++;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes;
}

function renderPlan(md: string) {
  const out: React.ReactNode[] = [];
  const lines = md.split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? "")) {
      const head = line.split("|").slice(1, -1).map(c => c.trim());
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i].split("|").slice(1, -1).map(c => c.trim()));
        i++;
      }
      out.push(
        <div key={`t${k++}`} className="my-4 overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-slate-900/70">
              <tr>{head.map((h, x) => <th key={x} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y} className="border-t border-slate-800/70">
                  {r.map((c, x) => <td key={x} className="px-3 py-2 align-top text-slate-300">{inline(c, `t${k}-${y}-${x}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      const lvl = (line.match(/^#+/) as RegExpMatchArray)[0].length;
      const txt = line.replace(/^#+\s*/, "");
      const cls = lvl === 1 ? "mt-2 text-2xl font-semibold tracking-tight text-slate-100"
        : lvl === 2 ? "mt-8 border-b border-slate-800 pb-1.5 text-lg font-semibold text-slate-100"
          : "mt-5 text-[15px] font-semibold text-indigo-200";
      out.push(<h3 key={`h${k++}`} className={cls}>{inline(txt, `h${k}`)}</h3>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { i++; continue; }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        i++;
      }
      const L = ordered ? "ol" : "ul";
      out.push(
        <L key={`l${k++}`} className={"my-3 space-y-1.5 pl-5 text-sm text-slate-300 " + (ordered ? "list-decimal" : "list-disc")}>
          {items.map((it, x) => <li key={x}>{inline(it, `l${k}-${x}`)}</li>)}
        </L>
      );
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^[#|>-]/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(<p key={`p${k++}`} className="my-3 text-sm leading-relaxed text-slate-300">{inline(para.join(" "), `p${k}`)}</p>);
    else i++;
  }
  return out;
}

function scoreStyle(s: number) {
  if (s >= 5) return "bg-emerald-400/15 text-emerald-200 ring-emerald-400/40";
  if (s >= 4) return "bg-indigo-400/15 text-indigo-200 ring-indigo-400/40";
  return "bg-slate-700/40 text-slate-300 ring-slate-600/50";
}

export default async function GetHiredNow() {
  const [roles, plan] = await Promise.all([
    loadRoles(),
    readFile(PLAN_PATH, "utf-8").catch(() => ""),
  ]);

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-4 md:px-10">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 text-sm font-bold text-white shadow-lg shadow-emerald-500/20">$</span>
            <span className="flex flex-col leading-none">
              <span className="text-[15px] font-semibold tracking-tight text-slate-100">Get Hired Now</span>
              <span className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">income in weeks, few constraints</span>
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {/* The page-local "Pipeline | Review queue" links used to live here.
                Removed: this page renders the shared SiteNav below, so keeping
                them meant /now displayed TWO different navigation bars, one of
                them a two-item subset. */}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <SiteNav active="now" />
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Live roles on this track</h2>
            <span className="text-xs tabular-nums text-slate-500">{roles.length} pending</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            No geography gate, no comp floor, no archetype. Scored on what shortens time to a first payment.
          </p>

          {roles.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
              Nothing on this track yet. The nightly scan fills it.
            </div>
          ) : (
            <ul className="mt-4 space-y-2">
              {roles.map(r => (
                <li key={r.slug} className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold tabular-nums ring-1 ring-inset ${scoreStyle(r.score)}`}>
                    {r.score}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold text-slate-100">{r.company}</span>
                      <span className="text-sm text-slate-300">{r.role}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span className="rounded bg-slate-800 px-1.5 py-0.5">{r.geo || "unstated"}</span>
                      <span className="tabular-nums">{r.ageDays}d old</span>
                      {r.applyUrl && (
                        <a href={r.applyUrl} target="_blank" rel="noreferrer" className="text-indigo-300 underline underline-offset-2 hover:text-indigo-200">
                          open the application
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-10">
          {plan
            ? <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-5 py-4 md:px-7 md:py-6">{renderPlan(plan)}</div>
            : <p className="text-sm text-slate-500">data/get-hired-now.md not found.</p>}
        </section>
      </main>
    </div>
  );
}
