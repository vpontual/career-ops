// Print exactly what the scorer model returns, so the output shape can be seen
// rather than inferred from the damage it does downstream.
import { readFile } from 'fs/promises';

const ENDPOINT = process.env.OLLAMA_URL;
const MODEL = process.env.RANK_MODEL ?? 'Qwen/Qwen3.6-35B-A3B-FP8';

const md = await readFile('modes/_profile.md', 'utf8');
const H = '## Your Scoring Rules (Override)';
const s = md.indexOf(H), a = s + H.length, n = md.indexOf('\n## ', a);
const rules = md.slice(a, n === -1 ? md.length : n).trim();

const jd = await readFile('jds/figma-6100482004.md', 'utf8');
const SYSTEM = (await readFile('rank-leads.mjs', 'utf8'))
  .match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

const withRules = [
  '=== TARGET PROFILE ===',
  'Scoring rules — apply these strictly on top of the base scale:', rules, '',
  '=== JOB DESCRIPTION ===', jd.slice(0, 3000), '',
  '=== TASK ===', 'Return JSON. Score this job for the candidate. /no_think',
].join('\n');

const withoutRules = [
  '=== TARGET PROFILE ===', '(rules omitted for this probe)', '',
  '=== JOB DESCRIPTION ===', jd.slice(0, 3000), '',
  '=== TASK ===', 'Return JSON. Score this job for the candidate. /no_think',
].join('\n');

async function ask(label, body) {
  const t0 = Date.now();
  const res = await fetch(`${ENDPOINT}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: body }],
      stream: false,
    }),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const d = await res.json().catch(() => null);
  const out = d?.message?.content ?? d?.choices?.[0]?.message?.content ?? JSON.stringify(d);
  console.log(`\n===== ${label} (${body.length} chars, ${secs}s, HTTP ${res.status}) =====`);
  console.log(String(out).replace(/<think>[\s\S]*?<\/think>/g, '[think elided]').slice(0, 900));
}

console.log('rules block:', rules.length, 'chars');
await ask('WITH restored rules', withRules);
await ask('WITHOUT rules (control)', withoutRules);
