#!/usr/bin/env node
// Inspect a Greenhouse application form: dump every input/textarea/select with
// id, name, type, placeholder, autocomplete, and the closest <label> text.
// Used to find the right selectors for fields the autofill bot is missing.
//
// usage: node inspect-form.mjs <url>

import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('usage: inspect-form.mjs <url>');
  process.exit(2);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 1800 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);

// Some forms are behind an Apply click
const hasInputs = await page.locator('input, textarea, select').count();
if (hasInputs < 5) {
  const applyBtn = page.locator('a[href*="apply"], button:has-text("Apply")').first();
  try {
    await applyBtn.click({ timeout: 2000 });
    await page.waitForTimeout(2000);
  } catch {}
}

const fields = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('input, textarea, select')) {
    let labelText = '';
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) labelText = lbl.innerText.trim().slice(0, 80);
    }
    if (!labelText && el.closest('label')) {
      labelText = el.closest('label').innerText.trim().slice(0, 80);
    }
    if (!labelText) {
      // Walk up looking for a sibling/ancestor label-ish text
      const wrapper = el.closest('div,section');
      if (wrapper) {
        const lbl = wrapper.querySelector('label, .label, [class*="label" i]');
        if (lbl) labelText = lbl.innerText.trim().slice(0, 80);
      }
    }
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      id: el.id || '',
      name: el.name || '',
      placeholder: el.placeholder || '',
      autocomplete: el.autocomplete || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      label: labelText
    });
  }
  return out;
});

for (const f of fields) {
  const bits = [];
  if (f.id) bits.push(`#${f.id}`);
  if (f.name) bits.push(`name="${f.name}"`);
  if (f.type) bits.push(`type=${f.type}`);
  if (f.autocomplete) bits.push(`autoc="${f.autocomplete}"`);
  if (f.placeholder) bits.push(`ph="${f.placeholder}"`);
  if (f.ariaLabel) bits.push(`aria="${f.ariaLabel}"`);
  if (f.role) bits.push(`role=${f.role}`);
  console.log(`${f.tag}  ${bits.join(' | ')}${f.label ? '   ← ' + f.label : ''}`);
}

await browser.close();
