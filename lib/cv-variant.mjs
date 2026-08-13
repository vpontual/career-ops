/**
 * lib/cv-variant.mjs — which CV variant a role would be sent, in one place.
 *
 * This was a private function in enqueue-review.mjs, and its own comment there
 * records why it must not be re-implemented: a hand-rolled copy invented a
 * variant called 'leadership' for any Director/Head title, a later change
 * forced every Track D card to it, cv-variants/cv-leadership.md does not exist
 * and never did, and tailor-cv.mjs does not fall back — so 22 of 69 cards
 * pointed at a missing file and rendered nothing.
 *
 * It moved here when lib/cv-coverage.mjs needed the same answer at SCORING
 * time, which is upstream of enqueue. Importing it was the only way to ask the
 * question without becoming the second copy that comment warns about.
 */

import { classifyArchetype } from '../tailor-cv.mjs';

export const DEFAULT_VARIANT = 'ai-product';

/** @returns {string} variant name — the file is cv-variants/cv-<name>.md */
export function cvVariantFor(jdContent, track) {
  if (track === 'teaching') return 'teaching';
  try {
    return classifyArchetype(jdContent) || DEFAULT_VARIANT;
  } catch {
    return DEFAULT_VARIANT;
  }
}
