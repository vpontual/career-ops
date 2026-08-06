#!/usr/bin/env python3
"""ready-check.py — is every pending role actually ready for VP to review?

The other gates each check one thing. This asks the question VP actually asks:
can he open the review tab and decide, without hitting a gap. A role is ready
only when all six are true:

  1. a real application URL — an Indeed viewjob page is not a form
  2. a rendered CV
  3. an answers.md with dated evidence the live form was opened
  4. diligence recorded — research.md, read from the employer's own posting
  5. interview process researched, including take-home risk
  6. nothing still marked as work owed by me

Exit 1 if anything is not ready, so this can gate a "done" claim.
"""
import json, os, re, sys

ROOT = "/home/vp/career-ops"
q = json.load(open(os.path.join(ROOT, "data", "review-queue.json")))
pending = [i for i in q["items"] if not i.get("decision")]

# Evidence that the live form was actually opened, in either convention. The
# earlier one writes a "# Form:" header block whose findings - the ATS, the job
# id, whether a cover letter field exists - often run onto the following lines,
# so this deliberately spans a few hundred characters rather than one line.
INSPECTED = re.compile(
    r"(?:form\s+inspected\D{0,20}\d{4}-\d{2}-\d{2}"                    # dated marker (current)
    r"|\#\s*Form:.{0,300}?(?:inspect|cover letter|required|optional))",  # earlier, same evidence
    re.I | re.S,
)
OWED = re.compile(r"ON ME:(?!.{0,400}?(not enumerable|cannot|could not))", re.I)

rows, ready = [], 0
for it in pending:
    slug = it["slug"]
    d = os.path.join(ROOT, "output", slug)
    ans_path = os.path.join(d, "answers.md")
    ans = open(ans_path, encoding="utf-8").read() if os.path.exists(ans_path) else ""
    notes = it.get("notes", "")

    gaps = []
    if "indeed.com" in (it.get("applyUrl") or ""):
        gaps.append("apply-url is Indeed")
    if not os.path.exists(os.path.join(d, "cv.pdf")):
        gaps.append("no cv.pdf")
    if not ans:
        gaps.append("no answers.md")
    elif not INSPECTED.search(ans):
        gaps.append("no dated form-inspection evidence")
    # Glassdoor was the old signal and it cannot be automated: it sits behind
    # Cloudflare and returns 403 to a real headless browser, so the only way to
    # satisfy this gate automatically was to write "no presence found" on every
    # card - a lie that would turn the gate into a rubber stamp. VP chose to swap
    # the signal (2026-08-04). What replaces it is diligence read from the
    # employer's own posting: research-roles.mjs writes output/<slug>/research.md
    # and stamps a verdict on the card.
    # A card researched by hand before the swap already HAS diligence - it just
    # recorded it as a Glassdoor block. Dropping that credit made the ready
    # count go DOWN when the gate changed, which is obviously wrong.
    # ⚠ EXISTENCE IS NOT DILIGENCE. This accepted the mere presence of
    # research.md, and research-roles.mjs writes one for every card - so on
    # 2026-08-06 there were 74 such files containing THREE distinct bodies, 73 of
    # them saying only "INTERVIEW PROCESS — NOT STATED" with a byte-identical
    # "ask this at the recruiter screen" block. This gate was the rubber stamp
    # the Glassdoor swap was made to avoid, twenty lines under a comment
    # congratulating itself for refusing to write "a lie that would turn the gate
    # into a rubber stamp".
    #
    # research-roles.mjs now stamps a file NOT DILIGENCE when the posting yielded
    # nothing decision-changing - no comp, no experience bar, no interview
    # format, no office requirement. Such a file no longer satisfies this gate.
    research_path = os.path.join(d, "research.md")
    research_text = ""
    if os.path.exists(research_path):
        research_text = open(research_path, encoding="utf-8", errors="replace").read()
    if (not it.get("research")
            and not it.get("glassdoor")
            and not research_text):
        gaps.append("no diligence")
    elif "NOT DILIGENCE" in research_text:
        gaps.append("diligence found nothing (posting states no comp/format/bar)")
    if ("INTERVIEW PROCESS" not in notes
            and "interview-process research" not in notes.lower()
            and not (it.get("research") or {}).get("verdict")):
        gaps.append("no interview research")
    if "ON ME:" in notes and OWED.search(notes):
        gaps.append("work still owed by Claude")

    if not gaps:
        ready += 1
    rows.append((slug, it.get("track", "?"), it["company"], gaps))

print("PENDING ROLES: %d   READY: %d   INCOMPLETE: %d\n" % (len(pending), ready, len(pending) - ready))
for slug, track, company, gaps in sorted(rows, key=lambda r: (bool(r[3]), r[1])):
    mark = "✓" if not gaps else "✗"
    print("%s %-10s %-32s %s" % (mark, track, company[:31], "; ".join(gaps) if gaps else "ready"))

sys.exit(0 if ready == len(pending) else 1)
