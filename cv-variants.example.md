# CV variants (TEMPLATE)

`cv-variants/` holds per-archetype CV markdown files. The `tailor-cv.mjs`
script picks one per role and renders it to `output/{slug}/cv.pdf`.

## Naming

`cv-{archetype}.md` — the archetype suffix is what `tailor-cv.mjs` reads
from `output/{slug}/cv-variant.txt` (or auto-classifies from the JD).

## Suggested archetypes

- `cv-ai-product.md` — DEFAULT. General AI PM roles.
- `cv-ai-infra.md` — Platform / infra / dev tools / vector DB.
- `cv-ai-enterprise.md` — B2B / enterprise / GTM-adjacent.
- `cv-ai-consumer.md` — Consumer / end-user AI products.

Add or rename freely. The classifier in `tailor-cv.mjs` only knows about
the keywords mapped in `classifyArchetype()`; if you add a new variant,
add the matching keyword set there.

## Format

Each variant is a complete `cv.md` (same shape as the unified one) but
with a tailored Summary and Competencies section, and optionally tighter
bullets emphasizing what matters for that archetype.

The body of experience entries is usually the same across variants. Only
the framing changes.

## How tailor-cv picks a variant

1. If `output/{slug}/cv-variant.txt` exists, read its first non-empty
   line and use that as the archetype name.
2. Otherwise, run `classifyArchetype()` on the JD content and pick a
   default. If the JD doesn't match anything specific, fall back to
   `ai-product`.
3. Render `cv-variants/cv-{archetype}.md` to `output/{slug}/cv.pdf`.
