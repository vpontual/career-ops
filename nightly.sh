#!/usr/bin/env bash
#
# nightly.sh — the 4am career-ops chain.
#
# This lived as a single crontab line until it grew past the length crontab will
# accept and refused to install. A pipeline you cannot extend without hitting a
# parser limit is one you stop extending, so it lives here now: one step per
# line, each announcing itself, so a failure in the middle is identifiable in
# the log rather than being one unreadable 1200-character command.
#
# Order matters:
#   scan/gmail/lensa   discover new postings
#   fetch-jds          pull the JD text and, importantly, the ATS location field
#   prune-stale        drop dead and ancient rows BEFORE anything is scored
#   indeed/amazon/olas the sources with no ATS API of their own
#   rank-leads         score everything against VP's full criteria
#   stage              build an application pack for what scored well
#   enqueue            carry the good ones into the review queue VP reads
#   answers/research   fill the form and do the diligence for each new card
#   GATES              refuse to leave a broken queue in front of VP
#   report             tell VP what is waiting on HIM
#
# ── FAILURE HANDLING (rewritten 2026-08-06) ────────────────────────────────
# This used to be `set -uo pipefail` with no `-e`, ending in an echo, so the
# script ALWAYS EXITED 0. There is no MAILTO on the crontab. If rank-leads died
# against the gateway, every downstream step still ran against the previous
# night's scores and produced a run that looked completely normal. Nothing in
# the system could distinguish that from a good night, which is how 8 broken
# cards survived two runs and 40 hours of uptime with VP as the only detector.
#
# It deliberately does NOT use `set -e`. Half these steps are network scrapers
# against sites that rate-limit and time out; aborting the whole night on the
# first flaky portal would lose the other fifteen steps' work and make the run
# less reliable, not more. The actual defect was that failures were INVISIBLE,
# not that they failed to abort. So: every step's exit code is recorded, the
# run ends non-zero if any failed, and the gates below decide whether the queue
# is fit for VP to look at.
set -uo pipefail
cd /home/vp/career-ops || exit 1

FAILED_STEPS=""
GATE_FAILURES=""

step() { echo "=== $(date -Iseconds) $1 ==="; }

# Run a pipeline step, record failure, never abort the run.
run_step() {
  local name="$1"; shift
  step "$name"
  if ! "$@"; then
    local code=$?
    echo "!!! STEP FAILED: $name (exit $code)"
    FAILED_STEPS="$FAILED_STEPS $name"
  fi
}

# Run a gate. A gate failing means the OUTPUT is not fit for VP, which is a
# different and more serious thing than a scraper timing out.
run_gate() {
  local name="$1"; shift
  step "gate:$name"
  if ! "$@"; then
    echo "!!! GATE FAILED: $name"
    GATE_FAILURES="$GATE_FAILURES $name"
  fi
}

# ── discovery ──────────────────────────────────────────────────────────────
run_step scan       /usr/bin/docker compose run --rm scanner node scan.mjs
# Tracks B and C have had their own portals files since 2026-07-29 and were
# never swept: only portals.yml was ever scanned, so the nonprofit and school
# boards VP asked for produced nothing at all.
run_step scan-teach /usr/bin/docker compose run --rm -e PORTALS_FILE=portals-teaching.yml scanner node scan.mjs
run_step scan-np    /usr/bin/docker compose run --rm -e PORTALS_FILE=portals-nonprofit.yml scanner node scan.mjs
run_step scan-now   /usr/bin/docker compose run --rm -e PORTALS_FILE=portals-now.yml scanner node scan.mjs
run_step gmail      /usr/bin/node fetch-gmail-leads.mjs
run_step resolve    /usr/bin/docker compose run --rm applier node resolve-lensa.mjs
run_step fetch-jds  /usr/bin/docker compose run --rm scanner node fetch-jds.mjs
run_step prune      /usr/bin/docker compose run --rm applier node prune-stale.mjs --max-browser 80
run_step indeed     /home/vp/career-ops/.venv-jobspy/bin/python /home/vp/career-ops/fetch-indeed.py
run_step amazon     /usr/bin/node fetch-amazon.mjs
run_step olas       /usr/bin/docker compose run --rm applier node fetch-olas.mjs

# Turn the Indeed/aggregator backlog into real apply URLs. This script was
# written 2026-08-05 to fix exactly the problem it names in its own header -
# "107 roles score tier 4+ and cannot be enqueued" - and was never wired in, so
# nothing ever read or drained data/unresolved-apply-paths.md. It is the single
# largest pool of qualifying roles in the system.
run_step resolve-apply /usr/bin/docker compose run --rm applier node resolve-apply-paths.mjs

# ── scoring and packaging ──────────────────────────────────────────────────
# Refresh which employers actually CLOSE their requisitions. The freshness gate
# reads data/employer-closure.json, and a stale measurement quietly turns into a
# stale policy. One API call per board, ~94 calls.
run_step lifespan   /usr/bin/node measure-req-lifespan.mjs
run_step rank-leads /usr/bin/node rank-leads.mjs
# Reapply the CURRENT policy to every stored fact. rank-leads cache-hits on
# filename forever, so without this a policy change reaches only newly-scored
# JDs - 52 of 718 on the 08-06 run - and the other 666 keep yesterday's verdict.
# Costs no LLM calls; that is the whole point of facts-in-code.
run_step recompute  /usr/bin/node recompute-scores.mjs
run_step stage      /usr/bin/docker compose run --rm -e MAX_AGE_DAYS=30 applier node stage-applications.mjs
run_step enqueue    /usr/bin/node enqueue-review.mjs
# Fills the form and does the diligence for whatever enqueue just created.
run_step answers    /usr/bin/docker compose run --rm applier node generate-answers.mjs
run_step research   /usr/bin/node research-roles.mjs

# ── gates: is what VP will see actually fit to look at? ────────────────────
# None of these ran until 2026-08-06. ready-check.py's own docstring promised
# "Exit 1 if anything is not ready, so this can gate a 'done' claim" and nothing
# called it; on the morning it was finally run it reported 8 of 9 pending cards
# INCOMPLETE, every one for a CV that existed in a directory the card did not
# point at.
run_gate cv-links   /usr/bin/python3 batch/link-check.py
run_gate ready      /usr/bin/python3 batch/ready-check.py
run_gate pack-match /usr/bin/node repair-split-packs.mjs        # dry run; reports, never writes
run_gate tests      /usr/bin/node test-all.mjs --quick

# ── the closing step ───────────────────────────────────────────────────────
# Reports against data/applications.md, the only file that measures the mission.
export CAREER_OPS_GATE_FAILURES="$GATE_FAILURES"
step report ; /usr/bin/node nightly-report.mjs

# ── verdict ────────────────────────────────────────────────────────────────
if [ -n "$FAILED_STEPS" ] || [ -n "$GATE_FAILURES" ]; then
  echo "=== $(date -Iseconds) done WITH FAILURES ==="
  [ -n "$FAILED_STEPS" ]   && echo "    failed steps:$FAILED_STEPS"
  [ -n "$GATE_FAILURES" ]  && echo "    failed gates:$GATE_FAILURES"
  exit 1
fi

step done
exit 0
