/**
 * lib/branded-boards.mjs — employers who host Greenhouse behind their own domain.
 *
 * ONE MAP, THREE CONSUMERS. This list existed as three separate literals in
 * fetch-jds.mjs, generate-answers.mjs and stage-applications.mjs, and they had
 * already drifted: fetch-jds knew six hosts, generate-answers knew five, and
 * stage-applications knew four. The consequences were all silent —
 *
 *   fetch-jds:         150 JD fetches failed EVERY night, 61 of them Achievement
 *                      First alone, a Track C employer that therefore never
 *                      produced a single scored JD in the system's life.
 *   generate-answers:  a card sat "form not enumerable" with no answers.md while
 *                      the Greenhouse board API returned the full question list
 *                      for the very same requisition.
 *   stage-applications: coverLetterRequirement returned 'unknown', which used to
 *                      mean "write a letter anyway" — work VP explicitly does
 *                      not want.
 *
 * The repo's own recurring lesson is that a duplicated table drifts and the
 * drift is invisible. Every slug below was verified against
 * boards-api.greenhouse.io before being added.
 *
 * ⚠ Two do NOT follow from the host name: hioscar.com is board 'oscar', and
 * abnormal.ai is board 'abnormalsecurity'. Guessing would have got both wrong,
 * which is exactly why this repo bans slug guessing.
 */

export const BRANDED_GREENHOUSE = {
  'stripe.com': 'stripe',
  'www.stripe.com': 'stripe',
  'databricks.com': 'databricks',
  'www.databricks.com': 'databricks',
  'careers.datadoghq.com': 'datadog',
  'brex.com': 'brex',
  'www.brex.com': 'brex',
  'jobs.elastic.co': 'elastic',
  'instacart.careers': 'instacart',
  'www.instacart.careers': 'instacart',
  'achievementfirst.org': 'achievementfirst',
  'www.achievementfirst.org': 'achievementfirst',
  'hioscar.com': 'oscar',
  'www.hioscar.com': 'oscar',
  'fivetran.com': 'fivetran',
  'www.fivetran.com': 'fivetran',
  'coreweave.com': 'coreweave',
  'www.coreweave.com': 'coreweave',
  'mongodb.com': 'mongodb',
  'www.mongodb.com': 'mongodb',
  'careers.duolingo.com': 'duolingo',
  'seatgeek.com': 'seatgeek',
  'www.seatgeek.com': 'seatgeek',
  'cockroachlabs.com': 'cockroachlabs',
  'www.cockroachlabs.com': 'cockroachlabs',
  'abnormal.ai': 'abnormalsecurity',
  'www.abnormal.ai': 'abnormalsecurity',
  'betterment.com': 'betterment',
  'www.betterment.com': 'betterment',
  'pubmatic.com': 'pubmatic',
  'www.pubmatic.com': 'pubmatic',
  'careers.upstart.com': 'upstart',
  'upstart.com': 'upstart',
};

/**
 * Resolve any Greenhouse-backed URL to { board, id }, or null.
 * Handles the canonical boards, the EU boards (the `.eu.` subdomain was missing
 * from the host pattern, so every European board silently failed to fetch), and
 * the branded domains above.
 */
export function greenhouseRef(url) {
  const u = String(url || '');
  const direct = /(?:job-boards|boards)(?:\.[a-z]{2})?\.greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/i.exec(u);
  if (direct) return { board: direct[1].toLowerCase(), id: direct[2] };

  const gh = /[?&]gh_jid=(\d+)/.exec(u);
  if (!gh) return null;
  let host = '';
  try { host = new URL(u).host.toLowerCase(); } catch { return null; }
  const board = BRANDED_GREENHOUSE[host];
  return board ? { board, id: gh[1] } : null;
}
