#!/usr/bin/env node
// probe-portals.mjs — for each candidate (name + likely-slug array), try
// Greenhouse/Ashby/Lever APIs in order and report which one works.
// Prints YAML-ready entries to stdout for the successes; lists failures.
//
// Used when bulk-adding new companies to portals.yml without polluting
// the scan with 404 noise.

const CANDIDATES = [
  // -- AI labs / model providers --
  { name: 'Hugging Face', slugs: ['huggingface', 'hugging-face'] },
  { name: 'Together AI', slugs: ['together', 'togetherai', 'together-ai'] },
  { name: 'Inflection AI', slugs: ['inflection', 'inflectionai'] },
  { name: 'Character.AI', slugs: ['character', 'characterai', 'character-ai'] },
  { name: 'Magic', slugs: ['magic', 'magicdev', 'magic-dev'] },
  { name: 'Poolside', slugs: ['poolside', 'poolsideai'] },
  { name: 'Adept', slugs: ['adept', 'adeptai'] },
  { name: 'Reka', slugs: ['reka', 'rekaai'] },
  { name: 'Stability AI', slugs: ['stabilityai', 'stability'] },
  { name: 'Suno', slugs: ['suno', 'sunomusic'] },
  { name: 'Luma AI', slugs: ['lumalabs', 'luma', 'lumaai'] },
  { name: 'Pika', slugs: ['pika', 'pikalabs'] },

  // -- Infra / dev-tools --
  { name: 'Modal', slugs: ['modallabs', 'modal'] },
  { name: 'Replicate', slugs: ['replicate'] },
  { name: 'Anyscale', slugs: ['anyscale'] },
  { name: 'Lambda Labs', slugs: ['lambdalabs', 'lambda'] },
  { name: 'Lightning AI', slugs: ['lightning', 'lightningai'] },
  { name: 'Browserbase', slugs: ['browserbase'] },
  { name: 'E2B', slugs: ['e2b'] },
  { name: 'RunPod', slugs: ['runpod'] },
  { name: 'Crusoe', slugs: ['crusoecloud', 'crusoe'] },

  // -- RAG / vector / eval --
  { name: 'LlamaIndex', slugs: ['llamaindex'] },
  { name: 'Voyage AI', slugs: ['voyageai', 'voyage'] },
  { name: 'Vectara', slugs: ['vectara'] },
  { name: 'Weaviate', slugs: ['weaviate'] },
  { name: 'Qdrant', slugs: ['qdrant'] },
  { name: 'Helicone', slugs: ['helicone'] },
  { name: 'Galileo', slugs: ['rungalileo', 'galileo'] },
  { name: 'Patronus AI', slugs: ['patronusai', 'patronus'] },
  { name: 'Lakera', slugs: ['lakera'] },

  // -- Enterprise SaaS doing real AI --
  { name: 'Stripe', slugs: ['stripe'] },
  { name: 'Brex', slugs: ['brex'] },
  { name: 'Ramp', slugs: ['ramp'] },
  { name: 'Mercury', slugs: ['mercury'] },
  { name: 'Databricks', slugs: ['databricks'] },
  { name: 'Snowflake', slugs: ['snowflake'] },
  { name: 'Datadog', slugs: ['datadog'] },
  { name: 'Atlassian', slugs: ['atlassian'] },
  { name: 'HubSpot', slugs: ['hubspot'] },
  { name: 'Zendesk', slugs: ['zendesk'] },
  { name: 'Intercom', slugs: ['intercom'] },
  { name: 'Front', slugs: ['frontapp', 'front'] },
  { name: 'Algolia', slugs: ['algolia'] },
  { name: 'Elastic', slugs: ['elastic'] },

  // -- AI-native prosumer --
  { name: 'Granola', slugs: ['granola'] },
  { name: 'Cleric', slugs: ['cleric'] },
  { name: 'Mem', slugs: ['mem'] },
  { name: 'Tana', slugs: ['tana'] },
  { name: 'Reflect', slugs: ['reflect'] },
  { name: 'Descript', slugs: ['descript'] },
  { name: 'HeyGen', slugs: ['heygen'] },
  { name: 'Synthesia', slugs: ['synthesia'] },
  { name: 'Tavus', slugs: ['tavus'] },

  // -- Coding agents --
  { name: 'Lovable', slugs: ['lovable'] },
  { name: 'StackBlitz', slugs: ['stackblitz'] },
  { name: 'Codeium', slugs: ['codeium'] },
  { name: 'Tabnine', slugs: ['tabnine'] },
  { name: 'Sourcegraph', slugs: ['sourcegraph'] },
  { name: 'Continue', slugs: ['continuedev', 'continue'] },
  { name: 'Augment Code', slugs: ['augmentcode', 'augment'] },
];

const UA = { 'User-Agent': 'career-ops/1.0 (portal-probe)' };
const TIMEOUT_MS = 6000;

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

async function tryGreenhouse(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const j = await fetchJson(url);
  if (j && Array.isArray(j.jobs)) return { ats: 'greenhouse', slug, count: j.jobs.length };
  return null;
}

async function tryAshby(slug) {
  // Ashby exposes the public board JSON at this endpoint
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  const j = await fetchJson(url);
  if (j && Array.isArray(j.jobs)) return { ats: 'ashby', slug, count: j.jobs.length };
  return null;
}

async function tryLever(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const j = await fetchJson(url);
  if (Array.isArray(j)) return { ats: 'lever', slug, count: j.length };
  return null;
}

async function probe(name, slugs) {
  for (const slug of slugs) {
    const gh = await tryGreenhouse(slug);
    if (gh) return { name, ...gh };
    const ab = await tryAshby(slug);
    if (ab) return { name, ...ab };
    const lv = await tryLever(slug);
    if (lv) return { name, ...lv };
  }
  return null;
}

function yamlEntry(r) {
  if (r.ats === 'greenhouse') {
    return [
      `  - name: ${r.name}`,
      `    careers_url: https://job-boards.greenhouse.io/${r.slug}`,
      `    api: https://boards-api.greenhouse.io/v1/boards/${r.slug}/jobs`,
      `    enabled: true`
    ].join('\n');
  }
  if (r.ats === 'ashby') {
    return [
      `  - name: ${r.name}`,
      `    careers_url: https://jobs.ashbyhq.com/${r.slug}`,
      `    enabled: true`
    ].join('\n');
  }
  if (r.ats === 'lever') {
    return [
      `  - name: ${r.name}`,
      `    careers_url: https://jobs.lever.co/${r.slug}`,
      `    enabled: true`
    ].join('\n');
  }
  return '';
}

const successes = [];
const failures = [];

for (const c of CANDIDATES) {
  const r = await probe(c.name, c.slugs);
  if (r) {
    successes.push(r);
    console.error(`OK  ${r.name.padEnd(20)} ${r.ats}/${r.slug} (${r.count} jobs)`);
  } else {
    failures.push(c.name);
    console.error(`MISS ${c.name.padEnd(20)} (tried ${c.slugs.join(', ')})`);
  }
}

console.error(`\n=== ${successes.length} OK / ${failures.length} MISS ===\n`);
console.error('Misses (need manual lookup or different ATS):');
for (const f of failures) console.error(`  - ${f}`);
console.error();

console.log('# === appended by probe-portals.mjs ===');
for (const r of successes) {
  console.log(yamlEntry(r));
  console.log('');
}
