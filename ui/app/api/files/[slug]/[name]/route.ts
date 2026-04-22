import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";

// Strict whitelist: slug must be lowercase alnum-with-dashes, name must be a known file.
const SLUG_RE = /^[a-z0-9-]+$/;
const NAME_RE = /^(cv|cover-letter|autofill-screenshot|autofill-report)\.(md|pdf|png)$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; name: string }> }
) {
  const { slug, name } = await params;
  if (!SLUG_RE.test(slug) || !NAME_RE.test(name)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  const filePath = path.join(DATA_ROOT, "output", slug, name);
  // Defend against any path-traversal monkey business
  if (!filePath.startsWith(path.join(DATA_ROOT, "output") + path.sep)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  try {
    const data = await readFile(filePath);
    const contentType = name.endsWith(".pdf") ? "application/pdf"
      : name.endsWith(".png") ? "image/png"
      : "text/markdown; charset=utf-8";
    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${slug}-${name}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
