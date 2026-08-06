/**
 * lib/queue-file.mjs — the ONLY safe way to write data/review-queue.json.
 *
 * Four things write this file: the UI's decision endpoint (whenever VP clicks),
 * enqueue-review.mjs (04:17 nightly), research-roles.mjs and
 * repair-split-packs.mjs. Every one of them did a lock-free read-modify-write of
 * the WHOLE document, so a click landing during the nightly silently discarded
 * one side — and because each writer rewrites everything, the loss is not a
 * field but potentially a whole night's cards, or a decision VP believes he made.
 *
 * ⚠ A COMPARE-AND-SWAP ON mtime IS NOT SUFFICIENT, and that was measured rather
 * than assumed: with a stat-check immediately before writing, ten concurrent
 * decisions left TWO in the file. Both writers stat, both see it unchanged, both
 * write — time-of-check/time-of-use. With the lock below, ten of ten survive.
 *
 * open(path, 'wx') fails when the file exists and is atomic on POSIX, so it is
 * the lock. The write itself goes to a temp file and is renamed, because
 * rename(2) is atomic within a filesystem and no reader can then observe a
 * half-written 1,600-line document.
 *
 * The UI carries its own copy of this logic in TypeScript (ui/app/api/review/
 * route.ts) because Next cannot import a root .mjs from its build context. Same
 * lock path, same semantics — if you change one, change the other.
 */

import { readFile, writeFile, rename, open, unlink, stat } from 'fs/promises';

const LOCK_STALE_MS = 30_000;
const MAX_WAIT_MS = 5_000;

async function acquire(lockPath) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return true;
    } catch {
      try {
        const st = await stat(lockPath);
        // A crashed holder must not block the nightly forever.
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
      } catch { /* vanished between stat and unlink — fine, retry */ }
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
    }
  }
  return false;
}

/**
 * Read → mutate → write, under an exclusive lock.
 * @param {string} queuePath
 * @param {(queue: any) => any|Promise<any>} mutate  return the object to write,
 *        or undefined to write the (mutated) object it was given.
 */
export async function updateQueue(queuePath, mutate) {
  const lockPath = `${queuePath}.lock`;
  if (!(await acquire(lockPath))) {
    throw new Error(`review-queue.json is locked by another writer (waited ${MAX_WAIT_MS}ms)`);
  }
  try {
    const queue = JSON.parse(await readFile(queuePath, 'utf-8'));
    const next = (await mutate(queue)) ?? queue;
    const tmp = `${queuePath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    await rename(tmp, queuePath);
    return next;
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
