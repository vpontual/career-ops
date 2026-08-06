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
import time
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
RESULTS = int(os.environ.get("INDEED_RESULTS", "100"))

# Boards to sweep. Default is indeed only, and that is a measured decision:
# tested 2026-07-29, zip_recruiter and google both return 0 rows for every
# query from this host (ZipRecruiter fronts Cloudflare; jobspy's google backend
# returns nothing even with google_search_term set). They stay wired so they
# can be re-enabled the moment they work again, but defaulting them ON would
# mean a third of every run silently doing nothing.
#   JOBSPY_SITES="indeed,zip_recruiter,google,linkedin,glassdoor"
# linkedin and glassdoor are supported by jobspy but rate-limit hard without
# proxies, so they are opt-in too.
SITES = [x.strip() for x in os.environ.get(
    "JOBSPY_SITES", "indeed").split(",") if x.strip()]

# (search_term, location, is_remote). Breadth is the point: the portals.yml scan
# covers ~128 named companies deeply; this covers every employer posting to a
# major board, at any size, in any industry. portals.yml title_filter cuts the
# volume down long before anything reaches the LLM scorer.
SEARCHES = [
    ("product manager",           "New York, NY", False),
    ("senior product manager",    "New York, NY", False),
    ("principal product manager", "New York, NY", False),
    ("director of product",       "New York, NY", False),
    ("head of product",           "New York, NY", False),
    ("product marketing manager", "New York, NY", False),
    ("AI product manager",        "New York, NY", False),
    ("senior product manager",    "remote",       True),
    ("principal product manager", "remote",       True),
    ("director of product",       "remote",       True),
    ("head of product",           "remote",       True),
    ("product marketing manager", "remote",       True),
    ("AI product manager",        "remote",       True),
    ("founding product manager",  "remote",       True),
]

# site x query sweep, flattened so the loop body stays at one indent level
QUERIES = [(site, t, l, r) for site in SITES for (t, l, r) in SEARCHES]

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



def cell(row, key):
    """Read a jobspy cell as clean text. Missing values arrive as float NaN,
    which is truthy, so the usual `or ""` guard passes it through and str()
    renders it as the word "nan"."""
    value = row.get(key)
    if value is None:
        return ""
    text = str(value).strip()
    if text.lower() in ("nan", "none", "<na>"):
        return ""
    return text


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



# Board APIs sit behind Cloudflare and intermittently fail DNS resolution
# mid-run even though the host resolves fine from the shell. Transient network
# errors get retried rather than surfaced; a query that still fails after
# RETRIES attempts is skipped with a warning.
RETRIES = int(os.environ.get("JOBSPY_RETRIES", "3"))
_TRANSIENT = ("NameResolutionError", "Max retries exceeded", "Temporary failure",
              "Connection reset", "timed out", "ConnectTimeout", "ReadTimeout")


def scrape_with_retry(**kwargs):
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            return scrape_jobs(**kwargs)
        except Exception as e:  # noqa: BLE001 - jobspy raises bare Exceptions
            last = e
            if not any(t in str(e) for t in _TRANSIENT) or attempt == RETRIES:
                raise
            time.sleep(2 ** attempt)
    raise last


def main():
    pos, neg = load_title_filter()
    seen = known_urls()
    os.makedirs(JDS_DIR, exist_ok=True)

    collected = []  # (url, company, title, location, iso, days, description)
    run_seen = set()
    # Every query failing must not look like a quiet night. The exception below
    # printed to stderr and continued, and the summary counted only what was
    # KEPT - so 14 failed searches and 14 searches that legitimately matched
    # nothing produced the same "Added 0 new Indeed roles" and the same exit 0.
    queries_run = 0
    queries_failed = 0
    queries_empty = 0

    for site, term, loc, remote in QUERIES:
        try:
            # jobspy's google backend ignores search_term and needs its own
            # natural-language query, otherwise it silently returns 0 rows.
            extra = {}
            if site == "google":
                where = "remote" if remote else loc
                extra["google_search_term"] = f"{term} jobs near {where}"
            df = scrape_with_retry(
                site_name=[site],
                search_term=term,
                **extra,
                location=loc,
                is_remote=remote,
                results_wanted=RESULTS,
                hours_old=HOURS_OLD,
                country_indeed="USA",
                description_format="markdown",
                verbose=0,
            )
        except Exception as e:
            queries_failed += 1
            print(f"  search FAILED [{site}: {term} @ {loc}]: {e}", file=sys.stderr)
            continue
        queries_run += 1
        if df is None or len(df) == 0:
            queries_empty += 1
            print(f"  0 results  [{site}: {term} @ {loc}]")
            continue

        kept = 0
        for _, r in df.iterrows():
            url = cell(r, "job_url")
            title = cell(r, "title")
            company = cell(r, "company")
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
        _report(queries_run, queries_failed, queries_empty, 0, 0)
        # A run where EVERY query failed is a broken run, not a quiet one.
        if queries_failed and queries_run == 0:
            sys.exit(1)
        return

    # Write jds/, pipeline.md, scan-history.tsv
    today = dt.date.today().isoformat()
    pipe_lines, hist_lines = [], []
    duplicates = 0
    for url, company, title, location, iso, days, desc in collected:
        # `"indeed-" + slugify(...) or "indeed-role"` never reached the fallback:
        # + binds tighter than or, and "indeed-" is always truthy, so an empty
        # slugify produced the filename "indeed-.md".
        body = slugify(f"{company}-{title}") or "role"
        slug = "indeed-" + body

        # ⚠ DO NOT create indeed-<slug>-2.md. The old loop suffixed until it
        # found a free name, so the same role reposted under a new Indeed jk=
        # became a SECOND JD file - 23 (company,title) groups spanned more than
        # one file, 32 duplicate scorings at ~34s of LLM time each, and the
        # duplicates then disagreed with each other about the score. The same
        # company and title is the same role; a repost is not new information.
        jd_name = f"{slug}.md"
        jd_path = os.path.join(JDS_DIR, jd_name)
        if os.path.exists(jd_path):
            duplicates += 1
            continue

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

    _report(queries_run, queries_failed, queries_empty, len(pipe_lines), duplicates)
    print("Next: rank-leads.mjs scores them; stage-applications.mjs packages tier 4+.")
    if queries_failed and queries_run == 0:
        sys.exit(1)


def _report(run, failed, empty, added, duplicates):
    """One place that says what actually happened, so a broken run is
    distinguishable from a quiet one in the nightly log."""
    print("")
    print(f"queries: {run + failed} attempted, {run} ok, {failed} FAILED, {empty} returned nothing")
    print(f"roles:   {added} new -> pipeline.md + jds/ (title-filtered)")
    if duplicates:
        print(f"         {duplicates} skipped as a repost of a role already on disk")
    if failed:
        print(f"⚠ {failed} search(es) failed — this run saw less than the board actually holds")


if __name__ == "__main__":
    main()
