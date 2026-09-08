#!/usr/bin/env node
/**
 * test-off-track-prose.mjs — the scorer's PM-framed prose is dropped from cards
 * that are not on the PM track, and from nothing else.
 *
 * The property that matters most here is NEGATIVE and it is asserted twice: a
 * pm card is never touched, and a claim that is not a category error is never
 * dropped, whatever track it is on. A false positive deletes a real warning off
 * a card VP is about to act on.
 */
import { readFileSync } from 'fs';
import {
  stripOffTrackClaims, cleanNotesForTrack, rebuildProseFromSource,
  isCategoryError, splitClaims, NOTE_SEGMENTS,
} from './lib/off-track-prose.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

// ── the live strings this was built from ──────────────────────────────────
eq('the useful half of a verdict survives; the category error does not',
  stripOffTrackClaims('teaching',
    "This is a teaching role at a charter school, which is fundamentally misaligned with the candidate's target track in product marketing."),
  'This is a teaching role at a charter school.');

eq('a comma-joined redFlags list loses only the offending clauses',
  stripOffTrackClaims('teaching',
    'Role is a Teacher position, not a Product Marketing role.,No product marketing responsibilities or skills required.'),
  'Role is a Teacher position.');

eq('"fundamentally different from the product ... career tracks" is a mismatch',
  stripOffTrackClaims('teaching',
    'This is a teaching role at a charter school network, which is fundamentally different from the product or product marketing career tracks targeted by the candidate.'),
  'This is a teaching role at a charter school network.');

eq('"entirely outside the target product tracks" is a mismatch',
  stripOffTrackClaims('teaching',
    "This is a K-12 teaching role in a public school district, which is entirely outside the candidate's target product or product marketing career tracks."),
  'This is a K-12 teaching role in a public school district.');

// ── ⚠ the negative property: pm is never touched ──────────────────────────
// On the PM search "this is not a product role" is exactly the warning VP
// needs. Same string, two tracks, two answers.
{
  const flag = 'Role is a Teacher position, not a Product Marketing role.';
  eq('pm keeps the category error, because there it is the point',
    stripOffTrackClaims('pm', flag), flag);
  eq('an unknown track keeps it too — only the four rubric tracks are stripped',
    stripOffTrackClaims('venture', flag), flag);
  eq('teaching drops it', stripOffTrackClaims('teaching', flag), 'Role is a Teacher position.');
}

// ── ⚠ precision: a real warning is never a category error ─────────────────
for (const [track, keep] of [
  ['civic', 'Requires serving permanently in the title or being on the civil service list.'],
  ['civic', 'Government employment status required.'],
  ['teaching', 'Comp floor seen: $65,000.'],
  ['nonprofit', 'The organisation announced layoffs in the last quarter.'],
  ['now', 'Contract is 3 months with no stated extension.'],
  // Names the concept but makes no mismatch claim.
  ['civic', 'The role owns the agency product roadmap.'],
  // Makes a mismatch claim about something that is not the concept.
  ['civic', 'Salary is not stated anywhere in the posting.'],
]) {
  eq(`kept on ${track}: ${keep.slice(0, 44)}`, stripOffTrackClaims(track, keep), keep);
}

// A `no` in a DIFFERENT clause must not take the concept with it. isCategoryError
// judges one clause; stripOffTrackClaims splits on commas first, and that split
// is what makes the guarantee hold at sentence level. Assert it where it lives.
eq('a mismatch in another clause does not condemn this one',
  stripOffTrackClaims('civic', 'No comp is stated, and the product surface is unclear.'),
  'No comp is stated, and the product surface is unclear.');
eq('concept and mismatch in the same clause is a category error',
  isCategoryError('this is not a product management role'), true);
eq('the concept alone is not',
  isCategoryError('The role owns the agency product roadmap'), false);
eq('a mismatch alone is not',
  isCategoryError('Requires SQL knowledge which the candidate cannot write'), false);

// ── round two: the phrasings the first concept list missed ────────────────
// Each observed on a real card. A third round means the design is wrong — see
// the note above PM_CONCEPT.
eq('"not Product/AI" is a category error',
  stripOffTrackClaims('civic', 'Role is in Public Sector/Government, not Product/AI.'),
  'Role is in Public Sector/Government.');
eq('"not a product or marketing position" is one',
  stripOffTrackClaims('civic', 'Role is Chief of Staff for a government commission, not a product or marketing position.'),
  'Role is Chief of Staff for a government commission.');
eq('"rather than product strategy" is one, and the geography flag beside it survives',
  stripOffTrackClaims('civic', "Located in Albany, NY, which is outside the candidate's acceptable NYC metro commute range, and the position focuses on administrative compliance rather than product strategy."),
  "Located in Albany, NY, which is outside the candidate's acceptable NYC metro commute range.");
eq('"target archetypes of Product" is one',
  stripOffTrackClaims('civic', "The role is a Senior Project Manager position at a government agency, which does not align with the candidate's target archetypes of Product."),
  'The role is a Senior Project Manager position at a government agency.');
eq('"No product surface" is one',
  stripOffTrackClaims('civic', 'No product surface or technical ownership.'), '');

// ⚠ and the real flags beside them are untouched.
for (const keep of [
  'Requires SQL knowledge which the candidate cannot write.',
  "Location is outside the candidate's acceptable NYC metro commute range.",
  'The role owns the agency product roadmap.',
  'Compensation is not stated.',
]) {
  eq(`still kept: ${keep.slice(0, 40)}`, stripOffTrackClaims('civic', keep), keep);
}

// ── shape ─────────────────────────────────────────────────────────────────
eq('the model\u2019s ".," list join is a claim boundary',
  splitClaims('A.,B.').length, 2);
eq('empty prose stays empty', stripOffTrackClaims('civic', ''), '');
eq('prose that is ALL category error becomes empty',
  stripOffTrackClaims('teaching', 'Not a product role. No product management scope.'), '');

// ── composed notes ────────────────────────────────────────────────────────
{
  const notes = "INTERVIEW PROCESS — NOT STATED: ask at first contact. || SCORER: This is a teaching role at a charter school, which is fundamentally misaligned with the candidate's target track in product marketing.. RED FLAGS: Role is a Teacher position, not a Product Marketing role.,No product marketing responsibilities. Comp floor seen: $65,000. ON ME: research not yet done.";
  const out = cleanNotesForTrack('teaching', notes);
  eq('the untouched segments survive intact',
    out.includes('INTERVIEW PROCESS') && out.includes('Comp floor seen: $65,000.') && out.includes('ON ME:'), true);
  eq('the scorer segment keeps its useful half',
    out.includes('SCORER: This is a teaching role at a charter school.'), true);
  eq('the red flags segment keeps its real flag', out.includes('RED FLAGS: Role is a Teacher position.'), true);
  eq('and drops the category error', /not a Product Marketing role/i.test(out), false);
  eq('no doubled full stop survives', /\.\./.test(out), false);
  // ⚠ Idempotent, which is what lets the nightly run it over the whole board
  // every night rather than needing a one-off migration.
  eq('cleaning clean notes is a no-op', cleanNotesForTrack('teaching', out), out);
  eq('a pm card is returned byte-identical', cleanNotesForTrack('pm', notes), notes);
}
{
  // A segment that empties out takes its own label AND the separator with it.
  // A bare "RED FLAGS:" reads as a warning the card failed to render.
  const notes = 'SCORER: Not a product role. RED FLAGS: No product management scope. ON ME: research not yet done.';
  const out = cleanNotesForTrack('civic', notes);
  eq('an emptied segment leaves no orphan label', /SCORER:|RED FLAGS:/.test(out), false);
  eq('and the rest of the card survives', out, 'ON ME: research not yet done.');
}
{
  const notes = 'FINDING: something. || SCORER: Not a product role.';
  eq('a separator orphaned by an emptied segment goes too',
    cleanNotesForTrack('civic', notes), 'FINDING: something.');
}

// ── rebuilding from the score record ──────────────────────────────────────
// ⚠ The reason this exists: cleaning derived text repeatedly bakes every defect
// in the cleaner into the card permanently. An early version treated ", " before
// a capital as a claim boundary and rewrote "archetypes of Product, Product
// Marketing, or AI roles" as "...of Product. Product Marketing, or AI roles".
// Nothing in the card could recover the original; the score record could.
{
  const damaged = "SCORER: The role is a PM position at an agency. Product Marketing, or AI roles. RED FLAGS: Role is Project Management. ON ME: research not yet done.";
  const source = {
    verdict: "The role is a Senior Project Manager position at a government agency, which does not align with the candidate's target archetypes of Product, Product Marketing, or AI roles",
    redFlags: 'Role is Project Management.',
  };
  const out = rebuildProseFromSource('civic', damaged, source);
  eq('the orphaned fragment is gone', /Product Marketing, or AI roles/.test(out), false);
  eq('the verdict is re-derived from the record',
    out.includes('SCORER: The role is a Senior Project Manager position at a government agency.'), true);
  eq('the untouched segments survive', out.includes('ON ME: research not yet done.'), true);
  eq('rebuilding twice is stable', rebuildProseFromSource('civic', out, source), out);
}
{
  // A list comma inside a surviving clause must not become a full stop. This is
  // the exact string the first version damaged.
  eq('City, STATE and list commas survive',
    stripOffTrackClaims('civic', "Located in Albany, NY, and the team owns Product, Data, and Design."),
    "Located in Albany, NY, and the team owns Product, Data, and Design.");
}
{
  // A pm card is re-derived too — rebuild is about the SOURCE, not the strip —
  // but nothing is stripped from it.
  const notes = 'SCORER: old text. RED FLAGS: stale. ON ME: x.';
  const out = rebuildProseFromSource('pm', notes, { verdict: 'Not a product role', redFlags: 'Not product.' });
  eq('pm keeps its category error after a rebuild',
    out.includes('SCORER: Not a product role.') && out.includes('RED FLAGS: Not product.'), true);
}
{
  // No record, or an empty one, removes the segments rather than leaving the
  // card's stale text behind pretending to be current.
  const out = rebuildProseFromSource('civic', 'SCORER: old. RED FLAGS: old. ON ME: x.', {});
  eq('an empty record clears the prose segments', out, 'ON ME: x.');
}

// ── the coupling that will rot ────────────────────────────────────────────
// NOTE_SEGMENTS bounds each segment. A prefix enqueue-review emits that is
// missing here means the segment before it absorbs it and gets rewritten.
{
  const src = readFileSync(new URL('./enqueue-review.mjs', import.meta.url), 'utf-8');
  for (const seg of ['SCORER: ', 'RED FLAGS: ', 'WORKDAY: ', 'CERTIFICATION: ', 'CV COVERAGE: ', 'ON ME: ']) {
    eq(`enqueue-review still emits the segment: ${seg.trim()}`, src.includes(seg), true);
    eq(`and NOTE_SEGMENTS knows it: ${seg.trim()}`, NOTE_SEGMENTS.includes(seg), true);
  }
}

let pass = 0, fail = 0;
console.log('\noff-track prose — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) {
  console.log('\nA false positive here deletes a real warning off a card VP is about to act on.');
  process.exitCode = 1;
}
