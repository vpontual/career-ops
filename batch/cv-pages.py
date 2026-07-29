#!/usr/bin/env python3
"""Count REAL pages in every staged cv.pdf. A CV over 2 pages is a defect.

Do not estimate this from HTML scrollHeight: the PDF renders at Letter with
0.6in side margins (7.3in of content, ~700px), and section headings do not
split from their lists, so a block that overflows moves whole. Measuring at
any other width silently under-counts.
"""
import re, sys, glob, os
bad = 0
for f in sorted(glob.glob("output/*/cv.pdf")):
    n = len(re.findall(rb"/Type\s*/Page[^s]", open(f, "rb").read()))
    slug = os.path.basename(os.path.dirname(f))
    if n > 2:
        bad = 1
        print(f"  FAIL {n} pages  {slug}")
print("  all staged CVs are 2 pages or fewer" if not bad else "  ^ trim these")
sys.exit(bad)
