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
#
# enqueue runs LAST and is the step that was missing until 2026-08-04: the
# scorer did its job nightly and nothing carried the result anywhere VP
# would see it. Staging runs first so a card lands with its pack already built.
set -uo pipefail
cd /home/vp/career-ops || exit 1

step() { echo "=== $(date -Iseconds) $1 ==="; }

step scan        ; /usr/bin/docker compose run --rm scanner node scan.mjs
step gmail       ; /usr/bin/node fetch-gmail-leads.mjs
step resolve     ; /usr/bin/docker compose run --rm applier node resolve-lensa.mjs
step fetch-jds   ; /usr/bin/docker compose run --rm scanner node fetch-jds.mjs
step prune       ; /usr/bin/docker compose run --rm applier node prune-stale.mjs --max-browser 80
step indeed      ; /home/vp/career-ops/.venv-jobspy/bin/python /home/vp/career-ops/fetch-indeed.py
step amazon      ; /usr/bin/node fetch-amazon.mjs
step olas        ; /usr/bin/docker compose run --rm applier node fetch-olas.mjs
step rank-leads  ; /usr/bin/node rank-leads.mjs
step stage       ; /usr/bin/docker compose run --rm -e MAX_AGE_DAYS=30 applier node stage-applications.mjs
step enqueue     ; /usr/bin/node enqueue-review.mjs

step done
