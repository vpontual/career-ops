# Fork-specific changes (vpontual/career-ops)

This fork of [santifer/career-ops](https://github.com/santifer/career-ops) has
diverged from upstream with personal infrastructure additions. Upstream sync is
**one-way** (pull-only) — these changes are not intended to be merged back.

This file documents what is different so future me / future contributors can
find their bearings.

## Replaced subsystems

### Web UI (Next.js 16 reader at port 3340)

Replaces upstream's Go TUI dashboard. Lives in `ui/` and runs as the `ui`
service in `docker-compose.yml`.

- Server-rendered. Reads `data/pipeline.md`, `data/lead-scores.json`,
  `data/applications.md`, and `jds/*.md` directly from the bind-mounted repo. No database.
- **Score join (fixed 2026-07-14):** each row's score comes from `data/lead-scores.json`
  (matched via the JD URL index), NOT the retired `reports/` dir. Reading `reports/`
  made every freshly-scored role show "unscored" and drop out of the Shortlist.
- **Redesigned 2026-07-14.** 3 primary tabs — **Shortlist** (score ≥4, the default) /
  **Ready to apply** (staged) / **All roles**; outcome tabs (Applied/Rejected/…) appear
  only when non-empty. A single **Fresh ≤30d** toggle replaces the old
  High+active/High+recent tabs. (Superseded the 13-tab bar + the `/ranked` page.)
- Sort options: **Best fit** (score) / **Newest** (`min(posted, updated)`) / **Company**.
  (Dropped City/Title/Updated/Grouped — NYC/remote-only makes City moot.)
- Per-row controls: status dropdown writes to `data/applications.md` via
  `POST /api/status`; `details →` link opens `/role/[base64url(url)]` for
  the scoring report + JD preview; `📦 PACK` link opens `/pack/{slug}` if
  staged.
- Search: `Ctrl+K` filters by company + role text, debounced 280ms,
  persists via `?q=` in the URL.
- Visual: Tailwind slate palette + blue-500 accent, absolute-centered title
  in the header, dual-pill age badges showing `↻ Yd` (Updated) prominently
  when more recent than the original Posted date.

The compose UI service mounts the repo writable (`.:/data`, not `:ro`) and
runs as `user: "1000:1000"` so `/api/status` writes land owned by the host
user.

### Cover letters

Cover letters are written by Claude (Opus 4.7), not by Gemini. The upstream
flow runs `stage-applications.mjs` which calls Gemini per role. This fork's
flow is:

1. Claude reads each JD.
2. Claude writes the cover letter in the user's voice (rules in
   `~/.claude/projects/-home-vp-Dev/memory/feedback-vitor-writing-style.md`
   and `user-product-values.md`).
3. The texts are dropped into a JSON manifest.
4. `batch-stage.mjs` consumes the manifest and renders all the role packs
   (md + PDF + cv.pdf copy) in one pass.

Use `rerender-cover.mjs` for one-off hand-edits to a single cover letter.

### Scoring

`rank-leads.mjs` is the **single scoring authority**. It scores every JD in
`jds/` against `cv.md` via the local LLM gateway nightly and caches results in
`data/lead-scores.json`.

`score-all.mjs` + `scoring-tier1.mjs` were **retired to `_archive/` (2026-07-14)**.
They were hand-curated static `SCORING` tables (a one-time LLM snapshot from
2026-04-21) that did not score new JDs, hardcoded a frozen "Evaluated" date, and
contradicted `rank-leads.mjs`. Nothing in cron/UI ran them. `stage-applications.mjs`
now reads candidate scores from `data/lead-scores.json` instead of the old
`reports/v-*.md` snapshots. Kept in `_archive/` for reference, not run.

## New scripts

| Script | Purpose |
|---|---|
| `probe-portals.mjs` | Given (name, [slug-candidates]) probes Greenhouse/Ashby/Lever and prints YAML-ready entries for the successes. Used to grow `portals.yml`. |
| `tailor-cv.mjs` | Per-role CV variant selection. Reads `cv-variants/cv-{archetype}.md`, auto-classifies archetype from JD keywords (override via `output/{slug}/cv-variant.txt`), renders `output/{slug}/cv.pdf`. |
| `rerender-cover.mjs` | Re-renders one role's `cover-letter.md` + `cover-letter.pdf` from a plain-text input. |
| `batch-stage.mjs` | Bulk-stages many roles from a JSON manifest of pre-written cover letters. |
| `inspect-form.mjs` | Debug helper that dumps every input/select/textarea on a URL with id/name/aria-label/closest-label. Used to find new ATS field selectors. |
| `_archive/scoring-tier1.mjs` | **Retired 2026-07-14.** Was a hand-curated static `SCORING_TIER1` table imported by `score-all.mjs`. Superseded by `rank-leads.mjs`. |
| `_archive/score-all.mjs` | **Retired 2026-07-14.** Was a static report renderer over a hardcoded scoring table. Superseded by `rank-leads.mjs`; `stage-applications.mjs` now reads `data/lead-scores.json`. |
| `fetch-gmail-leads.mjs` | IMAP poller for `[Gmail]/All Mail`. Curated sender allowlist in `config/gmail-sources.yml`. Strips tracking query params at write time so digest URLs (Lensa/Idealist/LinkedIn position=1/2/3) collapse to one row in `pipeline.md`. Cursor at `data/.gmail-cursor`. |
| `rank-leads.mjs` | Reads `jds/`, applies title filter (`portals.yml` positive/negative) + freshness filter (≤30d default), scores each survivor against `cv.md` via an Ollama-compatible endpoint (`OLLAMA_URL` env), dedups by title+company, writes `data/inbox-leads.md` grouped by tier. Per-JD scores cached in `data/lead-scores.json`. Each scoring call is bounded by an `AbortController` timeout (`SCORE_TIMEOUT_MS`, default 90s) + in-run retries so a wedged gateway can't hang the run; `--rescore` preserves the existing cache (never wipes out-of-scope entries). |
| `stage-applications.mjs` | **(2026-07-14)** Reads `data/lead-scores.json` for roles scored ≥4 & ≤14d (deduped by company+title), liveness-prunes confidently-expired URLs, then generates a Gemini cover letter + ATS-normalized CV/cover PDFs into `output/{slug}/`. `--list` = dry run. Chained into the nightly cron; **never submits**. |
| `fetch-indeed.py` | **(2026-07-14)** Indeed source via JobSpy (no login — public search API). Applies `portals.yml` title_filter, dedups vs `scan-history.tsv`, writes `pipeline.md` + `jds/*.md` (with descriptions). Runs from a gitignored `.venv-jobspy`; forces IPv4-only DNS. Wired into cron before `rank-leads`. |

See `docs/SCRIPTS.md` for invocation details.

## Browser autofill extension (`extension/`)

MV3 Chromium/Chrome extension (added 2026-07-14) that fills Greenhouse / Ashby /
Lever application forms with the candidate's standard answers, highlights every
touched field, and **never submits** — the human reviews and submits. It fetches
answers live from the UI endpoint `GET /api/application-defaults` (parses
`application-defaults.md`) via the background worker; the VM base URL is set once
in the extension's Options (no internal host is committed to this public repo).
See `extension/README.md`. Fills name/email/phone/location/links, work-auth, EEO,
years-of-experience, and a generic "why interested" essay; handles Ashby's
button-based Yes/No widgets and flags autocomplete (Location) fields for manual
dropdown selection. Skips file uploads and salary on purpose.

## Gmail → ranked-leads pipeline

End-to-end auto-ingest of jobs received by email, added 2026-05-07.

**Flow:**

1. `fetch-gmail-leads.mjs` scans Gmail All Mail for messages from curated
   senders (LinkedIn job alerts, Lensa, Idealist, ZipRecruiter, Welcome to
   the Jungle, etc.). Resolves redirects, drops noise URLs, canonicalizes
   tracking params, appends survivors to `pipeline.md`.
2. `fetch-jds.mjs` enriches each URL. Known ATS hosts use their APIs;
   everything else falls back to scraping `<script type="application/ld+json">`
   blocks for `JobPosting` schema. A `UNSCRAPEABLE_HOSTS` allowlist skips
   guaranteed-failure hosts (Lensa Cloudflare-gated, LinkedIn login-gated,
   Indeed/Glassdoor bot-detected). A `QUERY_STRIP_HOSTS` allowlist
   canonicalizes URLs that ship with email tracking JWTs (Welcome to the
   Jungle).
3. `rank-leads.mjs` filters by title and freshness, scores each survivor
   against `cv.md` via an Ollama-compatible LLM endpoint, dedups by
   title+company, writes `data/inbox-leads.md` grouped by tier.
4. UI at `/ranked` reads `inbox-leads.md` and renders the tier-grouped
   view. Header link from `/`.

**Required env (in `.env`):**

```
GMAIL_USER=
GMAIL_APP_PASSWORD=
OLLAMA_URL=
RANK_MODEL=    # optional, default Qwen/Qwen3.6-35B-A3B-FP8
```

**Geo override:** `rank-leads.mjs` injects a fixed `Geo policy: open to LA,
NYC, or remote-US` line into the LLM prompt instead of using `profile.yml`'s
raw `location` string. Without this the LLM read "Los Angeles (relocating
to NYC by July 2026)" and flagged every NYC-friendly role as a "geo
mismatch."

## Modified upstream scripts

### `fetch-jds.mjs`

Detects branded careers URLs that wrap Greenhouse postings behind a
`gh_jid` query param and routes them to the canonical `boards-api` endpoint.
Without this, JDs from Stripe, Datadog, Databricks, Brex, and Elastic were
unfetched and unscoreable.

```js
const BRANDED_GREENHOUSE = {
  'stripe.com': 'stripe',
  'databricks.com': 'databricks',
  'careers.datadoghq.com': 'datadog',
  'www.brex.com': 'brex',
  'brex.com': 'brex',
  'jobs.elastic.co': 'elastic',
};
```

Adding more branded employers requires only an entry in this map.

### `prefill-greenhouse.mjs`

Two changes:

1. **Per-role city.** `application-defaults.md` carries two values:
   `Current city (LA + remote, default)` and `Current city (NYC roles)`.
   `pickCityForRole(slug, defaults)` reads the JD's `**Location:**` line
   and picks the NYC value when the location includes a NYC keyword,
   otherwise falls back to the default LA value.
2. **Aria-label location selectors.** Anthropic-style Greenhouse forms
   build the location field as a dynamic `question_NNN` input identifiable
   only by `aria-label` (e.g. "What is the address from which you plan on
   working?"). Added a fallback selector list covering the common phrasings:
   `address from which`, `plan on working`, `where you live`, `current
   location`, `current city`, `hometown`, `where are you based`, `reside`,
   then a generic `city` last.

The location field selector list is the most likely place to need
extension when a new employer's form refuses to autofill — use
`inspect-form.mjs` to find the selector and add it.

## Personalized data files (gitignored)

- `cv.md` — base CV (used as fallback)
- `cv-variants/cv-*.md` — per-archetype CV variants (ai-product, ai-infra,
  ai-enterprise, ai-consumer)
- `application-defaults.md` — autofill answers + structured for per-role
  city selection
- `modes/_profile.md` — scoring rules: target archetypes, comp tiers,
  geography, hard exclusions
- `config/profile.yml` — name, contact, linkedin, etc.
- `portals.yml` — companies to scan (this fork tracks 83)

## Infrastructure on the host

- Repo at `/home/vp/career-ops` on `vp@<host>`
- Cron: `0 4 * * *` runs `scan.mjs` → `fetch-gmail-leads.mjs` →
  `fetch-jds.mjs` → `rank-leads.mjs`, logs to
  `/home/vp/career-ops/logs/scanner.log` (gitignored). Weekly Sunday 3am
  log rotation (`tail -c 1M`).
- UI at `http://<host>:3340`
- Daily 8pm `docker system prune -af --volumes` removes unused images;
  the scanner image rebuilds in seconds at the next 4am cron tick.
