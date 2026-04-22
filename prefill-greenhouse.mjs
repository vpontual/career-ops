#!/usr/bin/env node
/**
 * prefill-greenhouse.mjs - Level B autofill for Greenhouse application forms.
 *
 * Reads application-defaults.md and a per-role cover letter, opens the
 * Greenhouse apply page in headless Chromium, fills the standard fields
 * (name, email, phone, LinkedIn, location), uploads the CV PDF, and pastes
 * the cover letter into the cover-letter file input or text area.
 *
 * It STOPS before submit. The session is headless, so the user can't take
 * over this exact browser. Instead we save:
 *   - output/{slug}/autofill-screenshot.png  (visual proof of filled form)
 *   - output/{slug}/autofill-report.md       (what was filled, what was missed)
 * The user opens the URL in their own browser to do the final submit.
 *
 * Usage:
 *   docker compose run --rm applier node prefill-greenhouse.mjs <slug>
 *   docker compose run --rm applier node prefill-greenhouse.mjs --all
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(ROOT, 'output');
const DEFAULTS_PATH = path.join(ROOT, 'application-defaults.md');

function parseDefaults(md) {
  const get = (labelRe) => {
    const re = new RegExp(`\\*\\*${labelRe}:\\*\\*\\s+([^\\n]+)`, 'i');
    const m = md.match(re);
    return m ? m[1].trim() : '';
  };
  return {
    firstName: get('Legal first name'),
    lastName: get('Legal last name'),
    email: get('Email \\(for ATS logins\\)'),
    phone: get('Phone'),
    location: get('Current city \\(LA \\+ remote, default\\)') || get('Current city'),
    locationNyc: get('Current city \\(NYC roles\\)'),
    linkedin: get('LinkedIn'),
    website: get('Personal website / portfolio'),
    workAuth: get('Authorized to work in the United States\\?'),
    needSponsorship: get('Will you require visa sponsorship now or in the future\\?'),
    veteran: get('Veteran status'),
    raceEthnicity: get('Race / ethnicity'),
    gender: get('Gender identity'),
    disability: get('Disability status'),
  };
}

async function tryFill(page, label, selectors, value, filled, missed) {
  if (!value) { missed.push(`${label} (no value in defaults)`); return; }
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      await el.waitFor({ state: 'attached', timeout: 1200 });
      await el.scrollIntoViewIfNeeded();
      await el.fill(value);
      filled[label] = value.length > 60 ? value.slice(0, 57) + '...' : value;
      return;
    } catch {}
  }
  missed.push(label);
}

async function trySelect(page, label, selectors, value, filled, missed) {
  if (!value) { missed.push(`${label} (no value in defaults)`); return; }
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      await el.waitFor({ state: 'attached', timeout: 1000 });
      // Try by label text first, fall back to value
      try {
        await el.selectOption({ label: value });
        filled[label] = value;
        return;
      } catch {
        await el.selectOption({ value });
        filled[label] = value;
        return;
      }
    } catch {}
  }
  missed.push(label);
}


// Read the JD's Location line and pick which 'Current city' value to use.
// Rule: NYC role -> NYC value; everything else (LA, remote, SF, hybrid-without-NYC) -> default LA.
async function pickCityForRole(slug, defaults) {
  try {
    const coverMd = await readFile(path.join(OUTPUT_DIR, slug, 'cover-letter.md'), 'utf-8');
    const url = (coverMd.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1];
    if (!url) return defaults.location;
    const jdsDir = path.join(ROOT, 'jds');
    const files = await readdir(jdsDir);
    for (const f of files) {
      const text = await readFile(path.join(jdsDir, f), 'utf-8');
      if (!text.includes(url)) continue;
      const locLine = (text.match(/\*\*Location:\*\*\s+(.+)/) || [])[1] || '';
      if (/new york|\bNYC\b|manhattan|brooklyn|queens|jersey city|hoboken|stamford/i.test(locLine)) {
        return defaults.locationNyc || defaults.location;
      }
      return defaults.location;
    }
  } catch {}
  return defaults.location;
}

async function processOne(browser, slug, defaults) {
  const packDir = path.join(OUTPUT_DIR, slug);
  let coverMd;
  try { coverMd = await readFile(path.join(packDir, 'cover-letter.md'), 'utf-8'); }
  catch { return { slug, error: 'no cover-letter.md', filled: 0, missed: 0 }; }

  const url = (coverMd.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1];
  if (!url) return { slug, error: 'no URL in cover letter', filled: 0, missed: 0 };
  if (!/greenhouse\.io/.test(url)) return { slug, skipped: 'not greenhouse', filled: 0, missed: 0 };

  const coverLetterBody = coverMd.split(/^---\s*$/m).slice(1).join('---').trim();
  const cvPdf = path.join(OUTPUT_DIR, 'cv.pdf');
  const coverLetterPdf = path.join(packDir, 'cover-letter.pdf');

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const filled = {};
  const missed = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Form mounting is sometimes deferred a few hundred ms
    await page.waitForTimeout(2000);

    // Look for any form inputs at all to confirm a form is present
    const hasForm = await page.locator('input, textarea').count();
    if (hasForm === 0) {
      // Some Greenhouse pages put the apply form behind a button click
      const applyBtn = page.locator('a[href*="apply"], button:has-text("Apply")').first();
      try {
        await applyBtn.click({ timeout: 2000 });
        await page.waitForTimeout(1500);
      } catch {}
    }

    await tryFill(page, 'first_name',
      ['#first_name', 'input[name="first_name"]', 'input[autocomplete="given-name"]'],
      defaults.firstName, filled, missed);
    await tryFill(page, 'last_name',
      ['#last_name', 'input[name="last_name"]', 'input[autocomplete="family-name"]'],
      defaults.lastName, filled, missed);
    await tryFill(page, 'email',
      ['#email', 'input[name="email"]', 'input[type="email"]'],
      defaults.email, filled, missed);
    await tryFill(page, 'phone',
      ['#phone', 'input[name="phone"]', 'input[type="tel"]'],
      defaults.phone, filled, missed);

    // Resume upload
    try {
      const resumeInput = page.locator(
        'input[type="file"][name="resume"], input[type="file"][id*="resume" i], input[type="file"]'
      ).first();
      await resumeInput.waitFor({ state: 'attached', timeout: 1500 });
      await resumeInput.setInputFiles(cvPdf);
      filled.resume = path.basename(cvPdf);
    } catch {
      missed.push('resume upload');
    }

    // Cover letter (file or textarea)
    let clHandled = false;
    try {
      const clFile = page.locator(
        'input[type="file"][name="cover_letter"], input[type="file"][id*="cover" i]'
      ).first();
      await clFile.waitFor({ state: 'attached', timeout: 1200 });
      try { await stat(coverLetterPdf); } catch { throw new Error('no cover letter pdf'); }
      await clFile.setInputFiles(coverLetterPdf);
      filled.cover_letter_file = path.basename(coverLetterPdf);
      clHandled = true;
    } catch {}
    if (!clHandled) {
      try {
        const clTextarea = page.locator(
          'textarea[name*="cover" i], textarea[id*="cover" i]'
        ).first();
        await clTextarea.waitFor({ state: 'attached', timeout: 1200 });
        await clTextarea.fill(coverLetterBody);
        filled.cover_letter_text = `${coverLetterBody.length} chars pasted`;
        clHandled = true;
      } catch {}
    }
    if (!clHandled) missed.push('cover letter (no file input or textarea found)');

    // LinkedIn
    await tryFill(page, 'linkedin',
      ['input[name*="linkedin" i]', 'input[id*="linkedin" i]'],
      defaults.linkedin, filled, missed);

    // Location - LA by default, NYC for NYC-located roles
    const cityForThisRole = await pickCityForRole(slug, defaults);
    await tryFill(page, 'location', [
      // Greenhouse standard
      '#candidate-location',
      'input[name*="location" i][type="text"]',
      'input[autocomplete="address-level2"]',
      'input[name*="city" i]',
      // Anthropic-style: dynamic question_NNN inputs identified by aria-label
      'input[aria-label*="address from which" i]',
      'input[aria-label*="plan on working" i]',
      // Other common phrasings used across Greenhouse forms
      'input[aria-label*="where you live" i]',
      'input[aria-label*="where do you live" i]',
      'input[aria-label*="current location" i]',
      'input[aria-label*="current city" i]',
      'input[aria-label*="hometown" i]',
      'input[aria-label*="where are you based" i]',
      'input[aria-label*="reside" i]',
      // Generic - placed last so more specific selectors win
      'input[aria-label*="city" i]'
    ], cityForThisRole, filled, missed);

    // Personal site
    await tryFill(page, 'website',
      ['input[name*="website" i]', 'input[name*="portfolio" i]', 'input[type="url"]'],
      defaults.website, filled, missed);

    // EEOC dropdowns - usually optional
    await trySelect(page, 'gender',
      ['select[name*="gender" i]'], defaults.gender, filled, missed);
    await trySelect(page, 'race_ethnicity',
      ['select[name*="race" i]', 'select[name*="ethnicity" i]'],
      defaults.raceEthnicity, filled, missed);
    await trySelect(page, 'veteran_status',
      ['select[name*="veteran" i]'], defaults.veteran, filled, missed);
    await trySelect(page, 'disability_status',
      ['select[name*="disabil" i]'], defaults.disability, filled, missed);

    // Snapshot before stop
    await mkdir(packDir, { recursive: true });
    const screenshotPath = path.join(packDir, 'autofill-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const reportPath = path.join(packDir, 'autofill-report.md');
    const report = `# Autofill report - ${slug}

**URL:** ${url}
**Run at:** ${new Date().toISOString()}
**Mode:** Headless Greenhouse autofill (Level B)

## Filled (${Object.keys(filled).length})

${Object.entries(filled).map(([k, v]) => `- **${k}:** ${v}`).join('\n')}

## Missed / needs manual fill (${missed.length})

${missed.map(m => `- ${m}`).join('\n')}

## How to use this

Headless mode means you can't take over this exact browser session. Workflow:

1. Open ${url} in your own browser.
2. Reference the screenshot at \`output/${slug}/autofill-screenshot.png\` to see exactly which fields the bot filled.
3. Fill in any missed fields (typically: custom per-company questions, EEOC if you didn't pre-set them, salary expectations).
4. Standard answers from \`application-defaults.md\` are ready to copy-paste.
5. Submit when satisfied.

If most "filled" fields are missed (e.g. all of name/email/phone), the page structure is non-standard. Check the screenshot - the form may be embedded in an iframe or behind a click.
`;
    await writeFile(reportPath, report);
  } catch (err) {
    missed.push(`fatal error: ${err.message}`);
  } finally {
    await context.close();
  }

  return { slug, filled: Object.keys(filled).length, missed: missed.length };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node prefill-greenhouse.mjs <slug> | --all');
    process.exit(2);
  }

  const defaultsMd = await readFile(DEFAULTS_PATH, 'utf-8');
  const defaults = parseDefaults(defaultsMd);

  let slugs;
  if (arg === '--all') {
    slugs = (await readdir(OUTPUT_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } else {
    slugs = [arg];
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const slug of slugs) {
    const r = await processOne(browser, slug, defaults);
    if (r.error) console.log(`[ERR ] ${slug}: ${r.error}`);
    else if (r.skipped) console.log(`[SKIP] ${slug}: ${r.skipped}`);
    else console.log(`[OK  ] ${slug}: filled=${r.filled} missed=${r.missed}`);
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
