/**
 * track.mjs — which of VP's three searches a role belongs to, and how a score is
 * earned inside each one.
 *
 * VP runs three tracks and wants them kept separate (MISSION-nyc-job.md, decided
 * 2026-07-29). Until now only Track A existed in code: `portals.yml`'s title
 * filter is entirely PM and PMM titles, so a Business Teacher vacancy was
 * dropped before it was ever scored, and the ~30 Success Academy JDs sitting on
 * disk had no score at all. Widening the title list alone would not have helped
 * - the rubric behind the number is a Senior-PM rubric, so every teaching role
 * would come back a 1 and the tier-4 gate would still have hidden it.
 *
 * Everything here is derived from the posting text in CODE, deliberately. It
 * follows the same architecture the scorer already uses - the model reports
 * facts, policy is applied in code - and it means adding these two tracks costs
 * no prompt surface and no re-scoring. The scoring prompt is already 5,554
 * characters against a 6,000 limit, and it has silently truncated before.
 */

// ── Track detection ───────────────────────────────────────────────────────
//
// Track comes from the BOARD the role was found on, not from guessing at the
// company name. The first version pattern-matched company names for
// `foundation|institute|society|trust|charity` and `academy`, and an audit found
// it exactly backwards: Northern Trust, a bank, routed to `nonprofit` and scored
// 5 with none of Track A's gates applied, while Propel, The Trevor Project and
// DonorsChoose - the actual nonprofits portals-nonprofit.yml exists to scan -
// all routed to `pm`. Khan Academy's Director of Technology scored 5 as a
// TEACHING role.
//
// portals-teaching.yml and portals-nonprofit.yml already name every employer and
// its careers URL. The ATS board slug in that URL also appears in every JD URL
// from that board, so it is an exact, verifiable key. Same lesson as "location
// comes from the ATS record, never the model".

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function boardSlugs(file) {
  const p = path.join(ROOT, file);
  if (!existsSync(p)) return [];
  let doc;
  try { doc = yaml.load(readFileSync(p, 'utf-8')); } catch { return []; }
  // The key is `tracked_companies`. Reading `companies`/`portals` returned an
  // empty list silently, so every nonprofit board fell through to the PM rubric
  // and Track B stayed empty while looking wired.
  const list = doc?.tracked_companies || doc?.companies || doc?.portals || [];
  const out = [];
  for (const c of list) {
    const u = String(c?.careers_url || c?.api || '');
    const m = u.match(/(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/(?:v1\/boards\/)?([A-Za-z0-9_-]+)/);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

let _cache = null;
function slugSets() {
  if (!_cache) {
    _cache = {
      teaching: new Set(boardSlugs('portals-teaching.yml')),
      nonprofit: new Set(boardSlugs('portals-nonprofit.yml')),
      now: new Set(boardSlugs('portals-now.yml')),
    };
  }
  return _cache;
}

function urlSlug(url) {
  const m = String(url || '').match(/(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/([A-Za-z0-9_-]+)/);
  return m ? m[1].toLowerCase() : '';
}

const TEACHING_TITLE = /\b(teacher|teaching|instructor|educator|faculty|lecturer|adjunct|professor)\b/i;

// Track D, "Get Hired Now". Engagements that start fast, wherever they are.
const NOW_TITLE = /\b(fractional|interim|contract|consultant|consulting|advisor|freelance)\b/i;

// "Consultant" alone admitted N26's Senior Atlassian Consultant - a tooling
// administrator, not a product or strategy engagement. These are specialist
// platform-admin roles and VP cannot do them, whatever the pay.
const NOW_TOOLING = /\b(atlassian|jira|confluence|salesforce|servicenow|workday|netsuite|sap\b|sharepoint|hubspot|zendesk|tableau|powerbi|power bi|sailpoint|okta|dynamics)\b/i;

// Roles that merely contain the word "business" inside a school. Lifted from
// fetch-olas.mjs, which learned this the hard way: every district has an
// Assistant Superintendent for Business & Operations and none of them teach.
const NOT_TEACHING = /\b(superintendent|administrator|business official|business manager|treasurer|payroll|purchasing|custodian|paraprofessional|secretary|clerk|bus driver|nurse|coach|monitor|cleaner|food service)\b/i;

// Only used to catch teaching roles that arrive from somewhere OTHER than the
// teaching boards - an Indeed scrape of a school district, say. It is never used
// to route a role to `nonprofit`, because a name is not evidence of tax status.
const SCHOOL_EMPLOYER = /\b(school district|central school|public schools?|UFSD|CSD|BOCES|charter school)\b/i;

/**
 * @param {{title?:string, company?:string, body?:string, url?:string}} jd
 * @returns {'pm'|'teaching'|'nonprofit'}
 */
// ── Track E: civic / public sector ──────────────────────────────────────
// Added 2026-08-10. VP: "working for the city is also a valid path... various
// opportunities from teaching to product, to other management etc. and they
// might provide a path in through tests or certs." He had already APPROVED an
// NYC Office of Technology & Innovation PM role, so this is a demonstrated
// interest, not a hypothetical - and it was being scored on the PM rubric,
// whose AI-native thesis and $150K floor are both wrong for a city agency.
const CIVIC_EMPLOYER = /\b(city of new york|new york city|nyc\b|department of|dept\.? of|office of (?:the )?[a-z]|mayor'?s office|commission on|campaign finance board|comptroller|\\bbureau of|human resources administration|\bhra\b|\bdoitt\b|\boti\b|health \+ hospitals|housing authority|\bnycha\b|\bmta\b|port authority|school construction authority|state of new york|county of|municipal|public sector|civil service|borough)\b/i;
// A civil-service exam or certification is a PATH IN, not a barrier - VP named it
// as one of the attractions. It must never be scored like a disqualifying credential.
const CIVIC_PATHWAY = /\b(civil service (?:exam|list|title)|open competitive|promotional exam|provisional appointment|exam number|eligible list)\b/i;
// Credentials he genuinely cannot obtain in time, unlike an exam he can sit.
const CIVIC_HARD_CREDENTIAL = /\b(licensed (?:professional )?engineer|\bP\.?E\.? license|registered architect|bar admission|licensed attorney|\bMD\b|registered nurse|CPA license|police officer|firefighter)\b/i;

export function detectTrack(jd) {
  const title = String(jd?.title || '');
  const company = String(jd?.company || '');
  const url = String(jd?.url || '');

  // A PM or PMM role stays Track A wherever it was found. Wikimedia hiring a
  // Senior Product Manager is still the PM search, scored on the PM rubric.
  const isProductRole = /\b(product manager|product marketing|product lead|head of product|director,? product|director of product|group product manager)\b/i.test(title);

  if (/olasjobs\.org/i.test(url)) return 'teaching';
  if (NOT_TEACHING.test(title)) return 'pm';
  if (TEACHING_TITLE.test(title)) return 'teaching';

  const slug = urlSlug(url);
  const sets = slugSets();
  // A school network hiring a Product Manager is still the PM search.
  if (slug && sets.teaching.has(slug)) return isProductRole ? 'pm' : 'teaching';
  // A nonprofit hiring a Product Manager is precisely what Track B IS - "bring
  // product skills somewhere with community impact" - so it must NOT fall back
  // to the PM rubric and its $150K floor, which VP said not to apply here.
  if (slug && sets.nonprofit.has(slug)) return 'nonprofit';

  if (SCHOOL_EMPLOYER.test(company) && !isProductRole) {
    // ⚠ A DISTRICT'S CENTRAL OFFICE IS A CITY AGENCY, NOT A CLASSROOM.
    // "NYC Public Schools" matches SCHOOL_EMPLOYER on "public schools", and this
    // line fired before the civic check below — so every DOE central-office
    // posting was routed to the TEACHING rubric and then rejected by the
    // teaching title filter, which admits only teacher/instructor/faculty
    // titles. Measured 2026-08-14 when fetch-doe.mjs first ran: 6 of its 8 JDs
    // were classified teaching and ALL 8 were dropped before scoring. They were
    // written to disk and appended to pipeline.md, so the run looked successful.
    //
    // NOT_TEACHING above already encodes this idea ("every district has an
    // Assistant Superintendent for Business & Operations and none of them
    // teach") but only matches specific title words, and "Senior Data Analyst,
    // OGC" is not one of them.
    //
    // Narrow by construction: it fires only for an employer matching BOTH the
    // school pattern and the city-agency pattern, which is a public school
    // system. Charter and private networks — Success Academy, Achievement
    // First, Democracy Prep — match SCHOOL_EMPLOYER and not CIVIC_EMPLOYER, so
    // they still route to teaching. A teaching TITLE has already returned above.
    if (CIVIC_EMPLOYER.test(company)) return 'civic';
    return 'teaching';
  }

  // Track E before the PM fallback. A city agency hiring a product manager is
  // exactly what this track is for - the work is the draw and the pay scale is
  // a known, accepted tradeoff - so it must not fall through to the PM rubric.
  // The URL is definitional and cannot false-positive: cityjobs.nyc.gov only ever
  // serves City of New York postings. The name regex below is the fallback for
  // civic roles arriving from other sources, and it needed widening - "Office of
  // the Comptroller", "Commission on Racial Equity" and "Campaign Finance Board"
  // are all plainly city agencies that the first version missed.
  if (/cityjobs\.nyc\.gov|jobs\.nyc\.gov/i.test(url)) return 'civic';
  if (CIVIC_EMPLOYER.test(company)) return 'civic';

  // Track D. A fractional or interim engagement is a path to income wherever it
  // sits, so it belongs here rather than in a search anchored on NYC.
  if (NOW_TITLE.test(title) && !NOW_TOOLING.test(title)) return 'now';
  if (slug && sets.now.has(slug)) return 'now';

  return 'pm';
}

// ── Title filters, per track ─────────────────────────────────────────────
// Track A keeps portals.yml exactly as it is. These two only ever ADD roles that
// the PM filter would have thrown away.

const TEACHING_OK = /\b(teacher|teaching|instructor|educator|faculty|lecturer|adjunct|professor)\b/i;

// Nonprofit titles reach much wider than "Product Manager" - VP's own note names
// Director of Technology, Director of Programs, Director of Innovation and CPO
// at a foundation as in scope.
//
// Widened 2026-08-11, measured against a live sweep of all 37 Track B boards
// rather than guessed at. The first list was still a technology-sector list, and
// the sector it was pointed at does not name things that way. Every word added
// below was dropped on a REAL posting that VP could plainly do:
//   strateg*   ACLU "Associate Director, Web Strategy" (NYC);
//              Consumer Reports "Director, Strategic Initiatives" (Yonkers)
//   technical  ACLU "Technical Project Manager" (NYC) - the list had `technology`
//              but not `technical`, which is the word an ATS actually uses
//   initiative Vera "Initiative Director, Greater Justice New York" x3 (Brooklyn)
//   project    "Technical Project Manager", "Project Director"
//   platform   Mozilla "Head of Editorial + Platforms"
//   chief of staff  GiveDirectly "Chief of Staff, Emergency Cash"
// `service`, `analytics` and `transformation` are included for symmetry with the
// civic gate, which already admits them.
//
// ⚠ Widening a title regex widens what reaches a ~34s scoring call, so it is
// paired with the functionArea gate in scoreNonprofit() below. Without that gate
// `strateg*` alone admits "Senior Strategic Finance Manager" and "Manager of
// Strategic Finance" - both real postings on these boards, both disciplines VP
// has never practised. The regex is the cheap net; the discipline is the policy.
const NONPROFIT_OK = /\b(product|technology|technical|innovation|programs?|digital|data|analytics|impact|operations|platforms?|initiatives?|projects?|transformation|service design|chief of staff)\b|strateg/i;
const NONPROFIT_SENIOR = /\b(director|head|chief|vp|vice president|lead|senior|principal|manager)\b/i;

// Hours-for-minimum-wage work, which VP excluded by name. The only real floor on
// Track D.
// A specialism VP has never practised. Applied at the TITLE FILTER, not only in
// scoring, because a role that reaches the scorer costs a ~34s LLM call before
// policy can reject it - and broadening the Track D filter surfaced 250 roles at
// once, many of them Direct Tax Manager and Compensation Manager at Brazilian
// offices. Free to exclude here, expensive to exclude later.
const NOW_WRONG_FIELD = new RegExp([
  // SALES in any form. The mission excludes it by name on the PM track and
  // nothing about Track D changes that - a quota is not a path he wants.
  'sales', 'account executive', 'account manager', 'business development rep',
  'sdr\\b', 'bdr\\b', 'channel partner', 'partner success', 'revenue operations',
  // DEMAND-GEN marketing. Product marketing stays in; this is the lead-gen trap
  // the mission spends a whole section rejecting.
  'growth marketing', 'demand gen\\w*', 'performance marketing', 'field marketing',
  'partner marketing', 'brand marketing', 'lifecycle marketing', 'retention lead',
  'campaign', '\\bseo\\b', 'social media',
  // ENGINEERING. He is not a software developer and cannot pass a coding screen.
  'engineer', 'engineering', 'architect', 'developer', 'programmer',
  'machine learning', '\\bml\\b', 'data scien\\w+', 'devops', 'sre\\b',
  // Professional specialisms he has never practised.
  'tax', 'audit', 'payroll', 'controller', 'treasury', 'accounting', 'accountant',
  'actuar\\w+', 'underwrit\\w+', 'fp&a', 'compensation', 'benefits',
  'recruit(er|ing)', 'talent acquisition', 'hrbp', 'people analytics',
  'counsel', 'lawyer', 'legal', 'paralegal', 'compliance officer',
  'anti.?financial crime', '\\bafc\\b', '\\baml\\b', '\\bsar\\b', '\\bkyc\\b',
  'information security', 'security engineer', 'soc analyst', '\\bgrc\\b',
  'creative', 'art direction', 'copywrit\\w+', 'design lead',
  // 'designer' alone excluded Curriculum Designer, which is instructional design
  // and squarely something VP could teach. Narrow it to the visual crafts.
  '(ux|ui|graphic|visual|product|industrial|motion) designer',
  'clinical', 'nurse', 'physician', 'quantitative',
  // A second round of leaks, each one observed in a real enqueue rather than
  // imagined. Keyword filtering is doing the job of a judgement call here and it
  // shows - if this list needs a third round, the right fix is to have the model
  // report a function-area FACT and gate on that in code, the way leadGen and geo
  // already work.
  '\\bsox\\b', '\\bsec analyst\\b', 'internal control', 'strategic finance',
  'renewals', 'pipeline excellence', 'account based marketing', '\\babm\\b',
  'deal desk', 'sales ops', 'order management', 'billing',
  'people ops', 'people operations', 'people business partner', 'hyperscaler', 'workplace experience', 'facilities',
  'procurement', 'vendor management', 'regulatory solutions', 'risk analyst',
  'collections', 'fraud analyst', 'customer excellence',
].join('|'), 'i');

const NOW_EXCLUDE = /\b(driver|courier|delivery|warehouse|cashier|retail associate|call cent(er|re)|customer service representative|software engineer|backend|frontend|full[- ]stack|data engineer|intern)\b/i;

export function titlePassesForTrack(track, title) {
  const t = String(title || '');
  if (track === 'teaching') return TEACHING_OK.test(t) && !NOT_TEACHING.test(t);
  if (track === 'nonprofit') return NONPROFIT_OK.test(t) && NONPROFIT_SENIOR.test(t);
  // Deliberately permissive: the brief is "few constraints, the important thing
  // is a good path to income".
  // Track E: a title gate, not a facts object. The city posts thousands of roles
  // and most are trades or clinical posts; this admits the product/program/tech
  // family and excludes the licensed trades outright.
  if (track === 'civic') {
    // `strateg\w*` rather than `strategy`: the city writes "Strategic Planning",
    // "Strategic Initiatives" and "Chief Strategy Officer", and the exact word
    // matched only the last of those. DOE's "Strategic Planning Consultant, DCP"
    // was dropped on that one letter.
    return /\b(product|program|project|digital|technology|data|analytics|innovation|service design|user experience|strateg\w*|transformation|chief of staff|advisor)\b/i.test(t)
      && !CIVIC_HARD_CREDENTIAL.test(t);
  }
  if (track === 'now') {
    // "Lead Designer" is a visual-design role and slipped through, because the
    // exclusion only listed qualified titles (UX Designer, Product Designer).
    // Any designer is out EXCEPT instructional design, which is teaching work
    // VP could genuinely do.
    const designer = /\bdesigner?\b/i.test(t) && !/\b(curriculum|instructional|learning)\b/i.test(t);
    return !NOW_EXCLUDE.test(t) && !NOW_TOOLING.test(t) && !NOW_WRONG_FIELD.test(t) && !designer;
  }
  return false;
}

// ── Facts, read off the posting ──────────────────────────────────────────

// The phrasing NY districts actually use is "seeking qualified candidates who
// hold New York State certification in Business" - no "must", no "required".
// Without that alternative the one hard Track C gate never fired on a
// tenure-track req VP is not legally eligible for, and it scored 4 on subject
// match alone (Harrison Central, verified).
const CERT_REQUIRED_RAW = /\b(must (hold|possess|have)|required to (hold|possess)|requires?)\b[^.]{0,60}\b(certif\w+|licens\w+)\b|\b(valid|current|active)\b[^.]{0,40}\b(certification|license)\b[^.]{0,30}\brequired\b|\bcertification required\b|\b(candidates|applicants|those|who) (who )?(hold|holding|possess|possessing)\b[^.]{0,50}\bcertification\b|\bcertification in\b[^.]{0,40}\b(is )?(required|preferred|necessary)\b/i;
const CERT_AFTER_HIRE_RAW = /\b(commit(ment)? to (obtain|earn|pursu|complet)\w*|willing(ness)? to (obtain|pursue)|path(way)? to certification|certif\w+ (within|after)\b|alternative certification|transitional [ABC]\b|we (will )?(support|sponsor|pay for)\b[^.]{0,40}certif|support (you )?(in|through)\b[^.]{0,30}certif|eligib\w+ for (NYS|New York State)\b[^.]{0,30}certif)/i;
// "no experience required" was an alternative here and was being read as "no
// certificate required" - two entirely different claims. Removed. Added the
// phrasing Success Academy actually uses: "Teaching certification and Master's
// degrees are not required for this role", which the old pattern could not parse,
// so all 28 of its requisitions scored 3.
const NO_CERT_NEEDED = /\bno (teaching )?(certification|license|credential)s? (is |are )?(required|necessary)\b|\bcertifications?\b[^.]{0,60}\b(are|is) not required\b|\bcertification not required\b|\bbachelor'?s degree (is all|is the only)\b|\bdo not need (a )?(teaching )?(certification|license|credential)\b/i;

// A teaching certificate, not any certificate. "requires current CPR
// certification" hard-rejected a Rocketship Elementary Teacher req to tier 1,
// while its identical sibling posting scored 3.
const CERT_NOT_TEACHING = /\b(CPR|first aid|AED|background check|fingerprint|food handler|driver'?s licen[cs]e)\b/i;

function certRequired(hay) {
  if (!CERT_REQUIRED_RAW.test(hay)) return false;
  // Re-read the matching sentence; if the only credential named is CPR or a
  // background check, this is not a teaching-certificate requirement.
  const sentences = String(hay).split(/(?<=[.!?])\s+/).filter((x) => /certif|licens|credential/i.test(x));
  const teachingOnes = sentences.filter((x) => !CERT_NOT_TEACHING.test(x));
  return teachingOnes.length > 0 && teachingOnes.some((x) => CERT_REQUIRED_RAW.test(x));
}

function certAfterHire(hay) {
  // Democracy Prep publishes a band starting "at $68,707 for a first-year
  // uncertified teacher" and words the requirement "Certification required (or
  // must be in progress)". Without this it scored 1 - a hard reject on an
  // employer that demonstrably hires uncertified teachers.
  return CERT_AFTER_HIRE_RAW.test(hay) || /\b(in progress|or must be in progress|currently enrolled|enroll in|working toward)\b[^.]{0,60}\b(certif\w+|credential|program)\b|\buncertified\b/i.test(hay);
}

// His MBA plus fifteen years of product map onto business, economics and
// technology. Anything else is a subject he would be teaching cold.
//
// Matched against the TITLE ONLY. Against the body it fired on almost every
// school posting - they all mention technology or business somewhere - which
// scored an Art Teacher and a PreK Assistant Teacher at 4, level with a
// Business Teacher. The subject is in the title or it is not established.
// NOTE the deliberate absence of \b before econom: the word boundary could not
// match "AP Macroeconomics", because there is no boundary between the o of Macro
// and the e of econom. That single character buried the best-fit Track C role in
// the corpus - Success Academy's AP Macroeconomics teacher, in NYC, whose body
// says certification is not required - at the same score as the Chess Teacher.
const SUBJECT_MATCH = /\b(business|marketing|entrepreneur\w*|finance|financial literacy|accounting|technology|computer science|CTE|career and technical|STEM|STEAM|information technology|project management|product management|management|innovation|leadership)\b|econom/i;

// The CTE clusters VP can claim on industry experience. Deliberately narrower
// than SUBJECT_MATCH: "management" and "leadership" make a role a good fit but do
// not by themselves make it a CTE title.
const CTE_SUBJECT = /\b(business|marketing|entrepreneur\w*|finance|financial literacy|accounting|information technology|computer science|CTE|career and technical|technology|tech ed)\b|econom/i;

// Per-course, temporary or covering work. Real, but not income replacement, and
// VP should see that difference in the number.
const UNSTABLE = /\b(substitute|leave replacement|per diem|per-diem|part[- ]time|interim|maternity|temporary|seasonal)\b/i;

const LEADERSHIP_TITLE = /\b(director|head of|chief|vp\b|vice president)\b/i;
const PRODUCT_SCOPE = /\b(product|platform|technology|engineering|digital|data)\b/i;

export function trackFacts(track, jd) {
  const body = String(jd?.body || '');
  const title = String(jd?.title || '');
  const hay = `${title}\n${body}`;

  if (track === 'teaching') {
    return {
      certRequired: certRequired(hay),
      certAfterHire: certAfterHire(hay),
      // Silence is the signal for the charters. Success Academy requires only a
      // bachelor's and never mentions certification at all, so testing for an
      // explicit "no certification required" scored it 3 - below the employers
      // that DO demand a certificate and merely offer to help you earn it. A NY
      // district that requires certification always says so.
      // The silence fallback must also see "credential" and "endorsement", or a
      // Rocketship req reading "must have a valid teaching credential" is scored
      // as needing no certificate at all. It is still a weak signal - an OLAS row
      // whose entire body is 109 characters gets it for free - so it is only ever
      // worth +1, never a gate.
      noCertNeeded: NO_CERT_NEEDED.test(hay) || !/\b(certif\w+|licens\w+|credential\w*|endorsement)\b/i.test(hay),
      subjectMatch: SUBJECT_MATCH.test(title),
      // Business Management & Administration is one of NYSED's 13 CTE clusters,
      // and the Business (CTE) title asks for "in-depth, comprehensive and
      // appropriate business-related (not clerical or support staff) work
      // experience" - which fifteen years of product leadership plainly is. That
      // matters for the gate below, because for a CTE subject the certificate is
      // obtained THROUGH being hired, not before it.
      cteEligible: CTE_SUBJECT.test(title),
      // Adjunct teaching IS per-course and part-time by definition - the mission
      // calls CUNY adjunct the only true "start now" path while noting it is a
      // give-back track, not income replacement. Penalising it for being
      // part-time double-counts something VP already knows and accepted.
      // Title only. Scanning the body matched "60,000 full- and part-time alumni"
      // in General Assembly's boilerplate - the alumni count, not the schedule.
      unstable: /\b(adjunct|lecturer)\b/i.test(title) ? false : UNSTABLE.test(title),
    };
  }
  if (track === 'nonprofit') {
    return {
      leadership: LEADERSHIP_TITLE.test(title),
      productScope: PRODUCT_SCOPE.test(title),
      unstable: UNSTABLE.test(title),
    };
  }
  if (track === 'civic') {
    return {
      // A published exam or eligible-list route is a POSITIVE: it is a defined
      // way in that does not depend on a hiring manager's shortlist.
      examPathway: CIVIC_PATHWAY.test(hay),
      // Product/program work he can actually do, versus a licensed trade.
      productScope: PRODUCT_SCOPE.test(title) || /\b(program manager|project manager|product manager|digital service|service design|technology)\b/i.test(title),
      leadership: LEADERSHIP_TITLE.test(title),
      hardCredential: CIVIC_HARD_CREDENTIAL.test(hay),
      // Serving a multilingual population is a genuine edge here: Portuguese
      // native, Spanish and French fluent, in the most multilingual city in the US.
      languageEdge: /\b(bilingual|multilingual|spanish|portuguese|french|language access|limited english)\b/i.test(hay),
    };
  }
  if (track === 'now') {
    return {
      // SPEED - the thing this track is actually ranked on.
      fastStart: NOW_TITLE.test(title),
      hiringUrgently: /\b(immediate start|start immediately|urgent(ly)? (hiring|needed)|hiring now|asap|as soon as possible|immediate opening)\b/i.test(hay),
      remote: /\bremote|anywhere|distributed|work from home\b/i.test(hay),

      // QUALIFICATION. VP's test is whether he could DO it, not whether the
      // title matches - but a professional specialism he has never practised
      // is a real no. Broadening the title filter surfaced Direct Tax Manager,
      // Compensation Manager and Information Security GRC at Brazilian offices:
      // all correctly not-product, all things he cannot do.
      wrongField: NOW_WRONG_FIELD.test(title),

      // QUALIFICATION - a gate he genuinely cannot pass, which is a different
      // thing from a role that merely does not match his job title.
      hardCredential: /\b(security clearance|ts\/sci|active clearance|must be licensed|licen[cs]ed (attorney|physician|nurse|cpa)|bar admission|registered nurse|medical degree|professional engineer)\b|\b(PhD|doctorate) (is )?required\b|requires? a (PhD|doctorate)\b/i.test(hay),

      // BONUS ONLY - these raise the score because they earn more or face less
      // competition. They must never gate. VP: helpful experience "should not
      // block others that I could still do and would hire quickly".
      seniorEnough: /\b(senior|staff|lead|principal|director|head|group|vp|chief|manager)\b/i.test(title),
      languageEdge: /\b(brazil|brasil|portuguese|português|latam|latin america|s[ãa]o paulo|rio de janeiro|mexico|m[ée]xico|spain|espa[nñ]a|spanish|france|french|fran[çc]ais|portugal|lisbon|colombia|argentina|chile|bilingual|multilingual)\b/i.test(hay),
    };
  }
  return {};
}

// ── Policy ───────────────────────────────────────────────────────────────
// Track B and C carry a ~$60K floor, not the $150K PM floor. VP set that
// explicitly, offered with uncertainty, on 2026-07-29.
const ALT_COMP_FLOOR = 60000;

/**
 * Track C. The hard constraint is that he can teach RIGHT AWAY, completing any
 * exam or licensure on his own time. A posting that requires a certificate he
 * does not hold, with no route to earn it after hire, fails that outright - no
 * subject fit or salary offsets it.
 */
export function scoreTeaching(f) {
  if (f.geo === 'onsite-elsewhere' || f.geo === 'hybrid-elsewhere') return 1;
  // A certification requirement is only disqualifying where no route lets him
  // start. Researched 2026-08-04 against NYSED: for a CTE subject there IS a
  // route, and it runs through the hire rather than before it. NYSED states it
  // plainly - "If a school district cannot find a certified business teacher to
  // fill a position, it is able to hire a person for what is called a
  // Transitional A certification" - which is valid three years, needs two years
  // of documented industry experience in the subject, and is nominated BY the
  // employing district. So "candidates who hold NYS certification in Business" is
  // a preference a district can waive, not a wall. Harrison Central was being
  // hard-rejected to tier 1 on exactly that sentence.
  //
  // For a NON-CTE subject - French, ELA, elementary - the route is Transitional
  // B/C, which requires a master's in education and the EAS and CST exams. That
  // is not "licensure in his own time" and it stays a gate.
  if (f.certRequired && !f.certAfterHire && !f.noCertNeeded && !f.cteEligible) return 1;

  let score = 3;
  if (f.noCertNeeded) score += 1;        // a true "start now" employer
  if (f.certAfterHire) score += 1;       // certify on the way, with support
  if (f.subjectMatch) score += 1;        // business / econ / tech - what he can teach
  // No penalty for needing Transitional A on a CTE subject. It is the designed
  // route for industry professionals, not an obstacle: NYSED asks two years of
  // documented experience and VP has fifteen. Charging a point for it put
  // Harrison Central - tenure-track Business, $79,299-$159,238, Metro-North - at
  // 3, below the queue line, which is the same silent burial this rubric exists
  // to end. It stays visible as a certRequired flag on the card instead, because
  // the district still has to agree to nominate him.
  if (f.unstable) score -= 1;            // substitute and leave-replacement work
  if (f.compLow != null && f.compLow < ALT_COMP_FLOOR) score -= 1;
  if (f.geo === 'unclear') score -= 1;

  // Tier 4 means "he should apply to this", so it is reserved for subjects he
  // can credibly stand in front of a class and teach - business, economics,
  // entrepreneurship, technology. Coney Island Prep's French and Marine Science
  // vacancies have an excellent certification route and are still jobs he cannot
  // do; without this they scored 4 on the strength of that route alone. Mirrors
  // the PM rubric's rule that a non-AI role cannot buy its way to 5.
  if (!f.subjectMatch) score = Math.min(score, 3);

  return Math.max(1, Math.min(5, score));
}

/**
 * Track B. Product skill applied somewhere with community impact. Seniority and
 * real product or technology ownership are what make one of these worth his
 * fifteen years; a coding screen is still disqualifying wherever it appears.
 */
/**
 * Track D — "Get Hired Now". Scored for time-to-income, not for fit with the NYC
 * search. VP set this one deliberately loose on 2026-08-04: no comp floor, no
 * archetype. Another country and another CURRENCY are the point, not a problem.
 * The only things that still disqualify are work he cannot do (a live-coding
 * screen) and hours-for-minimum-wage work, which is excluded by title before
 * scoring ever runs.
 *
 * ⚠ "No geography gate at all" was too broad, and it took VP asking the right
 * question to see it: this track scored QuintoAndar's "Staff Product Manager -
 * Growth" a 5 on geoRaw "Brasil" / geoModel "Remote (Brazil)" - remote WITHIN
 * Brazil - and put it top of his shortlist. He asked how he would actually
 * collect that income. He would not: it needs Brazilian work authorization and
 * residence. Time-to-income for a job he cannot be hired into is not 5, it is
 * never, so the number was meaningless rather than merely loose.
 *
 * The original brief conflated two different things, exactly as
 * enqueue-review.mjs already records: being PAID from elsewhere is fine, and is
 * what "another currency" meant; being REQUIRED TO RESIDE elsewhere is not, and
 * no amount of speed buys it back. `remote` and `languageEdge` were firing as
 * BONUSES on a role he is ineligible for, which is how it reached 5.
 *
 * The loose parts of the brief are untouched - no comp floor, no archetype, no
 * NYC-fit requirement, and a remote role for a foreign employer that pays a
 * Manhattan resident still scores exactly as it did.
 */
// Disciplines VP has never practised. This is the authoritative gate now; the
// keyword list in titlePassesForTrack stays only as a CHEAP PREFILTER, so an
// obvious non-starter never costs a ~34s scoring call. Four rounds of keyword
// exclusions taught the lesson - Deal Desk Analyst, Lead Designer, SOX PMO,
// Regional Sales Director, Systems Engineer, each caught one round late - that a
// regex cannot express "a job he could actually do". The model reports the
// discipline; the policy is here.
//
// Exported so rank-leads.mjs's normalizeFunctionArea can see which labels are
// EXPENSIVE to get wrong. A wrong benign label costs a point; a wrong label from
// this set deletes the role. The normalizer treats the two directions
// differently and needs this set to know which is which - one definition, not
// two copies drifting apart.
export const CANNOT_DO = new Set([
  'engineering', 'design', 'sales', 'marketing-demand', 'finance',
  'legal', 'hr', 'security', 'clinical', 'support',
]);

export function scoreNow(f) {
  // A role that REQUIRES living somewhere else is out on every track, full stop
  // (VP, 2026-08-10). This is the same first line every other scorer in this
  // file carries - scoreTeaching, scoreCivic and scoreNonprofit all have it, and
  // this function was the only exception. Being paid from elsewhere is fine;
  // being required to reside there is not. See the note above the function.
  if (f.geo === 'onsite-elsewhere' || f.geo === 'hybrid-elsewhere') return 1;

  // The only two things that disqualify are things he cannot do.
  // Gates on the CODE-VERIFIED fact, not the model's inference - see
  // lib/screen-evidence.mjs. The model set technicalScreen on 176 of 806 records
  // and none of those 176 postings stated a screen, so this was rejecting on a
  // guess. VP's rule is unchanged: a stated live-coding screen is still a hard 1.
  if (f.technicalScreenStated) return 1;   // cannot pass a live-coding screen
  // Two facts, both code-derived, OR'd rather than swapped. `hardCredential` is
  // the body-wide regex above; `credentialBlocked` is lib/credential-gate.mjs,
  // which is section-scoped, refuses to fire on a preference or an equivalency
  // clause, and stores the sentence it read in `credentialEvidence`. Dropping
  // the old one would be a silent relaxation, so it stays.
  if (f.hardCredential) return 1;    // a clearance or licence he does not hold
  if (f.credentialBlocked) return 1; // ...stated as required, with the sentence on the record
  if (f.functionArea && CANNOT_DO.has(f.functionArea)) return 1;  // a discipline he has never practised
  if (f.wrongField) return 1;        // cheap keyword backstop, kept as belt and braces

  // Base 2, not 3. On this track "he is qualified" is the entry price rather
  // than a recommendation - the score has to be earned by how fast it pays.
  let score = 2;

  // SPEED dominates. That is the whole point of the track.
  if (f.fastStart) score += 2;         // contract / fractional / interim / freelance
  else if (f.hiringUrgently) score += 2;
  if (f.remote) score += 1;            // no relocation, no commute, starts sooner

  // BONUSES, never gates. A role with none of these still reaches 4 on speed
  // alone, which is exactly what VP asked for.
  if (f.languageEdge) score += 1;      // far less competition in a PT/ES/FR market
  if (f.seniorEnough) score += 1;      // pays like fifteen years, not like two

  return Math.max(1, Math.min(5, score));
}

/**
 * Track E - civic / public sector.
 *
 * Deliberately NOT the PM rubric. Two of Track A's strongest signals are wrong
 * here and would bury the whole track:
 *   - aiNative: a city agency is almost never "AI-native", and VP is not looking
 *     for that here. Scoring its absence would cap every civic role at 3.
 *   - the $150K floor: public pay scales sit below it by design, and VP said
 *     plainly he is "not so hard coded on a salary number" for work that helps
 *     people. Applying a commercial floor to a civil-service band is a category
 *     error, so comp only ever ADDS here and never subtracts.
 *
 * What it does keep from Track A are the absolute gates - a live-coding screen
 * and a geography he cannot work are disqualifying wherever the role sits.
 */
export function scoreCivic(f) {
  if (f.geo === 'onsite-elsewhere' || f.geo === 'hybrid-elsewhere') return 1;
  if (f.technicalScreenStated) return 1;
  if (f.level === 'below') return 1;
  // A licensed trade is a real wall; a civil-service exam is not (see below).
  if (f.hardCredential) return 1;
  // Same OR as scoreNow. ⚠ This is the track where the two facts disagree most:
  // NYC job specs are numbered EQUIVALENCY LADDERS, and the licence is usually
  // one route among several rather than a bar. credential-gate declines those
  // on purpose and blocks only a standing condition — DOT's "Current New York
  // State registration as a Professional Engineer must be maintained for the
  // duration of your employment" — so it will flag roles hardCredential misses
  // and stay quiet on ones it fires at.
  if (f.credentialBlocked) return 1;
  // A discipline he has never practised, the same fact and the same set as
  // scoreNow and scoreNonprofit. Added 2026-08-11: Track E was the last rubric
  // with no discipline check, and its title filter admits `data` and `analytics`
  // by design, so the city's data-science and developer postings walked straight
  // in. Measured over the corpus it was carding NINE of them at tier 4 - two
  // "Appian Developer - Software & Data Management" (DOF: "hands-on designing,
  // coding, and testing of new applications"), three "Data Scientist" postings
  // at DOT and DCWP ("fluent in Python and GIS"), and DOHMH's "Director of
  // Applied Data Science and Solutions" ("Act as lead or supporting sql
  // developer, python developer, or data scientist for any project"). Each of
  // those would have had a tailored CV staged against it.
  //
  // A civil-service EXAM is still a path in and not a barrier - that is
  // examPathway below, and this gate does not touch it. This is about the
  // discipline, not the hiring mechanism.
  if (f.functionArea && CANNOT_DO.has(f.functionArea)) return 1;

  let score = 3;
  if (f.productScope) score += 1;          // work he can actually do
  if (f.leadership) score += 1;
  // An exam or eligible-list route is an ADVANTAGE, not a hurdle: VP named it as
  // part of the appeal. This is the line that most distinguishes Track E.
  if (f.examPathway) score += 1;
  if (f.languageEdge) score += 1;          // trilingual, serving NYC
  // No bonus for being in NYC: a city job is in the city by definition, so it
  // would be a free point on every role and would saturate the scale. Geography
  // is already an absolute gate above. Calibrated 2026-08-10 after a plain NYC
  // product role and one with an exam pathway AND the language edge both scored 5.
  if (f.compLow != null && f.compLow >= 120000) score += 1;    // adds, never subtracts
  if (f.geo === 'unclear') score -= 1;

  return Math.max(1, Math.min(5, score));
}

export function scoreNonprofit(f) {
  if (f.geo === 'onsite-elsewhere' || f.geo === 'hybrid-elsewhere') return 1;
  // Same absolute rule as Track A: he cannot pass a live-coding screen, and the
  // mission says such a role is not a candidate however good the fit. Track B
  // was missing every Track A gate, which is what made a misrouted commercial
  // role able to reach 5 here.
  if (f.technicalScreenStated) return 1;   // evidence, not inference — as Track A
  if (f.credentialBlocked) return 1;   // a stated licence he cannot hold, as Track A
  if (f.level === 'below') return 1;   // not entry level, same as Track A
  // A discipline he has never practised, using the SAME code-normalised fact and
  // the same set as scoreNow. Added 2026-08-11 alongside the NONPROFIT_OK
  // widening above, and it is the reason that widening is safe: `strateg` admits
  // "Senior Strategic Finance Manager" (DonorsChoose) and "Manager of Strategic
  // Finance" (charity: water), `data` admits analytics roles, and Track B had no
  // function gate of any kind - only a screen, a credential and a level check.
  // Track A rejects marketing-demand this way and Track D rejects all ten; Track
  // B being the one rubric with no discipline check was an oversight, not a
  // policy. Note this is NOT a comp floor: VP said explicitly not to apply the PM
  // rubric's $150K floor here, and none is applied.
  if (f.functionArea && CANNOT_DO.has(f.functionArea)) return 1;

  let score = 3;
  if (f.leadership) score += 1;
  if (f.productScope) score += 1;
  if (f.compLow != null && f.compLow >= 120000) score += 1;
  if (f.compLow != null && f.compLow < ALT_COMP_FLOOR) score -= 1;
  if (f.unstable) score -= 1;
  if (f.geo === 'unclear') score -= 1;

  return Math.max(1, Math.min(5, score));
}
