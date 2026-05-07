import { readFile, readdir } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { loadPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";

// Mirrors ui/app/role/[encoded]/page.tsx::decodeUrl — accepts base64url or
// percent-encoded URL so MCP clients can pass either form.
function decodeId(id: string): string | null {
  try {
    if (id.startsWith("http")) return decodeURIComponent(id);
    const padded = id.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(id.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function readJdForUrl(url: string): Promise<string | null> {
  try {
    const idMatch = url.match(/jobs\/(\d+)|jobs\/([0-9a-f-]+)|postings\/[^/]+\/([0-9a-f-]+)/);
    const jobId = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3]) : null;
    if (!jobId) return null;
    const jdsDir = path.join(DATA_ROOT, "jds");
    const files = await readdir(jdsDir);
    const match = files.find(f => f.includes(jobId));
    if (!match) return null;
    return await readFile(path.join(jdsDir, match), "utf-8");
  } catch {
    return null;
  }
}

async function readCoverLetter(slug: string): Promise<string | null> {
  try {
    const p = path.join(DATA_ROOT, "output", slug, "cover-letter.md");
    return await readFile(p, "utf-8");
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = decodeId(id);
  if (!url) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const data = await loadPipeline();
  const row = data.rows.find(r => r.url === url);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const reportMd = row.reportPath ? await readFile(row.reportPath, "utf-8").catch(() => null) : null;
  const jdMd = await readJdForUrl(row.url);
  const coverLetterMd = row.stagedSlug ? await readCoverLetter(row.stagedSlug) : null;

  return NextResponse.json({ row, reportMd, jdMd, coverLetterMd });
}
