#!/usr/bin/env node
// tailor-cv.mjs - render a per-role tailored CV PDF for a staged role.
//
// For each role under output/{slug}/, picks the right CV variant from
// cv-variants/ (auto-classified from JD content unless overridden by
// output/{slug}/cv-variant.txt) and renders the variant md to
// output/{slug}/cv.pdf using the same htmlForCv template as
// stage-applications.mjs.
//
// usage:
//   node tailor-cv.mjs <slug>           - tailor one role
//   node tailor-cv.mjs --all            - tailor every staged role
//   node tailor-cv.mjs <slug> --variant ai-infra  - force a variant
//   node tailor-cv.mjs <slug> --dry-run - show pick, do not render

import { readFile, readdir, writeFile, mkdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { renderCvHtml } from './lib/render.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(ROOT, 'output');
const VARIANTS_DIR = path.join(ROOT, 'cv-variants');
const JDS_DIR = path.join(ROOT, 'jds');
const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
const DEFAULT_VARIANT = 'ai-product';

// Keyword-based classifier. Order matters: first match wins.
// Tune this when adding new variants under cv-variants/.
const ARCHETYPES = [
  {
    name: 'ai-infra',
    keywords: [
      'developer platform', 'developer tools', 'infrastructure', 'vector database',
      'embeddings', 'reranking', 'retrieval', 'observability', 'evaluation',
      'agent runtime', 'system design', 'API design', 'platform strategy',
      'inference', 'prompt regression', 'eval', 'safety research', 'model behavior',
      'agent platform', 'AI platform', 'LangSmith', 'pinecone', 'vector'
    ]
  },
  {
    name: 'ai-enterprise',
    keywords: [
      'enterprise', 'B2B', 'GTM', 'go-to-market', 'customer success', 'governance',
      'RBAC', 'access control', 'permissions', 'forward deployed', 'enterprise integration',
      'enterprise customers', 'enterprise AI', 'agent governance', 'integration',
      'enterprise-grade', 'fortune 500', 'CIO', 'compliance', 'data governance'
    ]
  },
  {
    name: 'pmm',
    keywords: [
      'product marketing', 'positioning', 'messaging', 'competitive intelligence',
      'competitive landscape', 'launch strategy', 'go-to-market strategy',
      'buyer persona', 'customer education', 'evangelism', 'thought leadership',
      'product storytelling', 'analyst relations', 'win/loss', 'value proposition'
    ]
  },
  {
    name: 'ai-consumer',
    keywords: [
      'consumer product', 'consumers', 'millions of people', 'consumer AI',
      'mass market', 'end user', 'engagement', 'retention', 'daily active'
    ]
  }
  // Default fallback handled below as 'ai-product'
];

export function classifyArchetype(jdContent) {
  const text = jdContent.toLowerCase();
  // A product marketing role is decided by its title, not by keyword mass.
  // PMM postings are dense in enterprise/GTM vocabulary and would otherwise
  // out-score into ai-enterprise and ship a PM-flavoured CV. The JD files put
  // the title on the first line, so look only at the head.
  if (/product marketing/.test(text.slice(0, 300))) return 'pmm';
  // Same reasoning for teaching roles: a school posting is dense in program /
  // leadership vocabulary and would otherwise classify as a product variant.
  if (/\b(teacher|teaching|instructor|lecturer|adjunct|faculty|educator)\b/.test(text.slice(0, 300))) return 'teaching';
  // Score each archetype by keyword hits, pick the highest non-zero score.
  const scores = ARCHETYPES.map(a => ({
    name: a.name,
    score: a.keywords.reduce((n, k) => n + (text.includes(k.toLowerCase()) ? 1 : 0), 0)
  }));
  scores.sort((a, b) => b.score - a.score);
  if (scores[0].score === 0) return DEFAULT_VARIANT;
  return scores[0].name;
}

async function findJdForUrl(url) {
  try {
    const files = await readdir(JDS_DIR);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const text = await readFile(path.join(JDS_DIR, f), 'utf-8');
      if (text.includes(url)) return text;
    }
  } catch {}
  return '';
}

async function pickVariant(slug, override) {
  if (override) return override;
  // Manual override file wins
  try {
    const v = (await readFile(path.join(OUTPUT_DIR, slug, 'cv-variant.txt'), 'utf-8'))
      .split('\n').map(l => l.trim()).filter(Boolean)[0];
    if (v) return v;
  } catch {}
  // Auto-classify from JD - return null if no cover letter (not a real staged role)
  let coverMd;
  try {
    coverMd = await readFile(path.join(OUTPUT_DIR, slug, 'cover-letter.md'), 'utf-8');
  } catch {
    return null;
  }
  const url = (coverMd.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1];
  if (!url) return DEFAULT_VARIANT;
  const jd = await findJdForUrl(url);
  if (!jd) return DEFAULT_VARIANT;
  return classifyArchetype(jd);
}

// htmlForCv now lives in the shared lib/render.mjs (renderCvHtml).

async function renderPdf(html, outPath, browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: outPath,
    format: 'Letter',
    margin: { top: '0.6in', bottom: '0.6in', left: '0.7in', right: '0.7in' }
  });
  await ctx.close();
}

async function tailorOne(slug, browser, opts = {}) {
  const slugDir = path.join(OUTPUT_DIR, slug);
  try { await stat(slugDir); } catch {
    return { slug, error: 'no output dir' };
  }
  const variant = await pickVariant(slug, opts.variant);
  if (!variant) return { slug, skipped: 'no cover-letter.md (not a staged role)' };
  const variantPath = path.join(VARIANTS_DIR, `cv-${variant}.md`);
  let cvMd;
  try {
    cvMd = await readFile(variantPath, 'utf-8');
  } catch {
    return { slug, error: `variant cv-${variant}.md not found` };
  }
  if (opts.dryRun) {
    return { slug, variant, dryRun: true };
  }
  const outPdf = path.join(slugDir, 'cv.pdf');
  await renderPdf(renderCvHtml(cvMd), outPdf, browser);
  // Record what was used so the choice is auditable
  await writeFile(path.join(slugDir, 'cv-variant.txt'), variant + '\n');
  return { slug, variant, written: outPdf };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: tailor-cv.mjs <slug> | --all  [--variant <name>] [--dry-run]');
    process.exit(2);
  }
  const variantIdx = args.indexOf('--variant');
  const variantOverride = variantIdx >= 0 ? args[variantIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');

  const slugs = all
    ? (await readdir(OUTPUT_DIR, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
    : [args[0]];

  const browser = dryRun ? null : await chromium.launch({ args: ['--no-sandbox'] });
  for (const slug of slugs) {
    const r = await tailorOne(slug, browser, { variant: variantOverride, dryRun });
    if (r.error) console.log(`[ERR ] ${slug}: ${r.error}`);
    else if (r.skipped) console.log(`[SKIP] ${slug}: ${r.skipped}`);
    else if (r.dryRun) console.log(`[PICK] ${slug}: ${r.variant}`);
    else console.log(`[OK  ] ${slug}: variant=${r.variant}`);
  }
  if (browser) await browser.close();
}

// Only run the CLI when invoked directly, so stage-applications.mjs can import
// classifyArchetype without firing main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
