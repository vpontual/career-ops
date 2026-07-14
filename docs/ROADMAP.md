# career-ops roadmap

Personal fork (`vpontual/career-ops`). Goal: get VP employed (NYC + remote-US AI
PM) with the least manual effort — source → score → shortlist → stage → apply
(human submits) → track. Not tracking upstream feature-for-feature; upstream is a
public multi-user product on a different trajectory (see "Architecture" below).

## Recently shipped (2026-07-14)
- **Apply loop closed** — `stage-applications.mjs` reads `lead-scores.json`, dedups, liveness-prunes, generates cover-letter + CV/cover PDFs; chained into the nightly cron. Human submits.
- **Gateway resilience** — `rank-leads.mjs` scorer call has an AbortController timeout + in-run retry (a wedged gateway can't hang the run); `--rescore` preserves the cache.
- **Indeed source** — `fetch-indeed.py` via JobSpy (no login, IPv4-only), title-filtered, in cron.
- **UI redesign** — 3 primary tabs (Shortlist / Ready to apply / All), Fresh ≤30d toggle, score rail; **score join fixed** to read `lead-scores.json` (not the retired `reports/`).
- **Browser autofill extension** (`extension/`) — fills Greenhouse/Ashby/Lever forms, highlights, never submits; fetches answers from `/api/application-defaults`.
- **Ported from upstream** — canonical `company::title` dedup (#1750: URL-drift score join + row dedup) and the CV/cover **fact-validator** (#682: `verify-cv-facts.mjs`, flags invented metrics in generated letters).

## Next — architecture consolidation (incremental, NOT a rewrite)
Upstream did a ground-up `.mjs → web/src/lib/core` TS rewrite because it's a public
multi-user product. **This fork should not** — it's a personal tool relied on daily,
and its value is features, not architecture. Instead, capture ~80% of the benefit at
~10% of the risk by extracting a shared typed `lib/` **one module at a time, between
features** (no freeze). Kills the duplication + drift Agent-1 flagged:
- **`lib/canonical`** — company/title normalization + dedup. Currently duplicated in `ui/lib/pipeline.ts`, `stage-applications.mjs`, and `rank-leads.mjs` (3 copies of the same idea).
- **`lib/jd-parse`** — the `**Field:**` front-matter parser (~4 copies).
- **`lib/status`** — `applications.md` status normalization (5 copies, already drifting on casing).
- **`lib/render`** — CV / cover-letter HTML templates (5 copies).
- **`lib/llm`** — gateway client + the timeout/retry (and a future cross-provider fallback).

## Backlog (opportunistic)
- **URL canonicalization at ingest** — the 3 appenders (scan / gmail / lensa) strip different tracking params, which is the *root* of the URL-drift the canonical join papers over. Fix the source.
- **`company_aliases`** (portals.yml) — the alias half of the #1750 port (ATS-org vs brand, e.g. Intercom↔Fin).
- **Extension** — per-role cover-letter auto-paste (job URL → staged slug), threshold-dropdown years-of-experience (pick the "10+"/"15+" band), Ashby Location combobox auto-select.
- **Salary enrichment** — Adzuna/Levels.fyi comp band to filter to $150–200K before scoring (blocked on an API key).
- **More upstream ports to evaluate** — `blacklist.md` do-not-apply list (#1748), interview-prep URL-entry (#1817), funnel-velocity benchmarks (#1694).
- **File-locking** for `pipeline.md` / `applications.md` (defense-in-depth; low active risk with the sequential cron).
