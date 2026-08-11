#!/usr/bin/env node
/**
 * test-credential-gate.mjs — a licence he cannot get blocks only where the
 * posting STATES it is required, and the vocabulary traps never fire.
 *
 * Same specification shape as test-skill-gate.mjs, tuned harder in the
 * non-blocking direction. The gate this replaces (`if (f.hardCredential)
 * return 1`) was never reachable on the pm track at all — the field is absent
 * from 1,171 of 1,358 records and `scoreFromFacts` never referenced it — so
 * every case below is new behaviour, and a wrong one costs VP a role he never
 * sees. The trap block is the point of the file: this is a PRODUCT MANAGER
 * search, where "license" is usually a SaaS noun.
 */
import { detectHardCredential, NEVER_BLOCK } from './lib/credential-gate.mjs';

const T = [];
const eq = (l, g, w) => T.push([l, g, w]);
const blocks = (body) => detectHardCredential(body).blocked;
const cred = (body) => detectHardCredential(body).credential || '';
const warns = (body) => detectHardCredential(body).warned.map(w => w.credential).join(',');

// ── required -> BLOCK ────────────────────────────────────────────────
eq('required: TS/SCI clearance blocks',
   blocks('**Requirements**\n- Active TS/SCI clearance is required.'), true);
eq('required: security clearance names itself in the evidence',
   cred('**Requirements**\n- An active security clearance is required.'), 'security clearance');
eq('required: customs broker licence blocks',
   blocks('Requirements\n- You must hold a licensed customs broker credential.'), true);
eq('required: CPA blocks',
   blocks('Minimum Qualifications\n- CPA license required.'), true);
eq('required: bar admission blocks',
   blocks('Requirements\n- Admission to the New York bar is required.'), true);
eq('required: Professional Engineer blocks',
   blocks('Requirements\n- A current P.E. license is required for this position.'), true);
eq('required: RN licensure blocks',
   blocks("What you'll need\n- Active RN license in the state of New York."), true);
eq('required: Series 7 blocks',
   blocks('Requirements\n- Series 7 and 63 registrations are required.'), true);
eq('required: actuarial fellowship blocks',
   blocks('Requirements\n- Fellow of the Society of Actuaries designation required.'), true);
eq('required: CDL blocks',
   blocks('Requirements\n- Must have a valid CDL-A.'), true);
eq('required: no heading, requirement wording still blocks',
   blocks('You must hold an active security clearance to be considered for this role.'), true);

// ── preferred / optional -> NEVER block ──────────────────────────────
// THE live case. `indeed-klearnow-product-manager-customs-house-brokerage.md`
// scores 5 and the model's redFlags reported it as "Requires specific domain
// knowledge (US broker license/field equivalent)". The posting does not say
// that. It says "plus", twice softened. Blocking it would delete a tier-5
// AI-native remote-US PM role over a sentence that grants an exemption.
const KLEARNOW = '### What You Bring\n\n**Customs brokerage depth.** You know the entry lifecycle cold: HTS classification, 7501, ISF, ABI/ACE/CATAIR mechanics, PGA, and post-entry work. A US broker license (or the field-earned equivalent) is a strong plus.';
eq('KlearNow: "a strong plus" does not block', blocks(KLEARNOW), false);
eq('KlearNow: it is still reported as a warning', warns(KLEARNOW), 'customs broker licence');

eq('preferred: nice-to-have clearance does not block',
   blocks('**Nice to have**\n- An active security clearance.'), false);
eq('preferred: "CPA preferred" does not block',
   blocks('Qualifications\n- CPA or CMA preferred.'), false);
eq('preferred: "or equivalent experience" does not block',
   blocks('Requirements\n- CPA license or equivalent accounting experience.'), false);
eq('preferred: "ability to obtain a clearance" does not block',
   blocks('Requirements\n- Must have the ability to obtain a security clearance.'), false);
// A posting with BOTH sections must split them. This is the case a body-wide
// scan gets wrong in the most damaging direction.
const both = 'Requirements\n- 8+ years of product management.\n\nPreferred Qualifications\n- An active security clearance.';
eq('split: required section has no credential -> no block', blocks(both), false);
eq('split: the preferred clearance still warns', warns(both), 'security clearance');

// ── a bare mention, no requirement language -> no block ──────────────
// Ambiguity resolves to NOT blocking. skill-gate can afford to warn on
// ambiguity; here the vocabulary itself is the risk.
eq('mention: credential named with no requirement language does not block',
   blocks('Our customers include licensed customs brokers and freight forwarders.'), false);
eq('mention: clearance named in company boilerplate does not block',
   blocks('We build software for agencies where security clearance work happens.'), false);

// ── TRAPS. Each of these fired somewhere in a real corpus. ───────────
eq('trap: driver\'s license never blocks',
   blocks('Requirements\n- A valid driver\'s license is required.'), false);
eq('trap: driving licence never blocks',
   blocks('Requirements\n- Must have a current driving licence and own transport.'), false);
eq('trap: MIT license (software) never blocks',
   blocks('Requirements\n- Experience shipping code licensed under the MIT license is required.'), false);
eq('trap: per-seat SaaS licensing never blocks',
   blocks('Requirements\n- You must own our per-seat license model and license revenue targets.'), false);
eq('trap: enterprise license agreements never blocks',
   blocks('Requirements\n- Must have owned enterprise license agreements and renewals.'), false);
eq('trap: software licensing strategy never blocks',
   blocks('What you will need\n- Deep knowledge of our licensing model and license key infrastructure is required.'), false);
eq('trap: "certified partner" never blocks',
   blocks('Requirements\n- We are a certified partner and you must maintain that relationship.'), false);
eq('trap: "registered trademark" never blocks',
   blocks('Acme is a registered trademark of Acme Inc. All rights reserved.'), false);
eq('trap: PE as private equity never blocks',
   blocks('Requirements\n- Must have sold into PE and VC-backed portfolio companies.'), false);
eq('trap: private equity spelled out never blocks',
   blocks('Requirements\n- Experience with private equity (PE) buyers is required.'), false);
eq('trap: "raise the bar" never blocks',
   blocks('Requirements\n- You must raise the bar for product quality on every launch.'), false);
eq('trap: "bar chart" never blocks',
   blocks('Requirements\n- Must be able to read a bar chart and a funnel report.'), false);
eq('trap: CPA as cost-per-acquisition never blocks',
   blocks('Requirements\n- Must own CPA, CAC and LTV targets across paid channels.'), false);
eq('trap: "JD" meaning the job description never blocks',
   blocks('Requirements\n- Please read the full JD before applying. A JD is required reading.'), false);
eq('trap: FSA in the benefits blurb never blocks',
   blocks('Benefits\n- Medical, dental, vision, 401(k), FSA and HSA. A benefits election is required.'), false);
eq('trap: MD as Maryland never blocks',
   blocks('Requirements\n- Must be able to travel to our Bethesda, MD office weekly.'), false);
eq('trap: MD as Managing Director never blocks',
   blocks('Requirements\n- You must partner with the MD of the business unit.'), false);
eq('trap: "Series A/B/C" funding never blocks',
   blocks('Requirements\n- Must have shipped at a Series B startup. We just closed our Series C.'), false);
eq('trap: RN inside another word never blocks',
   blocks('Requirements\n- Must own the LEARN and RETURN surfaces end to end.'), false);
eq('trap: "license to operate" figurative never blocks',
   blocks('We earn our social license to operate every day.'), false);

// ── REGRESSIONS. Every one of these was a live false positive measured ──
// ── over jds/ (2,057 files) while building this gate. ────────────────

// The worst one available in this corpus. `LL\.?M\.?` for Master of Laws matched
// "LLM", flagging 44 postings — Webflow x2, Brex x2, Spotify x2, Google Gemini,
// Databricks, Datadog x3 — i.e. it hard-rejected the AI-native tier-5 roles this
// entire search exists to find.
eq('regression: "LLM-based tools" is not a law degree',
   blocks('Requirements\n- Regularly uses LLM-based tools like Claude Code and Cursor to accelerate your work.'), false);
eq('regression: "LLM/agent features" is not a law degree',
   blocks("What you'll need\n- You've shipped LLM/agent features to real users, with depth in prompting and eval design."), false);
eq('regression: "LLM-as-judge" is not a law degree',
   blocks('Requirements\n- Own the AI-judge evaluation pipeline: offline eval with golden datasets, online LLM-as-judge scoring.'), false);

// Elastic's federal-notices footer. Bare `polygraph` matched the "Employee
// Polygraph Protection Act (EPPA) Poster" line on 25 postings with no clearance
// requirement at all.
eq('regression: the EPPA poster is not a clearance requirement',
   blocks('Applicants have rights under Federal Employment Laws, view posters linked below: Family and Medical Leave Act (FMLA) Poster; Employee Polygraph Protection Act (EPPA) Poster.'), false);

// Karthik Consulting's compensation paragraph.
eq('regression: a pay-philosophy paragraph is not a requirement',
   blocks('We are committed to providing competitive compensation based on the responsibilities of the role, required qualifications, security clearance level, relevant experience, and certifications.'), false);

// MongoDB's Staff PMM prints this as a SELLING POINT. The naive read inverts it.
eq('regression: "No security clearance ... required" must not block',
   blocks('Requirements\n- No security clearance or prior government employment required.'), false);

// NYC civil-service specs are numbered equivalency ladders. Six DDC/NYCHA
// postings read as hard licensure requirements on a sentence offering the
// licence as ONE OF SEVERAL ways in — the others being routes VP already meets.
eq('regression: NYC "may be substituted for" does not block',
   blocks('Requirements\n- An accredited Master\'s degree in one of the disciplines described in "1" above, a law degree, or a valid New York State license as a Professional Engineer may be substituted for one year of the experience.'), false);
eq('regression: NYC alternative-route licence does not block',
   blocks('Requirements\n- One year of the experience as described in "1" above and a valid license as a professional engineer, registered architect, or registered landscape architect.'), false);
eq('regression: a list of acceptable degrees naming Juris Doctor does not block',
   blocks("Qualifications\n- A master's degree from an accredited college in economics, finance, accounting, business or public administration, or a Juris Doctor."), false);

// Ad Hoc's Senior PM. "able to successfully obtain" — the adverb defeated the
// soft-word test on the first pass.
eq('regression: "able to successfully obtain" a clearance does not block',
   blocks('Requirements\n- Must be able to successfully obtain and maintain a Public Trust security clearance.'), false);

// Blackstone's conditional. "you may be required to obtain certain securities
// licenses IF you are in a client facing role" is not this role's requirement.
eq('regression: a conditional "may be required" does not block',
   blocks('Depending on the position, you may be required to obtain certain securities licenses if you are in a client facing role.'), false);

// Blackstone's BXCI PM. The bullet lists activities that would TRIGGER a
// registration for whoever performs them; the licensees are other employees.
eq('regression: "securities licensed employees" describes other people',
   blocks('Qualifications\n- Supervising or training securities licensed employees;'), false);
eq('regression: a workforce of licensed staff is not the candidate',
   blocks('Requirements\n- You must supervise a team of licensed clinical staff.'), false);
eq('regression: Blackstone\'s non-exhaustive licensing note is a disclaimer',
   blocks('Qualifications\n- Note: The above list is not the exhaustive list of activities requiring securities licenses and there may be roles that require review on a case-by-case basis.'), false);
// ...but the THIRD_PARTY rule must not disarm an occupational credential. An
// earlier version listed "brokers" and silently killed the customs-broker gate.
eq('regression: "a licensed customs broker" is still the candidate',
   blocks('Requirements\n- You must be a licensed customs broker.'), true);
// Karthik Consulting. "About the Must Haves" was not read as a requirements
// heading, and first-hit-wins then let this bare bullet warn while the explicit
// "**Clearance:** TS/SCI (required)" in the footer was discarded.
eq('regression: "About the Must Haves" is a requirements heading',
   blocks('**About the Must Haves**\n* Active Secret security clearance'), true);
eq('regression: an explicit requirement beats a bare mention elsewhere',
   blocks('Our work spans a security clearance environment.\n\n**Clearance:** TS/SCI (required)'), true);
// ...but a stated exemption still wins over a bare mention.
eq('regression: a stated "plus" still beats a bare mention',
   blocks('We work alongside a security clearance team.\n\nNice to have\n- An active security clearance.'), false);
// NYC DOT's Project Manager, a genuine stated requirement in the same corpus
// where six sibling postings offer the same licence as an alternative route.
eq('regression: "registration as a Professional Engineer must be maintained" blocks',
   blocks('Requirements\n- Current New York State registration as a Professional Engineer must be maintained for the duration of your employment.'), true);

// ── PM-adjacent certificates must NEVER block ────────────────────────
// These are weeks of study and most senior PMs already hold one. Gating on them
// would gut the pipeline, which is the failure this gate exists to avoid — not
// to cause.
for (const c of NEVER_BLOCK) {
  eq(`never-block: "${c} required" does not block`,
     blocks(`Requirements\n- ${c} certification is required.`), false);
}
eq('never-block: PMP + Scrum + AWS in one required bullet',
   blocks('Requirements\n- PMP, Certified Scrum Master and AWS Certified Solutions Architect are all required.'), false);
eq('never-block: Six Sigma black belt required',
   blocks('Requirements\n- Six Sigma Black Belt certification required.'), false);
eq('never-block: CIPP/US privacy certification required',
   blocks('Requirements\n- CIPP/US certification is required for this role.'), false);
eq('never-block: SAFe required',
   blocks('Requirements\n- SAFe Agilist certification is required.'), false);

// ── teaching certification is deliberately OUT OF SCOPE ──────────────
// scoreTeaching already has a researched NYSED answer (Transitional A is earned
// THROUGH the hire for a CTE subject). A blunt credential gate firing on the
// same sentence would undo that work and re-bury Harrison Central.
eq('teaching: NYS teaching certification is not this gate\'s business',
   blocks('Requirements\n- NYS Business teaching certification is required.'), false);
eq('teaching: a valid teaching credential is not this gate\'s business',
   blocks('Requirements\n- Must hold a valid teaching credential.'), false);

// ── evidence is quotable ─────────────────────────────────────────────
// A human has to be able to overrule this by reading one line.
const ev = detectHardCredential('Requirements\n- Active TS/SCI clearance with polygraph is required for this position.').evidence;
eq('evidence: the matched sentence comes back verbatim',
   /Active TS\/SCI clearance with polygraph is required/.test(ev), true);
eq('evidence: empty when nothing blocks',
   detectHardCredential('Requirements\n- 8+ years of product management.').evidence, '');

let pass = 0; const fails = [];
for (const [l, g, w] of T) { if (g === w) pass++; else fails.push(`  ❌ ${l}\n     expected ${JSON.stringify(w)}, got ${JSON.stringify(g)}`); }
console.log(`\ncredential gate — ${T.length} cases`);
for (const f of fails) console.log(f);
console.log(`${pass}/${T.length} passed`);
if (fails.length) { console.log('\nA block is a silent loss of a role. Do not relax a case.\n'); process.exit(1); }
console.log('');
