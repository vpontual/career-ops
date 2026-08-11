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
import { fileURLToPath, pathToFileURL } from 'url';
import { greenhouseRef } from './lib/branded-boards.mjs';

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
// An OPTION is not a QUESTION. The Ashby reader emits each radio option as its
// own field when it cannot find the group's legend, and CANON was then matched
// against the option text. On four real packs that produced, verbatim:
//
//   | White (Not Hispanic or Latino)          | Hispanic or Latino            |
//   | Black or African American (Not ...)     | Hispanic or Latino            |
//   | I identify as one or more of the        | I am not a protected veteran  |
//   |   classifications of protected veteran  |                               |
//   | Yes, I have a disability, or have had   | No, I do not have a           |
//   |   one in the past                       |   disability ...              |
//
// Followed as written, that ticks every race box, affirms protected-veteran
// status and declares a disability — on a federally regulated form. An option
// label is never auto-answered. The few affirmative checkboxes where VP has a
// definite standing policy are marked `optionSafe` and are the only exceptions.
function isOptionLabel(label) {
  return /\((?:not\s+)?hispanic or latino\)/i.test(label)
    || /^i\s+(identify|am not|do not|don'?t|have|decline|prefer not|wish)/i.test(label)
    || /^(?:decline|prefer not)\s+to\s+(?:self.?identify|answer|say)/i.test(label)
    || /^i do not wish/i.test(label)
    || /^(?:yes|no)[,;]?\s+i\b/i.test(label);
}

// A conditional follow-up to an option that was not selected. Not work VP owes.
function isConditional(label) {
  return /^if\b/i.test(label) || /if\s+(?:you\s+)?(?:selected|answered|chose|checked)/i.test(label)
    || /if\s+["“]?other/i.test(label);
}

// `from` names the heading or bullet in application-defaults.md this comes from,
// so an answer is traceable to VP's own file rather than invented here.
//
// NOTE: no personal detail is written literally in this file — it is a public
// fork and the pre-commit secret check rightly refuses it. Anything identifying
// is a `lookup` resolved at runtime from the gitignored application-defaults.md.
const CANON = [
  // ── affirmative checkboxes with a standing policy (option-safe) ──────────
  // "Yes, I will require <Company> to sponsor my employment". The old regex
  // wanted the NOUN "sponsorship" and this phrasing uses the verb, so it fell
  // through to a gap on every Ashby form that asks this way.
  { re: /\b(?:require|need)\b[^?]*\bsponsor(?:ship)?\b|sponsorship (?:now|in the future)|visa sponsorship|sponsor (?:my|your) employment/i,
    answer: 'No', from: 'Work authorization', optionSafe: true },
  // "Yes, I'm based in this location and able to work from the office 3 days per
  // week". Old regex required in-office/on-site/hybrid adjacent to a day word.
  { re: /\b(?:in[-\s]?office|on[-\s]?site|hybrid|from the office)\b[^?]*(?:day|week|requirement)|days? (?:a|per) week[^?]*office|office \d+ days?|acknowledge[^?]*office|based in this location/i,
    answer: 'Yes', from: 'Open to hybrid? Yes', optionSafe: true },

  // ── work authorization ───────────────────────────────────────────────────
  { re: /authoriz(?:ed|ation)[^?]*\b(?:work|employment)\b|legally (?:able|authorized) to work|right to work/i,
    answer: 'Yes', from: 'Work authorization' },
  { re: /what country[^?]*(?:based|located|resid)|country of (?:residence|origin)|where are you (?:based|located)/i,
    answer: 'United States', from: 'Identity' },

  // ── EEO. Race and ethnicity are TWO DIFFERENT QUESTIONS and this had them
  //    inverted: /\brace\b|ethnicit/ answered BOTH with "White", so "What is
  //    your ethnicity?" came back White. VP's recorded rule is flagged "get this
  //    right": ethnicity -> Hispanic or Latino, a separate race question -> White.
  { re: /ethnicit|are you hispanic|hispanic or latino\?/i,
    answer: 'Hispanic or Latino', from: 'EEO - ethnicity' },
  { re: /\brace\b|racial/i, answer: 'White', from: 'EEO - race' },
  { re: /\bgender\b|gender identity/i,
    answer: 'Male (on Man/Woman/Non-Binary forms: Man)', from: 'EEO' },
  { re: /pronoun/i, answer: '_leave blank; if forced, he/him_', from: 'EEO' },
  { re: /veteran/i, answer: 'I am not a protected veteran', from: 'EEO' },
  { re: /disabilit/i,
    answer: 'No, I do not have a disability and have not had one in the past', from: 'EEO' },
  { re: /transgender/i, answer: 'No', from: 'EEO' },

  // ── identity ─────────────────────────────────────────────────────────────
  // Name fields, most specific first. "Legal First and Last Name" must join both
  // halves; it used to fall to token overlap, where "Legal first name" and
  // "Legal last name" tie at 1.00 and the first one wins — hence "Vitor" as a
  // full legal name, and "Vitor" again for "Preferred Last Name".
  { re: /first and last name|full (?:legal )?name|^legal name$|^name$|^full name/i,
    lookup: /^legal first name/i, join: /^legal last name/i, from: 'Identity' },
  { re: /\b(?:last|family|sur)\s?name\b/i, lookup: /^legal last name/i, from: 'Identity' },
  { re: /^preferred name$|preferred (?:first )?name|nickname|goes by/i,
    lookup: /^preferred name/i, from: 'Identity' },
  { re: /\b(?:first|given)\s?name\b/i, lookup: /^legal first name/i, from: 'Identity' },
  // Country code before phone: "Please select your Country Phone Code" was
  // answered with the full phone number on five packs.
  { re: /country[^?]*(?:phone|dial|calling)? ?code|phone country code|dial(?:ling)? code/i,
    lookup: /^country code/i, from: 'Identity' },
  { re: /^e-?mail|email address/i, lookup: /email.*canonical|email.*ats|^email/i, from: 'Identity' },
  { re: /(?:mobile|cell|phone) ?(?:number)?$|telephone/i, lookup: /^phone/i, from: 'Identity' },
  { re: /^(?:street )?address|address line/i, lookup: /^street address/i, from: 'Identity' },
  { re: /^city$|city and state|city, ?state|where do you (?:live|reside)|city.*reside/i,
    lookup: /^current city$|^current city \(/i, from: 'Identity' },
  { re: /linkedin/i, lookup: /linkedin/i, from: 'Identity' },
  { re: /\b(?:website|portfolio|personal site)\b/i, lookup: /website|portfolio/i, from: 'Identity' },

  // ── education. application-defaults.md had NO education section until
  //    2026-08-06, so every one of these came back as a gap VP had to fill by
  //    hand while the answers sat in cv.md.
  { re: /highest (?:level of )?education|education level|highest degree/i,
    lookup: /^highest level of education/i, from: 'Education' },
  { re: /field of study|major\b|concentration/i, lookup: /^field of study/i, from: 'Education' },
  { re: /graduation year|year (?:of )?graduat|when did you graduate/i,
    lookup: /^graduation year/i, from: 'Education' },
  { re: /\bundergraduate\b[^?]*(?:school|university|college)/i,
    lookup: /^undergraduate school/i, from: 'Education' },
  { re: /\bdegree\b/i, lookup: /^degree:?$|^degree\b/i, from: 'Education' },
  { re: /university|college|school attended|alma mater|educational background|school name/i,
    lookup: /^university \/ school attended/i, from: 'Education' },

  // ── logistics ────────────────────────────────────────────────────────────
  // "Current or Most Recent Employer" — the old regex needed "current employer"
  // adjacent, so this common phrasing missed and became a gap.
  { re: /current(?:ly)?\s+(?:or\s+most\s+recent\s+)?(?:employer|company|employed)|most recent employer|present employer|who (?:is|was) your (?:current|most recent) employer/i,
    lookup: /^current or most recent employer/i, from: 'Education' },
  { re: /how did you hear about/i,
    answer: 'Company website / job board', from: 'How did you hear about us?' },
  { re: /consent[^?]*(?:process|privacy|personal (?:data|information))|privacy (?:policy|notice)|data protection/i,
    answer: 'Yes', from: 'standard consent' },
  { re: /relocat/i, answer: 'No - already NYC-based', from: 'Logistics' },
  { re: /(?:available |earliest )?start date|when (?:can|could|would) you (?:start|begin)|availability to start/i,
    answer: 'Two weeks notice from offer acceptance', from: 'Logistics' },
  { re: /notice period/i, answer: 'None (independent consultant)', from: 'Logistics' },

  // ── comp. Expectations are answerable; HISTORY is not. The old table
  //    answered salary history with "Decline to answer", which contradicts VP's
  //    recorded rule ("i dont usually like making the conscious choice of
  //    'decline to answer'" — leave identity/comp history blank instead). There
  //    is deliberately no entry for salary history: it falls through to a gap.
  { re: /(?:desired|expected|target|requested)[^?]*(?:salary|compensation)|salary expectation|compensation expectation/i,
    lookup: /^target base salary/i, from: 'Target base salary' },
];

function canonMatch(label, defaults) {
  // A conditional follow-up is never answered from defaults.
  if (isConditional(label)) return null;
  const opt = isOptionLabel(label);
  for (const c of CANON) {
    if (opt && !c.optionSafe) continue;   // an option is not a question
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

// Words whose PRESENCE in the question is discriminating: a default that does
// not carry the same one cannot answer it, however much else overlaps. Without
// this, "Preferred name" answered "Preferred LAST name" — which is how VP got a
// legal name of "Vitor Vitor" on a live Ashby form.
const DISCRIMINATING = [
  ['first', 'given'],
  ['last', 'family', 'surname'],
  ['middle'],
  ['country'],          // "Country Phone Code" is not "Phone"
  ['current', 'present'],
  ['expected', 'desired', 'target'],
  ['undergraduate'],
  ['graduate'],
  ['previous', 'prior', 'former'],
];

function discriminatorMismatch(q, d) {
  for (const group of DISCRIMINATING) {
    const inQ = group.some((w) => q.has(w));
    const inD = group.some((w) => d.has(w));
    if (inQ && !inD) return true;
  }
  return false;
}

// Question shapes a lookup table cannot answer, whatever the token overlap.
// "Do you have any experience with GitHub Actions?" shares every content word
// with the "GitHub" default and is not asking for a URL.
const NOT_A_LOOKUP = [
  /\b(experience|familiar|proficien|comfortable|worked with|knowledge of)\b/i,
  /^(how many|how much|how would you|why|describe|tell us|explain|what makes)/i,
  /\?$/,   // only in combination with the above — see bestMatch
];

function bestMatch(label, defaults) {
  const t = tokenize(label);
  if (!t.size) return null;

  // FAIL CLOSED. This scored `hit / Math.min(question, default)`, so any default
  // whose tokens were a SUBSET of the question scored exactly 1.00 — the maximum
  // — no matter how much of the question it ignored. Measured against VP's real
  // defaults file, that produced, all at confidence 1.00:
  //
  //   "Preferred Last Name"                        -> his FIRST name
  //   "How many years ... managing direct reports" -> 18 (his total PM tenure)
  //   "experience with GitHub Actions?"            -> his GitHub profile URL
  //   "Please select your Country Phone Code"      -> his phone number
  //
  // and every generated file closed with "a question with no confident match is
  // left explicitly blank rather than guessed". No threshold reaches a defect
  // that scores 1.00; the shape of the algorithm is wrong. Three guards now
  // apply, and a question that survives none of them is an honest gap.
  const asksAboutExperience = NOT_A_LOOKUP.slice(0, 2).some((re) => re.test(label));
  if (asksAboutExperience) return null;

  let best = null;
  for (const d of defaults) {
    if (!d.tokens.size) continue;
    if (discriminatorMismatch(t, d.tokens)) continue;

    let hit = 0;
    for (const x of t) if (d.tokens.has(x)) hit++;
    if (!hit) continue;

    // Coverage of the FORM's question, which is the thing being answered. A
    // default that speaks to two of six words in the question does not know the
    // answer, whatever fraction of ITSELF is matched.
    const coverage = hit / t.size;
    // And the default must not be wildly broader than what it matched, or a
    // one-word default wins every question containing that word.
    const specificity = hit / d.tokens.size;
    if (coverage < 0.6 || specificity < 0.5) continue;

    const score = Math.min(coverage, specificity);
    if (!best || score > best.score) best = { d, score };
  }
  return best;
}

// ── Form readers ──────────────────────────────────────────────────────────
// greenhouseRef and the branded-host map now live in lib/branded-boards.mjs.
// Three files carried their own copy and they had already drifted - fetch-jds
// knew six hosts, this file five, stage-applications four - so a card could sit
// "form not enumerable" with no answers.md while the Greenhouse board API
// returned the full question list for that exact requisition. Abnormal Security
// and Betterment were both in that state on 2026-08-06.

async function readGreenhouse(url) {
  const ref = greenhouseRef(url);
  if (!ref) return null;
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.id}?questions=true`,
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
// Some boards - Workday, and the vanity domains that front a Workday tenant -
// render no inputs at all on the job page: the application only begins after an
// account step. An empty read there is not evidence of a wall, it is the absence
// of evidence, and the two are indistinguishable from a nav timeout, a 404, a
// bot block or a broken browser. So we do NOT infer a wall from an empty read.
// We follow the board's own apply path and let looksLikeLoginWall fire on fields
// we actually observed. If the page is dead or the browser is broken this yields
// nothing and the card still fails loudly, which is the point.
function applyStepUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '') + '/apply/applyManually';
    return u.toString();
  } catch { return null; }
}

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
      const radioGroups = new Map();

      const labelFor = (el) => {
        const id = el.getAttribute('id');
        if (id) {
          const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (l && l.innerText.trim()) return l.innerText;
        }
        const al = el.getAttribute('aria-labelledby');
        if (al) {
          const n = document.getElementById(al);
          if (n && n.innerText.trim()) return n.innerText;
        }
        return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
      };

      // Ashby puts the QUESTION in a sibling of the option list rather than in a
      // <legend>, so a radio's own label is the OPTION text. Reading those as
      // fields turned one three-way question into three separate "fields" - and
      // the relocation question came out as three contradictory answers. Walk up
      // to the group container and take its heading instead.
      const groupQuestion = (el) => {
        let n = el;
        for (let i = 0; i < 6 && n; i++) {
          n = n.parentElement;
          if (!n) break;
          const fs = n.querySelector(':scope > legend, :scope > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > p, :scope > div[class*="label" i], :scope > div[class*="title" i]');
          if (fs && fs.innerText.trim() && fs.innerText.trim().length > 3) return fs.innerText;
          if (n.getAttribute && n.getAttribute('role') === 'radiogroup') {
            const al = n.getAttribute('aria-labelledby');
            if (al) { const x = document.getElementById(al); if (x) return x.innerText; }
          }
        }
        return '';
      };

      for (const el of document.querySelectorAll('input, textarea, select')) {
        const type = (el.getAttribute('type') || el.tagName).toLowerCase();
        if (['hidden', 'submit', 'button'].includes(type)) continue;

        if (type === 'radio' || type === 'checkbox') {
          const key = el.getAttribute('name') || groupQuestion(el) || 'ungrouped';
          if (!radioGroups.has(key)) {
            radioGroups.set(key, {
              label: (groupQuestion(el) || key).replace(/\s+/g, ' ').trim(),
              required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
              type: 'choice',
              options: [],
            });
          }
          const opt = (labelFor(el) || '').replace(/\s+/g, ' ').trim();
          if (opt) radioGroups.get(key).options.push(opt);
          continue;
        }

        const label = (labelFor(el) || '').replace(/\s+/g, ' ').trim().replace(/\*$/, '').trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push({
          label,
          required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
          type,
          options: el.tagName === 'SELECT'
            ? [...el.querySelectorAll('option')].map(o => o.innerText.trim()).filter(Boolean).slice(0, 12)
            : [],
        });
      }

      for (const g of radioGroups.values()) {
        if (!g.label || seen.has(g.label)) continue;
        seen.add(g.label);
        out.push(g);
      }
      return out;
    });
  } finally {
    await browser.close();
  }
}

// ── Persisting the reading ────────────────────────────────────────────────
// The field list was the most expensive thing this script produced and the only
// place it survived was as a markdown TABLE in answers.md — prose, for a human.
// So stage-applications, which has to decide whether a cover letter is wanted,
// could not use the very reading that answers the question, and said "could not
// be determined for this ATS" about 72 of 104 pending cards. It is now written
// as data next to answers.md; lib/cover-letter-requirement.mjs reads it.
//
// It records `how` and the date, because "we read this form" and "we could not
// read this form" must stay distinguishable later, and an undated claim about a
// form is not checkable.
async function writeFormFields(slug, { loginWall, how, fields }) {
  await writeFile(path.join(OUT, slug, 'form-fields.json'), JSON.stringify({
    inspectedOn: today(),
    how: how || null,
    loginWall: !!loginWall,
    fields: (fields || []).map((f) => ({
      label: f.label, required: f.required === true, type: f.type || null,
    })),
  }, null, 2));
}

// ── Rendering ─────────────────────────────────────────────────────────────
function renderAnswers(card, fields, defaults, how) {
  // ONE pass. requiredGaps used to be computed by re-running canonMatch and
  // bestMatch over every field a second time, so the header count and the table
  // could disagree whenever either function changed.
  const decided = fields.map((f) => {
    const label = f.label;
    if (/resume|cv\b|cover letter/i.test(label)) {
      return { f, kind: 'attach', text: '_attached from the pack_' };
    }
    if (isConditional(label)) {
      return { f, kind: 'na', text: '_N/A — conditional on an option not selected_' };
    }
    const c = canonMatch(label, defaults);
    if (c) return { f, kind: 'canon', text: c.answer, from: c.from };
    const m = bestMatch(label, defaults);
    if (m) return { f, kind: 'match', text: m.d.value || '', d: m.d };
    return { f, kind: 'gap' };
  });

  // An affirmative checkbox states a claim; the answer is whether to TICK it.
  // Printing "No" beside "Yes, I will require sponsorship" invites the opposite
  // of the intended action.
  const asCheckbox = (label, answer) => {
    if (!/^(?:yes|no)[,;]?\s+i\b|^i\s+(?:am|will|have|acknowledge|confirm|agree)\b/i.test(label)) return null;
    if (/^no\b/i.test(answer)) return '**Leave UNCHECKED** — the answer is No';
    if (/^yes\b/i.test(answer)) return '**Tick this box** — the answer is Yes';
    return null;
  };

  const rows = [];
  let mapped = 0, gaps = 0, requiredGaps = 0;
  for (const d of decided) {
    const req = d.f.required ? '**yes**' : 'no';
    if (d.kind === 'gap') {
      gaps++;
      if (d.f.required) requiredGaps++;
      rows.push(`| ${d.f.label} | ${req} | ⚠ **NO DEFAULT — VP to answer** |`);
      continue;
    }
    mapped++;
    let cell = d.text;
    if (d.kind === 'canon') {
      cell = asCheckbox(d.f.label, d.text) ?? d.text;
      const opts = d.f.options?.length ? ` <br/>_options: ${d.f.options.join(' · ').slice(0, 160)}_` : '';
      cell += `${opts} <br/>_via application-defaults.md → ${d.from}_`;
    } else if (d.kind === 'match') {
      const rule = d.d.rules.length ? ` <br/>_${d.d.rules[0].replace(/\|/g, '/')}_` : '';
      cell = (d.text || '_(blank by default)_') + rule;
    }
    rows.push(`| ${d.f.label} | ${req} | ${cell} |`);
  }

  const na = decided.filter((d) => d.kind === 'na').length;

  return `# ${card.company} — ${card.role}

**Apply:** ${card.applyUrl}
**ATS:** ${card.ats || 'unknown'} · **Form inspected: ${today()}** — read via ${how}.
**Fields:** ${fields.length} · answered ${mapped - na} · N/A ${na} · gaps ${gaps} (${requiredGaps} required)

${requiredGaps > 0
  ? `> ⚠ **${requiredGaps} required field${requiredGaps === 1 ? ' has' : 's have'} no default.** Answer ${requiredGaps === 1 ? 'it' : 'them'} before submitting; everything else is prefilled below.`
  : `> Every required field has an answer. Nothing is blocking submission.`}

| Field | Required | Answer |
|---|---|---|
${rows.join('\n')}

---

_Generated by generate-answers.mjs from application-defaults.md._

_The matcher fails CLOSED: a question is answered only by the hand-written CANON
table or by a token match that covers the question and is specific to it. Anything
else is written as a gap. It does not answer radio OPTION labels — self-identifying
an option row is how a table came to instruct ticking every race box — and it does
not answer "do you have experience with X" from a lookup table._

_This is a matcher, not a reader. Check anything that matters before you submit;
it has been wrong before, at maximum confidence, and the cases it got wrong are
pinned in test-answers-matcher.mjs._
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
    if ((!fields || !fields.length) && !NO_BROWSER) {
      const step = applyStepUrl(url);
      if (step) {
        try {
          const viaApply = await readRendered(step);
          if (viaApply && viaApply.length) {
            fields = viaApply;
            how = "the board's own account step";
          }
        } catch (e) {
          console.log(`[${i}] apply-step read failed for ${c.slug}: ${String(e.message).slice(0, 70)}`);
        }
      }
    }
    if (fields && looksLikeLoginWall(fields)) {
      // Record the finding rather than a fabricated field list.
      if (!DRY) {
        await mkdir(path.join(OUT, c.slug), { recursive: true });
        await writeFormFields(c.slug, { loginWall: true, how: null, fields: [] });
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
      await writeFormFields(c.slug, { loginWall: false, how, fields });
      await writeFile(path.join(OUT, c.slug, 'answers.md'), md);
    }
    ok++;
    const gaps = (md.match(/NO DEFAULT/g) || []).length;
    console.log(`[${i}] ${c.slug} — ${fields.length} fields, ${gaps} gap(s) [${how}]`);
  }

  console.log(`\nwrote ${ok}, could not enumerate ${failed}${DRY ? ' (dry run, nothing saved)' : ''}`);
};

// Import-safe: running the nightly form-filler must be an explicit invocation, not
// a side effect of `import`. Same guard as tailor-cv.mjs. Without it the matcher
// cannot be tested, which is the reason it went unmeasured for as long as it did.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}

// Exported for test-answers-matcher.mjs. These are the functions that decide what
// goes into a live employer form; they are not helpers.
export { loadDefaults, tokenize, canonMatch, bestMatch, renderAnswers, CANON, isNoise, applyStepUrl, looksLikeLoginWall };
