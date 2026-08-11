/**
 * lib/credential-gate.mjs — a licence, clearance or registration VP cannot get
 * in time, read out of the POSTING rather than guessed by the model.
 *
 * `scoreNow` and `scoreCivic` both carry the line
 *
 *     if (f.hardCredential) return 1;    // a clearance or licence he does not hold
 *
 * and it is the fourth gate in this repo to be measured and found dead. The
 * measurement, over all 1,358 records in data/lead-scores.json on 2026-08-11:
 *
 *   hardCredential true 14 | false 173 | ABSENT ENTIRELY 1,171 (86%)
 *
 * and the 1,171 split perfectly by track — pm 839, teaching 121, nonprofit 4,
 * untracked 207. Every one of the 187 records that HAS the field is `now` or
 * `civic`, the only two tracks whose `trackFacts()` computes it. So the true
 * finding is sharper than "the model does not fill it in": the model is NEVER
 * ASKED. `hardCredential` is not one of the ten keys SYSTEM_PROMPT requests, and
 * `scoreFromFacts` — the Track A rubric that scores 839 of the records — has no
 * credential gate at all. Nothing was reading a null; there was no field and no
 * gate.
 *
 * What the postings DO say was measured the same day: 33 records name a licence,
 * certification, clearance or registration in their own `redFlags`/`verdict`
 * prose, 30 of them on a track where nothing could ever have fired, and six of
 * those thirty sit at 4 or 5 in VP's shortlist.
 *
 * So this module supplies the fact, deterministically, the way
 * lib/screen-evidence.mjs supplies `technicalScreenStated` and lib/skill-gate.mjs
 * supplies `skillBlocked`:
 *
 *   the posting STATES the credential is required -> gate to 1
 *   the posting merely MENTIONS or prefers it     -> warn on the card, cost nothing
 *
 * ── Why this one is tuned harder toward precision than skill-gate ──
 *
 * A false block here is invisible. The role drops to tier 1, never reaches the
 * review queue, and VP never learns it existed — the exact silent burial that
 * cost this repo a $240K Google GenAI GPM role through `technicalScreen`. And
 * the vocabulary is far more treacherous than a skill name: this is a PRODUCT
 * MANAGER search, so "licence" is overwhelmingly a SaaS noun ("per-seat
 * licensing", "licence revenue", "licensed under Apache 2.0"), "PE" is private
 * equity, "MD" is Maryland or a Managing Director, "JD" is the job description
 * itself, "FSA" is the benefits blurb, "CPA" is cost per acquisition, and "bar"
 * is something you raise. Every one of those is in the corpus.
 *
 * Three defences, in order:
 *   1. NO GENERIC "certification required" PATTERN. Only NAMED credentials
 *      match. That alone removes the whole PMP / CSM / AWS / Six Sigma / SAFe /
 *      CIPP class, which is trainable, common, and would gut the pipeline.
 *   2. Every ambiguous abbreviation carries a `guard` — a second regex that must
 *      also match the same sentence — so `CPA` only counts beside accounting or
 *      licensure words, and `PE` only as "PE license" / "professional engineer".
 *   3. A NOT_A_CREDENTIAL context test kills the sentence outright when the word
 *      "licence" is being used commercially or about driving.
 *
 * ── What blocks, and what deliberately does not ──
 *
 * BLOCKS (VP cannot hold one of these within a hiring cycle): security
 * clearance, customs broker licence, CPA, bar admission / attorney licensure,
 * Professional Engineer, clinical licensure (RN/MD/PharmD/LCSW…), FINRA Series
 * registrations, actuarial fellowship, CDL, and an explicitly ACTIVE state
 * professional licence of any profession.
 *
 * DOES NOT BLOCK, by name and on purpose: PMP, CSM/PSM/SAFe/Scrum, AWS/Azure/GCP
 * certifications, Six Sigma, CIPP/CIPM, Google Analytics, ITIL, Salesforce.
 * These are weeks of study, most senior PMs pick them up on the job, and gating
 * on them would delete a large slice of the board for no real barrier.
 *
 * TEACHING CERTIFICATION IS ABSENT ON PURPOSE. `scoreTeaching` already has a
 * researched, NYSED-specific answer (Transitional A is obtained THROUGH the hire
 * for a CTE subject, so "must hold NYS Business certification" is a preference a
 * district can waive) and it took a live casualty — Harrison Central — to get
 * right. A blunt credential gate firing on the same sentence would undo that
 * work, so the word "teaching certificate" is not in this file and this fact is
 * not wired into Track C.
 */

// ── Section scoping ────────────────────────────────────────────────────────
// Same shape as lib/skill-gate.mjs, and DELIBERATELY a separate copy rather than
// an import. skill-gate's heading vocabulary is tuned against a different set of
// live casualties, and widening it (this file needs "What You Bring", the
// heading KlearNow puts its broker-licence sentence under) would silently change
// which sections count as "required" for the SKILL gate too. Two gates, two
// vocabularies, no shared blast radius.
const PREFERRED_HEAD = /^\s*(?:#+\s*)?\**\s*(?:preferred|nice[- ]to[- ]have|bonus|plus(?:es)?|desirable|good to have|it'?s a plus|additional|we'?d love|even better|extra credit)\b/im;
// "About the Must Haves" is Karthik Consulting's heading over "Active Secret
// security clearance", and the leading "About the" is why that section read as
// unclassified and the clearance requirement was missed.
const REQUIRED_HEAD = /^\s*(?:#+\s*)?\**\s*(?:about\s+the\s+)?(?:requirements?|required|minimum|basic qualifications?|must[- ]?haves?|qualifications?|what you(?:'ll| will)? need|what you(?:'ll| will)? bring|who you are|what we(?:'re| are) looking for|skills? (?:&|and) experience|about you|your background|experience (?:&|and) qualifications|clearance)\b/im;

function sections(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let cur = { kind: 'unknown', text: '' };
  for (const line of lines) {
    const isPref = PREFERRED_HEAD.test(line);
    const isReq = !isPref && REQUIRED_HEAD.test(line);
    if ((isPref || isReq) && line.trim().length <= 90) {
      if (cur.text.trim()) out.push(cur);
      cur = { kind: isPref ? 'preferred' : 'required', text: '' };
    }
    cur.text += line + '\n';
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}

// ── Language tests ─────────────────────────────────────────────────────────

// The posting saying, in the sentence itself, that it is not optional. A
// heading can supply this instead; see verdict() below.
const REQ_WORDS = /\b(?:is required|are required|required\b|must (?:have|hold|possess|be|maintain|obtain)|you must|requires? (?:an?|the|active|current|valid)|mandatory|non[- ]negotiable|only candidates with|candidates? must)\b/i;

// The posting saying it is optional — this is the whole reason the gate is
// evidence-based. KlearNow's "A US broker license (or the field-earned
// equivalent) is a strong plus" is the live example: the model's redFlags prose
// reported it as "Requires ... US broker license", the posting says "plus".
const SOFT_WORDS = /\b(?:preferred|preference|nice to have|nice[- ]to[- ]have|a (?:strong |big |huge |major )?plus|plus\b|bonus|desirable|ideally|would be great|helpful|advantageous|familiarity|exposure to|we'?d love|not required|no(?:t)? necessary|willing(?:ness)? to obtain|abilit(?:y|ies) to (?:\w+ )?obtain|able to (?:\w+ )?obtain|eligib\w+ to (?:\w+ )?obtain|we (?:will )?(?:sponsor|support|pay for)|or (?:the )?(?:field[- ]earned )?equivalent|equivalent (?:experience|work experience|practical experience)|or comparable|may be required|if (?:you are|applicable|required)|depending on the (?:position|role)|some (?:roles|positions))\b/i;

// Text that is not the employer describing THIS job. Compensation philosophy,
// EEO and federal-notice footers, and benefits blurbs all contain the words
// "required" and "clearance" and neither states nor implies a requirement.
// Karthik Consulting's pay paragraph — "compensation based on the
// responsibilities of the role, required qualifications, security clearance
// level, relevant experience, certifications..." — was reading as a stated
// clearance requirement on a role that never asked for one.
const BOILERPLATE = /\b(?:compensation|salary\s+range|pay\s+(?:range|transparency|scale)|base\s+pay|equal\s+(?:employment\s+)?opportunit|EEO\b|affirmative\s+action|without\s+regard\s+to|reasonable\s+accommodation|applicants?\s+have\s+rights|poster\b|benefits\s+(?:include|package)|401\(k\))/i;

// The employer saying the credential is NOT needed. MongoDB's Staff PMM prints
// "No security clearance or prior government employment required" as a selling
// point, and the naive read of that sentence is a stated clearance requirement —
// a perfect inversion.
const NEGATED = /\b(?:no|not|never|without|do(?:es)?\s+not|don'?t|neither)\s+(?:\w+\s+){0,3}(?:clearance|licen[cs]|certif|registration|credential|admission|required)/i;

// An ALTERNATIVE ROUTE, not a requirement. NYC civil-service specs are written
// as numbered equivalency ladders — "An accredited Master's degree ..., a law
// degree, or a valid New York State license as a Professional Engineer ... may
// be substituted for one year of the experience" — and six DDC/NYCHA postings
// read as hard licence requirements on exactly that sentence. The licence is one
// of several ways to satisfy the spec, and the others are ways VP already
// satisfies it.
const EQUIVALENCY = /\b(?:may\s+be\s+substituted|substitut\w+\s+for|in\s+lieu\s+of|credit\s+will\s+be\s+given|as\s+described\s+in\s+["“']?\d|one\s+of\s+the\s+following|any\s+(?:one\s+)?of\s+the\s+above|or\s+an?\s+equivalent)\b/i;

// A LIST OF ACCEPTABLE DEGREES is not a licensure requirement, the same rule
// lib/skill-gate.mjs applies when "Statistics" appears in a list of majors. Only
// consulted when the thing that matched is itself degree-shaped ("law degree",
// "Juris Doctor", "M.D. degree") — a real "Bachelor's in Accounting and an
// active CPA license" must still block, so this cannot be applied globally.
const DEGREE_LIST = /\b(?:bachelor|master|b\.?s\.?|m\.?s\.?|m\.?b\.?a\.?|ph\.?d|degree|major(?:ed)? in|field of study)\b[^.]{0,140}\bin\b|\bdegree in\b/i;
const DEGREE_SHAPED = /\b(?:degree|juris\s+doctor|doctor\s+of)\b/i;

// SOMEBODY ELSE holds the credential. Blackstone's "Supervising or training
// securities licensed employees" is a list of activities that would TRIGGER a
// registration for the person doing them, not a qualification bar on this
// requisition — and the same shape covers "we serve licensed customs brokers"
// and "you will support licensed clinicians". The candidate is not the licensee.
// Only COLLECTIVE nouns for a workforce or a customer base. Occupational nouns
// are deliberately absent: "a licensed customs broker" is the candidate in a
// customs-brokerage requisition, and putting `brokers?` here silently disarmed
// the credential it exists to catch.
const THIRD_PARTY = /\b(?:licen[cs]ed|registered|certified|cleared)\s+(?:\w+\s+){0,2}(?:employees?|staff|personnel|team members?|colleagues?|users?|customers?|clients?|partners?|contractors?|firms?|companies|organi[sz]ations?|workforce)\b/i;

// A disclaimer about the posting rather than a statement about the job. The
// Blackstone BXCI req closes its securities-licensing section with "Note: The
// above list is not the exhaustive list of activities requiring securities
// licenses and there may be roles that require review on a case-by-case basis",
// which is legal hedging, not a bar on this requisition.
const DISCLAIMER = /\b(?:case[- ]by[- ]case|not (?:an?|the) exhaustive|non[- ]exhaustive|the above list|for informational purposes|^\s*note:)/i;

// The word "licen[cs]e" doing a job that has nothing to do with professional
// licensure. Any of these in the sentence and the sentence is discarded, no
// matter what else matched. Every entry below was chosen against real corpus
// text: driving is the classic false positive, and everything after it is
// ordinary SaaS vocabulary in a product-manager search.
const NOT_A_CREDENTIAL = /\b(?:driver'?s?|driving|chauffeur)\s+licen[cs]e|\blicen[cs]e\s+(?:agreement|key|plate|fee|term|revenue|model|management|compliance|renewal|utilization|utilisation|count|seat|tier)|\b(?:software|open[- ]source|source[- ]code|content|technology|patent|music|brand|trademark|data|api|enterprise|per[- ]seat|seat|user|floating|perpetual|subscription|product|volume)\s+licen[cs]|\blicen[cs]ed\s+(?:under|technology|content|material|software|product|from)\b|\b(?:mit|apache|gpl|bsd|creative commons)\s+licen[cs]e|\blicen[cs]ing\s+(?:model|revenue|agreement|term|deal|strategy|partner)/i;

// ── The credentials themselves ─────────────────────────────────────────────
// `re` must match. `guard`, when present, must ALSO match the same sentence —
// it exists purely to disarm an abbreviation that is a common English word or a
// common business term. Nothing here is generic: a credential that is not on
// this list cannot block, by construction.
const CREDENTIALS = [
  {
    name: 'security clearance',
    // "Public Trust" and "Secret" are only credentials next to the word
    // clearance; "top secret" alone appears in prose about confidentiality.
    // ⚠ Bare `polygraph` was here and matched the "Employee Polygraph Protection
    // Act (EPPA) Poster" line in Elastic's federal-notices footer — 25 flags,
    // every one of them the same boilerplate, on roles with no clearance
    // requirement whatsoever. A statutory poster is not a job requirement.
    re: /\b(?:ts\/sci|tssci|top[- ]secret\s*(?:\/\s*sci)?\s+clearance|sci\s+clearance|secret\s+clearance|security\s+clearance|public\s+trust\s+(?:security\s+)?clearance|dod\s+clearance|government\s+clearance|active\s+clearance|q\s+clearance)\b/i,
  },
  {
    name: 'customs broker licence',
    re: /\b(?:licensed\s+customs\s+broker|customs\s+(?:house\s+)?broker(?:'s|s')?\s+licen[cs]e|customs\s+brokerage\s+licen[cs]e|us\s+broker\s+licen[cs]e|broker'?s?\s+licen[cs]e|\bLCB\b)\b/i,
  },
  {
    name: 'CPA',
    // "CPA" is cost-per-acquisition in half the marketing JDs in this corpus.
    re: /\b(?:certified\s+public\s+accountant|CPA)\b/i,
    guard: /\b(?:certified\s+public\s+accountant|licen[cs]\w*|certifica\w+|account(?:ing|ant)|audit\w*|CPA\s+(?:licen|certif|designation|credential|required))/i,
  },
  {
    name: 'bar admission / attorney licensure',
    // Never bare "JD" — in a job-description corpus that abbreviation is the
    // document itself — and never bare "bar", which is a thing you raise.
    //
    // ⚠ `LL.M.` WAS IN THIS LIST AND IT MATCHED "LLM". Measured over jds/ before
    // removal: 44 of 74 total flags were the Master of Laws pattern firing on
    // "LLM-based tools", "LLM/agent features", "LLM-as-judge" — i.e. it would
    // have hard-rejected Webflow, Brex, Spotify, Google Gemini and Databricks,
    // every one of them a tier-5 AI-native role and the exact thesis of this
    // search. It is the single worst false positive available in this corpus and
    // it must never come back. An LL.M. is not disqualifying on its own anyway.
    re: /\b(?:bar\s+admission|admission\s+to\s+(?:the\s+)?(?:[a-z ]{0,25})?bar\b|admitted\s+to\s+(?:the\s+)?(?:[a-z ]{0,20}\s+)?bar\b|member(?:ship)?\s+(?:in\s+good\s+standing\s+)?(?:of|in)\s+(?:the\s+)?[a-z ]{0,20}bar\b|active\s+bar\s+(?:licen[cs]e|membership|status)|licensed\s+(?:to\s+practice\s+law|attorney|lawyer)|juris\s+doctor|\bJ\.D\.\s+(?:degree|required)|law\s+degree)\b/i,
  },
  {
    name: 'Professional Engineer licence',
    // "PE" on its own is private equity. Only the spelled-out title or an
    // explicit "PE licence/licensure/stamp" counts.
    re: /\b(?:professional\s+engineer(?:ing)?\s+(?:licen[cs]\w+|registration|certification)|licensed\s+professional\s+engineer|(?:registration|licen[cs]ure|licen[cs]ed|registered)\s+as\s+an?\s+professional\s+engineer|\bP\.?E\.?\s+(?:licen[cs]\w+|registration|stamp)|\bF\.?E\.?\s*\/\s*P\.?E\.?)\b/i,
  },
  {
    name: 'architect registration',
    // NYC DDC posts these constantly and they are real state licensure. The
    // numbered-ladder guard below is what keeps them honest: the same words
    // appear as requirement ("Current New York State Registration as an
    // Architect must be maintained for the duration of your employment") and as
    // one option among several in a qualification ladder.
    re: /\b(?:registered\s+(?:landscape\s+)?architect|registration\s+as\s+an?\s+(?:landscape\s+)?architect|licensed\s+architect|architect(?:ural)?\s+licen[cs]\w+)\b/i,
  },
  {
    name: 'clinical licensure',
    // "MD" is Maryland and Managing Director; "RN" and "PA" are worse. Every
    // abbreviation here is anchored to a licensure word by the regex itself.
    re: /\b(?:registered\s+nurse|licensed\s+practical\s+nurse|\bRN\s+licen[cs]\w+|nursing\s+licen[cs]\w+|medical\s+licen[cs]\w+|licensed\s+physician|doctor\s+of\s+medicine|\bM\.?D\.?\s+(?:degree|licen[cs]\w+)|pharm\.?\s?d\.?\b|pharmacist\s+licen[cs]\w+|licensed\s+clinical\s+social\s+worker|\bLCSW\b|\bLMFT\b|\bLMSW\b|nurse\s+practitioner\s+licen[cs]\w+|physician\s+assistant\s+licen[cs]\w+|\bDEA\s+registration|board[- ]certified\s+(?:physician|nurse|pharmacist)|clinical\s+licen[cs]ure|licensed\s+(?:therapist|counselor|counsellor|psychologist))\b/i,
  },
  {
    name: 'FINRA / securities registration',
    re: /\b(?:series\s*(?:7|63|65|66|24|79|3|4|9|10)\b|FINRA\s+(?:licen[cs]\w+|registration|registered)|FINRA[- ]registered|securities\s+licen[cs]\w+|\bSIE\s+exam)\b/i,
    // "Series 7" is unambiguous, but "Series 3" would collide with a funding
    // round if rounds were numbered; they are lettered, so the only real risk is
    // a product "Series 7" (a hardware line). Requiring a registration word
    // nearby costs nothing and removes it.
    guard: /\b(?:licen[cs]\w*|registr\w+|registered|FINRA|broker[- ]dealer|securities|exam)\b/i,
  },
  {
    name: 'actuarial fellowship',
    // NO bare FSA or ASA. "FSA" is in the benefits paragraph of a large share of
    // US postings ("medical, dental, vision, FSA/HSA") and would have been a
    // guaranteed false positive on roles with nothing actuarial about them.
    re: /\b(?:fellow\s+of\s+the\s+society\s+of\s+actuaries|associate\s+of\s+the\s+society\s+of\s+actuaries|actuarial\s+(?:fellowship|credential|designation|exams?)|\bFSA\s+(?:designation|credential)|\bASA\s+(?:designation|credential))\b/i,
  },
  {
    name: 'commercial driver licence (CDL)',
    re: /\b(?:commercial\s+driver'?s?\s+licen[cs]e|\bCDL\b(?:[- ]?[A-C])?)\b/i,
  },
  {
    name: 'active professional licensure',
    // The only pattern here that is not a named credential, and it is kept
    // narrow on purpose: the posting must say the licence is ACTIVE / CURRENT /
    // VALID / UNRESTRICTED, which nobody writes about a software licence or a
    // certificate of completion. NOT_A_CREDENTIAL still applies on top.
    re: /\b(?:active|current|valid|unrestricted|in\s+good\s+standing)\s+(?:[a-z]{1,15}\s+){0,3}licen[cs](?:e|ure)\b/i,
  },
];

// Credentials that must NEVER block. Not consulted at runtime — nothing here can
// match a CREDENTIALS entry — but written down because the list is the policy,
// and because test-credential-gate.mjs asserts every one of them.
export const NEVER_BLOCK = [
  'PMP', 'CAPM', 'CSM', 'PSM', 'SAFe', 'Scrum Master', 'Six Sigma',
  'AWS Certified', 'Azure certification', 'Google Cloud certification',
  'CIPP', 'CIPM', 'Google Analytics certification', 'ITIL', 'Salesforce certified',
  'Pragmatic Institute', 'Product School',
];

// ── Sentence extraction ────────────────────────────────────────────────────
// The evidence has to be quotable, because a human has to be able to overrule
// this gate by reading one line. Bounded on both sides by sentence punctuation
// or a newline, since these bodies are markdown bullets as often as prose.
/**
 * A NYC civil-service QUALIFICATION LADDER — "1. A baccalaureate degree ... 2.
 * ... 3. A valid New York State Registration as an Architect." — where the
 * numbered items are ALTERNATIVE ways to qualify, not a list of requirements.
 * These specs make up most of the civic track, and reading item 3 as a hard
 * licensure requirement rejects a role VP can qualify for through item 1.
 *
 * A ladder needs at least two numbered options to be a ladder. An item that
 * says "must" is exempt: DOT writes "Current New York State registration as a
 * Professional Engineer must be maintained for the duration of your employment"
 * as a standing condition of the job, and that is a genuine wall.
 */
function inEquivalencyLadder(text, idx) {
  const numbered = text.match(/^\s*\d+\.\s+\S/gm) || [];
  if (numbered.length < 2) return false;
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  let lineEnd = text.indexOf('\n', idx); if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  if (!/^\s*\d+\.\s/.test(line)) return false;
  return !/\bmust\b/i.test(line);
}

function sentenceAt(text, idx, len) {
  let a = idx;
  while (a > 0 && !/[.!?\n]/.test(text[a - 1])) a--;
  let b = idx + len;
  while (b < text.length && !/[.!?\n]/.test(text[b])) b++;
  return { start: a, end: b, sentence: text.slice(a, b).replace(/\s+/g, ' ').trim() };
}

/**
 * Decide required vs preferred for one match.
 *
 * A heading wins, exactly as in skill-gate. Where there is no heading the
 * sentence's own words decide, and — unlike skill-gate — AMBIGUITY DOES NOT
 * BLOCK. skill-gate can afford to warn on ambiguity because its vocabulary is
 * unambiguous once matched; here the words themselves are the risk, so a
 * credential named without any requirement language at all is reported and not
 * gated.
 */
function verdict(kind, window) {
  if (SOFT_WORDS.test(window)) return 'preferred';
  if (kind === 'preferred') return 'preferred';
  if (kind === 'required') return 'required';
  return REQ_WORDS.test(window) ? 'required' : 'mentioned';
}

/**
 * @param {string} jdText  the JD body (title + body is fine)
 * @returns {{blocked:boolean, credential:string|null, evidence:string,
 *            warned:Array<{credential:string, evidence:string, why:string}>}}
 *
 * `blocked` is true only when the posting STATES the credential is required.
 * `evidence` is the verbatim sentence, trimmed, so the decision can be audited
 * and reversed by hand. `warned` carries the credentials that were named but not
 * required, so the card can say "they mention a CPA" without costing the role a
 * single point.
 */
export function detectHardCredential(jdText) {
  const warned = [];
  // Every usable occurrence of every credential, then resolved once per
  // credential. skill-gate stops at the first hit; that is wrong here, and the
  // corpus proved it: Karthik Consulting names "Active Secret security
  // clearance" in a bullet and then "**Clearance:** TS/SCI (required)" in its
  // footer, and first-hit-wins let the bare bullet warn and threw the explicit
  // requirement away. Resolution order is required > preferred > mentioned.
  //
  // Note the asymmetry, which is deliberate: softening is judged PER OCCURRENCE,
  // so "a US broker license or the field-earned equivalent is required" is
  // preferred (the exemption is in the same breath), while a soft mention in one
  // place cannot cancel an explicit requirement stated in another.
  const found = new Map();
  for (const { kind, text } of sections(jdText)) {
    for (const cred of CREDENTIALS) {
      const scan = new RegExp(cred.re.source, cred.re.flags.replace('g', '') + 'g');
      let m;
      while ((m = scan.exec(text)) !== null) {
        const { sentence, end } = sentenceAt(text, m.index, m[0].length);
        // The sentence decides whether the word is a credential at all...
        if (NOT_A_CREDENTIAL.test(sentence)) continue;
        if (BOILERPLATE.test(sentence)) continue;
        if (NEGATED.test(sentence)) continue;
        if (EQUIVALENCY.test(sentence)) continue;
        if (THIRD_PARTY.test(sentence)) continue;
        if (DISCLAIMER.test(sentence)) continue;
        if (inEquivalencyLadder(text, m.index)) continue;
        if (DEGREE_SHAPED.test(m[0]) && DEGREE_LIST.test(sentence)) continue;
        if (cred.guard && !cred.guard.test(sentence)) continue;
        // ...but a softening clause frequently TRAILS it ("... is a strong
        // plus", "... or equivalent experience"), and these bodies are markdown
        // bullets whose punctuation splits mid-thought, so look a little past.
        const window = (sentence + ' ' + text.slice(end, end + 120)).replace(/\s+/g, ' ');
        const v = verdict(kind, window);
        const rank = { required: 3, preferred: 2, mentioned: 1 }[v];
        const prev = found.get(cred.name);
        if (!prev || rank > prev.rank) {
          found.set(cred.name, { rank, why: v, credential: cred.name, phrase: m[0], evidence: sentence.slice(0, 240) });
        }
      }
    }
  }

  let hit = null;
  for (const r of found.values()) {
    if (r.why === 'required') { if (!hit) hit = r; }
    else warned.push({ credential: r.credential, evidence: r.evidence, phrase: r.phrase, why: r.why });
  }

  return hit
    ? { blocked: true, credential: hit.credential, evidence: hit.evidence, phrase: hit.phrase, warned }
    : { blocked: false, credential: null, evidence: '', phrase: null, warned };
}
