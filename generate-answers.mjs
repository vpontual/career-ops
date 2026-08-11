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
 * ── AND a first draft for the essay questions (added 2026-08-11) ───────────
 *
 * The matcher half above answers "same question every ATS asks". It has nothing
 * to say about "Why Do You Want To Be A Product Manager for Membership Growth
 * and Development at ProPublica?", and wrote `⚠ NO DEFAULT — VP to answer`
 * against it — which is what VP saw: "why didnt any of the propublica questions
 * get answered? they were listed but not answered". Those questions ARE the work
 * of applying.
 *
 * Every field is now CLASSIFIED first (lib/answer-classify.mjs) and only the
 * OPEN-ENDED bucket is drafted (lib/answer-draft.mjs, one Gemini call per pack).
 * Address, salary, start date, EEO, work authorisation, prior employment and
 * legal attestations are on a deny list that is checked BEFORE the draft bucket,
 * and they stay blank. That ordering is the safety property; see both headers.
 *
 * answers.md now distinguishes three things it used to conflate:
 *   ✅  a real answer, from VP's own application-defaults.md
 *   ✏️  a DRAFT, written by a model from cv.md — he edits it, never pastes it
 *   ⚠  blank by design — factual, and only he can answer it
 *
 * Usage: node generate-answers.mjs [--slug X] [--limit N] [--no-browser] [--dry-run]
 *                                  [--refresh] [--no-draft] [--draft-limit N]
 *   --refresh      rewrite packs that already have an answers.md (see canRewrite)
 *   --no-draft     matcher only, no LLM call
 *   --draft-limit  cap the number of packs drafted in one run (free tier = 5 RPM)
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { greenhouseRef } from './lib/branded-boards.mjs';
import {
  classify, isNoise, isOptionLabel, isConditional, isAttachment,
  NOISE, OPTION, CONDITIONAL, ATTACHMENT, FACTUAL, OPEN_ENDED, UNKNOWN,
} from './lib/answer-classify.mjs';
import { draftPack } from './lib/answer-draft.mjs';

try {
  const { config } = await import('dotenv');
  config();
} catch {}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(ROOT, 'data', 'review-queue.json');
const DEFAULTS = path.join(ROOT, 'application-defaults.md');
const OUT = path.join(ROOT, 'output');
const JDS = path.join(ROOT, 'jds');
const VARIANTS = path.join(ROOT, 'cv-variants');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_BROWSER = args.includes('--no-browser');
const REFRESH = args.includes('--refresh');
const NO_DRAFT = args.includes('--no-draft');
const ONLY = (() => { const i = args.indexOf('--slug'); return i >= 0 ? args[i + 1] : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : null; })();
const DRAFT_LIMIT = (() => {
  const i = args.indexOf('--draft-limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : 12;
})();

const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => createHash('sha256').update(s).digest('hex');

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
//
// ⚠ isOptionLabel / isConditional / isNoise MOVED to lib/answer-classify.mjs on
// 2026-08-11 and are re-exported below, unchanged in meaning and widened in
// coverage. They now decide, alongside the draft deny list, whether a model is
// ever pointed at a field — so they belong beside that deny list, in one file
// with one test, rather than three regexes buried in a renderer.

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
  // "Yes - I consent to receiving text messages" appeared as an unanswered gap on
  // 12 packs while application-defaults.md carries a rule that could not be more
  // explicit: "ALWAYS no. Applies to every employer, every form."
  { re: /(?:receiv\w*|consent\w*|opt.?.?in|agree|like to get)[^?]{0,60}\b(?:sms|text messages?|texts|whatsapp)\b|\b(?:sms|whatsapp)\b[^?]{0,60}(?:consent|opt.?.?in|receiv)/i,
    answer: 'No', from: 'Identity - SMS/WhatsApp: ALWAYS no', optionSafe: true },

  // ⚠ FIRST, before every identity rule. "How did you hear about us? (Previous
  // or Current Employee, LinkedIn, Conference, Job board, etc)" matched the
  // LinkedIn rule and was answered with VP's LinkedIn PROFILE URL — on Nava's
  // form and everywhere else an ATS lists its channels in the label. The
  // question is unambiguous; it just has to be asked before the identity block
  // gets a chance to see the word.
  { re: /how did you hear about|where did you (?:first )?(?:hear|learn) about|how\s*\/\s*where did you first learn|how did you (?:learn|find out) about|first (?:hear|learn) about (?:this|the|us)/i,
    answer: 'Company website / job board', from: 'How did you hear about us?' },

  // ── work authorization ───────────────────────────────────────────────────
  // ⚠ `guard: 'usOnly'`. The old regex answered "Yes" to any authorisation
  // question, and the audit found "Are you legally entitled to work in Canada?"
  // among the pending packs. He is authorised in the US; that answer is not
  // transferable, and a wrong Yes here is a false statement on an application.
  // A question that names no country ("in the country where this job is based")
  // is still answered Yes — every role in the queue is US-based.
  //
  // The spelling matters too: `authoriz` alone missed "Are you legally authorised
  // to work full-time in the country where this job is based?" on four required
  // fields, purely on the British s.
  { re: /authoriz(?:ed|ation)[^?]*\b(?:work|employment)\b|authoris(?:ed|ation)[^?]*\b(?:work|employment)\b|legally (?:able|allowed|authorized|authorised|permitted|entitled) to work|right to work|eligible to work|entitled to work|permitted to work|eligible for employment/i,
    answer: 'Yes', from: 'Work authorization', guard: 'usOnly' },
  // ⚠ the lookahead is load-bearing: "Please select your Country Phone Code" is
  // a DIAL code, and answering it "United States" is the same class of defect as
  // the phone number it used to get (pinned in test-answers-matcher.mjs).
  { re: /what country[^?]*(?:based|located|resid)|country of (?:residence|origin)|country (?:in which|where) you (?:are|reside|live)|which country (?:are|do) you|(?:choose|select) (?:your|the) country(?!\s*(?:phone|dial(?:ling)?|calling)?\s*code)/i,
    answer: 'United States', from: 'Identity' },
  // Where he IS, which is a different question from which country. This used to
  // live in the country rule above and answered "United States" to "Where are you
  // physically based?" — true, and less useful than the city he actually lives in.
  { re: /where are you (?:currently |physically |presently )?(?:based|located)|what is your current location|from where do you intend to work|in what cit(?:y|ies)[^?]*(?:available|work|based)|where (?:are|do) you (?:currently )?work from/i,
    lookup: /^current city$|^current city \(/i, from: 'Identity' },

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
  // "What's the name you'd prefer us to use throughout the interview process?"
  // is the single most common unmatched gap on the pending packs (9 of them) and
  // application-defaults.md answers it in one bullet.
  { re: /^preferred name$|preferred (?:first )?name|nickname|goes by|name you'?d? (?:prefer|like)[^?]*(?:use|call)|what (?:should|shall|do) we call you|prefer(?:red)? to be (?:called|addressed)/i,
    lookup: /^preferred name/i, from: 'Identity' },
  { re: /\b(?:first|given)\s?name\b/i, lookup: /^legal first name/i, from: 'Identity' },
  // Country code before phone: "Please select your Country Phone Code" was
  // answered with the full phone number on five packs.
  { re: /country[^?]*(?:phone|dial|calling)? ?code|phone country code|dial(?:ling)? code/i,
    lookup: /^country code/i, from: 'Identity' },
  { re: /^e-?mail|email address/i, lookup: /email.*canonical|email.*ats|^email/i, from: 'Identity' },
  { re: /(?:mobile|cell|phone) ?(?:number)?$|telephone/i, lookup: /^phone/i, from: 'Identity' },
  // ── postal address. NOT a lookup: the form wants one string and the file
  //    stores four fields on two bullets ("Street address", then
  //    "City / State / Zip / Country" as a slash-delimited pair of lists). Token
  //    overlap could never assemble that, so "Current Mailing Address" — VP's
  //    address, written down, in his own file — came back as a required gap on
  //    the ProPublica pack, and "Legal Address" / "Zip Code" / "Province/State"
  //    on eleven more.
  //
  //    ⚠ Each part is addressed SEPARATELY and the composed form fires only on
  //    an explicit address qualifier (mailing / home / legal / current / full /
  //    permanent / residential / postal). A bare "City" field must keep getting
  //    the city and nothing else — which is why there is no broad
  //    /address|location/ rule here, and why `zip` is matched before `state`
  //    ("Postal/Zip Code" contains both words).
  // Line 2 is the unit number, and application-defaults.md's rule under "Street
  // address" is explicit: "apartment/unit number deliberately omitted at
  // application stage." It was being filled with a SECOND COPY of line 1.
  { re: /address line ?2|^apartment|^apt\b|^unit\b|^suite\b|apt\.?\s*\/\s*(?:unit|suite)/i,
    answer: '_leave blank — the unit number is deliberately omitted at application stage (application-defaults.md rule). If the form hard-requires it, ask VP._',
    from: 'Identity - Street address rule' },
  { re: /\bzip\b|postal ?code|post ?code/i, addr: 'zip', from: 'Identity - address' },
  { re: /^country$|^country\s*\/\s*region$|^country of residence$/i, addr: 'country', from: 'Identity - address' },
  { re: /^state$|^province|province\s*\/\s*state|state\s*\/\s*province|^state or province|which state(?: or province)? do you|in which state do you|what state (?:will|do) you\b/i,
    addr: 'state', from: 'Identity - address' },
  { re: /(?:mailing|home|legal|current|permanent|residential|full|postal)\s+address/i,
    addr: 'full', from: 'Identity - address' },
  { re: /^(?:street )?address|address line/i, lookup: /^street address/i, from: 'Identity' },
  // ⚠ TWO city questions, two answers. A bare "City" sitting beside its own
  // State and Zip fields wants the city ALONE — Fivetran's form was getting
  // "New York, NY, USA" in the City box with NY and 10011 in the two boxes next
  // to it. "What city and state do you reside in?" is the other question and
  // still gets the full "New York, NY, USA".
  { re: /^city$|^city name$|^city:?$/i, addr: 'city', from: 'Identity - address' },
  { re: /city and state|city, ?state|where do you (?:live|reside)|city.*reside/i,
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
  { re: /consent[^?]*(?:process|privacy|personal (?:data|information))|privacy (?:policy|notice)|data protection/i,
    answer: 'Yes', from: 'standard consent' },
  { re: /relocat/i, answer: 'No - already NYC-based', from: 'Logistics' },
  // ⚠ These two sit AFTER the relocation rule on purpose. "Our office is in New
  //   York — are you willing to relocate?" must answer the relocation question,
  //   not the office one.
  //
  //   Both require an explicit NYC token. "Are you open to working 3 days from
  //   one of our office hubs in NYC, NJ, CA, WA?" is a Yes because NYC is on the
  //   list; the same question about hubs in Austin and SF is NOT, and falls
  //   through to a gap. A blanket "open to hybrid → Yes" would have answered both.
  { re: /(?:office|hq|headquarters|in[- ]person|on[- ]?site|hub)\b[^?]*\b(?:nyc|new york|manhattan|soho|brooklyn)\b|\b(?:nyc|new york|manhattan|soho|brooklyn)\b[^?]*\b(?:office|hq|headquarters|in[- ]person|on[- ]?site|hub)\b/i,
    answer: 'Yes', from: 'Logistics - open to hybrid, and NYC-based' },
  { re: /(?:are|do) you\b[^?]*\b(?:currently )?(?:based|located|live|living|reside|residing)\b[^?]*\b(?:nyc|new york(?: city)?|manhattan|brooklyn|tri-?state)\b/i,
    answer: 'Yes', from: 'Identity - current city' },
  // "This job is only open to candidates in the United States or Canada. Do you
  //  live in the US or Canada?" — he does. Note this is a RESIDENCE question, not
  //  an authorisation one, so it carries no country guard: "the US or Canada"
  //  is answered Yes on the US alone.
  // ⚠ the country phrase must follow the verb IMMEDIATELY. A looser
  // `live … the US` matched "(Product & DS Hub) Do you live within 45 miles of
  // one of Socure's talent hubs in the US?" and answered Yes to a question
  // nothing on file can answer.
  { re: /(?:do|are) you\b[^?]*\b(?:live|living|reside|residing|based|located)\s+(?:in|within)\s+(?:the\s+)?(?:united states|u\.?s\.?a?\b|continental us)/i,
    answer: 'Yes', from: 'Identity - US-based' },
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

// application-defaults.md stores the address as a street bullet plus one
// slash-delimited pair ("City / State / Zip / Country" → "New York / NY / 10011 /
// United States"). Read the LABEL's slashes to name the value's slashes rather
// than assuming an order — a file that ever grows a "County" or drops "Country"
// then still parses, instead of quietly returning the zip as the state.
function addressParts(defaults) {
  const out = { street: null, city: null, state: null, zip: null, country: null };
  const street = defaults.find((d) => /^street address/i.test(d.label));
  if (street?.value) out.street = street.value;
  const compound = defaults.find((d) => /^city\s*\/\s*state/i.test(d.label));
  if (compound?.value) {
    const keys = compound.label.split('/').map((k) => k.trim().toLowerCase());
    const vals = compound.value.split('/').map((v) => v.trim());
    keys.forEach((k, i) => {
      const v = vals[i];
      if (!v) return;
      if (/^city/.test(k)) out.city = v;
      else if (/^state|^province/.test(k)) out.state = v;
      else if (/^zip|^postal/.test(k)) out.zip = v;
      else if (/^country/.test(k)) out.country = v;
    });
  }
  if (!out.city) {
    const cc = defaults.find((d) => /^current city$/i.test(d.label));
    if (cc?.value) out.city = String(cc.value).split(',')[0].trim();
  }
  return out;
}

function composeAddress(p) {
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.street, cityLine, p.country].filter(Boolean).join(', ') || null;
}

// A country other than the US, named in the question itself. "Are you legally
// entitled to work in Canada?" is not a question VP's US authorisation answers.
const FOREIGN_COUNTRY = /\b(?:canada|canadian|united kingdom|great britain|ireland|germany|france|spain|portugal|italy|netherlands|belgium|switzerland|sweden|norway|denmark|finland|poland|romania|australia|new zealand|india|singapore|japan|china|hong kong|korea|israel|brazil|mexico|argentina|chile|colombia|south africa|united arab emirates|european union|\buk\b|\bemea\b|\bapac\b)\b/i;

function mentionsForeignCountry(label) {
  return FOREIGN_COUNTRY.test(label)
    && !/\bunited states\b|\bu\.?s\.?a?\.?\b|\bamerica\b/i.test(label);
}

function canonMatch(label, defaults) {
  // A conditional follow-up is never answered from defaults.
  if (isConditional(label)) return null;
  const opt = isOptionLabel(label);
  for (const c of CANON) {
    if (opt && !c.optionSafe) continue;   // an option is not a question
    if (!c.re.test(label)) continue;
    if (c.guard === 'usOnly' && mentionsForeignCountry(label)) return null;
    if (c.addr) {
      const p = addressParts(defaults);
      const value = c.addr === 'full' ? composeAddress(p) : p[c.addr];
      if (!value) return null;           // nothing on file -> honest gap
      return { ...c, answer: value };
    }
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
//
// ⚠ The table itself now lives in lib/answer-classify.mjs (2026-08-11), widened
// with what the 114-pack audit turned up: cookie-banner switches, a store
// locator's latitude/longitude, Lever's `urls[...]`, Ashby's `cards[<uuid>]`,
// and bare lowercase HTML `name` attributes the reader found no label for.

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
//
// decide() is the whole resolution order, in one place, and the ORDER is the
// safety property:
//
//   1. not-a-question   noise / upload / conditional / option row
//   2. VP's own answer  canonMatch, then bestMatch, against application-defaults.md
//   3. the deny list    factual — address, comp, dates, EEO, work auth, prior
//                       employment, attestations. Blank BY DESIGN. Never drafted.
//   4. open-ended       an essay. The only bucket a model is pointed at.
//   5. unknown          could not be classified confidently. Blank.
//
// Step 2 before step 3 is deliberate: a mailing address is factual, and VP has
// written his down, so it is answered from HIS file rather than left blank. Step
// 3 before step 4 is the one that must never be reordered.
function decide(f, defaults, drafts = {}) {
  const label = f.label;
  const k = classify(label, f);

  if (k.bucket === NOISE) return { f, kind: 'noise' };
  if (k.bucket === ATTACHMENT) return { f, kind: 'attach', text: '_attached from the pack_' };
  if (k.bucket === CONDITIONAL) return { f, kind: 'na', text: '_N/A — conditional on an option not selected_' };

  const c = canonMatch(label, defaults);
  if (c) return { f, kind: 'canon', text: c.answer, from: c.from };
  if (k.bucket === OPTION) return { f, kind: 'option' };
  const m = bestMatch(label, defaults);
  if (m) return { f, kind: 'match', text: m.d.value || '', d: m.d };

  if (k.bucket === FACTUAL) return { f, kind: 'factual', why: k.why };
  if (k.bucket === OPEN_ENDED) {
    const d = drafts[label];
    if (d && d.text && !d.rejected) return { f, kind: 'draft', text: d.text, draft: d };
    return { f, kind: 'undrafted', why: d?.reason || null, form: k.form };
  }
  // Nothing matched it and it looks like a raw HTML `name` attribute — only NOW
  // is it safe to call it noise. See isFieldNameLabel in lib/answer-classify.mjs:
  // `name`, `email`, `phone` and `urls[LinkedIn]` reach here as real required
  // fields on three packs, and are answered above by canonMatch.
  if (k.soft === NOISE) return { f, kind: 'noise' };
  return { f, kind: 'gap' };
}

function renderAnswers(card, fields, defaults, how, drafts = {}, inspectedOn = today()) {
  // ONE pass. requiredGaps used to be computed by re-running canonMatch and
  // bestMatch over every field a second time, so the header count and the table
  // could disagree whenever either function changed.
  const decided = fields.map((f) => decide(f, defaults, drafts));

  // An affirmative checkbox states a claim; the answer is whether to TICK it.
  // Printing "No" beside "Yes, I will require sponsorship" invites the opposite
  // of the intended action.
  const asCheckbox = (label, answer) => {
    if (!/^(?:yes|no)[,;]?\s+i\b|^i\s+(?:am|will|have|acknowledge|confirm|agree)\b/i.test(label)) return null;
    if (/^no\b/i.test(answer)) return '**Leave UNCHECKED** — the answer is No';
    if (/^yes\b/i.test(answer)) return '**Tick this box** — the answer is Yes';
    return null;
  };

  // A cell must say WHICH OF THREE THINGS it is at a glance, because they carry
  // completely different instructions: paste it, edit it, or write it yourself.
  // The old file had one shape for all of them and VP read the whole table as
  // "listed but not answered".
  const cellFor = (d) => {
    switch (d.kind) {
      case 'canon': {
        const opts = d.f.options?.length ? ` <br/>_options: ${d.f.options.join(' · ').slice(0, 160)}_` : '';
        return `✅ ${asCheckbox(d.f.label, d.text) ?? d.text}${opts} <br/>_via application-defaults.md → ${d.from}_`;
      }
      case 'match': {
        const rule = d.d.rules.length ? ` <br/>_${d.d.rules[0].replace(/\|/g, '/')}_` : '';
        return `✅ ${d.text || '_(blank by default)_'}${rule}`;
      }
      case 'draft': {
        const q = d.draft.checks?.quoted?.length
          ? ` <br/>_figures quoted from the posting: ${d.draft.checks.quoted.join(', ')}_` : '';
        return `✏️ **DRAFT — edit before sending** <br/>${d.text.replace(/\s*\n\s*/g, ' <br/><br/>')}${q}`;
      }
      case 'factual':
        return `⚠ **BLANK BY DESIGN — only VP can answer** <br/>_${d.why}; a drafted answer here would be invented_`;
      case 'undrafted':
        return d.why
          ? `⚠ **NO DRAFT — VP to answer** <br/>_draft rejected: ${String(d.why).replace(/\|/g, '/')}_`
          : '⚠ **NO DRAFT — VP to answer** _(open-ended; no draft was produced)_';
      case 'option':
        return '— _an option row, not a question. Answer the group it belongs to._';
      case 'na':
      case 'attach':
        return d.text;
      default:
        return '⚠ **NO DEFAULT — VP to answer**';
    }
  };

  const rows = [];
  const tally = { answered: 0, draft: 0, blank: 0, requiredBlank: 0, na: 0, option: 0 };
  for (const d of decided) {
    if (d.kind === 'noise') continue;                 // not a field on the form
    const req = d.f.required ? '**yes**' : 'no';
    if (d.kind === 'canon' || d.kind === 'match' || d.kind === 'attach') tally.answered++;
    else if (d.kind === 'draft') tally.draft++;
    else if (d.kind === 'na') tally.na++;
    else if (d.kind === 'option') tally.option++;
    else { tally.blank++; if (d.f.required) tally.requiredBlank++; }
    rows.push(`| ${d.f.label} | ${req} | ${cellFor(d)} |`);
  }

  const shown = rows.length;
  const banner = tally.requiredBlank > 0
    ? `> ⚠ **${tally.requiredBlank} required field${tally.requiredBlank === 1 ? '' : 's'} still need${tally.requiredBlank === 1 ? 's' : ''} VP.** Everything marked ✅ is ready to paste; everything marked ✏️ is a draft to edit.`
    : `> Every required field is answered or drafted. Nothing is blocking submission — but read the ✏️ drafts before sending.`;

  return `# ${card.company} — ${card.role}

**Apply:** ${card.applyUrl}
**ATS:** ${card.ats || 'unknown'} · **Form inspected: ${inspectedOn}** — read via ${how}.
**Fields:** ${shown} shown of ${fields.length} read · ✅ answered ${tally.answered} · ✏️ drafted ${tally.draft} · ⚠ blank ${tally.blank} (${tally.requiredBlank} required) · N/A ${tally.na} · option rows ${tally.option}

${banner}

**Legend** — ✅ VP's own answer from \`application-defaults.md\`, paste as is · ✏️ a DRAFT written from \`cv.md\`, **edit it, do not paste it unread** · ⚠ blank on purpose, because guessing would be inventing.

| Field | Required | Answer |
|---|---|---|
${rows.join('\n')}

---

_Generated by generate-answers.mjs from application-defaults.md, cv.md and the JD._

_The matcher fails CLOSED: a question is answered only by the hand-written CANON
table or by a token match that covers the question and is specific to it. Anything
else is written as a gap. It does not answer radio OPTION labels — self-identifying
an option row is how a table came to instruct ticking every race box — and it does
not answer "do you have experience with X" from a lookup table._

_✏️ DRAFTS ARE NOT ANSWERS. They are written by a language model from cv.md and
the posting, and are only produced for open-ended questions — never for an
address, a salary, a date, an EEO row, a work-authorisation status, prior
employment or a legal attestation, all of which stay blank by design. Every draft
was checked for figures and for organisations that do not appear in cv.md, and a
draft that failed either check was thrown away rather than shown. That is not a
guarantee: read every draft before it goes anywhere._

_This is a matcher, not a reader. Check anything that matters before you submit;
it has been wrong before, at maximum confidence, and the cases it got wrong are
pinned in test-answers-matcher.mjs._
`;
}

// ── The drafting half ─────────────────────────────────────────────────────
// One Gemini call per PACK (not per question) and a deliberate pause between
// packs: the key is on the free tier, which is 5 requests a minute — the same
// constraint that shapes MAX_CONCURRENT in stage-applications.mjs.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _model = null;
async function geminiModel() {
  if (_model) return _model;
  if (!process.env.GEMINI_API_KEY) return null;
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  _model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: GEMINI_MODEL });
  return _model;
}

// Same backoff as stage-applications.mjs's callGeminiWithRetry: honour the
// RetryInfo the API hands back rather than guessing at the window.
async function callGemini(prompt, maxAttempts = 5) {
  const model = await geminiModel();
  if (!model) throw new Error('GEMINI_API_KEY missing');
  let attempt = 0;
  for (;;) {
    try {
      const r = await model.generateContent(prompt);
      return r.response.text().trim();
    } catch (e) {
      attempt++;
      const msg = String(e?.message || e);
      // ⚠ retry TRANSPORT failures too, not only 429s. Three of five sample
      // packs died on a bare "Error fetching from generativelanguage.googleapis
      // .com" that succeeded on the next attempt — and because the old
      // stage-applications predicate only recognised quota errors, a one-off
      // network blip cost the pack its drafts for the night.
      const retryable = /429|Too Many Requests|quota|RetryInfo|Error fetching|fetch failed|ECONN|ETIMEDOUT|socket hang up|\b5\d\d\b/i.test(msg);
      if (!retryable || attempt >= maxAttempts) throw e;
      const m = msg.match(/retry in ([\d.]+)s/);
      const wait = m ? Math.ceil(parseFloat(m[1])) + 2 : Math.min(60, 5 * 2 ** attempt);
      console.log(`      rate-limited, sleeping ${wait}s (attempt ${attempt}/${maxAttempts})`);
      await sleep(wait * 1000);
    }
  }
}

// ── Idempotency ───────────────────────────────────────────────────────────
// Two separate promises, and they need two separate mechanisms:
//
//   "do not redraft what already has a draft" — answer-drafts.json is keyed by
//   the question text and is written BEFORE answers.md. A question already in it
//   is never sent to the model again, INCLUDING one whose draft was rejected:
//   the rejection is recorded with its reason, so a bad draft costs one call
//   ever, not one call a night.
//
//   "do not clobber an answer VP edited by hand" — answers-meta.json stores the
//   sha256 of the file we wrote. If the file on disk still hashes to that, we
//   wrote it and nobody has touched it. If it does not, he edited it and it is
//   not ours to overwrite.
//
// ⚠ HONEST LIMIT. The 213 answers.md files that predate this guard have no
// stored hash, so for those the test falls back to "does it still carry the
// generator's footer" — which cannot tell a hand-edited body from an untouched
// one. If VP has already edited one of those in place, --refresh will overwrite
// it. That is why --refresh is opt-in and the nightly does not pass it.
const GEN_MARKER = '_Generated by generate-answers.mjs';

async function canRewrite(dir) {
  let existing = null;
  try { existing = await readFile(path.join(dir, 'answers.md'), 'utf-8'); } catch { return { ok: true, why: 'no answers.md yet' }; }
  let meta = null;
  try { meta = JSON.parse(await readFile(path.join(dir, 'answers-meta.json'), 'utf-8')); } catch {}
  if (meta?.sha256) {
    return meta.sha256 === sha(existing)
      ? { ok: true, why: 'unchanged since we generated it' }
      : { ok: false, why: 'EDITED BY HAND since it was generated — leaving it alone' };
  }
  return existing.includes(GEN_MARKER)
    ? { ok: true, why: 'machine-written (predates the hash guard)' }
    : { ok: false, why: 'no generator footer — this file was written by hand' };
}

async function readOr(p, fallback = '') {
  try { return await readFile(p, 'utf-8'); } catch { return fallback; }
}

// The "Standard short-answer Q&As" section is VP's own prose for exactly this
// class of question. It is the strongest voice signal in the repo, so it goes to
// the model verbatim rather than being paraphrased into the prompt.
function shortAnswerSection(raw) {
  const m = raw.match(/^##\s+Standard short-answer Q&As[\s\S]*?(?=^##\s|\Z)/m);
  return m ? m[0] : '';
}

async function loadRoleContext(card, defaultsRaw) {
  const cv = await readOr(path.join(ROOT, 'cv.md'));
  const variant = (await readOr(path.join(OUT, card.slug, 'cv-variant.txt'), card.cvVariant || '')).trim();
  const variantCv = variant ? await readOr(path.join(VARIANTS, `cv-${variant}.md`)) : '';
  const jdText = card.scoreSource ? await readOr(path.join(JDS, card.scoreSource)) : '';
  const profile = await readOr(path.join(ROOT, 'config', 'profile.yml'));
  let cvFacts = { allow_metrics: [], forbidden_phrases: [] };
  try { cvFacts = JSON.parse(await readFile(path.join(ROOT, 'config', 'cv-facts.json'), 'utf-8')); } catch {}
  const shortAnswers = shortAnswerSection(defaultsRaw);
  return {
    company: card.company, role: card.role, cv, variantCv, shortAnswers, jdText, cvFacts,
    // What checkFacts and checkProvenance are allowed to treat as true about VP.
    // Deliberately NOT the JD: a number in the employer's posting is not a fact
    // about his history, and checkFacts is given it separately as `quoted`.
    factSource: `${cv}\n${variantCv}\n${defaultsRaw}\n${profile}`,
  };
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

  const defaultsRaw = await readOr(DEFAULTS);

  let cards = queue.items.filter(i => !i.decision);
  if (ONLY) {
    const want = new Set(ONLY.split(',').map((s) => s.trim()).filter(Boolean));
    cards = cards.filter(c => want.has(c.slug));
  }

  const todo = [];
  const held = [];
  for (const c of cards) {
    const dir = path.join(OUT, c.slug);
    let exists = false;
    try { await stat(path.join(dir, 'answers.md')); exists = true; } catch {}
    if (!exists) { todo.push(c); continue; }
    if (!REFRESH) continue;
    const g = await canRewrite(dir);
    if (g.ok) todo.push(c); else held.push(`${c.slug} — ${g.why}`);
  }
  const work = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.log(`${cards.length} pending, ${todo.length} to write${REFRESH ? ' (--refresh)' : ' without answers.md'}, doing ${work.length}`);
  for (const h of held) console.log(`  held: ${h}`);
  if (!NO_DRAFT && !process.env.GEMINI_API_KEY) {
    console.log('  ⚠ GEMINI_API_KEY missing — open-ended questions will be left blank, not drafted');
  }
  console.log('');

  let ok = 0, failed = 0, drafted = 0;
  for (const [i, c] of work.entries()) {
    const url = c.applyUrl || c.sourceUrl;
    let fields = null, how = null, inspectedOn = today(), fromCache = false;
    // On --refresh, a form we already enumerated is re-used rather than re-read.
    // A browser session per pack is the expensive part of this script, and the
    // point of a refresh is usually the MATCHER, not the form. The recorded
    // inspection date travels with it — batch/ready-check.py treats "Form
    // inspected: <date>" as evidence the live form was opened, and re-stamping
    // it with today's date on a cached read would be manufacturing that evidence.
    if (REFRESH) {
      try {
        const cached = JSON.parse(await readFile(path.join(OUT, c.slug, 'form-fields.json'), 'utf-8'));
        if (!cached.loginWall && cached.fields?.length) {
          fields = cached.fields;
          how = cached.how || 'a previous reading';
          inspectedOn = cached.inspectedOn || inspectedOn;
          fromCache = true;
        }
      } catch {}
    }
    try {
      if (!fields) fields = await readGreenhouse(url);
      if (fields && !how) how = 'the Greenhouse board API';
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

    // ── draft the open-ended questions, and ONLY those ────────────────────
    const dir = path.join(OUT, c.slug);
    let drafts = {};
    try { drafts = (JSON.parse(await readFile(path.join(dir, 'answer-drafts.json'), 'utf-8'))).drafts || {}; } catch {}

    const open = [];
    for (const f of fields) {
      const k = classify(f.label, f);
      if (k.bucket === OPEN_ENDED && !(f.label in drafts)) open.push({ label: f.label, form: k.form });
    }
    if (open.length && !NO_DRAFT && process.env.GEMINI_API_KEY) {
      if (drafted >= DRAFT_LIMIT) {
        console.log(`[${i}] ${c.slug} — ${open.length} open-ended question(s) NOT drafted (--draft-limit ${DRAFT_LIMIT} reached)`);
      } else {
        try {
          const ctx = await loadRoleContext(c, defaultsRaw);
          const fresh = await draftPack({ ...ctx, questions: open }, callGemini);
          drafts = { ...drafts, ...fresh };
          const kept = Object.values(fresh).filter((d) => !d.rejected).length;
          console.log(`[${i}] ${c.slug} — drafted ${kept}/${open.length} open-ended answer(s)`);
          for (const [q, d] of Object.entries(fresh)) {
            if (d.rejected) console.log(`      ✗ rejected "${q.slice(0, 60)}": ${d.reason}`);
          }
          if (!DRY) {
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, 'answer-drafts.json'), JSON.stringify({
              generatedOn: today(), model: GEMINI_MODEL, drafts,
            }, null, 2));
          }
          drafted++;
          await sleep(13000);        // free tier = 5 requests/minute
        } catch (e) {
          console.log(`[${i}] draft failed for ${c.slug}: ${String(e.message).slice(0, 100)}`);
        }
      }
    }

    const md = renderAnswers(c, fields, defaults, how, drafts, inspectedOn);
    if (!DRY) {
      await mkdir(dir, { recursive: true });
      if (!fromCache) await writeFormFields(c.slug, { loginWall: false, how, fields });
      await writeFile(path.join(dir, 'answers.md'), md);
      await writeFile(path.join(dir, 'answers-meta.json'), JSON.stringify({
        writtenOn: today(), sha256: sha(md),
      }, null, 2));
    }
    ok++;
    const blanks = (md.match(/⚠ \*\*(?:NO DRAFT|NO DEFAULT|BLANK BY DESIGN)/g) || []).length;
    const drafts_ = (md.match(/DRAFT — edit before sending/g) || []).length;
    console.log(`[${i}] ${c.slug} — ${fields.length} fields, ${drafts_} draft(s), ${blanks} blank(s) [${how}${fromCache ? ', cached' : ''}]`);
  }

  console.log(`\nwrote ${ok}, could not enumerate ${failed}, packs drafted ${drafted}${DRY ? ' (dry run, nothing saved)' : ''}`);
};

// Import-safe: running the nightly form-filler must be an explicit invocation, not
// a side effect of `import`. Same guard as tailor-cv.mjs. Without it the matcher
// cannot be tested, which is the reason it went unmeasured for as long as it did.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}

// Exported for test-answers-matcher.mjs. These are the functions that decide what
// goes into a live employer form; they are not helpers.
export {
  loadDefaults, tokenize, canonMatch, bestMatch, renderAnswers, decide, CANON,
  addressParts, composeAddress, mentionsForeignCountry, canRewrite,
  applyStepUrl, looksLikeLoginWall,
};
// Re-exported unchanged from lib/answer-classify.mjs so existing importers (and
// test-answers-matcher.mjs) keep working after the move.
export { isNoise, isOptionLabel, isConditional, isAttachment, classify };
