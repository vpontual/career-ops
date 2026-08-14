#!/usr/bin/env node
/**
 * watch-civil-service.mjs — do not miss a civil-service deadline.
 *
 * WHY THIS EXISTS. VP passed Exam 6003 (Administrative Education Officer) and
 * sits at list number 166. From here the city contacts him by EMAIL, and the
 * replies are on a clock: canvass and pool notices commonly give days, not
 * weeks. DCAS Personnel Rule 4 is unforgiving about silence — "failure of the
 * eligible to respond to an offer of appointment within the period fixed by the
 * agency head" withholds the name from certification exactly as a declination
 * does, and a withheld name "shall not be eligible for like certification until
 * all eligibles on the eligible list have been reached". One missed email costs
 * the list place, not just the vacancy.
 *
 * The mail also does not look urgent. The Notice of Result that started this
 * arrived from CandidateNotifications@dcas.nyc.gov at 05:42, styled like every
 * other government form letter.
 *
 * ⚠ READ-ONLY, ALWAYS. It opens the mailbox with readOnly:true and never marks
 * anything seen — if this ever marks VP's mail read, he stops trusting his own
 * inbox, which is a worse failure than the one being prevented.
 *
 * ⚠ THIS IS A BACKSTOP, NOT THE PRIMARY DEFENCE. It runs when the nightly runs.
 * Set the Gmail-side filter too so the mail is starred and never lands in spam;
 * a poller that runs once a day is not a substitute for the mail arriving
 * somewhere visible.
 *
 * ⚠ NOTIFICATION IS OFF UNLESS CONFIGURED. lib/notify.mjs needs
 * CAREER_OPS_TELEGRAM_TOKEN and CAREER_OPS_TELEGRAM_CHAT in .env; neither was
 * set as of 2026-08-14, so this prints loudly to stdout and sends nothing.
 *
 * State: data/.civil-service-seen  (UIDs already reported, newline-separated)
 * Run:   node watch-civil-service.mjs [--days 14] [--all]
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { notify, notifyEnabled } from './lib/notify.mjs';

dotenv.config();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SEEN = path.join(ROOT, 'data', '.civil-service-seen');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const DAYS = (() => { const i = args.indexOf('--days'); return i >= 0 ? parseInt(args[i + 1], 10) : 14; })();

// Who the city writes from. Deliberately domain-level: DCAS alone sends as
// CandidateNotifications@, noreply@ and examsforjobs@, and the list will grow.
const SENDERS = /@(?:dcas\.nyc\.gov|schools\.nyc\.gov|nycenet\.edu|cityjobsupport\.nyc\.gov|citystaffing\.nyc\.gov)|nyc\.gov.*(?:civil ?service|exam)/i;

// Phrases that mean a clock is running. Ordered loosest last.
const DEADLINE = [
  /\bwithin\s+(\w+|\d+)\s+(business\s+)?days?\b/i,
  /\bby\s+(?:no later than\s+)?(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  /\bno later than\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
  /\brespond(?:ing)?\s+by\b[^.]{0,40}/i,
  /\bdeadline\b[^.]{0,60}/i,
  /\bexpire[sd]?\b[^.]{0,60}/i,
];

// Words that make a message an ACTION, not a receipt.
const ACTIONABLE = /\b(canvass|pool|interview|appointment|certif\w+|vacanc\w+|offer|schedule|respond|reply|confirm|accept|declin\w+|selective certification|hiring pool)\b/i;

const main = async () => {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error('GMAIL_USER / GMAIL_APP_PASSWORD not set in .env — cannot check.');
    process.exit(1);
  }
  let seen = new Set();
  try { seen = new Set((await readFile(SEEN, 'utf8')).split('\n').filter(Boolean)); } catch {}

  const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  await c.connect();
  const lock = await c.getMailboxLock('[Gmail]/All Mail', { readOnly: true });
  const hits = [];
  try {
    const since = new Date(Date.now() - DAYS * 864e5);
    for await (const msg of c.fetch({ since }, { envelope: true, source: true, uid: true })) {
      const from = (msg.envelope?.from || []).map(a => `${a.name || ''} <${a.address || ''}>`).join(', ');
      if (!SENDERS.test(from)) continue;
      const key = String(msg.uid);
      if (!ALL && seen.has(key)) continue;
      const parsed = await simpleParser(msg.source);
      const body = (parsed.text || '').replace(/\s+/g, ' ');
      const deadlines = DEADLINE.map(re => (body.match(re) || [])[0]).filter(Boolean).slice(0, 3);
      hits.push({
        uid: key,
        from,
        subject: msg.envelope?.subject || '(no subject)',
        date: msg.envelope?.date,
        actionable: ACTIONABLE.test(body) || ACTIONABLE.test(msg.envelope?.subject || ''),
        deadlines,
      });
    }
  } finally {
    lock.release();
    await c.logout();
  }

  if (!hits.length) {
    console.log(`civil-service watch: nothing new from DCAS/NYCPS in the last ${DAYS} days`);
    return;
  }

  const urgent = hits.filter(h => h.actionable);
  const out = [];
  out.push(`📋 ${hits.length} civil-service email(s), ${urgent.length} needing a reply`);
  for (const h of hits) {
    out.push('');
    out.push(`${h.actionable ? '⚠ ACTION' : '·'} ${h.subject}`);
    out.push(`   from ${h.from} — ${h.date?.toISOString?.().slice(0, 16).replace('T', ' ') || h.date}`);
    for (const d of h.deadlines) out.push(`   ⏳ ${d.trim().slice(0, 110)}`);
  }
  const text = out.join('\n');
  console.log(text);
  if (urgent.length) {
    if (notifyEnabled) await notify(text.slice(0, 3500));
    else console.log('\n(notify disabled — set CAREER_OPS_TELEGRAM_TOKEN and CAREER_OPS_TELEGRAM_CHAT in .env)');
  }

  if (!ALL) {
    await mkdir(path.dirname(SEEN), { recursive: true });
    for (const h of hits) seen.add(h.uid);
    await writeFile(SEEN, [...seen].join('\n') + '\n');
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
