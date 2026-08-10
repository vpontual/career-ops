#!/usr/bin/env node
/**
 * test-skill-gate.mjs — a skill VP lacks blocks only where it is REQUIRED.
 *
 * VP, 2026-08-10: "IF its a requirement, block it. if its in the nice to haves
 * section, show it with a warning."
 *
 * The section distinction is the whole thing. This repo has already shipped one
 * parser that ignored it — the years-of-experience reader took its number from
 * anywhere in the body, and 204 of 778 postings kept their minimum inside a
 * preferred block. Getting it wrong in the blocking direction loses good roles
 * silently, which is the failure mode this codebase keeps paying for.
 */
import { skillGate } from './lib/skill-gate.mjs';

const LACKS = [
  { name: 'SQL', re: /\bSQL\b/i },
  { name: 'Python', re: /\bPython\b/i },
  { name: 'statistics', re: /\b(statistical analysis|statistics)\b/i },
];
const T = [];
const eq = (l, g, w) => T.push([l, g, w]);
const run = (body) => {
  const r = skillGate(body, LACKS);
  return { blocked: r.blocked.map(x => x.skill).sort().join(','), warned: r.warned.map(x => x.skill).sort().join(',') };
};

// ── required -> BLOCK ────────────────────────────────────────────────
// The real Datadog "Senior Product Manager - Journey Monitoring" bullet, which
// reached VP at 5.0 with the flag shown but never scored.
eq('required: Datadog\'s SQL bullet blocks',
   run('**Requirements**\n- Strong analytical skills - you can write SQL, interpret complex data.').blocked, 'SQL');
eq('required: "Minimum Qualifications" heading blocks',
   run('Minimum Qualifications\n- Proficiency writing complex SQL queries with joins.').blocked, 'SQL');
eq('required: "What you\'ll need" heading blocks',
   run("What you'll need\n- Python for prototyping and analysis.").blocked, 'Python');

// ── preferred -> WARN, never block ───────────────────────────────────
eq('preferred: nice-to-have only warns',
   run('**Nice to have**\n- SQL and dashboarding experience.').warned, 'SQL');
eq('preferred: nice-to-have does NOT block',
   run('**Nice to have**\n- SQL and dashboarding experience.').blocked, '');
eq('preferred: "Bonus points" only warns',
   run('Bonus points\n- Python scripting is a plus.').warned, 'Python');
// A posting with BOTH sections must split them correctly. This is the case a
// body-wide scan gets wrong in the most damaging direction.
const both = run('Requirements\n- 8+ years of product management.\n\nPreferred Qualifications\n- SQL proficiency.');
eq('split: required section has no lacked skill -> no block', both.blocked, '');
eq('split: the preferred SQL still warns', both.warned, 'SQL');

// ── a degree major is not a skill ────────────────────────────────────
// REGRESSION: Upstart's "Bachelor's degree in Computer Science, Engineering,
// Mathematics, Statistics, Economics, or a related field" blocked the role on
// "Statistics". It is listing acceptable majors; VP holds an Economics BA and
// an MBA. Blocking there is a silent loss of a qualified match.
eq('degree list: naming Statistics as a major does not block',
   run("Requirements\n- Bachelor's degree in Computer Science, Mathematics, Statistics, or Economics.").blocked, '');

// ── no headings at all: fall back to the sentence, and prefer WARN ───
eq('no heading: requirement wording blocks',
   run('You must have deep proficiency in SQL to succeed here.').blocked, 'SQL');
eq('no heading: soft wording only warns',
   run('Familiarity with SQL is helpful but not essential.').warned, 'SQL');
// Ambiguity resolves to warn — losing a role silently is the worse error.
eq('no heading: a bare mention does not block',
   run('Our stack touches SQL, Kafka and Go.').blocked, '');

// ── skills VP HAS must never appear ──────────────────────────────────
// Kubernetes and AWS are on his confirmed `has` list (2026-08-10) even though
// cv.md omits them, so they are not in LACKS and cannot gate anything.
eq('has-list: Kubernetes never blocks',
   run('Requirements\n- Deep Kubernetes and AWS experience required.').blocked, '');


// ── BAR HEIGHT: he has the skill, just not at every depth ────────────
// VP has BASIC SQL (SELECT/JOIN/filter) and understands pipelines without
// building them, confirmed 2026-08-10. A bare "SQL: no" deleted 17 reviewable
// roles, two of them tier-5 (Anthropic, Twilio), because it could not tell
// these two requirements apart. `beyond` is what separates them.
const LEVELLED = [{
  name: 'SQL', re: /\bSQL\b/i,
  beyond: /\b(complex|advanced) sql|common table expression|\bCTEs?\b|window function|query (optimi[sz]|tuning)/i,
}];
const lv = (body) => {
  const r = skillGate(body, LEVELLED);
  return { blocked: r.blocked.map(x => x.skill).join(','), warned: r.warned.length ? 'warned' : '' };
};
// Datadog's real bullet - a bar most senior PMs clear. Must NOT block.
eq('level: "you can write SQL" is within his level',
   lv('Requirements\n- Strong analytical skills - you can write SQL, interpret complex data.').blocked, '');
eq('level: ...but he is still told it was asked for',
   lv('Requirements\n- Strong analytical skills - you can write SQL, interpret complex data.').warned, 'warned');
// GitLab's real bullet - an analytics specialist. Must block.
eq('level: complex SQL with CTEs exceeds it',
   lv('Minimum Qualifications\n- Proficiency writing complex SQL queries with joins, aggregations, common table expressions.').blocked, 'SQL');
eq('level: query optimisation exceeds it',
   lv('Requirements\n- Experience with SQL query optimization at scale.').blocked, 'SQL');
// A levelled skill in a nice-to-have still only warns, whatever its depth.
eq('level: advanced SQL in nice-to-haves still only warns',
   lv('Nice to have\n- Advanced SQL including window functions.').blocked, '');

let pass = 0; const fails = [];
for (const [l, g, w] of T) { if (g === w) pass++; else fails.push(`  ❌ ${l}\n     expected ${JSON.stringify(w)}, got ${JSON.stringify(g)}`); }
console.log(`\nskill gate — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log('\nA block is a silent loss of a role. Do not relax a case.\n'); process.exit(1); }
console.log('');
