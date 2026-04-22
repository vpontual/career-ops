import { readFile } from "fs/promises";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadPipeline, PipelineRow } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

function decodeUrl(encoded: string): string | null {
  try {
    // Accept both base64url and percent-encoded for convenience
    if (encoded.startsWith("http")) return decodeURIComponent(encoded);
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

interface RoleData {
  row: PipelineRow;
  reportMd: string | null;
  jdPreview: string | null;
}

async function loadRole(url: string): Promise<RoleData | null> {
  const data = await loadPipeline();
  const row = data.rows.find(r => r.url === url);
  if (!row) return null;

  let reportMd: string | null = null;
  if (row.reportPath) {
    try { reportMd = await readFile(row.reportPath, "utf-8"); } catch {}
  }

  // Try to find the JD file for a preview snippet
  let jdPreview: string | null = null;
  try {
    const idMatch = url.match(/jobs\/(\d+)|jobs\/([0-9a-f-]+)|postings\/[^/]+\/([0-9a-f-]+)/);
    const id = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3]) : null;
    if (id) {
      const fs = await import("fs/promises");
      const path = await import("path");
      const jdsDir = path.join(process.env.CAREER_OPS_ROOT ?? "/data", "jds");
      const files = await fs.readdir(jdsDir);
      const match = files.find(f => f.includes(id));
      if (match) {
        const full = await fs.readFile(path.join(jdsDir, match), "utf-8");
        // First ~2000 chars is plenty to glance at without overwhelming the page
        jdPreview = full.slice(0, 4000);
      }
    }
  } catch {}

  return { row, reportMd, jdPreview };
}

// Lightweight markdown → HTML for reports. Reports are well-structured (headings,
// bold labels, bullet lists) so we don't need a full parser.
function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (/^#\s+/.test(line)) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h2 class="text-xl font-semibold mt-6 mb-2 text-slate-100">${line.replace(/^#\s+/, "")}</h2>`); continue; }
    if (/^##\s+/.test(line)) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h3 class="text-base font-semibold mt-5 mb-2 text-slate-200">${line.replace(/^##\s+/, "")}</h3>`); continue; }
    if (/^###\s+/.test(line)) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h4 class="text-sm font-semibold mt-4 mb-1 text-slate-300 uppercase tracking-wide">${line.replace(/^###\s+/, "")}</h4>`); continue; }
    if (/^\s*-\s+/.test(line)) {
      if (!inList) { out.push(`<ul class="list-disc list-inside space-y-1 text-slate-300 my-2">`); inList = true; }
      const item = line.replace(/^\s*-\s+/, "").replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100">$1</strong>');
      out.push(`<li>${item}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (line.trim() === "") { out.push(""); continue; }
    const para = line.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100">$1</strong>');
    out.push(`<p class="text-slate-300 my-2 leading-relaxed">${para}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

export default async function RolePage({ params }: { params: Promise<{ encoded: string }> }) {
  const { encoded } = await params;
  const url = decodeUrl(encoded);
  if (!url) return notFound();
  const data = await loadRole(url);
  if (!data) return notFound();

  const { row, reportMd, jdPreview } = data;

  return (
    <main className="min-h-screen px-6 py-8 md:px-12 md:py-10 max-w-4xl mx-auto">
      <header className="mb-6 border-b border-slate-800 pb-6">
        <Link href="/" className="text-xs text-slate-500 hover:text-blue-300 font-mono">
          ← back to dashboard
        </Link>
        <div className="mt-2 text-xs font-mono uppercase tracking-wider text-slate-500">{row.company}</div>
        <h1 className="text-2xl font-semibold mt-1 text-slate-100">{row.role}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          {row.locations.length > 0 && (
            <span className="text-slate-500 font-mono">{row.locations.join(" · ")}</span>
          )}
          {typeof row.score === "number" && (
            <span className={
              "font-mono px-2 py-0.5 rounded " +
              (row.score >= 4.0 ? "bg-green-500/15 text-green-300"
                : row.score >= 3.5 ? "bg-amber-500/15 text-amber-300"
                : "bg-red-500/15 text-red-300")
            }>
              {row.score.toFixed(1)} / 5
            </span>
          )}
          {row.postedDaysAgo != null && (
            <span className="font-mono text-slate-500">{row.postedDaysAgo}d old</span>
          )}
          {row.legitimacyTier && (
            <span className="font-mono text-slate-500">tier: {row.legitimacyTier}</span>
          )}
          <span className="font-mono text-slate-600">status: {row.status}</span>
        </div>
        <a
          href={row.url}
          target="_blank"
          rel="noopener"
          className="mt-3 inline-block text-blue-300 hover:text-blue-200 underline-offset-4 hover:underline text-sm font-mono break-all"
        >
          {row.url} ↗
        </a>
        {row.stagedSlug && (
          <Link
            href={`/pack/${row.stagedSlug}`}
            className="ml-4 inline-block text-purple-300 hover:text-purple-200 text-sm font-mono"
          >
            📦 application pack →
          </Link>
        )}
      </header>

      {reportMd ? (
        <section className="mb-8">
          <h2 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-3">Scoring report</h2>
          <article
            className="prose prose-invert max-w-none rounded-md border border-slate-800 bg-slate-900/40 px-5 py-4"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(reportMd) }}
          />
        </section>
      ) : (
        <section className="mb-8 rounded-md border border-slate-800 bg-slate-900/40 px-5 py-4">
          <h2 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-2">No scoring report yet</h2>
          <p className="text-sm text-slate-400">
            This role hasn&apos;t been scored. To score it, run on the VM:
          </p>
          <pre className="mt-2 px-4 py-3 bg-slate-950 border border-slate-800 rounded-md text-xs font-mono text-blue-300 overflow-x-auto">
            cd ~/career-ops && docker compose run --rm scanner node gemini-eval.mjs --url {row.url}
          </pre>
        </section>
      )}

      {jdPreview && (
        <section className="mb-8">
          <h2 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-3">JD preview</h2>
          <pre className="rounded-md border border-slate-800 bg-slate-950 px-5 py-4 text-xs leading-relaxed text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono max-h-[40rem] overflow-y-auto">
            {jdPreview}
          </pre>
        </section>
      )}
    </main>
  );
}
