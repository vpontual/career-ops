/**
 * lib/off-track-prose.mjs — drop the scorer's PM-framed prose from a card that
 * is not on the PM track.
 *
 * WHY THIS EXISTS. There is one scoring prompt and it is Track A's: it asks a
 * model to describe a role against VP's NYC product search. Every track's facts
 * come back through it, so on a teaching, civic, nonprofit or `now` card the
 * model's `verdict` and `redFlags` are answering a question that card is not
 * asking. Measured on 2026-09-08: 46 of 287 pending cards, 16% of the board,
 * displayed a red flag that was a category error. An Achievement First teaching
 * card, scored 4 by the TEACHING rubric, rendered:
 *
 *     RED FLAGS: Role is a Teacher position, not a Product Marketing role.,
 *     No product marketing responsibilities or skills required.
 *
 * Both statements are true and neither is a defect. The card scored 4 because
 * the teaching rubric rated it 4, and then argued against itself in its own
 * warning line. A card that contradicts itself teaches VP to distrust every
 * other card on the page.
 *
 * ⚠ THIS IS A DISPLAY FIX AND CHANGES NO SCORE. `hasCaveat()` still reads the
 * raw `redFlags` off the score record and still caps a 5 to a 4 — which on
 * civic is every one of its 54 rubric-5 roles, and on teaching its only one.
 * That is VP's rule ("a 5 means nothing is flagged", 2026-08-11) applied to
 * prose it was not written for, and changing it is his call, not this module's.
 * Stripping the sentence from the card while the number still moves would hide
 * the evidence for the cap rather than fix it, so the two must be decided
 * together. See the note in rank-leads.mjs's hasCaveat.
 *
 * ⚠ PRECISION-FIRST, like every other filter here. A false positive deletes a
 * real warning off a card VP is about to act on, which is far worse than
 * leaving one category error on screen. A sentence is dropped only when it
 * BOTH names a Track-A concept AND asserts a mismatch. "Agency is under a
 * hiring freeze" survives; so does "No product management experience will be
 * developed in this role", because it makes no mismatch claim about what the
 * role IS... and if that reads as a close call, it is: the rule errs toward
 * keeping.
 *
 * Pure: no I/O, no clock. test-off-track-prose.mjs pins it, including against
 * every distinct redFlags string in the live corpus.
 */

/** The tracks whose cards are scored by their own rubric in lib/track.mjs. */
const OFF_TRACK = new Set(['teaching', 'civic', 'nonprofit', 'now']);

// A Track-A concept. Deliberately narrow: the words the PM search is ABOUT.
// "product" alone is far too broad — a civic posting about a data product, or a
// nonprofit's "program products", would match on the noun alone.
const PM_CONCEPT =
  /\b(product manager|product management|product marketing|product owner|product role|product or product marketing|product lead|\bPMM\b|\bPM\b|product career|product track)\b/i;

// A claim that the role is not that thing. Without one of these, a sentence
// mentioning product work is describing the role, not disqualifying it.
const MISMATCH =
  /\b(not|non|no\b|lacks?|lacking|without|absent|unrelated|misaligned|mismatch\w*|does not|doesn't|do not|don't|rather than|instead of|outside|irrelevant|little to do with|nothing to do with|differs? from|different from|distinct from|removed from|deviat\w+|divergen\w+|far from|opposed to|unrelated to|no bearing)\b/i;

/**
 * Split prose into the units a reader sees as separate claims.
 *
 * The model returns redFlags as a COMMA-JOINED list and enqueue-review pastes
 * it verbatim, so the corpus contains literal `.,` joins. A comma before a
 * capital is therefore a sentence boundary here as much as a full stop is.
 */
export function splitClaims(prose) {
  return String(prose || '')
    .replace(/\.\s*,\s*/g, '. ')          // the `.,` the model's list join produces
    .split(/(?<=[.!?])\s+|,(?=\s*[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Is this one clause a category error — "this is not a PM job" — rather than a
 * fact about the role worth VP's attention?
 *
 * ⚠ CLAUSE, NOT SENTENCE, and the difference is most of the value. The model
 * writes the useful half and the category error as two halves of ONE sentence:
 * "This is a teaching role at a charter school, which is fundamentally
 * misaligned with the candidate's target track in product marketing." Dropping
 * the sentence throws away the only line on the card that says what the role
 * IS. Dropping the clause keeps "This is a teaching role at a charter school."
 *
 * Both halves of the test must sit in the same clause. Otherwise "No comp is
 * stated, and the product surface is unclear" — two unrelated claims sharing a
 * sentence — would be discarded on the strength of a `no` twenty words from the
 * word `product`.
 */
export function isCategoryError(claim) {
  const t = String(claim || '');
  return PM_CONCEPT.test(t) && MISMATCH.test(t);
}

/**
 * Remove category-error claims from one prose blob, for one track.
 *
 * Returns the blob unchanged for `pm` and for any track not in OFF_TRACK: on
 * the PM search "this is not a product role" is exactly the warning VP needs.
 */
export function stripOffTrackClaims(track, prose) {
  const text = String(prose || '');
  if (!OFF_TRACK.has(String(track))) return text;
  if (!text.trim()) return text;
  const kept = [];
  for (const sentence of splitClaims(text)) {
    // Split on commas, drop the offending clauses, keep the rest of the
    // sentence. A sentence whose every clause is a category error disappears.
    // ⚠ `,\s+` and not `,\s*`. A comma with nothing after it is a thousands
    // separator, and splitting there turned "Comp floor seen: $65,000." into
    // "$65, 000." on the rejoin. Caught by the test, not by reading it.
    const clauses = sentence.split(/,\s+/).filter((c) => !isCategoryError(c));
    if (!clauses.length) continue;
    const rebuilt = clauses.join(', ')
      // A trailing conjunction or relative pronoun left behind by the clause we
      // removed. "This is a teaching role at a charter school, which" reads as
      // truncated; "...at a charter school." does not.
      .replace(/[\s,]*\b(which|and|but|though|although|while|whereas|however|so)\b[\s,]*$/i, '')
      .replace(/[\s,]+$/, '')
      .trim();
    if (rebuilt) kept.push(rebuilt);
  }
  if (!kept.length) return '';
  return kept
    .map((c) => (/[.!?]$/.test(c) ? c : `${c}.`))
    .join(' ');
}

/**
 * The prefixes enqueue-review joins with a single space to build `notes`.
 *
 * ⚠ Used to find where a segment ENDS when cleaning an already-written card.
 * A prefix missing from this list means the segment before it absorbs it and
 * gets rewritten, so anything added to that assembly must be added here. The
 * test asserts every literal prefix in enqueue-review.mjs appears below.
 */
export const NOTE_SEGMENTS = Object.freeze([
  'SCORER: ',
  'RED FLAGS: ',
  'Listed as preferred, not required: ',
  'WORKDAY: ',
  'Comp floor seen: ',
  '⚠ SCORER FLAGGED A TECHNICAL SCREEN',
  '⚠ SCORE CONFLICT:',
  'CERTIFICATION: ',
  'CV COVERAGE: ',
  'ON ME: ',
  'INTERVIEW PROCESS',
]);

/**
 * Clean an already-composed `notes` string on an existing card.
 *
 * Only the two segments that carry the model's prose — SCORER and RED FLAGS —
 * are touched, and each is bounded by the next known segment prefix so nothing
 * else can be rewritten by accident. Idempotent: cleaning clean notes is a
 * no-op, which is what lets the nightly run it over the whole board every time
 * instead of needing a one-off migration.
 */
export function cleanNotesForTrack(track, notes) {
  const text = String(notes || '');
  if (!OFF_TRACK.has(String(track)) || !text) return text;

  let out = text;
  for (const marker of ['SCORER: ', 'RED FLAGS: ']) {
    const start = out.indexOf(marker);
    if (start === -1) continue;
    const bodyStart = start + marker.length;
    let end = out.length;
    for (const other of NOTE_SEGMENTS) {
      const i = out.indexOf(other, bodyStart);
      if (i !== -1 && i < end) end = i;
    }
    const body = out.slice(bodyStart, end);
    const cleaned = stripOffTrackClaims(track, body);
    // The whole segment goes when nothing survives — a bare "RED FLAGS:" with
    // no flags after it reads as a warning the card failed to render.
    const replacement = cleaned.trim() ? `${marker}${cleaned.trim()} ` : '';
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out
    .replace(/\s+/g, ' ')
    // `SCORER: ${verdict}.` where the verdict already ended in one. Pre-dates
    // this module and is only visible once the sentence around it is tidy.
    .replace(/\.{2,}(?=\s|$)/g, '.')
    // Separators orphaned by a segment that went away entirely. research-roles
    // joins its findings to the scorer's prose with " || ", so removing the
    // scorer's half leaves the card ending in a bare "||".
    .replace(/\s*\|\|\s*(?=\|\||$)/g, '')
    .replace(/^\s*\|\|\s*/, '')
    .replace(/\s*\|\|\s*/g, ' || ')
    .trim();
}
