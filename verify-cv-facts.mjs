#!/usr/bin/env node
/**
 * verify-cv-facts.mjs — guard generated CVs / cover letters against invented
 * metrics. Ported from upstream (santifer/career-ops #682) and adapted to this
 * fork: default sources are cv.md + config/profile.yml, and `checkFacts` is
 * exported so stage-applications.mjs can flag hallucinated numbers in the
 * Gemini-written cover letters (zero extra LLM calls — pure regex).
 *
 * CLI:
 *   node verify-cv-facts.mjs <generated.md|html|tex> [--source path]... [--config path]
 * A "metric-like claim" (percent, $/€/£ amount, Nx multiplier, "N users/…") in
 * the target that is absent from every source (and not allow-listed) fails.
 */
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCES = ['cv.md', 'config/profile.yml'];
const DEFAULT_CONFIG = join(ROOT, 'config', 'cv-facts.json');

function stripMarkup(text) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, ' $1 ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

const normalizeClaim = (c) => c.toLowerCase().replace(/[,\s]+/g, ' ').trim();

function metricClaims(text) {
  const clean = stripMarkup(text);
  const patterns = [
    /\b\d+(?:\.\d+)?\s?%/g,
    /\b[$€£]\s?\d[\d,.]*(?:\s?[kKmMbB])?/g,
    /\b\d+(?:\.\d+)?\s?x\b/gi,
    /\b\d[\d,.]*\+?\s?(?:users|customers|clients|employees|engineers|teams|companies|hours|days|weeks|months|years|minutes|seconds|requests|tokens|documents|workflows|pipelines|agents|interviews|applications|offers|reports|cvs|resumes|brands|stores|merchants|markets|countries|regions)\b/gi,
  ];
  const claims = new Set();
  for (const pattern of patterns) for (const m of clean.matchAll(pattern)) claims.add(normalizeClaim(m[0]));
  return claims;
}

function loadConfig(path) {
  if (!existsSync(path)) return { allow_metrics: [], forbidden_phrases: [] };
  const config = JSON.parse(readFileSync(path, 'utf-8'));
  for (const key of ['allow_metrics', 'forbidden_phrases']) {
    if (config[key] == null) config[key] = [];
    else if (!Array.isArray(config[key])) throw new Error(`${key} must be an array in ${path}`);
  }
  return config;
}

/**
 * Pure check. Returns { ok, invented: string[], forbidden: string[] }.
 * @param {string} targetText  generated document text
 * @param {string} sourceText  concatenated source-of-truth text (cv.md, profile)
 * @param {{allow_metrics?:string[], forbidden_phrases?:string[]}} config
 */
export function checkFacts(targetText, sourceText, config = {}) {
  const allowed = new Set([
    ...metricClaims(sourceText || ''),
    ...(config.allow_metrics || []).map(normalizeClaim),
  ]);
  const invented = [...metricClaims(targetText || '')].filter((c) => !allowed.has(c));
  const clean = stripMarkup(targetText || '').toLowerCase();
  const forbidden = (config.forbidden_phrases || [])
    .filter(Boolean)
    .filter((p) => clean.includes(String(p).toLowerCase()));
  return { ok: invented.length === 0 && forbidden.length === 0, invented, forbidden };
}

// ---- CLI --------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const sourceArgs = [];
  let targetArg = '', configPath = DEFAULT_CONFIG;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') sourceArgs.push(args[++i]);
    else if (a === '--config') configPath = args[++i];
    else if (a === '--help' || a === '-h') { targetArg = ''; break; }
    else if (a.startsWith('--')) { console.error(`unknown option: ${a}`); process.exit(1); }
    else if (!targetArg) targetArg = a;
  }
  if (!targetArg) {
    console.log('Usage: node verify-cv-facts.mjs <generated> [--source path]... [--config path]');
    process.exit(1);
  }
  const resolve = (p) => (isAbsolute(p) ? p : join(process.cwd(), p));
  const read = (p) => (existsSync(resolve(p)) ? readFileSync(resolve(p), 'utf-8') : '');
  if (!existsSync(resolve(targetArg))) { console.error(`target not found: ${targetArg}`); process.exit(1); }
  const sources = sourceArgs.length ? sourceArgs : DEFAULT_SOURCES;
  const cfg = loadConfig(resolve(configPath));
  const r = checkFacts(read(targetArg), sources.map(read).join('\n'), cfg);
  if (r.ok) { console.log(`CV fact check passed: ${basename(targetArg)}`); process.exit(0); }
  console.error(`CV fact check FAILED: ${basename(targetArg)}`);
  if (r.invented.length) { console.error('\nMetric-like claims absent from sources:'); r.invented.forEach((c) => console.error(`  - ${c}`)); }
  if (r.forbidden.length) { console.error('\nForbidden phrases:'); r.forbidden.forEach((p) => console.error(`  - ${p}`)); }
  console.error('\nAdd real evidence to cv.md/profile.yml, or allow-list a verified exception in config/cv-facts.json.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
