#!/usr/bin/env node

/**
 * generate-answers.mjs — turn a scored card into a filled-in application.
 *
 * This was the missing half. The nightly chain produced a scored card and a
 * tailored CV, and then stopped: `answers.md` was written BY HAND. Nothing in
 * the pipeline created one, `ready-check.py` requires one, and so 32 of 48 cards
 * sat permanently "incomplete". VP's actual finish line is "open the application
 * and fill out all the info", and without this step nothing filled anything.
 *
 * Two ways to read a form:
 *   greenhouse — the board API answers it for free and authoritatively
 *                (?questions=true returns every field with a `required` flag).
 *                No browser, no rate limit, no guessing.
 *   everything else — the field list only exists in the rendered page, so this
 *                falls back to a real browser (same approach as inspect-form.mjs).
 *
 * Answers come from application-defaults.md, which is VP's own file and is
 * gitignored. A question with no confident match is written as an explicit gap
 * rather than filled with a guess - a wrong answer on a real application is far
 * worse than a blank one, and VP is the one who submits.
 *
 * Usage: node generate-answers.mjs [--slug X] [--limit N] [--no-browser] [--dry-run]
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const DEFAULTS = path.join(ROOT, 'application-defaults.md');
const OUT = path.join(ROOT, 'output');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_BROWSER = args.includes('--no-browser');
const ONLY = (() => { const i = args.indexOf('--slug'); return i >= 0 ? args[i + 1] : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : null; })();

const today = () => new Date().toISOString().slice(0, 10);

// ── VP's answers ──────────────────────────────────────────────────────────
// application-defaults.md is prose with `- **Question:** answer` bullets and
// indented "Rule:" lines that qualify them. Both are kept: the rule is often the
// part that matters (e.g. SMS contact is ALWAYS no).
async function loadDefaults() {
  let raw = '';
  try { raw = await readFile(DEFAULTS, 'utf-8'); } catch { return []; }
  const out = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+\*\*(.+?):?\*\*\s*(.*)$/);
    if (!m) continue;
    const label = m[1].trim();
    let value = m[2].trim();
    const rules = [];
    for (let j = i + 1; j < lines.length && /^\s{2,}/.test(lines[j]); j++) {
      const r = lines[j].trim().replace(/^-\s*/, '');
      if (r) rules.push(r);
    }
    out.push({ label, value, rules, tokens: tokenize(label) });
  }
  return out;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'are', 'is', 'do',
  'you', 'your', 'please', 'this', 'that', 'we', 'our', 'with', 'and', 'or', 'if', 'what',
  'have', 'has', 'been', 'will', 'would', 'any', 'at', 'by', 'be']);

function tokenize(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length > 2 && !STOP.has(t)));
}

// The questions every ATS asks, phrased differently every time. Token overlap
// alone missed them - "Are you authorized to work in the stated location of this
// role?" against "Authorized to work in the United States?" scores 0.5 and fell
// just under the bar, so eight required fields on a Brex form came back as gaps
// when application-defaults.md answers every one of them.
//
// `from` names the heading or bullet in application-defaults.md that this comes
// from, so the answer is traceable to VP's own file rather than invented here.
const CANON = [
  { re: /authoriz(ed|ation)[^?]*\b(work|employment)\b|legally (able|authorized) to work|right to work/i,
    answer: 'Yes', from: 'Work authorization' },
  { re: /\b(require|need)[^?]*sponsorship|sponsorship (now|in the future)|visa sponsorship/i,
    answer: 'No', from: 'Work authorization' },
  { re: /what country[^?]*(based|located|resid)|country of (residence|origin)|where are you (based|located)/i,
    answer: 'United States', from: 'Identity' },
  { re: /how did you hear about/i,
    answer: 'Company website / job board', from: 'How did you hear about us?' },
  { re: /consent[^?]*(process|privacy|personal (data|information))|privacy (policy|notice)|data protection/i,
    answer: 'Yes', from: 'standard consent' },
  { re: /relocat/i,
    answer: 'No - already NYC-based', from: 'Logistics' },
  { re: /\b(in.?office|on.?site|hybrid)\b[^?]*(day|requirement|week)|days per week[^?]*office|acknowledge[^?]*office/i,
    answer: 'Yes', from: 'Open to hybrid? Yes' },
  { re: /(available |earliest )?start date|when (can|could|would) you (start|begin)|availability to start/i,
    answer: 'Two weeks notice from offer acceptance', from: 'Logistics' },
  { re: /notice period/i,
    answer: 'None (independent consultant)', from: 'Logistics' },
  { re: /(desired|expected|target|requested)[^?]*(salary|compensation)|salary expectation|compensation expectation/i,
    lookup: /target base salary/i, from: 'Target base salary' },
  { re: /salary history/i,
    answer: 'Decline to answer', from: 'Salary history' },
  { re: /\bgender\b|gender identity/i,
    answer: 'Male (on Man/Woman/Non-Binary forms: Man)', from: 'EEO' },
  { re: /pronoun/i,
    answer: '_leave blank; if forced, he/him_', from: 'EEO' },
  { re: /veteran/i,
    answer: 'I am not a protected veteran', from: 'EEO' },
  { re: /disability/i,
    answer: 'No, I do not have a disability and have not had one in the past', from: 'EEO' },
  { re: /transgender/i, answer: 'No', from: 'EEO' },
  { re: /hispanic|latino/i, answer: 'Hispanic or Latino', from: 'EEO - ethnicity' },
  { re: /\brace\b|ethnicit/i, answer: 'White', from: 'EEO - race' },
  // NOTE: no personal detail is written literally in this file - this is a public
  // fork and the pre-commit hook rightly refuses it. Anything identifying is a
  // `lookup` resolved at runtime from application-defaults.md, which is gitignored.
  { re: /^e-?mail|email address/i, lookup: /email.*canonical|email.*ats|^email/i, from: 'Identity' },
  { re: /(mobile|cell|phone) ?(number)?$|telephone/i, lookup: /^phone/i, from: 'Identity' },
  { re: /legal name|full name|^name$/i, lookup: /legal first name/i, from: 'Identity', join: /legal last name/i },
  { re: /^(street )?address|address line/i, lookup: /street address/i, from: 'Identity' },
  { re: /^city$|city, ?state|where do you live/i, lookup: /current city/i, from: 'Identity' },
  { re: /linkedin/i, lookup: /linkedin/i, from: 'Identity' },
  { re: /\b(website|portfolio|personal site)\b/i, lookup: /website|portfolio/i, from: 'Identity' },
  { re: /currently employed|current (employer|company)/i, answer: 'Independent (self-employed)', from: 'Logistics' },
];

function canonMatch(label, defaults) {
  for (const c of CANON) {
    if (!c.re.test(label)) continue;
    if (!c.lookup) return c;
    const d = defaults.find((x) => c.lookup.test(x.label));
    if (!d || !d.value) return null;   // no default on file -> honest gap, not a guess
    let value = d.value;
    if (c.join) {
      const d2 = defaults.find((x) => c.join.test(x.label));
      if (d2 && d2.value) value = `${value} ${d2.value}`;
    }
    return { ...c, answer: value };
  }
  return null;
}

function bestMatch(label, defaults) {
  const t = tokenize(label);
  if (!t.size) return null;
  let best = null;
  for (const d of defaults) {
    if (!d.tokens.size) continue;
    let hit = 0;
    for (const x of t) if (d.tokens.has(x)) hit++;
    // Jaccard-ish, biased toward covering the FORM's question rather than the
    // default's label, since defaults are often phrased more fully.
    const score = hit / Math.max(1, Math.min(t.size, d.tokens.size));
    if (score > 0.6 && (!best || score > best.score)) best = { d, score };
  }
  return best;
}

// ── Form readers ──────────────────────────────────────────────────────────
function greenhouseRef(url) {
  const u = String(url || '');
  let m = u.match(/greenhouse\.io\/([a-z0-9-]+)\/jobs\/(\d+)/i);
  if (m) return { slug: m[1], id: m[2] };
  const g = u.match(/gh_jid=(\d+)/);
  let host = '';
  try { host = new URL(u).host; } catch {}
  const branded = { 'careers.datadoghq.com': 'datadog', 'www.brex.com': 'brex', 'brex.com': 'brex',
    'stripe.com': 'stripe', 'www.stripe.com': 'stripe', 'jobs.elastic.co': 'elastic' };
  if (g && branded[host]) return { slug: branded[host], id: g[1] };
  return null;
}

async function readGreenhouse(url) {
  const ref = greenhouseRef(url);
  if (!ref) return null;
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${ref.slug}/jobs/${ref.id}?questions=true`,
    { headers: { 'User-Agent': 'career-ops/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`greenhouse HTTP ${res.status}`);
  const data = await res.json();
  return (data.questions || []).map(q => ({
    label: (q.label || '').replace(/\s+/g, ' ').trim(),
    required: q.required === true,
    type: (q.fields || [])[0]?.type || 'input',
    options: ((q.fields || [])[0]?.values || []).map(v => v.label).filter(Boolean),
  }));
}

// A rendered page hands back everything that looks like an input, and most of it
// is not the application form: raw internal field names (communicationConsent),
// placeholder strings ("Start typing..."), option labels from a radio group, and
// bare UUIDs. Writing those into answers.md produced 43 "gaps" on a form that
// actually has about a dozen real questions - which reads as unfillable when it
// is not. Worse than useless, because it hides the real gaps.
const NOISE_LABEL = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,        // a UUID used as a field id
  /^[a-z]+[A-Z][a-zA-Z]*$/,            // camelCase internal name, never a question
  /^start typing/i,
  /recaptcha|captcha/i,
  /^search/i,
  /^password$/i,
  /^\s*$/,
];

function isNoise(label) {
  return NOISE_LABEL.some((r) => r.test(label));
}

// OLAS and several district boards put the whole application behind an account.
// The scraper happily returns Username / Password / recaptcha and calls it a
// form, so every teaching card got a confidently wrong answers.md. Detect it and
// say so instead.
function looksLikeLoginWall(fields) {
  const labels = fields.map((f) => (f.label || '').toLowerCase());
  const hasPassword = labels.some((l) => /password/.test(l));
  const hasUser = labels.some((l) => /username|email|user id/.test(l));
  return hasPassword && hasUser && fields.length <= 10;
}

async function readRendered(url) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 1800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2800);
    if (await page.locator('input, textarea, select').count() < 4) {
      try { await page.locator('a[href*="apply"], button:has-text("Apply")').first().click({ timeout: 2500 }); } catch {}
      await page.waitForTimeout(2500);
    }
    return await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('input, textarea, select')) {
        const type = (el.getAttribute('type') || el.tagName).toLowerCase();
        if (['hidden', 'submit', 'button'].includes(type)) continue;
        let label = '';
        const id = el.getAttribute('id');
        if (id) {
          const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (l) label = l.innerText;
        }
        if (!label) {
          const al = el.getAttribute('aria-labelledby');
          if (al) label = (document.getElementById(al) || {}).innerText || '';
        }
        if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
        label = (label || '').replace(/\s+/g, ' ').trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push({
          label: label.replace(/\*$/, '').trim(),
          required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label),
          type,
          options: el.tagName === 'SELECT'
            ? [...el.querySelectorAll('option')].map(o => o.innerText.trim()).filter(Boolean).slice(0, 12)
            : [],
        });
      }
      return out;
    });
  } finally {
    await browser.close();
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────
function renderAnswers(card, fields, defaults, how) {
  const rows = [];
  let mapped = 0, gaps = 0;
  for (const f of fields) {
    if (/resume|cv\b|cover letter/i.test(f.label)) {
      rows.push(`| ${f.label} | ${f.required ? '**yes**' : 'no'} | _attached from the pack_ |`);
      mapped++;
      continue;
    }
    const c = canonMatch(f.label, defaults);
    if (c) {
      mapped++;
      rows.push(`| ${f.label} | ${f.required ? '**yes**' : 'no'} | ${c.answer} <br/>_via application-defaults.md → ${c.from}_ |`);
      continue;
    }
    const m = bestMatch(f.label, defaults);
    if (m) {
      mapped++;
      const rule = m.d.rules.length ? ` <br/>_${m.d.rules[0].replace(/\|/g, '/')}_` : '';
      rows.push(`| ${f.label} | ${f.required ? '**yes**' : 'no'} | ${m.d.value || '_(blank by default)_'}${rule} |`);
    } else {
      gaps++;
      rows.push(`| ${f.label} | ${f.required ? '**yes**' : 'no'} | ⚠ **NO DEFAULT — VP to answer** |`);
    }
  }
  const requiredGaps = fields.filter(f => f.required && !/resume|cv\b|cover letter/i.test(f.label) && !canonMatch(f.label, defaults) && !bestMatch(f.label, defaults)).length;

  return `# ${card.company} — ${card.role}

**Apply:** ${card.applyUrl}
**ATS:** ${card.ats || 'unknown'} · **Form inspected: ${today()}** — read via ${how}.
**Fields:** ${fields.length} · mapped ${mapped} · gaps ${gaps} (${requiredGaps} of them required)

${requiredGaps > 0
  ? `> ⚠ **${requiredGaps} required field${requiredGaps === 1 ? ' has' : 's have'} no default.** Answer ${requiredGaps === 1 ? 'it' : 'them'} before submitting; everything else is prefilled below.`
  : `> Every required field has an answer. Nothing is blocking submission.`}

| Field | Required | Answer |
|---|---|---|
${rows.join('\n')}

---

_Generated by generate-answers.mjs. Answers come from application-defaults.md.
A question with no confident match is left explicitly blank rather than guessed —
VP submits this himself, and a wrong answer is worse than an empty one._
`;
}

// ── Main ──────────────────────────────────────────────────────────────────
const main = async () => {
  const queue = JSON.parse(await readFile(QUEUE, 'utf-8'));
  const defaults = await loadDefaults();
  if (!defaults.length) {
    console.error('application-defaults.md not found or empty — cannot fill anything.');
    process.exit(1);
  }
  console.log(`loaded ${defaults.length} answers from application-defaults.md\n`);

  let cards = queue.items.filter(i => !i.decision);
  if (ONLY) cards = cards.filter(c => c.slug === ONLY);

  const todo = [];
  for (const c of cards) {
    const dir = path.join(OUT, c.slug);
    try { await stat(path.join(dir, 'answers.md')); continue; } catch {}
    todo.push(c);
  }
  const work = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.log(`${cards.length} pending, ${todo.length} without answers.md, doing ${work.length}\n`);

  let ok = 0, failed = 0;
  for (const [i, c] of work.entries()) {
    const url = c.applyUrl || c.sourceUrl;
    let fields = null, how = null;
    try {
      fields = await readGreenhouse(url);
      if (fields) how = 'the Greenhouse board API';
    } catch (e) {
      console.log(`[${i}] greenhouse read failed for ${c.slug}: ${e.message}`);
    }
    if (!fields && !NO_BROWSER) {
      try {
        fields = await readRendered(url);
        how = 'a rendered browser session';
      } catch (e) {
        console.log(`[${i}] browser read failed for ${c.slug}: ${String(e.message).slice(0, 70)}`);
      }
    }
    if (fields && looksLikeLoginWall(fields)) {
      // Record the finding rather than a fabricated field list.
      if (!DRY) {
        await mkdir(path.join(OUT, c.slug), { recursive: true });
        await writeFile(path.join(OUT, c.slug, 'answers.md'),
          `# ${c.company} — ${c.role}\n\n**Apply:** ${url}\n**ATS:** ${c.ats || 'unknown'} · ` +
          `**Form inspected: ${today()}** — the application is behind an account wall, so the ` +
          `field list cannot be read without registering.\n\n` +
          `> ⚠ **VP must create an account on this board before the form can be filled.** ` +
          `Recording that as the finding rather than guessing at fields; the login page's own ` +
          `inputs (username, password, captcha) are not the application.\n`);
      }
      ok++;
      console.log(`[${i}] ${c.slug} — behind a login wall, recorded as such`);
      continue;
    }
    if (fields) {
      const before = fields.length;
      fields = fields.filter((f) => !isNoise(f.label));
      if (before !== fields.length) console.log(`      dropped ${before - fields.length} non-question field(s)`);
    }
    if (!fields || !fields.length) {
      failed++;
      console.log(`[${i}] SKIP ${c.slug} — form not enumerable`);
      continue;
    }
    const md = renderAnswers(c, fields, defaults, how);
    if (!DRY) {
      await mkdir(path.join(OUT, c.slug), { recursive: true });
      await writeFile(path.join(OUT, c.slug, 'answers.md'), md);
    }
    ok++;
    const gaps = (md.match(/NO DEFAULT/g) || []).length;
    console.log(`[${i}] ${c.slug} — ${fields.length} fields, ${gaps} gap(s) [${how}]`);
  }

  console.log(`\nwrote ${ok}, could not enumerate ${failed}${DRY ? ' (dry run, nothing saved)' : ''}`);
};

main().catch(e => { console.error(e); process.exit(1); });
