// Weekly sweep of the boards that have no ATS API, so no slug guessing is possible
// and the posting-API shortcut does not exist either. All three are thin RIGHT NOW
// but refresh on their own cycles, which is exactly why this is scheduled rather
// than done once:
//
//   cuny.jobs            adjunct hiring is seasonal - departments post before each
//                        semester, so business/econ/CS openings appear and vanish
//   nysais.org           independent schools, ~20 live openings, no NYS certification
//                        required; only subjects VP can teach are reported
//   possefoundation.org  NYC program and career-program roles
//
// Prints only what matches. Silence means nothing new worth his attention.
import { chromium } from 'playwright';

const TEACHABLE = /spanish|portuguese|french|business|econom|computer sci|technolog|entrepreneur|STEM|math|project management/i;
const POSSE_NY  = /new york|nyc/i;

const b = await chromium.launch();
const p = await b.newPage({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1400, height: 1600 },
});

async function safe(url, fn) {
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(5000);
    return await fn();
  } catch (e) {
    console.log(`  [${url} failed: ${String(e).slice(0, 60)}]`);
    return [];
  }
}

// --- CUNY: adjunct openings in teachable subjects
for (const q of ['adjunct+business', 'adjunct+economics', 'adjunct+computer+science', 'adjunct+project+management']) {
  const rows = await safe(`https://cuny.jobs/jobs/?q=${q}&l=`, () =>
    p.$$eval('a[href*="/job/"]', as =>
      [...new Set(as.map(a => (a.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t.length > 8))]));
  const hits = rows.filter(t => TEACHABLE.test(t) && /adjunct|lecturer|faculty|instructor/i.test(t));
  hits.slice(0, 6).forEach(t => console.log(`CUNY  ${t.slice(0, 88)}`));
}

// --- NYSAIS: independent schools, teachable subjects only
const nys = await safe('https://www.nysais.org/careers/', () =>
  p.$$eval('a[href*="career-detail"]', as =>
    as.map(a => ({ t: (a.innerText || '').replace(/\s+/g, ' ').trim(), h: a.href }))));
nys.filter(x => TEACHABLE.test(x.t)).slice(0, 10)
   .forEach(x => console.log(`NYSAIS  ${x.t.slice(0, 66)}  ${x.h}`));

// --- Posse: NYC roles
const posse = await safe('https://www.possefoundation.org/jobs', () =>
  p.$$eval('a[href*="/jobs/"]', as =>
    as.map(a => ({ t: (a.innerText || '').replace(/\s+/g, ' ').trim(), h: a.href }))));
posse.filter(x => POSSE_NY.test(x.t)).slice(0, 10)
     .forEach(x => console.log(`POSSE  ${x.t.slice(0, 60)}  ${x.h}`));

await b.close();
