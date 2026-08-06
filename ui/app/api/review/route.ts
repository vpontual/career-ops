import { readFile, writeFile, rename, open, unlink, stat } from "fs/promises";
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

  // EXCLUSIVE LOCK + ATOMIC WRITE.
  //
  // This was a lock-free read-modify-write of the WHOLE file, and
  // enqueue-review.mjs rewrites the same file at 04:17 nightly. Two rapid
  // clicks, or one click landing during the nightly, silently discarded the
  // losing side — and since each side writes the entire document that is not a
  // lost field but potentially a whole night's cards, or a decision VP believes
  // he made.
  //
  // ⚠ A COMPARE-AND-SWAP ON mtime IS NOT ENOUGH, and I measured that rather than
  // assuming it: with a stat-check before writing, ten concurrent decisions left
  // only TWO in the file. Both writers stat, both see it unchanged, both rename
  // — classic time-of-check/time-of-use. Only a real lock fixes it.
  //
  // open(path, "wx") fails if the file exists and is atomic on POSIX, so it is
  // the lock. A stale lock (crashed process) is broken after LOCK_STALE_MS.
  const LOCK_PATH = `${QUEUE_PATH}.lock`;
  const LOCK_STALE_MS = 30_000;
  const acquire = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const fh = await open(LOCK_PATH, "wx");
        await fh.writeFile(String(process.pid));
        await fh.close();
        return true;
      } catch {
        try {
          const st = await stat(LOCK_PATH);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await unlink(LOCK_PATH);
        } catch { /* vanished — try again */ }
        await new Promise(r => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
      }
    }
    return false;
  };

  if (!(await acquire())) {
    return NextResponse.json({ error: "review queue is busy; try again" }, { status: 409 });
  }

  try {
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

    // Temp file + rename. rename(2) is atomic within a filesystem, so no reader
    // — including the nightly chain — can observe a half-written queue, which a
    // direct write of a 1,600-line document can produce.
    const tmp = `${QUEUE_PATH}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(queue, null, 2) + "\n", "utf-8");
    await rename(tmp, QUEUE_PATH);

    revalidatePath("/review");
    return NextResponse.json({ ok: true, slug, decision: item.decision });
  } finally {
    await unlink(LOCK_PATH).catch(() => {});
  }
}
