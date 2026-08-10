/**
 * lib/product-ownership.mjs — how close is this role to the product itself?
 *
 * `modes/_profile.md` opens with the axis this file exists to measure:
 * "Scoring axis: CLOSENESS TO PRODUCT, not title height. A Senior IC with direct
 * product ownership beats a VP managing managers, even at higher comp."
 * Nothing implemented it. The scorer used the job TITLE as a stand-in until
 * 2026-08-10, which is what VP threw out.
 *
 * ⚠ IT SCORES NOTHING. It is a card flag. That is deliberate, and the reason is
 * measured, not cautious: a body-wide keyword test for the same idea fired on
 * 50% of the roles VP approved and 33% of the ones he rejected, against a 29%
 * base rate - barely distinguishable from chance - and disagreed with ITSELF on
 * 13% of requisitions that were scraped twice. It also fired on "hands-on
 * experience with AWS" (a requirement, not the role), on a school named
 * "Founding", and on a film teacher's posting about STUDENTS' hands-on
 * exercises. Anything scoring off that would have buried good roles silently.
 *
 * So this ships as evidence first. Two rules make it auditable:
 *
 *   1. SENTENCE-SCOPED. A signal only counts inside a sentence written in ROLE
 *      VOICE ("you will...", "in this role you..."). That single restriction is
 *      what separates "you will be hands-on with the roadmap" from "hands-on
 *      experience with Kubernetes required", which body-wide matching could not.
 *   2. IT STORES THE SENTENCE IT FIRED ON. Every verdict carries the verbatim
 *      text that produced it, the same discipline as lib/screen-evidence.mjs.
 *      A wrong flag can be SEEN rather than inferred.
 *
 * It earns a score term only once it demonstrably separates VP's approvals from
 * his rejections. Today there are 9 approvals on record, which is not enough to
 * establish that. Do not promote it on vibes.
 */

// Role voice: the posting talking about what the HIRE does, not what the
// applicant must already have. Requirement bullets are the noise source.
const ROLE_VOICE = /\b(?:you(?:'ll|'re| will| would| can expect)?|in this role|as (?:the|our) [^,.;]{2,60},? you|the (?:successful )?candidate will|this role (?:will )?own|your (?:day|week|remit|mandate|charter))\b/i;

// Managing managers. _profile.md rejects this shape by name, independent of title.
const MANAGES_MANAGERS = /\b(?:manager[s]? (?:who |that )?report|managing managers|leaders? of leaders|team of (?:senior )?managers|manage (?:a team of )?(?:people )?managers|second.line manager)\b/i;

// Player-coach / still-shipping. _profile.md's Upscore list, verbatim.
const PLAYER_COACH = /\b(?:player.coach|hands.on (?:leader|manager|owner|product|role)|\bIC\+|roll up (?:your|the) sleeves|still (?:ship|build|code|write)|wear (?:many|multiple) hats|individual contributor)\b/i;

// Direct ownership of a NAMED surface, versus a portfolio. _profile.md:
// "Specific product surface owned (not a 'portfolio of products')".
const OWNS_SURFACE = /\bown(?:s|ing)?\b[^.;]{0,40}\b(?:the )?(?:end.to.end |full |entire )?(?:product|roadmap|surface|charter|backlog|strategy)\b/i;
const PORTFOLIO = /\b(?:portfolio of products|multiple product lines|suite of products|family of products)\b/i;

// "a team of 12", "8 direct reports", "15+ PMs"
const DIRECTS = /\b(?:team of|leading|manage[s]?|grow)\s+(?:a\s+)?(?:team\s+of\s+)?(\d{1,3})\+?\s*(?:direct reports?|directs|reports?|PMs?|product managers?|engineers?|people)\b|\b(\d{1,3})\+?\s*direct reports?\b/i;

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    // bullets and newlines are sentence boundaries in a JD far more often than periods
    .split(/(?<=[.!?;])\s+|\s*[•·]\s*|\s+\*\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 20 && s.length <= 400);
}

/**
 * @returns {{shape:string, directs:number|null, portfolio:boolean, evidence:string}}
 *   shape: 'manages-managers' | 'player-coach' | 'owns-surface' | 'unknown'
 */
export function productOwnership(body) {
  const out = { shape: 'unknown', directs: null, portfolio: false, evidence: '' };
  const sents = sentences(body);

  // Directs count is read anywhere - a headcount statement is a fact about the
  // job whether or not it is phrased in role voice.
  for (const s of sents) {
    const m = DIRECTS.exec(s);
    if (m) { const n = Number(m[1] || m[2]); if (Number.isFinite(n) && n > 0 && n < 500) { out.directs = n; break; } }
  }

  const roleSents = sents.filter(s => ROLE_VOICE.test(s));

  // Order matters and mirrors _profile.md: managing managers disqualifies the
  // shape no matter how much player-coach language surrounds it.
  for (const s of roleSents) {
    if (MANAGES_MANAGERS.test(s)) { out.shape = 'manages-managers'; out.evidence = s; return out; }
  }
  if (out.directs != null && out.directs > 15) {
    out.shape = 'manages-managers';
    out.evidence = sents.find(s => DIRECTS.test(s)) || '';
    return out;
  }
  for (const s of roleSents) {
    if (PLAYER_COACH.test(s)) { out.shape = 'player-coach'; out.evidence = s; break; }
  }
  if (out.shape === 'unknown') {
    for (const s of roleSents) {
      if (OWNS_SURFACE.test(s)) { out.shape = 'owns-surface'; out.evidence = s; break; }
    }
  }
  out.portfolio = sents.some(s => PORTFOLIO.test(s));
  return out;
}
