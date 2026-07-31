#!/usr/bin/env node

/**
 * triage-candidates.mjs — what the rescore surfaced that is not yet triaged.
 *
 * The review queue is built by hand, one role at a time, because the notes on
 * each item are research rather than data. This just answers "what should I be
 * looking at", so nothing worth applying to sits unseen in lead-scores.json
 * the way 197 tier-4s did.
 *
 * Prints one line per candidate with the facts the new scorer recorded, so the
 * shortlist can be judged before spending research time on it.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIN_SCORE = Number(process.argv.find((a) => /^--min=/.test(a))?.split('=')[1] ?? 4);

const scores = JSON.parse(await readFile(path.join(ROOT, 'data', 'lead-scores.json'), 'utf8'));
const queue = JSON.parse(await readFile(path.join(ROOT, 'data', 'review-queue.json'), 'utf8'));
const applications = await readFile(path.join(ROOT, 'data', 'applications.md'), 'utf8').catch(() => '');

// A pruned row keeps its JD file, so a req the ATS has already closed would
// otherwise sail back into the shortlist as a fresh recommendation. Only the
// liveness verdicts matter here — an age-archived role that is somehow still
// scoring well is worth seeing.
const archive = await readFile(path.join(ROOT, 'data', 'pipeline-archive.md'), 'utf8').catch(() => '');
const deadUrls = new Set(
  archive
    .split('\n')
    .filter((l) => /\| (?:ats: req gone|page:)/.test(l))
    .map((l) => l.split('|')[2]?.trim())
    .filter(Boolean)
);

// Queue slugs are derived from company+role, so match on the normalized pair
// rather than the filename, which differs between the Indeed and ATS copies of
// the same req.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const queued = new Set((queue.items ?? []).map((i) => `${norm(i.company)}|${norm(i.role)}`));
const appliedText = norm(applications);

const rows = [];
for (const [file, s] of Object.entries(scores)) {
  if ((Number(s.score) || 0) < MIN_SCORE) continue;
  if (s.geo === undefined) continue;          // not rescored under the new rubric

  let head;
  try {
    head = (await readFile(path.join(ROOT, 'jds', file), 'utf8')).slice(0, 900);
  } catch { continue; }

  const company = /^\*\*Company:\*\* (.+)$/m.exec(head)?.[1]?.trim() ?? '';
  const role = /^# (.+)$/m.exec(head)?.[1]?.trim() ?? '';
  const url = /^\*\*URL:\*\* (\S+)/m.exec(head)?.[1] ?? '';
  const posted = /^\*\*Posted:\*\* \S+ \((\d+) days/m.exec(head)?.[1];

  const key = `${norm(company)}|${norm(role)}`;
  if (queued.has(key)) continue;
  if (company && appliedText.includes(norm(company))) continue;
  if (deadUrls.has(url)) continue;

  rows.push({ score: s.score, company, role, url, posted, ...s });
}

// Collapse the Indeed and ATS copies of the same req; prefer the ATS one,
// whose URL is the real application form.
const seen = new Map();
for (const r of rows.sort((a, b) => (a.url.includes('indeed.com') ? 1 : 0) - (b.url.includes('indeed.com') ? 1 : 0))) {
  const key = `${norm(r.company)}|${norm(r.role)}`;
  if (!seen.has(key)) seen.set(key, r);
}
const out = [...seen.values()].sort((a, b) => b.score - a.score || (Number(a.posted) || 99) - (Number(b.posted) || 99));

console.log(`${out.length} untriaged at score >= ${MIN_SCORE}\n`);
for (const r of out) {
  const tags = [
    r.aiNative ? 'AI' : '--',
    r.geo,
    r.archetype,
    r.compLow ? `$${Math.round(r.compLow / 1000)}k` : 'no band',
    r.technicalScreen ? 'TECH-SCREEN' : '',
  ].filter(Boolean).join(' · ');
  console.log(`[${r.score}] ${r.company} — ${r.role}`);
  console.log(`      ${tags} · ${r.posted ?? '?'}d`);
  console.log(`      ${r.verdict}`);
  if (r.redFlags) console.log(`      ⚠ ${r.redFlags}`);
  console.log(`      ${r.url}`);
  console.log();
}
