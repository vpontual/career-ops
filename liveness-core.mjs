const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', reason: 'content present but no visible apply control found' };
}

/**
 * classifyLivenessFromFetch — the browser-free subset of the rules above, for
 * callers holding only an HTTP response.
 *
 * WHY IT EXISTS. nightly-report.mjs runs on the HOST (`node nightly-report.mjs`
 * in nightly.sh), while every Playwright step runs inside the `applier` /
 * `scanner` containers — the host has no chromium libraries at all. The report
 * still has to answer "is this requisition open?", and until 2026-09-02 it did
 * so with `fetch(url, { redirect: 'follow' })` and called any HTTP 200 OPEN.
 * Greenhouse answers a dead job by redirecting to `<board>?error=true`, which
 * is a 200, so the report advertised two closed roles as OPEN for three weeks.
 *
 * ⚠ THIS MUST NEVER RETURN `expired` FOR THIN CONTENT. classifyLiveness treats
 * a short body as death because a browser had already hydrated the page, so
 * "almost no text" really does mean nav-and-footer. A raw fetch of an SPA board
 * (Ashby, Lever, Workday) returns an empty shell for a perfectly open role, so
 * applying that rule here would declare live requisitions dead — the most
 * expensive error in this file, and the one check-liveness.mjs's header exists
 * to warn about. Thin content is `uncertain`, and uncertain is not dead.
 */
export function classifyLivenessFromFetch({ status = 0, finalUrl = '', bodyText = '' } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  // A non-2xx we do not recognise says something about our fetch, not about the
  // requisition: bot protection answers 403, rate limiters 429.
  if (status >= 400) {
    return { result: 'uncertain', reason: `HTTP ${status}` };
  }

  if (bodyText.trim().length >= MIN_CONTENT_CHARS) {
    return { result: 'active', reason: 'posting still served' };
  }

  return { result: 'uncertain', reason: 'thin response — cannot tell without a browser' };
}

/** Crude HTML → visible text, good enough for the pattern rules above. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
