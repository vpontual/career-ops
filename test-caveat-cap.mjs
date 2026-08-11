#!/usr/bin/env node

/**
 * test-caveat-cap.mjs — what a 5 means, and not cutting the reason in half.
 *
 * WHY THIS EXISTS. VP, 2026-08-11, looking at a 5.0 rendered directly above a
 * yellow caveat: "why is it a perfect score if there is a caveat? a perfect
 * score is only for a perfect job." It was systemic - of 217 fives, only 93 had
 * nothing flagged at all.
 *
 * The same card showed the flag cut mid-word: "...however, the core
 * responsibility i". Stored redFlags was `.slice(0, 200)` with no ellipsis, so
 * the rest was not hidden by the UI, it was gone from the record. Worse, the
 * clause after "however" is usually the part that decides whether the flag
 * matters, and that is exactly the part a 200-char cut removes.
 */
import { hasCaveat, truncateFlags } from './rank-leads.mjs';

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

// A clean role: pay stated, nothing flagged from any source.
const CLEAN = { compSource: 'posting', compLow: 200000, geo: 'nyc', redFlags: '' };
eq('a clean role has no caveat', hasCaveat(CLEAN), false);

// Every source of a caveat must count, because every one of them renders.
eq('model red flag counts', hasCaveat({ ...CLEAN, redFlags: 'may blur product and sales' }), true);
eq('whitespace-only red flag does NOT count', hasCaveat({ ...CLEAN, redFlags: '   \n ' }), false);
eq('credential warning counts', hasCaveat({ ...CLEAN, credentialWarnings: 'customs broker licence (preferred)' }), true);
eq('empty credential warning does not', hasCaveat({ ...CLEAN, credentialWarnings: '' }), false);
eq('skill warning counts', hasCaveat({ ...CLEAN, skillWarnings: ['SQL'] }), true);
eq('empty skill warning list does not', hasCaveat({ ...CLEAN, skillWarnings: [] }), false);
eq('unclear geography counts', hasCaveat({ ...CLEAN, geo: 'unclear' }), true);
eq('lead-gen focus counts', hasCaveat({ ...CLEAN, leadGen: true }), true);
eq('unstated pay counts', hasCaveat({ ...CLEAN, compSource: 'unstated' }), true);
eq('missing compLow counts', hasCaveat({ ...CLEAN, compLow: null }), true);

// truncateFlags: never cut mid-word, always mark that it was cut.
const long = 'A'.repeat(300) + '. ' + 'B'.repeat(400) + '. ' + 'C'.repeat(200);
const cut = truncateFlags(long);
eq('long text is truncated', cut.length < long.length, true);
eq('truncation is marked', cut.endsWith('…'), true);
eq('truncation does not end mid-token', /[\s,;.]…$/.test(cut), false);
eq('short text is untouched', truncateFlags('Compensation not stated.'), 'Compensation not stated.');
eq('exactly-600 text is untouched', truncateFlags('x'.repeat(600)), 'x'.repeat(600));
eq('601 chars is cut', truncateFlags('y'.repeat(601)).endsWith('…'), true);
eq('null is empty, not the string null', truncateFlags(null), '');
eq('undefined is empty', truncateFlags(undefined), '');
// The clause after "however" is the whole point of keeping more than 200 chars.
const however = 'The role requires direct engagement with sales and solutions engineering teams to close deals, which may blur the line between product strategy and sales enablement; however, the core responsibility is owning the roadmap end to end.';
eq('a 230-char "however" clause now survives intact', truncateFlags(however), however);

let pass = 0, fail = 0;
console.log('\ncaveat cap + flag truncation — ' + T.length + ' cases\n');
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else { fail++; console.log(`  ❌ ${label}\n     expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
}
console.log(`${pass}/${T.length} passed`);
if (fail) { console.log('\nA 5 must mean nothing is flagged, and a flag must be readable.'); process.exitCode = 1; }
