#!/usr/bin/env node

/**
 * lib/answer-draft.mjs — a first draft for the essay questions, and nothing else.
 *
 * WHY THIS EXISTS. generate-answers.mjs is a matcher. It fills identity and
 * authorisation fields from application-defaults.md and writes `⚠ NO DEFAULT —
 * VP to answer` against everything else — including "Why Do You Want To Be A
 * Product Manager for Membership Growth and Development at ProPublica?", which
 * is the actual work of applying. VP, 2026-08-11: "why didnt any of the
 * propublica questions get answered? they were listed but not answered".
 *
 * ⚠ WHAT THIS MUST NEVER DO. A day was spent removing unverifiable claims from
 * cv.md — a "5x order rate" that is not in the public record, a "founding PM"
 * title VP did not hold, client work misattributed to him. cv.md now carries a
 * guard comment naming those three. A drafted answer that invents a metric, an
 * employer, a date or a project is worse than a blank, because he might send it.
 * So:
 *   - only the OPEN_ENDED bucket from lib/answer-classify.mjs ever reaches here;
 *   - the prompt is given cv.md (the truth superset), the variant actually in
 *     the pack, VP's own short answers, and the JD — and told those are the only
 *     admissible facts;
 *   - every returned draft is run through TWO checks before it can be written:
 *     checkFacts() from verify-cv-facts.mjs (metric-like claims absent from the
 *     sources) and checkProvenance() below (a named organisation absent from the
 *     sources). A draft that fails either is REJECTED, not warned about — it is
 *     kept in answer-drafts.json marked `rejected` so it is visible and is never
 *     silently regenerated, but it does not reach answers.md.
 *
 * The generation call is injected, not imported, so parseDraftResponse and both
 * checks are testable without an API key or a network.
 */

import { checkFacts } from '../verify-cv-facts.mjs';

// Mirrors stage-applications.mjs's sanitizeAtsText — an ATS parser garbles
// non-ASCII typography, and these drafts get transcribed into one.
export function sanitizeAtsText(text) {
  if (!text) return text;
  return String(text)
    .replace(/[—–]/g, '-')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/…/g, '...')
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/ /g, ' ');
}

// ── Provenance: a named organisation that is not in the sources ───────────
// checkFacts catches invented NUMBERS. It does not catch "I did this at Stripe",
// which is the other half of what went wrong in the CV. A proper noun in an
// attribution position ("at X", "for X", "with X") must appear in cv.md, the
// defaults, or the employer's own posting.
const ENTITY_STOP = new Set([
  'i', 'we', 'you', 'he', 'it', 'the', 'a', 'an', 'my', 'our', 'their', 'his', 'her', 'this',
  'that', 'these', 'those', 'ai', 'ml', 'llm', 'llms', 'pm', 'pms', 'ciso', 'cisos', 'gtm',
  'us', 'u.s.', 'usa', 'api', 'apis', 'saas', 'b2b', 'b2c', 'ux', 'ui', 'kpi', 'kpis', 'sql',
  'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'series', 'product', 'engineering',
  'design', 'marketing', 'sales', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december', 'monday', 'friday',
]);

export function namedEntities(text) {
  const out = new Set();
  const re = /\b(?:at|for|with|from|joined|advised|advising|built for|worked with|led at)\s+((?:[A-Z][\w&.'’-]*)(?:\s+(?:[A-Z][\w&.'’-]*|of|and|the)){0,3})/g;
  for (const m of String(text || '').matchAll(re)) {
    let ent = m[1].replace(/[.,;:]+$/, '').trim();
    // Drop a trailing lowercase connector left by the greedy tail.
    ent = ent.replace(/\s+(?:of|and|the)$/i, '').trim();
    if (!ent) continue;
    if (ENTITY_STOP.has(ent.toLowerCase())) continue;
    // A single common word in an attribution slot ("at scale", "with care") is
    // not an organisation; require either two words or a distinctive token.
    if (!/\s/.test(ent) && ent.length < 3) continue;
    out.add(ent);
  }
  return out;
}

export function checkProvenance(text, sourceText) {
  const src = String(sourceText || '').toLowerCase();
  const unknown = [];
  for (const ent of namedEntities(text)) {
    if (src.includes(ent.toLowerCase())) continue;
    // Also accept the head word alone — "Reco.AI" in a draft against "Reco" in
    // the CV is the same employer, not an invented one.
    const head = ent.split(/[\s.]/)[0].toLowerCase();
    if (head.length > 3 && src.includes(head)) continue;
    unknown.push(ent);
  }
  return { ok: unknown.length === 0, unknown };
}

// ── The prompt ────────────────────────────────────────────────────────────
// One call per PACK, not per question. The free Gemini tier is 5 requests a
// minute (see MAX_CONCURRENT in stage-applications.mjs); ProPublica alone has
// five open-ended fields, and a per-question loop would spend a minute of the
// whole pipeline's quota on one card.
export function buildPrompt({ company, role, questions, cv, variantCv, shortAnswers, jdText }) {
  const list = questions.map((q, i) =>
    `${i + 1}. [${q.form === 'short' ? 'ONE LINE, max 20 words' : '120-200 words'}] ${q.label}`
  ).join('\n');

  return `You are drafting answers to the free-text questions on a job application for Vitor Pontual.
He will EDIT what you write before sending it. Your job is a grounded first draft, not a finished answer.

HARD RULES — a violation makes the draft useless and it will be thrown away:
- Use ONLY facts that appear in the CV, the variant CV, or Vitor's own short answers below.
- Do NOT invent or estimate a number, percentage, dollar figure, multiple, headcount, date or duration. If a number is not written in the sources, do not write one.
- Do NOT name a company, client, product or school that is not in the sources. Do not describe work he did not do.
- Do NOT claim a title he did not hold. He was NOT a founding PM anywhere.
- If the sources do not contain enough to answer honestly, answer with exactly: INSUFFICIENT_EVIDENCE

STYLE — he has said "i hate marketing writing":
- Plain, concrete, specific. First person. Short sentences.
- No "passionate about", "leveraged", "spearheaded", "results-oriented", "synergies", "excited to", "thrilled", "cutting-edge", "world-class".
- No adjective stacking, no closing summary sentence that restates the paragraph.
- Say what he did and what happened. Prefer one real example over three claims.
- US English. Plain text. No markdown, no bullets, no headings, no sign-off.

=== The role ===
Company: ${company}
Role: ${role}

=== Job description ===
${String(jdText || '').slice(0, 7000)}

=== CV (cv.md — the complete and only record of his history) ===
${cv}

=== The CV variant actually attached to this application ===
${String(variantCv || '').slice(0, 6000)}

=== Vitor's own answers to questions like these (application-defaults.md) ===
${String(shortAnswers || '').slice(0, 4000)}

=== The questions ===
${list}

Return ONLY a JSON object, no prose around it, no code fence:
{"answers":[{"n":1,"text":"..."},{"n":2,"text":"..."}]}
One entry per question, in order, using the same numbers.`;
}

// ── Parsing ───────────────────────────────────────────────────────────────
// The model is asked for bare JSON and returns a code fence about a third of the
// time. Pure, so the fixture can pin every shape without a network call.
export function parseDraftResponse(raw, questions) {
  const text = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { data = JSON.parse(m[0]); } catch { return []; }
  }
  const rows = Array.isArray(data) ? data : (data && Array.isArray(data.answers) ? data.answers : []);
  const out = [];
  for (const r of rows) {
    const n = parseInt(r?.n ?? r?.id ?? r?.index, 10);
    const q = Number.isFinite(n) ? questions[n - 1] : null;
    if (!q) continue;
    const body = sanitizeAtsText(String(r?.text ?? '').trim());
    if (!body) continue;
    out.push({ label: q.label, form: q.form, text: body });
  }
  return out;
}

/**
 * Draft the open-ended questions for one pack.
 *
 * @param {object} ctx      everything buildPrompt needs, plus factSource / cvFacts
 * @param {function} generate  async (prompt) => string. Injected.
 * @returns {Promise<object>} { "<question>": { text, form, rejected?, reason?, checks } }
 */
export async function draftPack(ctx, generate) {
  const { questions } = ctx;
  if (!questions.length) return {};
  const raw = await generate(buildPrompt(ctx));
  const parsed = parseDraftResponse(raw, questions);

  const out = {};
  for (const d of parsed) {
    const rec = { form: d.form, text: d.text, generatedOn: new Date().toISOString().slice(0, 10) };
    if (/^INSUFFICIENT_EVIDENCE\b/i.test(d.text)) {
      out[d.label] = { ...rec, rejected: true, reason: 'the model reported insufficient evidence in the CV' };
      continue;
    }
    const fc = checkFacts(d.text, ctx.factSource, ctx.cvFacts || {}, { jdText: ctx.jdText || '' });
    const pv = checkProvenance(d.text, `${ctx.factSource}\n${ctx.jdText || ''}\n${ctx.company}`);
    rec.checks = { invented: fc.invented, quoted: fc.quoted, forbidden: fc.forbidden, unknownEntities: pv.unknown };
    if (fc.invented.length || fc.forbidden.length || !pv.ok) {
      const bits = [
        ...fc.invented.map((m) => `unverified figure "${m}"`),
        ...fc.forbidden.map((p) => `forbidden phrase "${p}"`),
        ...pv.unknown.map((e) => `organisation not in the CV: "${e}"`),
      ];
      out[d.label] = { ...rec, rejected: true, reason: bits.join('; ') };
      continue;
    }
    out[d.label] = rec;
  }
  // A question the model skipped entirely is recorded as such, so a re-run does
  // not silently ask again and again on a free-tier quota.
  for (const q of questions) {
    if (!out[q.label]) {
      out[q.label] = { form: q.form, text: '', rejected: true, reason: 'the model returned no answer for this question',
        generatedOn: new Date().toISOString().slice(0, 10) };
    }
  }
  return out;
}
