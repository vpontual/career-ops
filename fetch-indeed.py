#!/usr/bin/env python3
"""
fetch-indeed.py — Indeed source for the career-ops pipeline via JobSpy.

Indeed blocks fetch-jds.mjs (it's in UNSCRAPEABLE_HOSTS), so instead of a
login-based scrape (which risks the account), this queries Indeed's public
search API through JobSpy — no credentials — and writes drop-in pipeline data:

  - appends new roles to data/pipeline.md  (- [ ] URL | Company | Title)
  - appends to data/scan-history.tsv       (dedup ledger, portal=indeed-jobspy)
  - writes jds/indeed-<id>.md with the JobSpy description so rank-leads.mjs
    scores them (no separate fetch-jds step needed — JobSpy has the text).

Roles are pre-filtered by the SAME positive/negative title rules as the ATS
sources (portals.yml title_filter), so Indeed's noisy relevance is stripped
before anything hits the pipeline. rank-leads.mjs still does the real scoring.

Run:  .venv-jobspy/bin/python fetch-indeed.py
Env:  INDEED_HOURS_OLD (default 720 = 30d), INDEED_RESULTS (default 30)
"""
import os
import re
import sys
import datetime as dt
import socket as _socket

# This LAN blocks IPv6 at pfSense; a flaky AAAA lookup once made apis.indeed.com
# fail to resolve mid-run ("No address associated with hostname"). Force IPv4-only
# DNS so requests/urllib3 never attempt an IPv6 path.
_orig_getaddrinfo = _socket.getaddrinfo
def _ipv4_only(host, port, family=0, *args, **kwargs):
    return _orig_getaddrinfo(host, port, _socket.AF_INET, *args, **kwargs)
_socket.getaddrinfo = _ipv4_only

ROOT = os.path.dirname(os.path.abspath(__file__))
PIPELINE = os.path.join(ROOT, "data", "pipeline.md")
SCAN_HISTORY = os.path.join(ROOT, "data", "scan-history.tsv")
JDS_DIR = os.path.join(ROOT, "jds")
PORTALS = os.path.join(ROOT, "portals.yml")

HOURS_OLD = int(os.environ.get("INDEED_HOURS_OLD", "720"))   # 30 days
RESULTS = int(os.environ.get("INDEED_RESULTS", "30"))

# (search_term, location, is_remote). Edit to tune coverage.
SEARCHES = [
    ("product manager AI", "New York, NY", False),
    ("AI product manager", "remote", True),
    ("senior product manager AI", "New York, NY", False),
    ("staff product manager AI", "remote", True),
]

try:
    from jobspy import scrape_jobs
except Exception as e:
    print(f"ERROR: jobspy not installed ({e}). Create the venv:\n"
          f"  python3 -m venv {ROOT}/.venv-jobspy && "
          f"{ROOT}/.venv-jobspy/bin/pip install python-jobspy pyyaml", file=sys.stderr)
    sys.exit(1)

import pandas as pd


def load_title_filter():
    """Reuse portals.yml title_filter (positive/negative substrings)."""
    try:
        import yaml
        cfg = yaml.safe_load(open(PORTALS))
        tf = (cfg or {}).get("title_filter", {}) or {}
        pos = [s.lower() for s in (tf.get("positive") or [])]
        neg = [s.lower() for s in (tf.get("negative") or [])]
        return pos, neg
    except Exception as e:
        print(f"WARN: could not read portals.yml title_filter ({e}); using minimal defaults", file=sys.stderr)
        return ["product manager", "head of product", "product lead", "director of product"], \
               ["marketing", "sales", "growth", "engineer"]


def title_passes(title, pos, neg):
    t = (title or "").lower()
    if neg and any(n in t for n in neg):
        return False
    return bool(pos) and any(p in t for p in pos)


def known_urls():
    urls = set()
    if os.path.exists(SCAN_HISTORY):
        for line in open(SCAN_HISTORY, encoding="utf-8"):
            urls.add(line.split("\t", 1)[0].strip())
    # also anything already sitting in pipeline.md
    if os.path.exists(PIPELINE):
        for line in open(PIPELINE, encoding="utf-8"):
            m = re.match(r"^- \[.\]\s*(\S+)", line)
            if m:
                urls.add(m.group(1).strip())
    return urls


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:60]


def days_ago(date_posted):
    if not date_posted or (isinstance(date_posted, float) and pd.isna(date_posted)):
        return None
    try:
        d = pd.to_datetime(date_posted).date()
        return max(0, (dt.date.today() - d).days), d.isoformat()
    except Exception:
        return None


def main():
    pos, neg = load_title_filter()
    seen = known_urls()
    os.makedirs(JDS_DIR, exist_ok=True)

    collected = []  # (url, company, title, location, iso, days, description)
    run_seen = set()

    for term, loc, remote in SEARCHES:
        try:
            df = scrape_jobs(
                site_name=["indeed"],
                search_term=term,
                location=loc,
                is_remote=remote,
                results_wanted=RESULTS,
                hours_old=HOURS_OLD,
                country_indeed="USA",
                description_format="markdown",
                verbose=0,
            )
        except Exception as e:
            print(f"  search failed [{term} @ {loc}]: {e}", file=sys.stderr)
            continue
        if df is None or len(df) == 0:
            print(f"  0 results  [{term} @ {loc}]")
            continue

        kept = 0
        for _, r in df.iterrows():
            url = str(r.get("job_url") or "").strip()
            title = str(r.get("title") or "").strip()
            company = str(r.get("company") or "").strip()
            if not url or not title or not company:
                continue
            if url in seen or url in run_seen:
                continue
            if not title_passes(title, pos, neg):
                continue
            run_seen.add(url)
            location = str(r.get("location") or "").strip()
            da = days_ago(r.get("date_posted"))
            days, iso = (da if da else (None, None))
            desc = r.get("description")
            desc = "" if (desc is None or (isinstance(desc, float) and pd.isna(desc))) else str(desc)
            collected.append((url, company, title, location, iso, days, desc))
            kept += 1
        print(f"  {kept} kept  [{term} @ {loc}] (of {len(df)})")

    if not collected:
        print("No new Indeed roles passed the title filter.")
        return

    # Write jds/, pipeline.md, scan-history.tsv
    today = dt.date.today().isoformat()
    pipe_lines, hist_lines = [], []
    for url, company, title, location, iso, days, desc in collected:
        slug = "indeed-" + slugify(f"{company}-{title}") or "indeed-role"
        # ensure jd filename uniqueness
        jd_name = f"{slug}.md"
        jd_path = os.path.join(JDS_DIR, jd_name)
        n = 2
        while os.path.exists(jd_path):
            jd_name = f"{slug}-{n}.md"
            jd_path = os.path.join(JDS_DIR, jd_name)
            n += 1

        posted = f"{iso} ({days} days ago)" if iso and days is not None else "(date unknown)"
        header = (f"# {title}\n"
                  f"**URL:** {url}\n"
                  f"**Company:** {company}\n"
                  f"**Location:** {location or '(not stated)'}\n"
                  f"**Posted:** {posted}\n"
                  f"**Source:** indeed (jobspy)\n"
                  f"---\n")
        with open(jd_path, "w", encoding="utf-8") as f:
            f.write(header + (desc or "(no description returned)") + "\n")

        pipe_lines.append(f"- [ ] {url} | {company} | {title}\n")
        hist_lines.append(f"{url}\t{today}\tindeed-jobspy\t{title}\t{company}\tadded\n")

    with open(PIPELINE, "a", encoding="utf-8") as f:
        f.writelines(pipe_lines)
    write_header = not os.path.exists(SCAN_HISTORY)
    with open(SCAN_HISTORY, "a", encoding="utf-8") as f:
        if write_header:
            f.write("url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n")
        f.writelines(hist_lines)

    print(f"\nAdded {len(collected)} new Indeed roles -> pipeline.md + jds/ (title-filtered).")
    print("Next: rank-leads.mjs scores them; stage-applications.mjs packages tier 4+.")


if __name__ == "__main__":
    main()
