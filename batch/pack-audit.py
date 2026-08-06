#!/usr/bin/env python3
"""pack-audit.py — does the pack on disk actually belong to the card pointing at it?

Context. enqueue-review.mjs seeds its anti-collision slug set from every directory
in output/, so a pack that stage-applications.mjs created earlier in the SAME
nightly run reads as a name collision and the card is minted as <slug>-2. The CV
sits in <slug>; the card points at <slug>-2, which holds only answers.md and
research.md. 8 of 9 pending cards are in that state.

The obvious repair is to repoint the card at the un-suffixed pack. This script
exists because that is an ASSUMPTION until the contents are compared: staging and
enqueue can select DIFFERENT SOURCE DOCUMENTS for the same role - typically the
Indeed scrape versus the employer's own ATS posting - and the cover letter is
generated from whichever one staging used. Same role is not the same document.

Checks per card, all read-only:
  variant   cv-variant.txt vs the card's cvVariant
  source    the cover letter's **URL:** vs the card's applyUrl / sourceUrl
  address   how the letter addresses the employer (Indeed titles are SHOUTED)
  orphan    whether the base slug has a card of its own (it must not)
  cv        whether cv.pdf is per-role or merely per-variant, by digest

Usage: python3 batch/pack-audit.py [--json]
"""
import hashlib, json, os, re, sys
from collections import defaultdict
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "output")
AS_JSON = "--json" in sys.argv

queue = json.load(open(os.path.join(ROOT, "data", "review-queue.json")))
pending = [i for i in queue["items"] if not i.get("decision")]
all_slugs = {i["slug"] for i in queue["items"]}

SUFFIX = re.compile(r"-(\d+)$")


def host_path(u):
    """Compare URLs by host+path only - query strings carry the req id on some ATSs
    and tracking junk on others, and this is a provenance check, not an identity."""
    if not u:
        return ""
    s = urlsplit(str(u))
    return f"{s.netloc.lower()}{s.path.rstrip('/')}"


def digest(p):
    try:
        return hashlib.sha1(open(p, "rb").read()).hexdigest()[:12]
    except OSError:
        return None


def read(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


# cv.pdf digests across every pack, to answer: per-role or per-variant?
by_digest, by_variant = defaultdict(list), defaultdict(set)
for d in sorted(os.listdir(OUT)):
    pdf = os.path.join(OUT, d, "cv.pdf")
    if os.path.exists(pdf):
        h = digest(pdf)
        by_digest[h].append(d)
        by_variant[read(os.path.join(OUT, d, "cv-variant.txt")).strip() or "?"].add(h)

results = []
for it in pending:
    slug = it["slug"]
    m = SUFFIX.search(slug)
    base = slug[: m.start()] if m else None
    card_dir = os.path.join(OUT, slug)
    base_dir = os.path.join(OUT, base) if base else None

    r = {
        "slug": slug, "company": it.get("company"), "role": it.get("role"),
        "base": base, "issues": [], "verdict": None,
    }

    if not base or not os.path.isdir(base_dir):
        r["verdict"] = "OK — card has its own pack" if os.path.exists(os.path.join(card_dir, "cv.pdf")) \
            else "NO PACK — nothing to recover"
        results.append(r)
        continue

    if base in all_slugs:
        r["issues"].append(f"base slug {base} is ALSO a card — not an orphan, do not merge")

    # variant
    card_variant = (it.get("cvVariant") or "").strip()
    pack_variant = read(os.path.join(base_dir, "cv-variant.txt")).strip()
    r["card_variant"], r["pack_variant"] = card_variant, pack_variant
    if pack_variant and card_variant and pack_variant != card_variant:
        r["issues"].append(f"variant mismatch: pack={pack_variant} card={card_variant}")

    # Provenance. Both cover-letter.md and cover-letter-skipped.md record the URL
    # staging worked from. Reading only the former left the correctly-skipped packs
    # with no recorded URL, which this script then reported as "safe" - an absence
    # of evidence dressed up as evidence of absence. Read whichever exists.
    letter = read(os.path.join(base_dir, "cover-letter.md"))
    skip_note = read(os.path.join(base_dir, "cover-letter-skipped.md"))
    m2 = re.search(r"^\*\*URL:\*\*\s*(\S+)", letter or skip_note, re.M)
    pack_url = m2.group(1) if m2 else ""
    r["pack_url"], r["card_url"] = pack_url, it.get("applyUrl")
    r["url_source"] = "cover-letter.md" if letter else ("cover-letter-skipped.md" if skip_note else None)
    if pack_url:
        hp = host_path(pack_url)
        if hp not in (host_path(it.get("applyUrl")), host_path(it.get("sourceUrl"))):
            src = "aggregator" if re.search(r"indeed|linkedin|glassdoor|ziprecruiter|lensa", pack_url, re.I) else "different"
            r["issues"].append(f"pack was staged from a {src} URL, card applies to another")
        else:
            r["provenance_verified"] = True
    else:
        # No URL recorded anywhere: the match is UNVERIFIED, not confirmed.
        r["issues"].append("no staging URL recorded in the pack — provenance unverifiable")

    # how the letter addresses them
    m3 = re.search(r"^(?:Dear|Hiring Team at)\s+(.+?),\s*$", letter, re.M)
    addressed = m3.group(1).strip() if m3 else ""
    r["addressed"] = addressed
    if addressed and addressed.isupper():
        r["issues"].append(f'letter shouts the employer name: "{addressed}"')
    if addressed and it.get("company") and addressed.lower() != str(it["company"]).lower():
        r["issues"].append(f'letter addresses "{addressed}", card says "{it["company"]}"')
    if re.search(r"\[Date\]", letter):
        r["issues"].append("letter contains a literal [Date] placeholder")
    if re.search(r"FACT CHECK", letter):
        r["issues"].append("letter carries an unresolved FACT CHECK banner")

    # what is actually there
    have = sorted(f for f in os.listdir(base_dir) if not f.startswith("."))
    r["base_files"], r["card_files"] = have, sorted(os.listdir(card_dir)) if os.path.isdir(card_dir) else []
    if "cv.pdf" not in have:
        r["issues"].append("base pack has no cv.pdf either")

    h = digest(os.path.join(base_dir, "cv.pdf"))
    r["cv_digest"] = h
    r["cv_shared_with"] = len(by_digest.get(h, []))

    # "Safe" requires positive confirmation that the pack was built from the same
    # posting the card applies to - never merely the absence of a detected problem.
    r["verdict"] = ("SAFE TO REPOINT — provenance verified"
                    if not r["issues"] and r.get("provenance_verified") else "NEEDS WORK")
    results.append(r)

if AS_JSON:
    print(json.dumps(results, indent=2))
    sys.exit(0)

print(f"pack-audit: {len(pending)} pending card(s)\n")
for r in results:
    print(f"{'='*72}\n{r['company']} — {r['role']}")
    print(f"  card slug : {r['slug']}")
    if r.get("base"):
        print(f"  base pack : {r['base']}")
        print(f"  card dir  : {', '.join(r['card_files']) or '(empty)'}")
        print(f"  base dir  : {', '.join(r['base_files'])}")
        print(f"  variant   : pack={r.get('pack_variant')!r} card={r.get('card_variant')!r}")
        print(f"  pack URL  : {r.get('pack_url') or '(none recorded)'}")
        print(f"  card URL  : {r.get('card_url')}")
        cv = r.get("cv_digest")
        if cv:
            print(f"  cv.pdf    : {cv} — byte-identical in {r['cv_shared_with']} pack(s)")
    for i in r["issues"]:
        print(f"  ⚠ {i}")
    print(f"  → {r['verdict']}")

safe = sum(1 for r in results if str(r["verdict"]).startswith("SAFE"))
work = sum(1 for r in results if r["verdict"] == "NEEDS WORK")
print(f"\n{'='*72}\n{safe} safe to repoint, {work} need work, "
      f"{len(results)-safe-work} other\n")

print("cv.pdf uniqueness — is the CV per-role or per-variant?")
for v, hashes in sorted(by_variant.items()):
    n = sum(len(by_digest[h]) for h in hashes)
    print(f"  {v:<16} {len(hashes):>3} distinct cv.pdf across {n:>3} pack(s)")
print()
