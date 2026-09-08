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
// ⚠ ROUND TWO, and the round is the warning. The first list missed "not
// Product or Marketing", "Role is in Public Sector/Government, not Product/AI"
// and "rather than product strategy" — the model names the discipline a dozen
// ways. Every alternative below was observed on a real card, not imagined.
//
// If this needs a THIRD round, the design is wrong and the fix is the one
// track.mjs already names for its own keyword lists: have the scorer report a
// structured "is this the PM search" fact instead of prose, and gate on that.
// Do not grow this by guessing.
//
// It stays narrow deliberately. Bare `product` is NOT here: a civic posting
// about a data product, or "the role owns the agency product roadmap", must
// survive. Each alternative names the discipline, not the noun.
const PM_CONCEPT = new RegExp([
  'product manage(r|ment)', 'product marketing', 'product owner', 'product lead',
  'product role', 'product position', 'product function', 'product professional',
  'product strategy', 'product surface', 'product ownership', 'product track',
  'product career', 'product or marketing', 'product or product marketing',
  'product or ai', 'product/marketing', 'product/ai', 'private product',
  'target archetype', 'archetypes of product',
  '\\bPMM\\b', '\\bPM\\b',
].join('|'), 'i');

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
    // ⚠ `,(?=[A-Z])` with NO whitespace allowed. The model joins its redFlags
    // list with a bare comma and no space — "...civil service list,Government
    // employment status required" — which is a claim boundary. Allowing
    // whitespace made "Located in Albany, NY" a boundary too, and the rejoin
    // then rendered it "Located in Albany. NY, which is...". City, STATE is
    // everywhere in this data; the model's list join never has the space.
    .split(/(?<=[.!?])\s+|,(?=[A-Z])/)
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
    //
    // ⚠ TRUNCATE FROM THE FIRST OFFENDING CLAUSE, DO NOT FILTER CLAUSE BY
    // CLAUSE. A category error is a trailing subordinate clause and the list
    // after it belongs to it: "...which does not align with the candidate's
    // target archetypes of Product, Product Marketing, or AI roles" is ONE claim
    // across three clauses. Filtering dropped the first and left "Product
    // Marketing, or AI roles" stranded on the card as if it were a finding.
    //
    // The cost is that a genuine flag placed AFTER a category error in the same
    // sentence goes with it. That is the safe direction, and it is rare: the
    // model states the category error as its conclusion, and separate findings
    // arrive as separate claims through splitClaims.
    const parts = sentence.split(/,\s+/);
    const cut = parts.findIndex((c) => isCategoryError(c));
    const clauses = cut === -1 ? parts : parts.slice(0, cut);
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
/**
 * Replace one marker-bounded segment's body, or remove the segment entirely
 * when the new body is empty. A bare "RED FLAGS:" with nothing after it reads
 * as a warning the card failed to render.
 *
 * The segment runs from its marker to the next KNOWN marker, which is why
 * NOTE_SEGMENTS has to be complete: a prefix missing from it means this
 * swallows the segment after it.
 */
function replaceSegment(notes, marker, body) {
  const start = notes.indexOf(marker);
  if (start === -1) return notes;
  const bodyStart = start + marker.length;
  let end = notes.length;
  for (const other of NOTE_SEGMENTS) {
    const i = notes.indexOf(other, bodyStart);
    if (i !== -1 && i < end) end = i;
  }
  const replacement = body.trim() ? `${marker}${body.trim()} ` : '';
  return notes.slice(0, start) + replacement + notes.slice(end);
}

/**
 * Rewrite the two prose segments from the SCORE RECORD rather than from what
 * the card already says.
 *
 * ⚠ PREFER THIS TO cleanNotesForTrack WHEREVER THE RECORD IS AVAILABLE, and the
 * reason is a bug this module caused. Cleaning derived text repeatedly means
 * every defect in the cleaner is baked into the card permanently: an early
 * version treated ", " before a capital as a claim boundary, so one pass over
 * the live queue rewrote "the candidate's target archetypes of Product, Product
 * Marketing, or AI roles" as "...of Product. Product Marketing, or AI roles"
 * and left orphaned fragments where a clause had been removed from the middle
 * of a list. Nothing in the card could recover the original.
 *
 * lead-scores.json holds the model's untouched verdict and redFlags, and every
 * card carries the `scoreSource` that names its record, so the honest operation
 * is to re-derive rather than re-edit. That also makes a cleaner fix
 * retroactive instead of only applying to cards minted after it.
 *
 * ⚠ NOT FOR ROUTINE USE, AND NOT WIRED INTO THE NIGHTLY. The record is REWRITTEN
 * by recompute-scores every night, so it holds the current verdict rather than
 * the one the card was minted with — measured on 2026-09-08, re-deriving would
 * have changed 213 of 287 pending cards, 173 of them `pm` cards this module does
 * not otherwise touch, replacing prose VP may be halfway through reading with a
 * newer model's wording. That is a different feature (keep cards in sync with
 * rescoring) and it needs to be VP's decision, not a side effect of a text fix.
 * The nightly uses cleanNotesForTrack, which is idempotent and rewrites nothing
 * it does not have to. This exists for a targeted repair.
 */
export function rebuildProseFromSource(track, notes, source = {}) {
  const text = String(notes || '');
  if (!text) return text;
  const verdict = stripOffTrackClaims(track, source.verdict || '');
  const flags = stripOffTrackClaims(track, source.redFlags || '');
  let out = text;
  // Same shape enqueue-review writes: the verdict gets a full stop, the flags
  // are pasted as the model listed them.
  out = replaceSegment(out, 'SCORER: ', verdict ? (/[.!?]$/.test(verdict) ? verdict : `${verdict}.`) : '');
  out = replaceSegment(out, 'RED FLAGS: ', flags);
  return tidy(out);
}

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
    out = replaceSegment(out, marker, stripOffTrackClaims(track, out.slice(bodyStart, end)));
  }
  return tidy(out);
}

/** Whitespace, orphaned separators and the doubled full stop, in one place. */
function tidy(out) {
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
