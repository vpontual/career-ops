#!/usr/bin/env node
/**
 * test-track-detect.mjs — which rubric a posting is scored against.
 *
 * WHY THIS EXISTS. detectTrack routes every posting to one of five rubrics and
 * had NO assertions at all: test-track.mjs is a corpus-analysis script that
 * prints counts, and test-all.mjs never ran it. The routing is silent by
 * construction — a role sent to the wrong track is dropped by that track's
 * title filter before scoring, so it leaves no error, no warning and no card.
 *
 * It broke exactly that way on 2026-08-14. fetch-doe.mjs wrote 8 NYC Public
 * Schools central-office JDs and appended them to pipeline.md; the run reported
 * success. All 8 were then routed to TEACHING, because "NYC Public Schools"
 * matches SCHOOL_EMPLOYER on `public schools?` and that check ran before the
 * civic one. The teaching title filter admits only teacher/instructor/faculty
 * titles, so "Senior Data Analyst, OGC" was discarded before it cost a scoring
 * call. Zero of the 8 were ever scored and nothing said so.
 */
import { detectTrack, titlePassesForTrack } from './lib/track.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);
const jd = (title, company, url = '') => ({ title, company, url, body: '' });

// ── the fix: a district's central office is a city agency ────────────
eq('NYCPS central-office analyst routes to civic',
   detectTrack(jd('Senior Data Analyst, OGC - 26513', 'NYC Public Schools')), 'civic');
eq('NYCPS project manager routes to civic',
   detectTrack(jd('Project Manager Consultant, DCP - 26226', 'NYC Public Schools')), 'civic');
eq('and civic actually admits the title',
   titlePassesForTrack('civic', 'Senior Data Analyst, OGC - 26513'), true);

// ── the fix must stay narrow ─────────────────────────────────────────
// A teaching TITLE at the same employer is still teaching. This is the case
// that makes the change safe: the exception is about central administration,
// not about the employer being a school system.
eq('a NYCPS teaching title is still teaching',
   detectTrack(jd('Elementary School Teacher', 'NYC Public Schools')), 'teaching');

// Charter and private networks match SCHOOL_EMPLOYER but NOT the city-agency
// pattern, so they must be untouched by this. Both are live in the corpus.
eq('a charter network admin role stays teaching',
   detectTrack(jd('Director of Operations', 'Democracy Prep Public Schools')), 'teaching');
eq('a charter network teacher stays teaching',
   detectTrack(jd('NY Physical Education Teacher', 'Achievement First')), 'teaching');

// ⚠ A PRODUCT ROLE AT A CITY AGENCY IS CIVIC, NOT PM, and that is deliberate —
// track.mjs: "Track E before the PM fallback. A city agency hiring a product
// manager is exactly what this track is for - the work is the draw and the pay
// scale is a known, accepted tradeoff." It behaved this way before the
// central-office change too; asserting 'pm' here was my error, not the code's.
eq('a product manager at a city school system is civic',
   detectTrack(jd('Senior Product Manager', 'NYC Public Schools')), 'civic');
// The isProductRole escape still routes to pm where the employer is NOT a city
// agency — a charter network hiring a PM is the plain PM search.
eq('a product manager at a charter network is pm',
   detectTrack(jd('Senior Product Manager', 'Democracy Prep Public Schools')), 'pm');

// ── the civic title filter ───────────────────────────────────────────
// `strategy` matched only the exact word, so "Strategic Planning Consultant"
// was dropped on one letter while "Chief Strategy Officer" passed.
eq('Strategic Planning passes the civic filter',
   titlePassesForTrack('civic', 'Strategic Planning Consultant, DCP - 26702'), true);
eq('Strategic Initiatives passes too',
   titlePassesForTrack('civic', 'Director of Strategic Initiatives'), true);
eq('and the exact word still passes',
   titlePassesForTrack('civic', 'Chief Strategy Officer'), true);

// The filter is a gate, not a welcome mat: licensed trades stay out.
eq('a licensed trade is still excluded from civic',
   titlePassesForTrack('civic', 'Licensed Attorney, Data Privacy'), false);
eq('an unrelated title is still excluded',
   titlePassesForTrack('civic', 'Sign Language Interpreter'), false);

// ── the teaching route that predates all of this ─────────────────────
eq('an OLAS url is teaching regardless of title',
   detectTrack(jd('Business Manager', 'Some UFSD', 'https://olasjobs.org/job/123')), 'teaching');
eq('a district business official is pm, not teaching',
   detectTrack(jd('Assistant Superintendent for Business', 'Central School District')), 'pm');

let pass = 0, fail = 0;
console.log('\ntrack detection — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nA role routed to the wrong track is dropped before scoring, silently.');
  process.exitCode = 1;
}
