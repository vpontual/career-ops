# CLAUDE.md

> ## ⚠ READ THIS FIRST — THIS DEPLOYMENT
>
> **Everything below the `## Origin` heading is UPSTREAM documentation
> (santifer/career-ops). It describes a system this fork no longer is.** An audit
> on 2026-08-06 checked 55 concrete claims across the docs and found **26 false
> and 13 stale**, with every claim about how the system actually runs — the
> architecture, the run model, the cron chain, the scoring, the batch subsystem —
> in the false column. `CLAUDE.md` had not been touched in 96 commits.
>
> It is kept rather than deleted because the onboarding, ethics and offer-
> verification sections are still good, and because deleting a file agents read
> first is its own hazard. But treat anything below as upstream's system, not
> this one, and verify before acting on it.
>
> ### What is actually true here
>
> **Run model.** A host crontab runs `nightly.sh` at 04:00, appending to
> `logs/scanner.log`. It is not a service. Nothing else is scheduled except a
> weekly log truncation.
>
> **The chain**, in order, as it exists in `nightly.sh` today:
>
> ```
> discovery   scan · scan-teach · scan-np · scan-now · gmail · resolve
>             fetch-jds · prune · indeed · amazon · olas · resolve-apply
> scoring     lifespan · rank-leads · recompute
> packaging   stage · enqueue · answers · research
> GATES       cv-links · ready · pack-match · tests
> closing     nightly-report
> ```
>
> Every step records its exit code; the run exits non-zero if any step or gate
> failed. It deliberately does NOT use `set -e` — half these steps are network
> scrapers, and aborting the night on the first flaky portal loses the other
> fifteen steps' work. The defect that mattered was that failures were invisible.
>
> **The gates are real and they block.** `batch/link-check.py` asks the RUNNING
> app whether every pending card's files resolve; `batch/ready-check.py` checks
> pack completeness and rejects diligence that found nothing; `repair-split-packs.mjs`
> (dry run) reports card/pack mismatches; `test-all.mjs` runs the suite. Before
> 2026-08-06 none of them ran at all.
>
> **Tests.** `node test-all.mjs` is the entry point and wraps the rest:
> `test-answers-matcher` · `test-screen-evidence` · `test-normalizers` ·
> `test-slug-identity` · `test-fact-check` · `test-jd-findings` ·
> `test-gmail-leads` · `test-liveness-verdict` · `test-recency` · `test-track`.
> 133 assertions, all green as of 2026-08-07. **A property is asserted in a test
> or not at all** — do not write a comment claiming code is correct.
>
> ### Freshness is measured, not assumed
>
> "Fresh" means the employer is still WORKING the requisition, not that the ad is
> new. Three signals, all derived from data rather than chosen:
>
> - **Survival curve** (`measure-req-lifespan.mjs`, ~740 postings via the
>   Greenhouse/Ashby board APIs): a req stays open for WEEKS — 85% at 8-14 days,
>   93% at 22-30 — and the cliff is at 45-60 days, not 3. The gate is 21 days,
>   7 for evergreen employers, 30 for whales.
> - **Employer closure behaviour** (`data/employer-closure.json`, refreshed
>   nightly): of postings watched 30+ days, Intercom closes 91% of its reqs and
>   Sierra closes 6%. An old posting on an evergreen board signals nothing.
>   ⚠ Only count postings watched 30+ days — a board tracked for 8 days shows
>   100% open because nothing has had TIME to close.
> - **Employer activity** (`updated_at`, parsed by `lib/jd-parse.mjs`): 607 of
>   684 reqs were touched more recently than they were posted. The gate uses the
>   most recent activity, so a 20-day-old req edited yesterday counts as worked.
>
> `data/scan-history.tsv` carries **`last_seen`**, stamped by every `scan.mjs`
> sweep. When a posting stops appearing, the date it last appeared is its closure
> date — that is what makes lifespan measured rather than right-censored. It only
> advances for boards `scan.mjs` sweeps; Indeed/Amazon/OLAS/gmail rows are never
> re-observed and are excluded from lifespan stats rather than counted as
> same-day closures.
>
> A **relist** (`lib/repost.mjs`) is the strongest positive signal there is —
> posted, not filled, back to market. Surfaced as a card note, never a score
> change. Requires a 14-day gap: the raw count of 122 is mostly the initial
> backfill re-observing one board a day apart; only 19 are real.
>
> ### Two failure shapes that keep recurring here
>
> **A gate that cries wolf is a gate VP disables.** Three built on 2026-08-06
> had to have their thresholds corrected against real data within hours: the
> fact checker fired on 40% of letters, the first diligence bar failed 27 of 29
> cards, and `ready` failed the nightly on postings that were merely thin. Always
> measure a new gate's fire rate against the corpus before shipping it.
>
> **A gate that refuses bad output needs a producer that can retry.** The rule
> "no card without a CV" was right, but staging's "already staged" check accepted
> a cover-letter marker without a CV — so one Gemini quota trip left 21 packs
> permanently unstageable and their roles permanently invisible. `link-check.py`
> now fails on that state specifically.
>
> **Deploy.** `scanner` and `applier` bind-mount the repo, so editing a `.mjs`
> takes effect on the next `docker compose run` — no rebuild. The **`ui` service
> is a baked production build**: any change under `ui/` needs
> `docker compose build ui && docker compose up -d ui`. ⚠ A long-running
> container holds the module it loaded at startup, so editing a file mid-run does
> not affect that run.
>
> **`dashboard/` is upstream's and is NOT what VP looks at.** The review surface
> is the Next.js app in `ui/` on port 3340.
>
> **Never run `update-system.mjs`** — see the section below.
>
> ### Rules that are VP's, not suggestions
>
> - A role reaching the Review Queue **must** have a completed, reachable CV.
>   `enqueue-review.mjs` refuses to write a card without one and holds it in
>   `data/held-no-pack.md`.
> - **Cover letters only when required.** Optional means none — "not a short one,
>   not a good one. None." An undetermined requirement is not permission.
> - **No unpaid take-homes.** A stated live-coding screen is a hard 1; an
>   *inferred* one is a flag, per the mission's "flag the risk where it is not
>   knowable".
> - **Never auto-submit.** Filling a form and stopping at Submit is fine.
> - EEO: ethnicity → Hispanic or Latino; a separate race question → White; never
>   "decline to answer".
> - If a recorded rule of VP's looks wrong, **surface it and stop** — do not ship
>   an override with a rationale in the source.
>
> ### Verify against the running system
>
> Existence on disk and reachability through the UI are different claims. On
> 2026-08-06 every CV existed and 34 of 36 links still 404'd. Paste command
> output; do not reason from the code.
>
> The mission itself lives at `~/Dev/plans/MISSION-nyc-job.md` **on VP's laptop,
> not on this VM** — the policy and its enforcement are on different hosts.


## Origin

This system was built and used by [santifer](https://santifer.io) to evaluate 740+ job offers, generate 100+ tailored CVs, and land a Head of Applied AI role. The archetypes, scoring logic, negotiation scripts, and proof point structure all reflect his specific career search in AI/automation roles.

The portfolio that goes with this system is also open source: [cv-santiago](https://github.com/santifer/cv-santiago).

**It will work out of the box, but it's designed to be made yours.** If the archetypes don't match your career, the modes are in the wrong language, or the scoring doesn't fit your priorities -- just ask. You (AI Agent) can edit the user's files. The user says "change the archetypes to data engineering roles" and you do it. That's the whole point.

## Data Contract (CRITICAL)

There are two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (NEVER auto-updated, personalization goes HERE):**
- `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer — ⚠ NOT AUTO-UPDATABLE IN THIS FORK:**
- `modes/_shared.md`, `modes/oferta.md`, all other modes
- `CLAUDE.md`, `*.mjs` scripts, `dashboard/*`, `templates/*`, `batch/*`

> ⚠ Upstream calls this layer auto-updatable. **Here it is where essentially all
> of the work lives** — the scoring rewrite, Track D, the review queue, the
> Next.js UI in `ui/`, the four gate scripts in `batch/`, and every `lib/`
> module. Nothing in it may be overwritten from upstream. See the update-check
> section below.

**THE RULE: When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), ALWAYS write to `modes/_profile.md` or `config/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content.** This ensures system updates don't overwrite their customizations.

## Update Check — DO NOT RUN. Removed 2026-08-06.

**Never run `update-system.mjs` in any form — not `check`, not `apply`.** Do not
offer it, do not act on a user request to "check for updates", and do not restore
the instructions that used to live here.

This section previously told every session to run `node update-system.mjs check` on
its first message and to offer `apply` if an update existed. That was inherited from
upstream and was a standing hazard: `apply` pulls `santifer/career-ops` over the
system layer, and **this fork has diverged from upstream by hundreds of commits**.
The "System Layer" listed in the Data Contract above — `*.mjs`, `batch/*`,
`templates/*`, this file — is NOT auto-updatable here. It is where essentially all
of the local work lives: the scoring rewrite, Track D, the review queue, the Next.js
UI, the four gate scripts. Upstream has since done a ground-up `.mjs → TypeScript`
rewrite, so a merge does not conflict cleanly — it clobbers.

The instruction sat here unnoticed from April to August 2026 while 20 unpushed local
commits accumulated. It was never triggered; that was luck, not design.

**If upstream has something worth having, cherry-pick it by hand** and record it in
`docs/FORK-CHANGES.md`. Sync direction is one-way and manual: pull only, never push
or PR to `santifer/career-ops`. `origin` is `vpontual/career-ops` and is the only
remote that is ever pushed to.

## What is career-ops

AI-powered job search automation built on Claude Code: pipeline tracking, offer evaluation, CV generation, portal scanning, batch processing.

### Main Files

| File | Function |
|------|----------|
| `data/applications.md` | Application tracker |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `portals.yml` | Query and company config |
| `templates/cv-template.html` | HTML template for CVs |
| `templates/cv-template.tex` | LaTeX/Overleaf template for CVs |
| `generate-pdf.mjs` | Playwright: HTML to PDF |
| `generate-latex.mjs` | LaTeX CV validator + pdflatex compiler |
| `article-digest.md` | Compact proof points from portfolio (optional) |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories across evaluations |
| `interview-prep/{company}-{role}.md` | Company-specific interview intel reports |
| `analyze-patterns.mjs` | Pattern analysis script (JSON output) |
| `followup-cadence.mjs` | Follow-up cadence calculator (JSON output) |
| `data/follow-ups.md` | Follow-up history tracker |
| `scan.mjs` | Zero-token portal scanner — hits Greenhouse/Ashby/Lever APIs directly, zero LLM cost |
| `check-liveness.mjs` | Job posting liveness checker |
| `liveness-core.mjs` | Shared liveness logic (expired signals win over generic Apply text) |
| `reports/` | Evaluation reports (format: `{###}-{company-slug}-{YYYY-MM-DD}.md`). Blocks A-F + G (Posting Legitimacy). Header includes `**Legitimacy:** {tier}`. |

### OpenCode Commands

When using [OpenCode](https://opencode.ai), the following slash commands are available (defined in `.opencode/commands/`):

| Command | Claude Code Equivalent | Description |
|---------|------------------------|-------------|
| `/career-ops` | `/career-ops` | Show menu or evaluate JD with args |
| `/career-ops-pipeline` | `/career-ops pipeline` | Process pending URLs from inbox |
| `/career-ops-evaluate` | `/career-ops oferta` | Evaluate job offer (A-F scoring) |
| `/career-ops-compare` | `/career-ops ofertas` | Compare and rank multiple offers |
| `/career-ops-contact` | `/career-ops contacto` | LinkedIn outreach (find contacts + draft) |
| `/career-ops-deep` | `/career-ops deep` | Deep company research |
| `/career-ops-pdf` | `/career-ops pdf` | Generate ATS-optimized CV |
| `/career-ops-latex` | `/career-ops latex` | Export CV as LaTeX/Overleaf .tex |
| `/career-ops-training` | `/career-ops training` | Evaluate course/cert against goals |
| `/career-ops-project` | `/career-ops project` | Evaluate portfolio project idea |
| `/career-ops-tracker` | `/career-ops tracker` | Application status overview |
| `/career-ops-apply` | `/career-ops apply` | Live application assistant |
| `/career-ops-scan` | `/career-ops scan` | Scan portals for new offers |
| `/career-ops-batch` | `/career-ops batch` | Batch processing with parallel workers |
| `/career-ops-patterns` | `/career-ops patterns` | Analyze rejection patterns and improve targeting |
| `/career-ops-followup` | `/career-ops followup` | Follow-up cadence tracker |

**Note:** OpenCode commands invoke the same `.claude/skills/career-ops/SKILL.md` skill used by Claude Code. The `modes/*` files are shared between both platforms.

### Gemini CLI Commands

When using the [Gemini CLI](https://github.com/google-gemini/gemini-cli), the following slash commands are available (defined in `.gemini/commands/`):

| Command | Claude Code Equivalent | Description |
|---------|------------------------|-------------|
| `/career-ops` | `/career-ops` | Show menu or evaluate JD with args |
| `/career-ops-pipeline` | `/career-ops pipeline` | Process pending URLs from inbox |
| `/career-ops-evaluate` | `/career-ops oferta` | Evaluate job offer (A-G scoring) |
| `/career-ops-compare` | `/career-ops ofertas` | Compare and rank multiple offers |
| `/career-ops-contact` | `/career-ops contacto` | LinkedIn outreach (find contacts + draft) |
| `/career-ops-deep` | `/career-ops deep` | Deep company research |
| `/career-ops-pdf` | `/career-ops pdf` | Generate ATS-optimized CV |
| `/career-ops-training` | `/career-ops training` | Evaluate course/cert against goals |
| `/career-ops-project` | `/career-ops project` | Evaluate portfolio project idea |
| `/career-ops-tracker` | `/career-ops tracker` | Application status overview |
| `/career-ops-apply` | `/career-ops apply` | Live application assistant |
| `/career-ops-scan` | `/career-ops scan` | Scan portals for new offers |
| `/career-ops-batch` | `/career-ops batch` | Batch processing with parallel workers |
| `/career-ops-patterns` | `/career-ops patterns` | Analyze rejection patterns and improve targeting |
| `/career-ops-followup` | `/career-ops followup` | Follow-up cadence tracker |

**Note:** Gemini CLI commands are defined in `.gemini/commands/*.toml`. The project context is auto-loaded from `GEMINI.md`. All `modes/*` files are shared across Claude Code, OpenCode, and Gemini CLI.

### First Run — Onboarding (IMPORTANT)

**Before doing ANYTHING else, check if the system is set up.** Run these checks silently every time a session starts:

1. Does `cv.md` exist?
2. Does `config/profile.yml` exist (not just profile.example.yml)?
3. Does `modes/_profile.md` exist (not just _profile.template.md)?
4. Does `portals.yml` exist (not just templates/portals.example.yml)?

If `modes/_profile.md` is missing, copy from `modes/_profile.template.md` silently. This is the user's customization file — it will never be overwritten by updates.

**If ANY of these is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place. Guide the user step by step:

#### Step 1: CV (required)
If `cv.md` is missing, ask:
> "I don't have your CV yet. You can either:
> 1. Paste your CV here and I'll convert it to markdown
> 2. Paste your LinkedIn URL and I'll extract the key info
> 3. Tell me about your experience and I'll draft a CV for you
>
> Which do you prefer?"

Create `cv.md` from whatever they provide. Make it clean markdown with standard sections (Summary, Experience, Projects, Education, Skills).

#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and then ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
>
> I'll set everything up for you."

Fill in `config/profile.yml` with their answers. For archetypes and targeting narrative, store the user-specific mapping in `modes/_profile.md` or `config/profile.yml` rather than editing `modes/_shared.md`.

#### Step 3: Portals (recommended)
If `portals.yml` is missing:
> "I'll set up the job scanner with 45+ pre-configured companies. Want me to customize the search keywords for your target roles?"

Copy `templates/portals.example.yml` → `portals.yml`. If they gave target roles in Step 2, update `title_filter.positive` to match.

#### Step 4: Tracker
If `data/applications.md` doesn't exist, create it:
```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

#### Step 5: Get to know the user (important for quality)

After the basics are set up, proactively ask for more context. The more you know, the better your evaluations will be:

> "The basics are ready. But the system works much better when it knows you well. Can you tell me more about:
> - What makes you unique? What's your 'superpower' that other candidates don't have?
> - What kind of work excites you? What drains you?
> - Any deal-breakers? (e.g., no on-site, no startups under 20 people, no Java shops)
> - Your best professional achievement — the one you'd lead with in an interview
> - Any projects, articles, or case studies you've published?
>
> The more context you give me, the better I filter. Think of it as onboarding a recruiter — the first week I need to learn about you, then I become invaluable."

Store any insights the user shares in `config/profile.yml` (under narrative), `modes/_profile.md`, or in `article-digest.md` if they share proof points. Do not put user-specific archetypes or framing into `modes/_shared.md`.

**After every evaluation, learn.** If the user says "this score is too high, I wouldn't apply here" or "you missed that I have experience in X", update your understanding in `modes/_profile.md`, `config/profile.yml`, or `article-digest.md`. The system should get smarter with every interaction without putting personalization into system-layer files.

#### Step 6: Ready
Once all files exist, confirm:
> "You're all set! You can now:
> - Paste a job URL to evaluate it
> - Run `/career-ops scan` (or `/career-ops-scan` if using OpenCode) to search portals
> - Run `/career-ops` to see all commands
>
> Everything is customizable — just ask me to change anything.
>
> Tip: Having a personal portfolio dramatically improves your job search. If you don't have one yet, the author's portfolio is also open source: github.com/santifer/cv-santiago — feel free to fork it and make it yours."

Then suggest automation:
> "Want me to scan for new offers automatically? I can set up a recurring scan every few days so you don't miss anything. Just say 'scan every 3 days' and I'll configure it."

If the user accepts, use the `/loop` or `/schedule` skill (if available) to set up a recurring `/career-ops scan` (or `/career-ops-scan` if using OpenCode). If those aren't available, suggest adding a cron job or remind them to run `/career-ops scan` (or `/career-ops-scan` if using OpenCode) periodically.

### Personalization

This system is designed to be customized by YOU (AI Agent). When the user asks you to change archetypes, translate modes, adjust scoring, add companies, or modify negotiation scripts -- do it directly. You read the same files you use, so you know exactly what to edit.

**Common customization requests:**
- "Change the archetypes to [backend/frontend/data/devops] roles" → edit `modes/_profile.md` or `config/profile.yml`
- "Translate the modes to English" → edit all files in `modes/`
- "Add these companies to my portals" → edit `portals.yml`
- "Update my profile" → edit `config/profile.yml`
- "Change the CV template design" → edit `templates/cv-template.html`
- "Adjust the scoring weights" → edit `modes/_profile.md` for user-specific weighting, or edit `modes/_shared.md` and `batch/batch-prompt.md` only when changing the shared system defaults for everyone

### Language Modes

Default modes are in `modes/` (English). Additional language-specific modes are available:

- **German (DACH market):** `modes/de/` — native German translations with DACH-specific vocabulary (13. Monatsgehalt, Probezeit, Kündigungsfrist, AGG, Tarifvertrag, etc.). Includes `_shared.md`, `angebot.md` (evaluation), `bewerben.md` (apply), `pipeline.md`.
- **French (Francophone market):** `modes/fr/` — native French translations with France/Belgium/Switzerland/Luxembourg-specific vocabulary (CDI/CDD, convention collective SYNTEC, RTT, mutuelle, prévoyance, 13e mois, intéressement/participation, titres-restaurant, CSE, portage salarial, etc.). Includes `_shared.md`, `offre.md` (evaluation), `postuler.md` (apply), `pipeline.md`.
- **Japanese (Japan market):** `modes/ja/` — native Japanese translations with Japan-specific vocabulary (正社員, 業務委託, 賞与, 退職金, みなし残業, 年俸制, 36協定, 通勤手当, 住宅手当, etc.). Includes `_shared.md`, `kyujin.md` (evaluation), `oubo.md` (apply), `pipeline.md`.

**When to use German modes:** If the user is targeting German-language job postings, lives in DACH, or asks for German output. Either:
1. User says "use German modes" → read from `modes/de/` instead of `modes/`
2. User sets `language.modes_dir: modes/de` in `config/profile.yml` → always use German modes
3. You detect a German JD → suggest switching to German modes

**When to use French modes:** If the user is targeting French-language job postings, lives in France/Belgium/Switzerland/Luxembourg/Quebec, or asks for French output. Either:
1. User says "use French modes" → read from `modes/fr/` instead of `modes/`
2. User sets `language.modes_dir: modes/fr` in `config/profile.yml` → always use French modes
3. You detect a French JD → suggest switching to French modes

**When to use Japanese modes:** If the user is targeting Japanese-language job postings, lives in Japan, or asks for Japanese output. Either:
1. User says "use Japanese modes" → read from `modes/ja/` instead of `modes/`
2. User sets `language.modes_dir: modes/ja` in `config/profile.yml` → always use Japanese modes
3. You detect a Japanese JD → suggest switching to Japanese modes

**When NOT to:** If the user applies to English-language roles, even at French, German, or Japanese companies, use the default English modes.

### Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline (evaluate + report + PDF + tracker) |
| Asks to evaluate offer | `oferta` |
| Asks to compare offers | `ofertas` |
| Wants LinkedIn outreach | `contacto` |
| Asks for company research | `deep` |
| Preps for interview at specific company | `interview-prep` |
| Wants to generate CV/PDF | `pdf` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns or wants to improve targeting | `patterns` |
| Asks about follow-ups or application cadence | `followup` |

### CV Source of Truth

- `cv.md` in project root is the canonical CV
- `article-digest.md` has detailed proof points (optional)
- **NEVER hardcode metrics** -- read them from these files at evaluation time

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.** The goal is to help the user find and apply to roles where there is a genuine match -- not to spam companies with mass applications.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply. The user makes the final call.
- **Strongly discourage low-fit applications.** If a score is below 4.0/5, explicitly recommend against applying. The user's time and the recruiter's time are both valuable. Only proceed if the user has a specific reason to override the score.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50. Guide the user toward fewer, better applications.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** ALWAYS use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without JD = closed. Title + description + Apply = active.

**Exception for batch workers (`claude -p`):** Playwright is not available in headless pipe mode. Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (batch mode)`. The user can verify manually later.

---


## MCP Server (agent integration)

`mcp-server.mjs` at the repo root exposes the pipeline as agent-queryable state via the MCP stdio protocol. Acts as a thin adapter over the UI's HTTP API, so the UI is the only source of truth for parsing.

**Tools:**
- `list_roles({status?, min_score?, fresh_days?, company?, query?, staged_only?, limit?})` — filtered pipeline rows
- `get_role({url})` — full pack: row + scoring report + JD + cover letter (when staged)
- `pipeline_stats()` — counts by status, score bucket, freshness, top companies, scored/staged totals
- `set_role_status({url, status, company?, role?, note?})` — mutate via existing `/api/status` endpoint. Statuses: `under_review`, `applied`, `rejected`, `archived`, `clear`

**Run:** `npm run mcp` (stdio). Configure via `CAREER_OPS_UI_URL` (default `http://localhost:3340`).

**Underlying HTTP API** (also useful to non-MCP agents):
- `GET /api/roles?status=…&min_score=…&fresh_days=…&company=…&q=…&staged_only=true&limit=…`
- `GET /api/roles/{base64url(url)}` — single role with full detail
- `POST /api/status` — pre-existing mutation endpoint (unchanged)

## CI/CD and Quality

- **GitHub Actions** run on every PR: `test-all.mjs` (63+ checks), auto-labeler (risk-based: 🔴 core-architecture, ⚠️ agent-behavior, 📄 docs), welcome bot for first-time contributors
- **Branch protection** on `main`: status checks must pass before merge. No direct pushes to main (except admin bypass).
- **Dependabot** monitors npm, Go modules, and GitHub Actions for security updates
- **Contributing process**: issue first → discussion → PR with linked issue → CI passes → maintainer review → merge

## Community and Governance

- **Code of Conduct**: Contributor Covenant 2.1 with enforcement actions (see `CODE_OF_CONDUCT.md`)
- **Governance**: BDFL model with contributor ladder — Participant → Contributor → Triager → Reviewer → Maintainer (see `GOVERNANCE.md`)
- **Security**: private vulnerability reporting via email (see `SECURITY.md`)
- **Support**: help questions go to Discord/Discussions, not issues (see `SUPPORT.md`)
- **Discord**: https://discord.gg/8pRpHETxa4

## Stack and Conventions

- Node.js (mjs modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data), Canva MCP (optional visual CV)
- Scripts in `.mjs`, configuration in YAML
- Output in `output/` (gitignored), Reports in `reports/`
- JDs in `jds/` (referenced as `local:jds/{file}` in pipeline.md)
- Batch in `batch/` (gitignored except scripts and prompt)
- Report numbering: sequential 3-digit zero-padded, max existing + 1
- **RULE: After each batch of evaluations, run `node merge-tracker.mjs`** to merge tracker additions and avoid duplications.
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.

### TSV Format for Tracker Additions

Write one TSV file per evaluation to `batch/tracker-additions/{num}-{company-slug}.tsv`. Single line, 9 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

**Column order (IMPORTANT -- status BEFORE score):**
1. `num` -- sequential number (integer)
2. `date` -- YYYY-MM-DD
3. `company` -- short company name
4. `role` -- job title
5. `status` -- canonical status (e.g., `Evaluated`)
6. `score` -- format `X.X/5` (e.g., `4.2/5`)
7. `pdf` -- `✅` or `❌`
8. `report` -- markdown link `[num](reports/...)`
9. `notes` -- one-line summary

**Note:** In applications.md, score comes BEFORE status. The merge script handles this column swap automatically.

### Pipeline Integrity

1. **NEVER edit applications.md to ADD new entries** -- Write TSV in `batch/tracker-additions/` and `merge-tracker.mjs` handles the merge.
2. **YES you can edit applications.md to UPDATE status/notes of existing entries.**
3. All reports MUST include `**URL:**` in the header (between Score and PDF). Include `**Legitimacy:** {tier}` (see Block G in `modes/oferta.md`).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `node verify-pipeline.mjs`
6. Normalize statuses: `node normalize-statuses.mjs`
7. Dedup: `node dedup-tracker.mjs`

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

**RULES:**
- No markdown bold (`**`) in status field
- No dates in status field (use the date column)
- No extra text (use the notes column)
