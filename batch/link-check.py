#!/usr/bin/env python3
"""link-check.py — every file link on a pending review card must actually resolve.

VP's rule, stated 2026-08-06 after hitting it twice: a role that reaches the
Review Queue MUST have a completed CV. A card he cannot act on is worse than a
card that never appeared - it costs a click, breaks trust in every other card,
and hides the roles that are genuinely ready.

WHY THIS ASKS THE RUNNING APP RATHER THAN THE DISK. ready-check.py already checks
that output/<slug>/cv.pdf exists, and it is correct, and it was not enough: on
2026-08-06 the CVs all existed and 34 of 36 links still 404'd, because the card
carried a `-2` slug pointing at a different directory. Existence on disk and
reachability through the UI are two different claims. This makes the second one.

Exits 1 if any pending card's CV does not return 200, so it can gate a nightly
run or a "fixed" claim.

Usage: python3 batch/link-check.py [--base http://localhost:3340] [--all]
"""
import argparse, json, os, sys, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument("--base", default=os.environ.get("CAREER_OPS_UI", "http://localhost:3340"))
ap.add_argument("--all", action="store_true", help="check decided cards too, not just pending")
ap.add_argument("--timeout", type=float, default=10.0)
args = ap.parse_args()

queue = json.load(open(os.path.join(ROOT, "data", "review-queue.json")))
items = queue["items"] if args.all else [i for i in queue["items"] if not i.get("decision")]


def status(url):
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "career-ops-link-check"})
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as r:
            return r.status, int(r.headers.get("Content-Length") or 0)
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception as e:                      # connection refused, DNS, timeout
        return f"ERR {type(e).__name__}", 0


# What the UI actually links. review/page.tsx renders cv.pdf; pack/[slug]/page.tsx
# renders cv.pdf + cover-letter.pdf + cover-letter.md unconditionally.
#
# A cover letter is legitimately absent when the ATS does not ask for one - the
# pack then holds cover-letter-skipped.md and that is CORRECT behaviour, not a
# defect. So a missing cover letter is only an error when nothing on disk says it
# was skipped on purpose. The CV has no such exemption: it is always required.
REQUIRED = ["cv.pdf"]
CONDITIONAL = ["cover-letter.pdf", "cover-letter.md"]

rows, hard_fail, soft_fail = [], 0, 0
for it in items:
    slug = it["slug"]
    pack = os.path.join(ROOT, "output", slug)
    skipped = os.path.exists(os.path.join(pack, "cover-letter-skipped.md"))

    for name in REQUIRED + CONDITIONAL:
        code, size = status(f"{args.base}/api/files/{slug}/{name}")
        ok = code == 200
        if name in REQUIRED and not ok:
            verdict, hard_fail = "FAIL", hard_fail + 1
        elif ok:
            verdict = "ok"
        elif skipped:
            verdict = "skipped-by-design"
        else:
            verdict, soft_fail = "missing", soft_fail + 1
        rows.append((verdict, slug, name, code, size))

print(f"link-check: {len(items)} {'total' if args.all else 'pending'} card(s) against {args.base}\n")
w = max([len(r[1]) for r in rows] + [4])
for verdict, slug, name, code, size in sorted(rows, key=lambda r: (r[0] != "FAIL", r[1])):
    mark = {"ok": "✓", "FAIL": "✗", "skipped-by-design": "-", "missing": "?"}[verdict]
    print(f"{mark} {slug:<{w}}  {name:<17} {str(code):>6}  {verdict}")

print(f"\nCV links: {len(items) - hard_fail}/{len(items)} resolve.", end=" ")
print(f"{soft_fail} cover letter(s) missing with no skip marker.")

if hard_fail:
    print(f"\n🔴 {hard_fail} pending card(s) have no reachable CV. "
          f"Per VP's standing rule these must not be in the queue.\n")
    sys.exit(1)
print("\n🟢 Every pending card has a reachable CV.\n")
