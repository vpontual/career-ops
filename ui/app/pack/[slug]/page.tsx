import { readFile } from "fs/promises";
import path from "path";
import Link from "next/link";
import { notFound } from "next/navigation";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";

interface PackData {
  slug: string;
  url: string;
  company: string;
  role: string;
  coverLetterMd: string;
  defaults?: string;
  autofillReport?: string;
  hasAutofillScreenshot?: boolean;
}

async function loadPack(slug: string): Promise<PackData | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const dir = path.join(DATA_ROOT, "output", slug);
  let coverMd: string;
  try {
    coverMd = await readFile(path.join(dir, "cover-letter.md"), "utf-8");
  } catch {
    return null;
  }
  const url = (coverMd.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1] || "";
  const heading = (coverMd.match(/^# Cover letter\s*-\s*(.+?):\s*(.+)$/m) || []);
  const company = heading[1] || "";
  const role = heading[2] || "";

  let defaults: string | undefined;
  try {
    defaults = await readFile(path.join(DATA_ROOT, "application-defaults.md"), "utf-8");
  } catch {}

  let autofillReport: string | undefined;
  let hasAutofillScreenshot = false;
  try {
    autofillReport = await readFile(path.join(dir, "autofill-report.md"), "utf-8");
  } catch {}
  try {
    const fs = await import("fs/promises");
    await fs.stat(path.join(dir, "autofill-screenshot.png"));
    hasAutofillScreenshot = true;
  } catch {}

  // Strip the markdown header and metadata, keep just the body.
  const body = coverMd.split(/^---\s*$/m).slice(1).join("---").trim();

  return { slug, url, company, role, coverLetterMd: body, defaults, autofillReport, hasAutofillScreenshot };
}

export default async function PackPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const pack = await loadPack(slug);
  if (!pack) return notFound();

  return (
    <main className="min-h-screen px-6 py-8 md:px-12 md:py-10 max-w-5xl mx-auto">
      <header className="mb-8 border-b border-slate-800 pb-6">
        <Link href="/?tab=staged" className="text-xs text-slate-500 hover:text-blue-300 font-mono">
          ← back to dashboard
        </Link>
        <h1 className="text-2xl font-semibold mt-2">{pack.company}</h1>
        <h2 className="text-lg text-slate-300 mt-1">{pack.role}</h2>
        <a
          href={pack.url}
          target="_blank"
          rel="noopener"
          className="text-blue-300 hover:text-blue-200 underline-offset-4 hover:underline text-sm font-mono break-all mt-2 inline-block"
        >
          {pack.url} ↗
        </a>
      </header>

      <section className="mb-8">
        <h3 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-3">Materials</h3>
        <div className="flex flex-wrap gap-3">
          <a
            href={`/api/files/${pack.slug}/cv.pdf`}
            target="_blank"
            rel="noopener"
            className="px-4 py-2 bg-slate-900 border border-slate-700 rounded-md hover:border-blue-400/60 hover:bg-slate-900/60 transition text-sm"
          >
            📄 cv.pdf
          </a>
          <a
            href={`/api/files/${pack.slug}/cover-letter.pdf`}
            target="_blank"
            rel="noopener"
            className="px-4 py-2 bg-slate-900 border border-slate-700 rounded-md hover:border-blue-400/60 hover:bg-slate-900/60 transition text-sm"
          >
            📄 cover-letter.pdf
          </a>
          <a
            href={`/api/files/${pack.slug}/cover-letter.md`}
            target="_blank"
            rel="noopener"
            className="px-4 py-2 bg-slate-900 border border-slate-700 rounded-md hover:border-blue-400/60 hover:bg-slate-900/60 transition text-sm"
          >
            📝 cover-letter.md
          </a>
          <a
            href={pack.url}
            target="_blank"
            rel="noopener"
            className="px-4 py-2 bg-blue-500/15 border border-blue-400/60 text-blue-200 rounded-md hover:bg-blue-500/25 transition text-sm font-medium"
          >
            🌐 Open in ATS ↗
          </a>
        </div>
      </section>

      <section className="mb-8">
        <h3 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-3 flex items-center justify-between">
          <span>Cover letter (copy-paste ready)</span>
          <span className="text-slate-600 text-[10px] normal-case">~{pack.coverLetterMd.split(/\s+/).filter(Boolean).length} words</span>
        </h3>
        <textarea
          readOnly
          className="w-full h-72 px-4 py-3 bg-slate-950 border border-slate-800 rounded-md font-mono text-sm leading-relaxed text-slate-200 focus:outline-none focus:border-blue-400/60"
          value={pack.coverLetterMd}
        />
      </section>

      {pack.autofillReport ? (
        <section className="mb-8">
          <h3 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-3 flex items-center justify-between">
            <span>Autofill (Level B)</span>
            <span className="text-slate-600 text-[10px] normal-case">/greenhouse only</span>
          </h3>
          <pre className="px-4 py-3 bg-slate-950 border border-slate-800 rounded-md text-xs leading-relaxed text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono">
            {pack.autofillReport}
          </pre>
          {pack.hasAutofillScreenshot && (
            <div className="mt-4">
              <p className="text-xs text-slate-500 font-mono mb-2">Screenshot of the headless browser session, after autofill ran:</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${pack.slug}/autofill-screenshot.png`}
                alt="Autofill screenshot"
                className="w-full border border-slate-800 rounded-md"
              />
            </div>
          )}
        </section>
      ) : (
        <section className="mb-8">
          <h3 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-3">Autofill (Level B)</h3>
          <p className="text-sm text-slate-400">
            Not run yet for this role. To autofill the Greenhouse form, run on the VM:
          </p>
          <pre className="mt-2 px-4 py-3 bg-slate-950 border border-slate-800 rounded-md text-xs font-mono text-blue-300 overflow-x-auto">
            cd ~/career-ops && docker compose run --rm applier node prefill-greenhouse.mjs {pack.slug}
          </pre>
          <p className="text-xs text-slate-600 mt-2 font-mono">
            Result: standard fields filled (name/email/phone/resume), screenshot + report saved here.
            Open the URL in your own browser to finish + submit.
          </p>
        </section>
      )}

      {pack.defaults && (
        <section className="mb-8">
          <h3 className="text-xs uppercase tracking-wider text-slate-500 font-mono mb-3">
            Standard application answers (from application-defaults.md)
          </h3>
          <pre className="px-4 py-3 bg-slate-950 border border-slate-800 rounded-md text-xs leading-relaxed text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono">
            {pack.defaults}
          </pre>
        </section>
      )}

      <footer className="mt-12 pt-6 border-t border-slate-800 text-xs text-slate-600 font-mono">
        <p>Edit materials in <code className="text-slate-400">output/{pack.slug}/</code> on the VM.</p>
      </footer>
    </main>
  );
}
