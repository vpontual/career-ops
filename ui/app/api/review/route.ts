import { readFile, writeFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";
const QUEUE_PATH = path.join(DATA_ROOT, "data", "review-queue.json");

const ALLOWED = new Set(["approved", "rejected", "hold", "clear"]);

export async function POST(req: Request) {
  let body: { slug?: string; decision?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { slug, decision } = body;
  if (!slug || !decision || !ALLOWED.has(decision)) {
    return NextResponse.json({ error: "slug and valid decision required" }, { status: 400 });
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }

  let queue: { items?: { slug: string; decision: string | null; decidedAt: string | null }[] };
  try {
    queue = JSON.parse(await readFile(QUEUE_PATH, "utf-8"));
  } catch {
    return NextResponse.json({ error: "no review queue" }, { status: 404 });
  }

  const item = (queue.items ?? []).find(i => i.slug === slug);
  if (!item) return NextResponse.json({ error: "slug not in queue" }, { status: 404 });

  if (decision === "clear") {
    item.decision = null;
    item.decidedAt = null;
  } else {
    item.decision = decision;
    item.decidedAt = new Date().toISOString();
  }

  await writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n", "utf-8");
  revalidatePath("/review");
  return NextResponse.json({ ok: true, slug, decision: item.decision });
}
