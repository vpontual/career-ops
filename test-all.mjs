#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const QUICK = process.argv.includes('--quick');

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(ROOT).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run('node', ['--check', f]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'verify-pipeline.mjs', expectExit: 0 },
  { name: 'normalize-statuses.mjs', expectExit: 0 },
  { name: 'dedup-tracker.mjs', expectExit: 0 },
  { name: 'merge-tracker.mjs', expectExit: 0 },
  // REMOVED 2026-08-06: `update-system.mjs check` contacts santifer/career-ops.
  // CLAUDE.md and GEMINI.md now prohibit running it in any form - this fork has
  // diverged by hundreds of commits and `apply` would clobber the system layer.
  // The prohibition was worthless while the test suite invoked it on every run.
];

for (const { name, allowFail } of scripts) {
  const result = run('node', name.split(' '), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (result !== null) {
    pass(`${name} runs OK`);
  } else if (allowFail) {
    warn(`${name} exited with error (expected without user data)`);
  } else {
    fail(`${name} crashed`);
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

console.log('\n3b. Canonical dedup key (lib/canonical.mjs)');

try {
  const { canonKey, normalizeCompany } = await import(pathToFileURL(join(ROOT, 'lib', 'canonical.mjs')).href);

  // Pure formatting/punctuation variants of the SAME role must collapse.
  if (canonKey('Datadog', 'Product Manager II - AI & Data Security') ===
      canonKey('Datadog', 'Product Manager II, AI & Data Security')) {
    pass('Punctuation-only title variants collapse to one key');
  } else {
    fail('Punctuation-only title variants did NOT collapse');
  }
  // Company punctuation/case is normalized.
  if (canonKey('Acme, Inc.', 'PM') === canonKey('acme inc', 'PM')) {
    pass('Company punctuation/casing is normalized');
  } else {
    fail('Company normalization mismatch');
  }
  // DISTINCT roles differing only in the parenthetical must STAY distinct
  // (regression guard: dropping "(...)" over-merged real roles — see lib/canonical.mjs).
  if (canonKey('Owner.com', 'Senior Product Manager (AI CMO)') !==
      canonKey('Owner.com', 'Senior Product Manager (Guest Lifecycle & Loyalty)')) {
    pass('Distinct roles differing only by parenthetical stay separate');
  } else {
    fail('Parenthetical-distinct roles were wrongly merged');
  }
  // Null-safety.
  if (normalizeCompany(null) === '' && normalizeCompany(undefined) === '') {
    pass('normalizeCompany is null-safe');
  } else {
    fail('normalizeCompany not null-safe');
  }
} catch (e) {
  fail(`Canonical dedup tests crashed: ${e.message}`);
}

console.log('\n3c. Status normalization (lib/status.mjs)');

try {
  const { normalizeStatus, classifyStatus, toDisplay, STATUS_RANK } =
    await import(pathToFileURL(join(ROOT, 'lib', 'status.mjs')).href);

  // Readers canonicalize to lowercase (drop-in with existing === 'applied' compares).
  if (normalizeStatus('**Applied** 2026-07-01') === 'applied' &&
      normalizeStatus('evaluada') === 'evaluated' &&
      normalizeStatus('monitor') === 'skip') {
    pass('Reader normalizeStatus → lowercase canonical (aliases + bold/date strip)');
  } else {
    fail('Reader normalizeStatus produced wrong canonical');
  }
  // Writers display Title-case (matches on-disk applications.md).
  if (toDisplay('applied') === 'Applied' && toDisplay('skip') === 'SKIP') {
    pass('toDisplay maps canonical → on-disk Title-case');
  } else {
    fail('toDisplay casing wrong');
  }
  // The casing-drift regression guard: writer-out round-trips to reader-in.
  const written = toDisplay(classifyStatus('aplicado').status);   // → 'Applied'
  if (written === 'Applied' && normalizeStatus(written) === 'applied') {
    pass('Writer→disk→reader status round-trips (no casing drift)');
  } else {
    fail(`Status casing drift: wrote "${written}", read back "${normalizeStatus(written)}"`);
  }
  // Rich classifier: dup/repost/em-dash → discarded (+moveToNotes); unknown flagged.
  if (classifyStatus('Duplicado #3').status === 'discarded' &&
      classifyStatus('repost #5').moveToNotes &&
      classifyStatus('—').status === 'discarded' &&
      classifyStatus('total nonsense').unknown === true) {
    pass('classifyStatus handles dup/repost/em-dash + flags unknowns');
  } else {
    fail('classifyStatus regex/unknown handling wrong');
  }
  // Dedup rank ordering.
  if (STATUS_RANK.offer > STATUS_RANK.applied && STATUS_RANK.applied > STATUS_RANK.rejected) {
    pass('STATUS_RANK advancement order intact');
  } else {
    fail('STATUS_RANK ordering wrong');
  }
} catch (e) {
  fail(`Status normalization tests crashed: ${e.message}`);
}

console.log('\n3d. JD front-matter parser (lib/jd-parse.mjs)');

try {
  const { parseJd } = await import(pathToFileURL(join(ROOT, 'lib', 'jd-parse.mjs')).href);
  const sample = [
    '# Senior PM (AI)',
    '**URL:** https://x.example/job',
    '**Company:** Acme, Inc.',
    '**Location:** NYC',
    '**Compensation:** $200k',
    '**Posted:** 2026-07-01 (5 days ago)',
    '',
    '---',
    'Body text here.',
  ].join('\n');
  const jd = parseJd(sample, 'x.md');
  if (jd.title === 'Senior PM (AI)' && jd.company === 'Acme, Inc.' &&
      jd.url === 'https://x.example/job' && jd.location === 'NYC' && jd.pay === '$200k' &&
      jd.posted_at === '2026-07-01' && jd.posted_days === 5 &&
      jd.body === 'Body text here.' && jd.filename === 'x.md') {
    pass('parseJd extracts all fields + body');
  } else {
    fail(`parseJd fields wrong: ${JSON.stringify(jd)}`);
  }
  // Null-safe + no-body fallback.
  const bare = parseJd('# Only A Title');
  if (bare.title === 'Only A Title' && bare.company === '' && bare.body === '# Only A Title') {
    pass('parseJd handles missing fields / no separator');
  } else {
    fail(`parseJd bare-case wrong: ${JSON.stringify(bare)}`);
  }
} catch (e) {
  fail(`JD parser tests crashed: ${e.message}`);
}

console.log('\n3e. CV / cover-letter rendering (lib/render.mjs)');

try {
  const { renderCvHtml, renderCoverLetterHtml } = await import(pathToFileURL(join(ROOT, 'lib', 'render.mjs')).href);

  const cv = renderCvHtml('# Jane Doe\n## Experience\n- **Lead** PM at [Acme](https://acme.co)\n\nParagraph.');
  if (cv.includes('<h1>Jane Doe</h1>') && cv.includes('<h2>Experience</h2>') &&
      cv.includes('<strong>Lead</strong>') && cv.includes('<a href="https://acme.co">Acme</a>') &&
      cv.includes('<li>') && cv.includes("font-family: 'Helvetica Neue'") && cv.includes('font-size: 22pt')) {
    pass('renderCvHtml converts markdown + keeps the CV template CSS');
  } else {
    fail('renderCvHtml output missing expected markup/CSS');
  }
  // HTML escaping (no raw injection).
  if (renderCvHtml('- a < b & c').includes('a &lt; b &amp; c')) {
    pass('renderCvHtml escapes HTML');
  } else {
    fail('renderCvHtml did not escape HTML');
  }

  const profile = 'full_name: "Vitor Pontual"\nemail: "v@x.com"\nphone: "555"\nlinkedin: "in/vp"';
  const cover = renderCoverLetterHtml('Dear team,\nHello.', profile, 'Re: PM - Acme');
  if (cover.includes('<div class="name">Vitor Pontual</div>') &&
      cover.includes('v@x.com · 555 · in/vp') &&
      cover.includes('Re: PM - Acme') && cover.includes('Dear team,<br>')) {
    pass('renderCoverLetterHtml renders contact + supplied meta line');
  } else {
    fail('renderCoverLetterHtml output wrong');
  }
} catch (e) {
  fail(`Render tests crashed: ${e.message}`);
}

console.log('\n3f. URL canonicalization at ingest (lib/url-canonical.mjs)');

try {
  const { canonicalizeUrl } = await import(pathToFileURL(join(ROOT, 'lib', 'url-canonical.mjs')).href);

  // Tracking params stripped (utm/click-ids/position); the drift-causing set.
  if (canonicalizeUrl('https://x.example/job?utm_source=a&fbclid=b&position=2') === 'https://x.example/job') {
    pass('strips utm_/fbclid/position tracking params');
  } else {
    fail(`tracking-strip wrong: ${canonicalizeUrl('https://x.example/job?utm_source=a&fbclid=b&position=2')}`);
  }
  // Identifying params KEPT (Greenhouse gh_jid selects the actual job).
  const gh = canonicalizeUrl('https://boards.greenhouse.io/co/jobs/1?gh_jid=456&utm_source=x');
  if (gh.includes('gh_jid=456') && !gh.includes('utm_source')) {
    pass('keeps identifying gh_jid, drops tracking');
  } else {
    fail(`gh_jid handling wrong: ${gh}`);
  }
  // Strip-all-query host.
  if (canonicalizeUrl('https://app.welcometothejungle.com/jobs/x?whatever=1&a=2') === 'https://app.welcometothejungle.com/jobs/x') {
    pass('strips entire query for strip-all hosts');
  } else {
    fail('strip-all-query host wrong');
  }
  // THE POINT: two tracking variants of one posting collapse to one canonical.
  const a = canonicalizeUrl('https://acme.com/careers/pm?utm_campaign=z&gclid=1');
  const b = canonicalizeUrl('https://acme.com/careers/pm?ref=digest&position=3');
  if (a === b && a === 'https://acme.com/careers/pm') {
    pass('drift variants of one posting collapse to a single canonical URL');
  } else {
    fail(`drift did not collapse: "${a}" vs "${b}"`);
  }
  // Unparseable → unchanged (never throws).
  if (canonicalizeUrl('not a url') === 'not a url') {
    pass('unparseable input returned unchanged');
  } else {
    fail('unparseable handling wrong');
  }
} catch (e) {
  fail(`URL canonicalization tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  const goBuild = run('cd dashboard && go build -o /tmp/career-dashboard-test . 2>&1');
  if (goBuild !== null) {
    pass('Dashboard compiles');
  } else {
    fail('Dashboard build failed');
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'config/profile.yml', 'modes/_profile.md', 'portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'go.mod', 'test-all.mjs',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Dashboard credit string
  'dashboard/internal/ui/screens/pipeline.go',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `'*.${e}'`).join(' ');

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    `git grep -n "${pattern}" -- ${grepPathspec} 2>/dev/null`
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
const absPathResult = run(
  `git grep -n "/Users/" -- '*.mjs' '*.sh' '*.md' '*.go' '*.yml' 2>/dev/null | grep -v README.md | grep -v LICENSE | grep -v CLAUDE.md | grep -v test-all.mjs`
);
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

// ── 9. CLAUDE.md INTEGRITY ──────────────────────────────────────

console.log('\n9. CLAUDE.md integrity');

const claude = readFile('CLAUDE.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (claude.includes(section)) {
    pass(`CLAUDE.md has section: ${section}`);
  } else {
    fail(`CLAUDE.md missing section: ${section}`);
  }
}

// ── 10. VERSION FILE ─────────────────────────────────────────────

console.log('\n10. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── 11. FORM-ANSWER MATCHER ─────────────────────────────────────
//
// generate-answers.mjs decides what goes into a live employer form. It shipped
// untested and was found (2026-08-06) filling federal EEO self-identification
// rows with contradictory values. The fixture is the specification; it is
// EXPECTED to fail until the matcher is fixed. Do not weaken a case to go green.
//
// Requires application-defaults.md, which is gitignored and VM-only, so this
// warns rather than fails where the file is absent (a dev checkout) — but a
// non-zero exit WITH the file present is a hard failure.

console.log('\n11. Form-answer matcher (golden fixture)');

if (!fileExists('test-answers-matcher.mjs')) {
  fail('test-answers-matcher.mjs missing — the matcher has no specification');
} else if (!fileExists('application-defaults.md')) {
  warn('application-defaults.md absent — matcher fixture skipped (expected off-VM)');
} else {
  const out = run('node', ['test-answers-matcher.mjs']);
  if (out === null) {
    // run() returns null on non-zero exit. Re-run to surface the tally.
    let tally = '';
    try {
      execFileSync('node', ['test-answers-matcher.mjs'], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
    } catch (e) {
      tally = String(e.stdout || '').split('\n').filter(l => /passed, \d+ failed/.test(l)).join(' ');
    }
    fail(`form-answer matcher fixture failing — ${tally || 'see: node test-answers-matcher.mjs'}`);
  } else {
    const tally = out.split('\n').filter(l => /passed, \d+ failed/.test(l)).join(' ');
    pass(`form-answer matcher fixture green — ${tally}`);
  }
}

// ── 12. INTERVIEW-FORMAT GATE ───────────────────────────────────
//
// scoreFromFacts hard-rejects a role to tier 1 on a live-coding screen. That is
// VP's rule and it stays. What it must fire on is EVIDENCE in the posting, not
// the model's inference: measured 2026-08-06, the model flagged 176 of 806
// records and 0 of those postings stated a screen, burying three of the six
// roles in the mission's own PREPARED ledger.

console.log('\n12. Interview-format gate (screen-evidence)');

if (!fileExists('test-screen-evidence.mjs')) {
  fail('test-screen-evidence.mjs missing — the interview-format gate has no specification');
} else {
  const out = run('node', ['test-screen-evidence.mjs']);
  if (out === null) fail('screen-evidence tests failing — run: node test-screen-evidence.mjs');
  else pass(`screen-evidence ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 13. SCORING NORMALIZERS ─────────────────────────────────────
//
// The recurring defect in this scorer is policy comparing against enum values
// the model never returns. `level` was one: free text in 785 of 806 records, so
// its gate never fired once. functionArea was another: ordered so a domain word
// beat a job title, which hard-rejected a role VP had approved.

console.log('\n13. Scoring normalizers');

if (!fileExists('test-normalizers.mjs')) {
  fail('test-normalizers.mjs missing — the scoring enums have no specification');
} else {
  const out = run('node', ['test-normalizers.mjs']);
  if (out === null) fail('normalizer tests failing — run: node test-normalizers.mjs');
  else pass(`normalizers ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 14. BLACKLIST GATE SHAPE ────────────────────────────────────
//
// parseBlacklist returns a Map. enqueue-review.mjs guarded its gate with
// `blacklist.length`, which on a Map is undefined, so the gate never blocked
// anything for its entire life. It was masked only because data/blacklist.md
// does not exist — the day VP creates one, rank-leads would honour it (it tests
// .size) and enqueue would not. A gate must be proven to FIRE.

console.log('\n14. Blacklist gate fires');

try {
  const { parseBlacklist, blacklistEntry } =
    await import(pathToFileURL(join(ROOT, 'blacklist.mjs')).href);
  const bl = parseBlacklist('| Company | Why |\n|---|---|\n| Acme Corp | test |\n');
  if (typeof bl.size !== 'number') {
    fail('parseBlacklist no longer returns a sized collection — check enqueue-review guard');
  } else if (bl.size && blacklistEntry('Acme Corp', bl)) {
    pass('blacklist gate blocks a listed company');
  } else {
    fail('blacklist gate did NOT block a listed company');
  }
  if (!blacklistEntry('Some Other Co', bl)) pass('blacklist gate passes an unlisted company');
  else fail('blacklist gate blocked an unlisted company');
} catch (e) {
  fail(`blacklist gate test crashed: ${e.message}`);
}

// ── 15. COVER-LETTER FACT CHECK ─────────────────────────────────
//
// It fired on 109 of 275 letters and was wrong essentially every time — 100 of
// those were one phrasing mismatch against cv.md. A gate wrong 40% of the time
// is one VP learns to skip, and then it stops catching the real thing.

console.log('\n15. Cover-letter fact check');

if (!fileExists('test-fact-check.mjs')) {
  fail('test-fact-check.mjs missing — the fact checker has no specification');
} else {
  const out = run('node', ['test-fact-check.mjs']);
  if (out === null) fail('fact-check tests failing — run: node test-fact-check.mjs');
  else pass(`fact-check ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 16. DILIGENCE FINDINGS ──────────────────────────────────────
//
// research.md replaced the Glassdoor gate and became the same thing: 74 files,
// three distinct bodies, 73 saying only "NOT STATED", and ready-check.py
// accepting mere existence as diligence.

console.log('\n16. Diligence findings');

if (!fileExists('test-jd-findings.mjs')) {
  fail('test-jd-findings.mjs missing — diligence extraction has no specification');
} else {
  const out = run('node', ['test-jd-findings.mjs']);
  if (out === null) fail('jd-findings tests failing — run: node test-jd-findings.mjs');
  else pass(`jd-findings ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 17. GMAIL LEAD EXTRACTION ───────────────────────────────────
//
// The digest subject was stamped onto every URL in the message, so 11 of the 12
// live rows carried a role that was not the job — and jobot.com is unscrapeable,
// so no JD ever corrected it. Separately, per-email eid/uid params meant 49
// distinct postings were written as 168 rows.

console.log('\n17. Gmail lead extraction');

if (!fileExists('test-gmail-leads.mjs')) {
  fail('test-gmail-leads.mjs missing — gmail lead extraction has no specification');
} else {
  const out = run('node', ['test-gmail-leads.mjs']);
  if (out === null) fail('gmail-leads tests failing — run: node test-gmail-leads.mjs');
  else pass(`gmail-leads ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 18. LIVENESS VERDICT ────────────────────────────────────────
//
// checkUrl returned `expired` for ANY navigation exception. Caught live during
// a full nightly run: a 15s timeout pruned Datadog's tier-5 NYC Senior PM role
// the morning it first became visible. The role loses its pack, and since
// enqueue-review refuses to card a role with no CV, VP never sees it at all.

console.log('\n18. Liveness verdict');

if (!fileExists('test-liveness-verdict.mjs')) {
  fail('test-liveness-verdict.mjs missing — liveness verdicts have no specification');
} else {
  const out = run('node', ['test-liveness-verdict.mjs']);
  if (out === null) fail('liveness-verdict tests failing — run: node test-liveness-verdict.mjs');
  else pass(`liveness-verdict ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 19. RECENCY (employer activity, not shelf age) ──────────────
//
// fetch-jds has always written **Updated:** into the JD and lib/jd-parse.mjs
// never parsed it, so the best signal of active hiring intent sat unread while
// every gate used posting age. 607 of 684 reqs were touched more recently than
// they were posted.

console.log('\n19. Recency signal');

if (!fileExists('test-recency.mjs')) {
  fail('test-recency.mjs missing — the recency signal has no specification');
} else {
  const out = run('node', ['test-recency.mjs']);
  if (out === null) fail('recency tests failing — run: node test-recency.mjs');
  else pass(`recency ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── SUMMARY ─────────────────────────────────────────────────────

// ── 21. SKILLS VP DOES NOT HAVE ─────────────────────────────────
// Blocks only where the posting REQUIRES the skill; nice-to-haves warn.
// A wrong block is a silent loss of a qualified role.
console.log('\n21. Skill gate');
if (!fileExists('test-skill-gate.mjs')) {
  fail('test-skill-gate.mjs missing — the skill gate has no specification');
} else {
  const out = run('node', ['test-skill-gate.mjs']);
  if (out === null) fail('skill-gate tests failing — run: node test-skill-gate.mjs');
  else pass(`skill gate ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 21b. A CREDENTIAL HE CANNOT HOLD ────────────────
// Blocks only where the posting STATES the licence/clearance is required.
// Tuned harder toward NOT blocking than the skill gate: "license" is a SaaS
// noun in a PM search, and a false block deletes a role VP never sees.
console.log('\n21b. Credential gate');
if (!fileExists('test-credential-gate.mjs')) {
  fail('test-credential-gate.mjs missing — the credential gate has no specification');
} else {
  const out = run('node', ['test-credential-gate.mjs']);
  if (out === null) fail('credential-gate tests failing — run: node test-credential-gate.mjs');
  else pass(`credential gate ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 21c. TRACK D RUBRIC ─────────────────────────────────────────
// "Get Hired Now" is deliberately loose - no comp floor, no archetype, no
// NYC-fit requirement - and that looseness once included "no geography gate at
// all", which scored a role that is remote WITHIN Brazil a 5 and put it top of
// the shortlist. Time-to-income for a job VP cannot be hired into is not 5. The
// cases pin BOTH halves: foreign residence is disqualifying, and the parts VP
// asked to stay loose must not quietly tighten.
console.log('\n21c. Track D rubric');
if (!fileExists('test-score-now.mjs')) {
  fail('test-score-now.mjs missing — the Get Hired Now rubric has no specification');
} else {
  const out = run('node', ['test-score-now.mjs']);
  if (out === null) fail('Track D rubric tests failing — run: node test-score-now.mjs');
  else pass(`track D rubric ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 21d. COVER-LETTER REQUIREMENT ───────────────────────────────
// Both failure directions are expensive: claiming a requirement nobody observed
// puts a fabricated fact on a live application, and shrugging "could not be
// determined" at a form this pipeline already read is how 67 of 104 pending
// cards ended up with no answer and no letter.
console.log('\n21d. Cover-letter requirement');
if (!fileExists('test-cover-letter-requirement.mjs')) {
  fail('test-cover-letter-requirement.mjs missing — the cover-letter gate has no specification');
} else {
  const out = run('node', ['test-cover-letter-requirement.mjs']);
  if (out === null) fail('cover-letter requirement tests failing — run: node test-cover-letter-requirement.mjs');
  else pass(`cover-letter requirement ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 21e. CAVEAT CAP ─────────────────────────────────────────────
// A 5 means nothing is flagged. VP: "a perfect score is only for a perfect
// job." Also pins that a flag is never cut mid-word - the stored text used to
// be sliced at 200 chars with no ellipsis, which removed the clause after
// "however", i.e. the part that decides whether the flag matters.
console.log('\n21e. Caveat cap');
if (!fileExists('test-caveat-cap.mjs')) {
  fail('test-caveat-cap.mjs missing — the meaning of a 5 has no specification');
} else {
  const out = run('node', ['test-caveat-cap.mjs']);
  if (out === null) fail('caveat cap tests failing — run: node test-caveat-cap.mjs');
  else pass(`caveat cap ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 21f. THE DISCIPLINE LABEL ───────────────────────────────────
// functionArea is the only fact that can delete a role on its own - three
// rubrics hard-score CANNOT_DO to 1, and a false block is silent. It also used
// to short-circuit on the model's own enum, which made the model's label
// unfalsifiable: Anthropic's "Web Product Manager" was hard-scored to 1 as
// marketing-demand, and 17 Product Marketing roles with a dedicated CV variant
// were blocked as work VP cannot do.
console.log('\n21f. Function area');
if (!fileExists('test-function-area.mjs')) {
  fail('test-function-area.mjs missing — the discipline label has no specification');
} else {
  const out = run('node', ['test-function-area.mjs']);
  if (out === null) fail('function-area tests failing — run: node test-function-area.mjs');
  else pass(`function area ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 21g. PER-TRACK FRESHNESS WINDOWS ────────────────────────────
// The windows are measured, and a measured number with no test is a number the
// next measurement quietly disagrees with. Also pins the property that matters
// more than any single number: the SAME window at every enforcement point, or a
// role is scored and never staged (or staged and never carded).
console.log('\n21g. Per-track freshness windows');
if (!fileExists('test-track-freshness.mjs')) {
  fail('test-track-freshness.mjs missing — the per-track windows have no specification');
} else {
  const out = run('node', ['test-track-freshness.mjs']);
  if (out === null) fail('track-freshness tests failing — run: node test-track-freshness.mjs');
  else pass(`track freshness ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 21h. ANSWER CLASSIFIER (the draft deny list) ────────────────
// generate-answers.mjs now lets a language model write into answers.md, which
// VP transcribes into live employer forms. The classifier is what keeps that
// model away from an address, a salary, an EEO row, a work-authorisation
// status, prior employment or a legal attestation. This file is that
// boundary's specification, not a description of it.
console.log('\n21h. Answer classifier (draft deny list)');
if (!fileExists('test-answer-classifier.mjs')) {
  fail('test-answer-classifier.mjs missing — the draft deny list has no specification');
} else {
  const out = run('node', ['test-answer-classifier.mjs']);
  if (out === null) fail('answer classifier tests failing — run: node test-answer-classifier.mjs');
  else pass(`answer classifier ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}

// ── 20. SEARCH-RESOLVED APPLY PATHS ─────────────────────────────
// A wrong resolution is worse than a miss: the chain stages a tailored CV
// against whatever it resolves and VP reviews the card as real. A permissive
// version of this rule measured 18% precision over 51 real rows.
console.log('\n20. Apply-path resolution rule');
if (!fileExists('test-resolve-rule.mjs')) {
  fail('test-resolve-rule.mjs missing — search resolution has no specification');
} else {
  const out = run('node', ['test-resolve-rule.mjs']);
  if (out === null) fail('resolve-rule tests failing — run: node test-resolve-rule.mjs');
  else pass(`resolve rule ${out.split('\n').filter(l => /passed/.test(l)).join(' ')}`);
}


console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
