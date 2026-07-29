#!/usr/bin/env python3
"""CV person check: implied first person, verb-first, NO pronouns, no 3rd-person -s verbs."""
import re, sys, glob, os

PRONOUNS = r"\b(I|me|my|mine|myself|he|him|his|himself|she|her|hers|we|us|our|ours)\b"

# Third-person singular verb forms that betray "he runs / he builds" phrasing.
THIRD = [
    "runs", "builds", "operates", "maintains", "ships", "owns", "leads", "drives",
    "manages", "watches", "prototypes", "designs", "partners", "creates", "delivers",
    "defines", "directs", "scales", "lifts", "closes", "supports", "studies",
]
THIRD_RE = re.compile(r"(?:^|(?<=[.;:]\s)|(?<=^- ))\s*(?:Currently |Now |Also )?(" + "|".join(THIRD) + r")\b",
                      re.IGNORECASE | re.MULTILINE)

# Framing that devalues the work.
DEVALUE = ["at home", "personal use", "personal-use", "my family", "and family",
           "myself and", "for fun", "hobby", "side project"]


def lint(path):
    hits = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        stripped = line.strip()
        # skip the contact line and links
        if stripped.startswith("**New York") or stripped.startswith("#"):
            continue
        for m in re.finditer(PRONOUNS, line):
            hits.append((n, "PRONOUN", m.group(0)))
        for m in THIRD_RE.finditer(line):
            hits.append((n, "3rd-person verb", m.group(1)))
        low = line.lower()
        for d in DEVALUE:
            if d in low:
                hits.append((n, "devaluing framing", d))
        if "—" in line:
            hits.append((n, "em dash", "—"))
    return hits


fail = 0
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.md"))):
    hits = lint(f)
    name = os.path.basename(f)
    if hits:
        fail = 1
        print(f"FAIL {name}  ({len(hits)} issues)")
        for n, kind, tok in hits[:12]:
            print(f"      line {n:>3}  {kind}: {tok!r}")
    else:
        print(f"PASS {name}")
sys.exit(fail)
