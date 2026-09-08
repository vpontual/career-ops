import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

/**
 * The application pack for the page the extension is standing on.
 *
 * WHY THIS EXISTS. The pipeline enumerates a form and answers it — 61 of the
 * 194 pending cards VP has to fill by hand on 2026-09-08 have a FULLY READ
 * field list with answers already written against it — and none of that was
 * reachable from the page where he actually fills the form. He had the answers
 * in one tab and the form in another.
 *
 * ⚠ WHAT IT DELIBERATELY DOES NOT DO. It never returns a value for a field the
 * answer classifier marked never-draft (address, comp, dates, EEO, work
 * authorisation, prior employment, attestations). Those are blank BY DESIGN in
 * the pack and stay blank here: a drafted answer to "Have you ever been
 * employed by Stripe?" would be invented. They are returned as prompts so the
 * extension can show VP that they are his to answer, never as text to paste.
 *
 * Read-only, same gating as the rest of the UI.
 */

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";

interface QueueItem {
  slug: string; company: string; role: string;
  sourceUrl: string; applyUrl: string; track?: string;
}

/**
 * Host + path, lowercased, without `www.` or any query string.
 *
 * ⚠ NOT lib/url-canonical.mjs, and deliberately not a port of it. That module
 * defines the pipeline's IDENTITY for a posting — what pipeline.md, dedup and
 * prune-stale key on — and a second copy of it here would be one more pair of
 * definitions to drift apart. This is a local, weaker thing: enough to point at
 * a card from the page VP has open, used nowhere else, and wrong only in the
 * direction of finding no pack rather than the wrong one.
 */
function looseKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "").toLowerCase()}${x.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return "";
  }
}

/** Find the card for a page URL. */
function findCard(items: QueueItem[], url: string): QueueItem | null {
  const want = looseKey(url);
  if (!want) return null;
  for (const i of items) {
    if (looseKey(i.applyUrl) === want || looseKey(i.sourceUrl) === want) return i;
  }
  // Greenhouse and Ashby both carry the requisition id in the URL, and it
  // survives every rewrite of the surrounding path. Fall back to it.
  const id = url.match(/gh_jid=(\d+)|\/jobs\/(\d{6,})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const key = id ? (id[1] || id[2] || id[3]) : null;
  if (!key) return null;
  return items.find(i => (i.applyUrl || "").includes(key) || (i.sourceUrl || "").includes(key)) ?? null;
}

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url") ?? "";
  if (!url) return NextResponse.json({ ok: false, error: "no url" }, { status: 400 });

  let items: QueueItem[] = [];
  try {
    const q = JSON.parse(await readFile(path.join(DATA_ROOT, "data", "review-queue.json"), "utf-8"));
    items = q.items ?? [];
  } catch {
    return NextResponse.json({ ok: false, error: "no review queue" }, { status: 500 });
  }

  const card = findCard(items, url);
  if (!card) return NextResponse.json({ ok: false, error: "no pack for this page" }, { status: 404 });

  const dir = path.join(DATA_ROOT, "output", card.slug);
  let answers = "";
  let enumerated: boolean | null = null;
  try { answers = await readFile(path.join(dir, "answers.md"), "utf-8"); } catch { /* no pack yet */ }
  try {
    const meta = JSON.parse(await readFile(path.join(dir, "answers-meta.json"), "utf-8"));
    if (typeof meta.enumerated === "boolean") enumerated = meta.enumerated;
  } catch { /* pre-2026-09-08 pack */ }

  return NextResponse.json({
    ok: true,
    slug: card.slug,
    company: card.company,
    role: card.role,
    track: card.track ?? null,
    // ⚠ null means "we do not know", not "yes". A pack written before the flag
    // existed has answers; the extension says so rather than asserting either.
    enumerated,
    answers,
  });
}
