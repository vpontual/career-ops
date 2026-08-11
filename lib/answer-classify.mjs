#!/usr/bin/env node

/**
 * lib/answer-classify.mjs — what KIND of thing is this form field?
 *
 * WHY THIS EXISTS. generate-answers.mjs is a matcher: it looks a question up in
 * application-defaults.md and, failing that, writes `⚠ NO DEFAULT — VP to
 * answer`. Measured across the 114 pending packs on 2026-08-11 that produced
 * 521 such rows, 177 of them "required" — and VP's reaction to the ProPublica
 * pack was the correct one: "why didnt any of the propublica questions get
 * answered? they were listed but not answered".
 *
 * But "gap" was doing four incompatible jobs at once, and only one of them is
 * work VP owes:
 *
 *   1. NOISE      — `latitude`, `gtrans`, `Targeting Cookies`, `cards[<uuid>]`.
 *                   Not a field on the application at all. 60 rows.
 *   2. OPTION     — `Male`, `Queer`, `Hispanic or Latino`, `Atlanta, GA`. One
 *                   row of a radio group whose legend the reader could not find.
 *                   Answering these is how a generated table once instructed VP
 *                   to tick every race box (see generate-answers.mjs's header).
 *                   145 rows.
 *   3. FACTUAL    — mailing address, salary, start date, EEO, work authorisation,
 *                   prior employment at this employer, legal attestations. A
 *                   drafted answer here is a fabricated one. These MUST stay
 *                   blank unless VP's own defaults file answers them.
 *   4. OPEN-ENDED — "Why do you want to work at Flock?", "Describe a product
 *                   launch you owned." Essays. This is the actual work of
 *                   applying, and it is the only bucket a language model may be
 *                   pointed at.
 *
 * ⚠ THE DENY LIST WINS. classify() checks FACTUAL before OPEN-ENDED, always, and
 * anything that matches neither is UNKNOWN and stays blank. "Guessing here is
 * worse than blank" is not a style preference: this pipeline has already shipped
 * federal EEO self-identification rows filled with contradictory values and a
 * USD salary target in answer to "current base salary (in reais)". A model asked
 * "what is your current mailing address?" will produce a street address.
 *
 * Pure functions, no I/O, no network — so test-answer-classifier.mjs can pin
 * every one of these decisions without a form, a browser or an API key.
 */

export const NOISE = 'noise';
export const OPTION = 'option';
export const CONDITIONAL = 'conditional';
export const ATTACHMENT = 'attachment';
export const FACTUAL = 'factual';
export const OPEN_ENDED = 'open-ended';
export const UNKNOWN = 'unknown';

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// ── 1. NOISE ──────────────────────────────────────────────────────────────
// A rendered page hands back everything that looks like an input. Most of it is
// site chrome: the cookie banner, the store locator, the language switcher, a
// share widget. None of it is the application.
const NOISE_LABEL = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,          // a UUID used as a field id
  /^[a-z]+[A-Z][a-zA-Z]*$/,              // camelCase internal name, never a question
  /^start typing/i,
  /recaptcha|captcha/i,
  /^search/i,
  /^password$/i,
  /^\s*$/,
  // ── added 2026-08-11 from the 114-pack gap audit ──
  /^cards\[[0-9a-f-]+\]\[field\d+\]$/i,  // Ashby's internal card fields
  /^b_[0-9a-f]{16,}/i,                   // a Mailchimp honeypot
  /^keyword$/i,
  /^(?:targeting|functional|performance|strictly necessary|social media|analytics) cookies$/i,
  /^cookie list search$/i,
  /^(?:checkbox|switch|radio) label$/i,
  /^language dropdown menu$/i,
  /^what can we help you find/i,
  /^write here/i,
  /^type your response$/i,
  /^copy the link and open wechat/i,
  /^(?:subscribe|newsletter|email me jobs)\b/i,
];

export function isNoise(label) {
  return NOISE_LABEL.some((r) => r.test(String(label || '')));
}

// ⚠ SOFT noise — a raw HTML `name` attribute the reader found no label for:
// `location`, `org`, `region`, `county`, `latitude`, `urls[Other]`. It looks like
// junk, and mostly is, but the SAME shape also carries real required fields:
// three packs present the applicant's name, e-mail and phone as bare `name`,
// `email`, `phone`, and Lever's link inputs arrive as `urls[LinkedIn]` and
// `urls[Portfolio]`. Dropping those as noise on sight deleted four answered
// required fields per pack, which is a worse bug than the one being fixed.
//
// So this is not applied up front. decide() tries the matcher first and only
// calls a raw field name noise if nothing at all could be made of it.
const FIELD_NAME_LABEL = [
  /^[a-z][a-z0-9_]*$/,          // location, org, latitude, loc_group_id
  /^urls\[[^\]]*\]$/i,          // Lever's link slots
];

export function isFieldNameLabel(label) {
  return FIELD_NAME_LABEL.some((r) => r.test(String(label || '').trim()));
}

// ── 2. OPTION ─────────────────────────────────────────────────────────────
// One row of a radio/checkbox group, emitted as its own field because the reader
// could not find the group's legend. An OPTION IS NOT A QUESTION.
const OPTION_VOCAB = [
  /\((?:not\s+)?hispanic or latino\)/i,
  /^i\s+(identify|am not|am currently|do not|don'?t|have|decline|prefer not|wish|consent|agree|certify|confirm|acknowledge)\b/i,
  /^(?:decline|prefer not|prefer to not|prefer not to|do not wish)\s+(?:to\s+)?(?:self.?identify|identify|answer|say|disclose|specify)/i,
  /^(?:english|french|german|spanish|portuguese|italian|dutch|mandarin|cantonese|japanese|korean|arabic|hindi|russian|hebrew|polish)$/i,
  /^i do not wish/i,
  /^i don'?t wish/i,
  /^(?:yes|no)[,;—-]?\s+i\b/i,
  // demographic option rows — the audit found 145 of these presented as "gaps"
  /^(?:male|female|man|woman|non[- ]?binary|other|none of the above|not listed|custom|self-describe|i prefer to self-describe|unknown|n\/a)$/i,
  /^(?:white|black|asian|hispanic|latin[oax]|latine|native|indigenous|middle eastern|east asian|south(?:east)? asian|pacific islander|two or more races|american indian)\b/i,
  /^(?:heterosexual|straight|gay|lesbian|queer|bisexual|asexual|pansexual|transgender)\b/i,
  /^(?:he|she|they)\/(?:him|her|them)\b/i,
  /^(?:under \d+|\d+\s*(?:-|–|to)\s*\d+|\d+\+|\d+ or (?:younger|older))$/i,
  /^(?:h-?1-?b|f-?1|j-?1|opt|cpt|tn visa|green card|us citizen|permanent resident)\b/i,
  /^(?:immediate family member|neurodiverse|parent|caregiver|refugee or immigrant|first[- ]generation|veteran)$/i,
  // "Atlanta, GA" / "Boston, MA" — a location picker's rows
  /^[A-Z][A-Za-z .'-]+,\s?[A-Z]{2}$/,
  // "Yes — direct voice AI experience" — an answer, not a question
  /^(?:yes|no)\s*[—–-]\s/i,
  /^(?:yes|no)\s*\|/i,
];

export function isOptionLabel(label) {
  const s = String(label || '').trim();
  if (/\?\s*$/.test(s)) return false;      // a question mark makes it a question
  return OPTION_VOCAB.some((r) => r.test(s));
}

// ── 3. CONDITIONAL ────────────────────────────────────────────────────────
// A follow-up to an option that was not selected. Not work VP owes.
export function isConditional(label) {
  const s = String(label || '');
  return /^if\b/i.test(s) || /if\s+(?:you\s+)?(?:selected|answered|chose|checked)/i.test(s)
    || /if\s+["“]?other/i.test(s);
}

// ── 4. ATTACHMENT ─────────────────────────────────────────────────────────
// ⚠ USE THE FIELD TYPE, NOT THE WORD. The old test was /resume|cv\b|cover letter/
// against the label, so ProPublica's "What do we need to know about you and your
// hopes for this position that can't be contained in projects and resumes?" — a
// required-adjacent free-text essay — was rendered "_attached from the pack_".
// The word "resumes" appeared in it. A file input announces itself in its type.
const FILE_TYPES = /(?:^|_)file$|^input_file$|^file$/i;

export function isAttachment(label, type) {
  if (type && FILE_TYPES.test(String(type))) return true;
  const s = String(label || '').trim();
  if (/\?\s*$/.test(s)) return false;                 // a question is not an upload slot
  return /^(?:resume|cv|resume\s*\/\s*cv|cover letter|upload|attach|portfolio file)\b/i.test(s)
    || /^(?:resume|cv|cover letter)$/i.test(s)
    || /\b(?:resume|cv|cover letter)\s*(?:upload|attachment|file)$/i.test(s);
}

// ── 5. FACTUAL — NEVER DRAFTED ────────────────────────────────────────────
// Each entry names the rule so a report can say WHY a field stayed blank. The
// order is irrelevant (any hit denies); the naming is for the audit.
export const NEVER_DRAFT = [
  ['address', /\b(?:mailing address|home address|street address|legal address|current address|postal address|address line)\b|\bzip\b|postal code|post ?code|^address$/i],
  ['location', /^city\b|^state$|^province|province\s*\/\s*state|state\s*\/\s*province|which (?:state|province|city|country)|where (?:do|are) you (?:live|reside|based|located|physically)|current location|what country|country (?:in which|where|of)|borough|location preference|for which location|available to work|reside in|metro area|talent hubs?|within \d+ miles/i],
  ['relocation', /relocat/i],
  ['comp', /salary|compensation|\bpay\b|\bwage\b|hourly rate|\bbonus\b|\bequity\b|\bote\b|base pay|desired (?:comp|rate)|currency|in reais|posted (?:salary )?range|minimum annual/i],
  ['dates', /start date|when (?:can|could|would) you (?:start|begin)|availability to start|notice period|earliest (?:start|available)|available (?:from|on)|graduation year|date of birth|how soon/i],
  ['eeo', /\brace\b|racial|ethnic|hispanic|latin[oax]|latine|\bgender\b|pronoun|\bveteran\b|disabilit|transgender|sexual orientation|self.?identif|\bage\b|age range|accommodat|adjustments? we can make|accessible and inclusive|interview experience/i],
  ['workauth', /authoriz(?:ed|ation)|authoris(?:ed|ation)|sponsor|visa|immigration|work permit|\bcitizen|permanent resident|green card|u\.?s\.? person|export control|eligible to work|entitled to work|right to work|legally (?:allowed|able|permitted)|nationality|country of (?:citizenship|residence)/i],
  ['references', /\breferences?\b(?!\s+(?:this|the)\b)|referee/i],
  ['background', /convicted|criminal|felony|misdemeanou?r|background check|drug (?:test|screen)|security clearance|clearance level|bonded/i],
  ['credentials', /\blicens(?:e|es|ed|ure)\b|\bcertification\b|\bcertified\b|\bcjis\b|\bpe\b stamp|registration number|bar admission/i],
  ['prior-employment', /(?:previous(?:ly)?|ever|currently|before|in the past|former)[^?]{0,80}\b(?:work(?:ed)?|employ(?:ed|ee|ment)?|consult(?:ed|ing)?|intern(?:ed)?|contract(?:or|ed)?|provided services|held a position)\b|\b(?:work(?:ed)?|employ(?:ed|ee)|consult(?:ed)?)\b[^?]{0,60}\b(?:previously|before|in the past)\b|are you (?:an? )?(?:former|current)\b|\balum\b|family member or close personal|immediate family member|relative(?:s)? (?:who )?work|are you (?:a|the) (?:parent|relative|family member|guardian|spouse)\b|do you know,? or are you related to|\brelated to\b[^?]{0,40}\banyone\b/i],
  // A referral is a fact about who he knows. Nothing in cv.md answers it.
  ['referral', /\brefer(?:red|ral)\b|were you referred|who referred you/i],
  // VP's own rule, in application-defaults.md: "Anything else you'd like us to
  // know? → Default: leave blank. The cover letter and resume should carry the
  // load. Generic differentiators do not belong here." A drafted answer here is
  // a generic differentiator by construction.
  ['optional-extra', /^additional (?:information|comments|details|notes)\b|anything else (?:you'?d like|we should|you would like|you want)/i],
  ['attestation', /^i (?:certify|confirm|agree|acknowledge|consent|understand|affirm)\b|by (?:checking|clicking|signing|submitting)|i certify that|true and (?:correct|complete)|read,? reviewed and understood|terms (?:and|&) conditions|privacy (?:policy|notice)|data protection|responsible use policy/i],
  ['restrictive-covenant', /non-?compete|non-?solicit|bound by any agreement|restrict your ability|conflict of interest|side business|board position|outside (?:activities|commitments)|other obligations|foresee any conflicts/i],
  ['counting', /^how many\b|how many (?:years|months|people|reports)|years of (?:relevant )?experience|number of (?:years|reports|people)|team size/i],
  ['contact-consent', /\b(?:sms|text message|whatsapp)\b|opt.?in to (?:receive|text)|receive communications/i],
  ['artifact', /writing samples?|work sample|portfolio (?:link|url|piece)|provide a link|share (?:a )?links?|attach (?:a|your)|upload (?:a|your)|github (?:profile|url)|\burls?\b/i],
  ['identity', /^(?:first|last|legal|preferred|middle|full)\s*name|^e-?mail|^phone|^telephone|linkedin|^website$/i],
];

export function factualRule(label) {
  const s = String(label || '');
  for (const [name, re] of NEVER_DRAFT) if (re.test(s)) return name;
  return null;
}

// ── 6. OPEN-ENDED ─────────────────────────────────────────────────────────
// A question that invites prose. Two independent signals, because neither alone
// is sufficient: a `textarea` on a form that also uses textareas for addresses,
// and a prose verb on a form whose reader lost the field types.
const PROSE_VERB = [
  /^why\b/i,
  /\bwhy (?:do|are|would|did) you\b/i,
  /\b(?:share|tell us|tell me) why\b/i,
  /\bwhy you'?re\b/i,
  /^(?:describe|tell us|tell me|share|walk (?:us|me) through|explain|elaborate|talk to us|talk about|give (?:us|me) an example|can you (?:share|describe|give|tell|walk|elaborate|explain))\b/i,
  /\bcan you (?:pls |please )?(?:elaborate|describe|explain|share|walk)\b/i,
  /\bwhat makes (?:you|this|our)\b/i,
  /\bshare with us\b/i,
  /^what (?:excites|interests|draws|attracts|motivates|makes you|do you (?:hope|find|think|see))\b/i,
  /\bwhat excites you (?:most )?about\b/i,
  /\bare you (?:most )?(?:interested|excited) (?:in|about)\b/i,
  /\b(?:briefly )?describe\b/i,
  /\bexamples? of\b/i,
  /\bhow would you\b/i,
  /\bwhat is (?:the most|your approach|your philosophy)\b/i,
  /\bwhat'?s the most\b/i,
  /\bwhat do we need to know\b/i,
  /\bhopes for this position\b/i,
  /\bin one sentence\b/i,
  // ProPublica's application is three named projects, each with a backstory.
  // "EXPERIENCE:" is the first project's TITLE field, not a header.
  /\bbackstory\b|\bthe story behind\b/i,
];

// A project-slot field: a short input asking VP to NAME a piece of work. It is
// open-ended (there is no default that can answer it) but wants a line, not an
// essay — so it is drafted `short`.
const PROJECT_SLOT = /^(?:experience|project|work sample|case study)\s*#?\d*\s*:?\s*$/i;

const TEXTAREA_TYPE = /textarea|^long_?text$|^multiline$/i;

export function isProjectSlot(label) {
  return PROJECT_SLOT.test(String(label || '').trim());
}

/**
 * classify(label, { type, required }) → { bucket, why, form }
 *   bucket — one of the constants above
 *   why    — the rule that decided it (for the audit report)
 *   form   — 'prose' | 'short' for OPEN_ENDED, else null
 *
 * ⚠ Ordering is the safety property. NOISE/OPTION/CONDITIONAL/ATTACHMENT strip
 * the things that are not questions; FACTUAL then denies everything a model must
 * never write; only what survives both can be OPEN_ENDED.
 */
export function classify(label, field = {}) {
  const s = String(label || '').trim();
  const type = field.type || '';

  if (isNoise(s)) return { bucket: NOISE, why: 'not a form field', form: null };
  if (isAttachment(s, type)) return { bucket: ATTACHMENT, why: 'file upload', form: null };
  if (isConditional(s)) return { bucket: CONDITIONAL, why: 'conditional follow-up', form: null };
  if (isOptionLabel(s)) return { bucket: OPTION, why: 'an option row, not a question', form: null };

  const denied = factualRule(s);
  if (denied) return { bucket: FACTUAL, why: `never-draft: ${denied}`, form: null };

  if (isProjectSlot(s)) return { bucket: OPEN_ENDED, why: 'project slot', form: 'short' };

  // "Please share why …" / "Please describe …" — the polite prefix hid the verb.
  const stem = s.replace(/^please\s+/i, '');
  const proseVerb = PROSE_VERB.some((r) => r.test(stem));
  const isTextarea = TEXTAREA_TYPE.test(String(type));

  // A prose verb decides it, as long as the label is a sentence and not a
  // one-word mis-read. "Why Higharc?" is two words and is unambiguously an essay
  // prompt; "Project 1 Backstory:" is three and is a textarea.
  if (proseVerb && (words(stem) >= 4 || isTextarea || /\?\s*$/.test(stem))) {
    return { bucket: OPEN_ENDED, why: 'prose verb', form: isTextarea || words(stem) > 12 ? 'prose' : 'short' };
  }
  if (isTextarea && words(s) >= 6 && /\?\s*$/.test(s)) {
    return { bucket: OPEN_ENDED, why: 'textarea question', form: 'prose' };
  }

  // Last, and only last: a bare `name`/`org`/`urls[Other]` that nothing else
  // could account for is the raw HTML attribute, not a question. See
  // isFieldNameLabel — this check is deliberately after every other one.
  if (isFieldNameLabel(s)) return { bucket: UNKNOWN, why: 'raw field name', soft: NOISE, form: null };

  return { bucket: UNKNOWN, why: 'unclassified — left blank', form: null };
}
