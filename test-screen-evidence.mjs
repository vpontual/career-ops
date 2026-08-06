#!/usr/bin/env node

/**
 * test-screen-evidence.mjs — the interview-format gate must fire on evidence only.
 *
 * VP's rule (MISSION-nyc-job.md): "Do not shortlist roles that will run a
 * live-coding technical screen, unless the role explicitly allows building
 * through AI. Check the interview process before shortlisting WHERE IT IS
 * KNOWABLE; FLAG THE RISK WHERE IT IS NOT."
 *
 * The rule is not being weakened. These cases pin BOTH halves: a posting that
 * states a screen must gate; a posting that does not must flag rather than bury.
 *
 * Two cases below (marked FALSE POSITIVE FOUND) are here because the first draft
 * of screen-evidence.mjs got them wrong on real data. Both stay permanently.
 */

import { findScreenEvidence, screenVerdict, findReportableFormats } from './lib/screen-evidence.mjs';

const CASES = [
  // ── stated → gate. VP's hard rule. ───────────────────────────────────────
  ['We use HackerRank for the first round.', 'gate'],
  ['The loop includes a live-coding exercise.', 'gate'],
  ['Interview process: a take-home assignment, then an onsite.', 'gate'],
  ['Our interview process includes a coding challenge round.', 'gate'],
  ['Hiring process: recruiter screen, then a CoderPad session.', 'gate'],
  ['You will complete a technical assessment as part of the interview.', 'gate'],

  // ── the mission's explicit exception ─────────────────────────────────────
  ['Interview includes a technical assessment; use of AI tools is encouraged.', 'flag'],

  // ── FALSE POSITIVE FOUND ON REAL DATA (2026-08-06). "Woven" and "Karat" are
  //    interview vendors AND ordinary words. Matching them bare produced 11 hits
  //    across the corpus, every one prose. These two are the actual sentences.
  ['Experiences you are building are tightly woven into our overall Cloud suite.', 'clear'],
  ['AI is woven into how you work. You spend time every week using AI to build.', 'clear'],

  // ── not about hiring at all ──────────────────────────────────────────────
  ['You will build coding challenges for our learners.', 'clear'],
  ['Strong SQL skills required for this analytics role.', 'clear'],
  ['We are a 24 karat gold standard employer.', 'clear'],

  // ── inference with nothing in the text → flag, never gate. This is the
  //    defect: 176 of 806 records carried the model's flag and 0 of their
  //    postings said anything. Those roles were hard-rejected to tier 1.
  ['Senior Product Manager. You will work closely with engineering on our API platform.', 'flag', true],
];

let pass = 0;
const fails = [];
for (const [text, want, modelSaid = false] of CASES) {
  const got = screenVerdict(text, modelSaid).action;
  if (got === want) pass++;
  else fails.push([text, want, got]);
}

// A case study is a format to REPORT, not a screen to gate on: VP is a PM and
// the mission says system-design and case rounds are "fine and he holds them
// credibly". Gating on these would exclude roles on an interview he would walk.
const REPORTABLE = [
  ['Interview stages: Case study\n\nInterview with the Hiring Manager', 1],
  ['The onsite includes a system-design round.', 1],
  ['Nothing about the process is described here.', 0],
];
for (const [text, wantCount] of REPORTABLE) {
  const n = findReportableFormats(text).length;
  const gated = screenVerdict(text, false).action === 'gate';
  if (n === wantCount && !gated) pass++;
  else fails.push([text, `${wantCount} reportable, not gated`, `${n} reportable, gated=${gated}`]);
}

const total = CASES.length + REPORTABLE.length;
console.log(`\nscreen-evidence — ${total} cases`);
for (const [t, want, got] of fails) {
  console.log(`  ❌ expected ${want}, got ${got}\n     ${JSON.stringify(t.slice(0, 74))}`);
}
console.log(`${pass}/${total} passed`);
if (fails.length) {
  console.log('\nThe interview-format rule is VP\'s. Do not relax a case to go green.\n');
  process.exit(1);
}
console.log('');
