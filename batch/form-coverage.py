#!/usr/bin/env python3
"""Verify every required field on every live application form has a drafted value.

VP's standing rule: inspect the form, never infer from a posting API, and prefill
every field. A card that claims "prepared" while the live form has unanswered
required questions is a false claim. This catches that.

Greenhouse exposes its field list with required flags, so coverage is checked
automatically. Ashby's posting API does NOT expose application questions - that is
exactly how four required essays on Propel were nearly missed - so Ashby and any
custom portal are reported as needing a manual inspect-form pass, tracked by a
marker line in answers.md.

Usage: python3 batch/form-coverage.py
Exit 1 if any role has an unanswered required field.
"""
import json, os, re, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUEUE = os.path.join(ROOT, "data", "review-queue.json")
SKIP = ("first name", "last name", "full name", "name", "email", "phone", "resume",
        "cover letter", "linkedin", "website", "pronouns", "preferred first name")
# Marker a human/Claude writes into answers.md once the live form has been read.
INSPECTED = re.compile(r"#\s*Form:.*(inspect|no cover letter|required)", re.I)


def gh_required(slug, jid):
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}?questions=true"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            d = json.load(r)
    except Exception as e:
        return None, f"fetch failed: {e}"
    out = []
    for q in d.get("questions") or []:
        lab = (q.get("label") or "").strip()
        if q.get("required") and not any(k in lab.lower() for k in SKIP):
            out.append(lab)
    return out, None


def covered(answers, label):
    """Loose match: enough distinctive words from the label appear in answers.md."""
    words = [w for w in re.findall(r"[a-z]{4,}", label.lower()) if w not in
             ("your", "you", "that", "this", "with", "have", "will", "from", "please",
              "following", "requirements", "sentences", "about", "which", "would")]
    if not words:
        return True
    hits = sum(1 for w in words[:8] if w in answers)
    return hits >= max(1, min(3, len(words[:8]) // 2))


def main():
    q = json.load(open(QUEUE))
    problems, manual = [], []
    for it in q["items"]:
        notes = it.get("notes", "")
        if "EXCLUDED" in notes or "SUBMITTED 2026" in notes:
            continue
        ans_path = os.path.join(ROOT, "output", it["slug"], "answers.md")
        answers = open(ans_path, encoding="utf-8").read().lower() if os.path.exists(ans_path) else ""
        if not answers:
            problems.append((it["company"], "NO answers.md AT ALL"))
            continue

        url = it.get("applyUrl") or it.get("sourceUrl") or ""
        m = re.search(r"greenhouse\.io/([^/]+)/jobs/(\d+)", url)
        if m:
            req, err = gh_required(m.group(1), m.group(2))
            if err:
                manual.append((it["company"], err))
                continue
            for lab in req:
                if not covered(answers, lab):
                    problems.append((it["company"], f"unanswered: {lab[:70]}"))
        else:
            # Ashby / Oracle / custom: cannot enumerate from an API. Require proof
            # that the live form was actually read.
            if not INSPECTED.search(open(ans_path, encoding="utf-8").read()):
                manual.append((it["company"], "non-Greenhouse form, no inspect-form evidence in answers.md"))

    if problems:
        print(f"UNANSWERED REQUIRED FIELDS ({len(problems)}):")
        for c, p in problems:
            print(f"  {c[:30]:<30} {p}")
    else:
        print("every required field on every Greenhouse form has a drafted value")
    if manual:
        print(f"\nNEEDS A MANUAL inspect-form PASS ({len(manual)}):")
        for c, p in manual:
            print(f"  {c[:30]:<30} {p}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
