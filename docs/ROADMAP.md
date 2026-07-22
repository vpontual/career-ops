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
- **Per-role tailored CV in staging** — `stage-applications` now classifies each role's archetype and renders the matching `cv-variants/cv-{variant}.md` into the packet (not a shared copy).
- **Ported from upstream** — canonical `company::title` dedup (#1750: URL-drift score join + row dedup), the CV/cover **fact-validator** (#682), and the **do-not-apply blacklist** (#1748). Ruled out with cause: provider-`postedAt` (#1578, redundant) and the skill-gap checker (#1559, 0/437 JDs fit it; scorer `redFlags` already cover PM gaps).

## Next — architecture consolidation (incremental, NOT a rewrite)
Upstream did a ground-up `.mjs → web/src/lib/core` TS rewrite because it's a public
multi-user product. **This fork should not** — it's a personal tool relied on daily,
and its value is features, not architecture. Instead, capture ~80% of the benefit at
~10% of the risk by extracting a shared typed `lib/` **one module at a time, between
features** (no freeze). Kills the duplication + drift Agent-1 flagged:
- [x] **`lib/canonical`** — company/title normalization + dedup. ✅ SHIPPED
  2026-07-22 (`refactor/shared-libs`): `lib/canonical.mjs` now backs
  `rank-leads.mjs`, `stage-applications.mjs`, `verify-pipeline.mjs`, and
  `blacklist.mjs`. Data-validated against 496 real JDs — corrected
  `normalizeTitle` to KEEP parenthetical content (the upstream impl dropped it
  and wrongly merged distinct roles, e.g. Owner.com's 3 Senior PM roles). Only
  true punctuation variants collapse. `ui/lib/pipeline.ts` aligned inline (can't
  import root `.mjs`; kept in sync by convention). Unit tests in `test-all.mjs`.
- [x] **`lib/jd-parse`** — ✅ SHIPPED 2026-07-22. `lib/jd-parse.mjs` (`parseJd`)
  replaces `parseJdFile` (rank-leads) + `parseJdMeta` (stage-applications, now a
  thin adapter preserving its postedIso/postedDays field names). `fetch-jds` is
  the writer, not a parse copy. Unit-tested.
- [x] **`lib/status`** — status normalization. ✅ SHIPPED 2026-07-22
  (`refactor/shared-libs`): `lib/status.mjs` unifies the 6 drifted copies
  (verify-pipeline, followup-cadence, analyze-patterns, dedup-tracker readers;
  normalize-statuses, merge-tracker writers). Fixes the casing drift by making
  the canonical **lowercase** internally (readers stay drop-in — their
  `=== 'applied'` compares untouched) and having writers map to the on-disk
  Title-case via `toDisplay()` at write time. `applications.md` format
  unchanged. Exports normalizeStatus (reader), classifyStatus (writer, rich
  regex + moveToNotes), toDisplay, STATUS_RANK, CANONICAL_STATUSES. Unit-tested
  incl. a writer→disk→reader round-trip drift guard.
- [x] **`lib/render`** — ✅ SHIPPED 2026-07-22. `lib/render.mjs` (`renderCvHtml`,
  `renderCoverLetterHtml`) unifies the 3 byte-identical `htmlForCv` copies
  (tailor-cv, render-pdfs, stage-applications) + the 2 profile-based
  `htmlForCoverLetter` (render-pdfs, stage-applications); the cover "Re:" line is
  a `metaLine` param so output is byte-preserved. `renderPdf()` stays per-file
  (PDF margins differ by doc type). `batch-stage.mjs` keeps its own cover variant
  (module-level contact vars + `Re: role, company`) — documented exception, not
  folded in to avoid changing its output. Unit-tested.
- [~] **`lib/llm`** — NOT extracted (intentional): there is no live duplication.
  The gateway call (`OLLAMA_URL /api/chat` + AbortController timeout/retry) is
  single-site in `rank-leads.mjs` (the sole scorer); Gemini is single-site in
  `stage-applications`. Extracting now would be premature abstraction (YAGNI).
  Revisit only if/when a genuine cross-provider fallback is actually built.

## Backlog (opportunistic)
- [x] **URL canonicalization at ingest** — ✅ SHIPPED 2026-07-22. `lib/url-canonical.mjs`
  (`canonicalizeUrl`) is now used at ingest by all 3 appenders: gmail (was the
  richest — 24 tracking params + strip-all-query hosts, now the shared source),
  lensa (was drifted — only 12 params; upgraded), and scan (had NONE; now
  canonicalizes both its seen-set and every job URL before dedup/append). Strips
  tracking (utm/click-ids/session/position/…), keeps identifying params (gh_jid).
  Drift variants of one posting now collapse to a single URL at the source
  instead of the `company::title` join papering over them. Unit-tested.
- **`company_aliases`** (portals.yml) — the alias half of the #1750 port (ATS-org vs brand, e.g. Intercom↔Fin).
- **Extension** — per-role cover-letter auto-paste (job URL → staged slug), threshold-dropdown years-of-experience (pick the "10+"/"15+" band), Ashby Location combobox auto-select.
- **Salary enrichment** — Adzuna/Levels.fyi comp band to filter to $150–200K before scoring (blocked on an API key).
- **More upstream ports to evaluate** — `blacklist.md` do-not-apply list (#1748), interview-prep URL-entry (#1817), funnel-velocity benchmarks (#1694).
- **File-locking** for `pipeline.md` / `applications.md` (defense-in-depth; low active risk with the sequential cron).
