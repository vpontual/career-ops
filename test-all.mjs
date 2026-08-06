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

// ── SUMMARY ─────────────────────────────────────────────────────

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
