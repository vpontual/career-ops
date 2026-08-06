#!/usr/bin/env node

/**
 * test-slug-identity.mjs — a card must point at its own application pack.
 *
 * THE BUG THIS PINS. enqueue-review.mjs seeded its collision set from every
 * directory in output/. stage-applications.mjs runs EARLIER in the same nightly
 * and creates output/<slug>/ with the CV and cover letter in it. Enqueue read
 * its own pipeline's fresh work as a foreign name collision and minted the card
 * as <slug>-2 - an empty directory that generate-answers and research-roles then
 * filled with answers.md and research.md.
 *
 * Result on 2026-08-06: 25 cards carried a `-N` slug, 8 of the 9 pending cards
 * had no reachable CV, and 34 of 36 file links on the live review queue returned
 * 404 while every CV sat intact one directory away.
 *
 * The rule being tested: a directory is not a conflict. A directory belonging to
 * a DIFFERENT role is.
 */

import { chooseSlug } from './enqueue-review.mjs';

const S = (...x) => new Set(x);
const M = (o) => new Map(Object.entries(o));

const T = [];
const eq = (label, got, want) => T.push([label, got, want]);

const BASE = 'harvey-senior-product-manager-command-center';
const MINE = 'harvey::seniorproductmanagercommandcenter';
const THEIRS = 'harvey::seniorproductmanagervault';

// ── THE REGRESSION. Staging built the pack minutes ago; adopt it. ─────────
eq('adopts the pack staged for this same role',
  chooseSlug({ base: BASE, canon: MINE, claimedByCard: S(), outputDirs: S(BASE), packKeys: M({ [BASE]: MINE }) }),
  BASE);

// A pack staged before pack-meta.json existed has no marker. Every one of the 8
// broken cards is this case. An unowned orphan directory is adoptable.
eq('adopts an unmarked orphan directory',
  chooseSlug({ base: BASE, canon: MINE, claimedByCard: S(), outputDirs: S(BASE), packKeys: M({}) }),
  BASE);

// ── The case the original guard was written for, which is real. ──────────
eq('suffixes when the directory is a DIFFERENT role',
  chooseSlug({ base: BASE, canon: MINE, claimedByCard: S(), outputDirs: S(BASE), packKeys: M({ [BASE]: THEIRS }) }),
  `${BASE}-2`);

// ── A slug held by an existing CARD is never reused, decided or not. ─────
eq('never steals a slug owned by a card',
  chooseSlug({ base: BASE, canon: MINE, claimedByCard: S(BASE), outputDirs: S(BASE), packKeys: M({ [BASE]: MINE }) }),
  `${BASE}-2`);

eq('walks past several owned slugs',
  chooseSlug({
    base: BASE, canon: MINE,
    claimedByCard: S(BASE, `${BASE}-2`, `${BASE}-3`),
    outputDirs: S(), packKeys: M({}),
  }),
  `${BASE}-4`);

// ── Free name, nothing on disk. ──────────────────────────────────────────
eq('takes a free name',
  chooseSlug({ base: BASE, canon: MINE, claimedByCard: S(), outputDirs: S(), packKeys: M({}) }),
  BASE);

// ── Mixed: base is someone else's marked pack, -2 is mine. ───────────────
eq('finds its own pack at a suffix',
  chooseSlug({
    base: BASE, canon: MINE, claimedByCard: S(), outputDirs: S(BASE, `${BASE}-2`),
    packKeys: M({ [BASE]: THEIRS, [`${BASE}-2`]: MINE }),
  }),
  `${BASE}-2`);

// ── Does not adopt a marked foreign pack even when nothing else is free. ─
eq('skips two foreign packs in a row',
  chooseSlug({
    base: BASE, canon: MINE, claimedByCard: S(), outputDirs: S(BASE, `${BASE}-2`),
    packKeys: M({ [BASE]: THEIRS, [`${BASE}-2`]: THEIRS }),
  }),
  `${BASE}-3`);

let pass = 0;
const fails = [];
for (const [label, got, want] of T) {
  if (got === want) pass++;
  else fails.push(`  ❌ ${label}\n     expected ${want}\n     got      ${got}`);
}
console.log(`\nslug identity — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) {
  console.log('\nA card that does not point at its own pack is a 404 in VP\'s face.\n');
  process.exit(1);
}
console.log('');
