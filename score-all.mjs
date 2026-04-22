#!/usr/bin/env node
/**
 * score-all.mjs — bulk-score every JD in jds/ and write a report to reports/.
 *
 * Uses a hand-curated scoring table built by Claude (Opus 4.7) applying
 * Vitor's modes/_profile.md rules:
 *   - PRIMARY archetypes: AI Product (IC), Founding/Early PM, Senior hands-on Director
 *   - Hard downranks: Growth/acquisition, PMM-sales-disguised, engineering-coded
 *   - Comp: $150-200K+ sweet spot, below OK only for startups with concrete equity
 *   - Geo: LA/NYC/remote US/remote+travel all equal-weight primary
 *   - Axis: closeness-to-product > title height
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { SCORING_TIER1 } from './scoring-tier1.mjs';

// scoring[filename] = { score, verdict, archetype, geo, comp, match, compScore, geoScore, cultural, redFlags }
const SCORING = {
  'airtable-8199012002.md': {
    score: 3.0,
    verdict: "Solid AI Product IC role at a great company, but SF-only geo excludes it. 3-5 yr experience level is under Vitor's 10+ seniority.",
    archetype: 'AI Product (IC)',
    geo: 'SF (excluded)',
    comp: '$170K-$221K',
    match: 3, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF-only; junior for 10+ yr PM',
    rec: 'Skip unless remote negotiable',
  },
  'airtable-8245333002.md': {
    score: 4.6,
    verdict: "Omni is Airtable's AI-native agent product at scale. 8+ yrs PM, builder mindset (Claude Code/Cursor explicit), SF+NYC, $240-339K. Archetype match is near-perfect.",
    archetype: 'AI Product (Senior IC)',
    geo: 'SF + NYC',
    comp: '$240K-$339K',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'none — "adoption metrics" reads growth-adjacent but JD is clearly product-craft',
    rec: 'APPLY',
  },
  'anthropic-4985920008.md': {
    score: 3.0,
    verdict: "Strong Claude Code PM role but SF/Seattle only. Would be 4.5+ if NYC were on the list.",
    archetype: 'AI Product (IC)',
    geo: 'SF + Seattle (excluded)',
    comp: '$285K-$305K',
    match: 5, compScore: 5, geoScore: 1, cultural: 5,
    redFlags: 'no NYC option',
    rec: 'Skip — geo',
  },
  'anthropic-5097067008.md': {
    score: 4.4,
    verdict: 'Model Behaviors PM — hands-on, IC, works directly with Alignment Finetuning. 5+ yr PM, ML grounding required. SF or NYC, $305-385K. High archetype fit.',
    archetype: 'AI Product (Senior IC)',
    geo: 'SF + NYC',
    comp: '$305K-$385K',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'none',
    rec: 'APPLY',
  },
  'anthropic-5127559008.md': {
    score: 4.7,
    verdict: "Anthropic Consumer PM — explicitly looking for former founders, 0-to-1 work, $385-460K. Vitor's Reco.AI stealth→Series A background + founder framing is an exceptional fit.",
    archetype: 'Founding / Early-Stage PM (inside a larger company)',
    geo: 'SF + NYC',
    comp: '$385K-$460K',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'none',
    rec: 'APPLY — top priority',
  },
  'anthropic-5153773008.md': {
    score: 1.5,
    verdict: 'Titled "PM Monetization" but the JD is a growth role: "drive revenue growth", "free-to-paid conversion", "pricing & packaging", "majority in growth focused roles". Hard downrank per Vitor\'s rules.',
    archetype: 'Growth PM (disguised)',
    geo: 'SF + NYC + Seattle',
    comp: '$305K-$385K',
    match: 4, compScore: 5, geoScore: 5, cultural: 4,
    redFlags: 'GROWTH ORIENTATION — core negative signal despite the Monetization title',
    rec: 'Skip — growth role per rules',
  },
  'anthropic-5183006008.md': {
    score: 4.3,
    verdict: "Education Labs: research + product + learning, hands-on IC, $305-460K, SF or NYC. JD explicitly rules out people-mgmt. Strong match for Vitor's builder profile.",
    archetype: 'AI Product (Senior IC) — adjacent to Founding PM',
    geo: 'SF + NYC',
    comp: '$305K-$460K',
    match: 5, compScore: 5, geoScore: 5, cultural: 4,
    redFlags: 'none — "What this role is not: people management" is explicitly stated in Vitor\'s favor',
    rec: 'APPLY',
  },
  'arize-ai-5818115004.md': {
    score: 3.8,
    verdict: "AI observability/eval PM, remote US, $150-220K + equity. Base in sweet spot. But 2-3 yr PM requirement is well under Vitor's level — potential under-levelling.",
    archetype: 'AI Product (IC)',
    geo: 'Remote US',
    comp: '$150K-$220K + equity',
    match: 4, compScore: 5, geoScore: 5, cultural: 4,
    redFlags: 'junior seniority target (2-3 yrs); Vitor is 10+',
    rec: 'Consider — only if they can level up',
  },
  'clay-749a6373-0979-42.md': {
    score: 4.5,
    verdict: "Clay PM Enrichment & AI — NYC, $240-300K + equity, Series C ($5B val), 7+ yrs PM. Owns tables/integrations/Claygent AI agent. Vitor's integrations + API homelab chops hit.",
    archetype: 'AI Product (Senior IC)',
    geo: 'NYC (preferred explicit)',
    comp: '$240K-$300K + equity',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'GTM-adjacent ("thousands of GTM teams") but the role is clearly product-craft',
    rec: 'APPLY',
  },
  'cohere-1d1b300d-254b-48.md': {
    score: 2.0,
    verdict: 'Agent Harness & Modelling — deeply technical and interesting, but Toronto only. Excluded geo.',
    archetype: 'AI Product (Senior IC)',
    geo: 'Toronto (excluded)',
    comp: 'not listed',
    match: 5, compScore: 3, geoScore: 1, cultural: 5,
    redFlags: 'geo exclusion',
    rec: 'Skip — geo',
  },
  'cohere-2a179d34-c391-48.md': {
    score: 4.0,
    verdict: "Cohere Search & Embeddings PM, NYC, 4+ yr PM. Retrieval/RAG is core AI product work. Vitor's technical depth fits.",
    archetype: 'AI Product (IC)',
    geo: 'NYC',
    comp: 'not listed (Cohere typical range; competitive equity)',
    match: 5, compScore: 4, geoScore: 5, cultural: 5,
    redFlags: '"Drive product strategy and monetization" mentioned — watch for growth drift in interviews',
    rec: 'APPLY',
  },
  'cohere-2a7f1fad-05ff-42.md': {
    score: 1.5,
    verdict: 'Canadian Public Sector & Defence PM — Ottawa/Toronto, requires Top Secret Canadian clearance. Fully excluded.',
    archetype: 'Solutions/Vertical PM',
    geo: 'Canada (excluded)',
    comp: 'not listed',
    match: 2, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'geo exclusion; requires Canadian security clearance',
    rec: 'Skip — geo + clearance',
  },
  'cohere-a8122632-cc3b-4a.md': {
    score: 4.1,
    verdict: "Cohere Safety Research PM — remote or hybrid (NYC/Toronto/London). 5+ yr PM, research+product bridge. Vitor's ability to translate research is a fit.",
    archetype: 'AI Product (Senior IC)',
    geo: 'Remote / NYC hybrid',
    comp: 'not listed (Cohere competitive + equity)',
    match: 4, compScore: 4, geoScore: 5, cultural: 5,
    redFlags: 'somewhat research-ops flavored, not pure product ownership',
    rec: 'Consider',
  },
  'decagon-0563a376-0881-48.md': {
    score: 2.5,
    verdict: "Decagon Voice Agent PM, SF in-office only, $232-290K + equity. Great role + comp but explicit 'we're an in-office company' kills geo.",
    archetype: 'AI Product (IC)',
    geo: 'SF in-office (excluded)',
    comp: '$232K-$290K',
    match: 5, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF in-office mandatory',
    rec: 'Skip — geo',
  },
  'decagon-6321ea2f-4e21-4c.md': {
    score: 2.5,
    verdict: 'Decagon Research PM, SF in-office. Same geo exclusion as Voice Agent.',
    archetype: 'AI Product (IC)',
    geo: 'SF in-office (excluded)',
    comp: '$232K-$290K',
    match: 4, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF in-office',
    rec: 'Skip — geo',
  },
  'decagon-d790a2a2-958d-4f.md': {
    score: 2.5,
    verdict: 'Decagon Platform PM, SF in-office. Founding PM scope but geo excluded.',
    archetype: 'AI Product (IC) / Founding PM',
    geo: 'SF in-office (excluded)',
    comp: '$232K-$290K',
    match: 5, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF in-office',
    rec: 'Skip — geo',
  },
  'decagon-dcf9b561-f2fb-42.md': {
    score: 2.5,
    verdict: "Senior Agent Product Manager role at Decagon. SF in-office. 'Offers Commission' which is unusual for PM and implies sales-adjacency.",
    archetype: 'APM (Agent Product Manager) — hybrid PM/solutions',
    geo: 'SF in-office (excluded)',
    comp: '$200K-$285K + equity + commission',
    match: 3, compScore: 4, geoScore: 1, cultural: 3,
    redFlags: 'SF in-office; commission structure suggests sales-flavor',
    rec: 'Skip — geo + sales-flavored',
  },
  'figma-5505263004.md': {
    score: 4.3,
    verdict: "Figma Design Tools PM — SF/NYC/remote US, $169-303K, 6+ yr PM. Prime AI-native product work at a beloved company.",
    archetype: 'AI Product (Senior IC)',
    geo: 'SF + NYC + Remote US',
    comp: '$169K-$303K',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'none',
    rec: 'APPLY',
  },
  'figma-5819866004.md': {
    score: 4.4,
    verdict: 'Figma Weave (NYC only). Node-based AI creative workflows — structured + generative. 6+ yrs PM, creative/automation tooling.',
    archetype: 'AI Product (Senior IC)',
    geo: 'NYC only',
    comp: '$169K-$303K',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'none',
    rec: 'APPLY',
  },
  'figma-5830640004.md': {
    score: 4.6,
    verdict: "Figma Make AI Platform — 7+ yrs PM, developer tools + AI agents + code execution. Vitor's Proxmox/k3s/homelab stack is precisely what they're hiring for (infra+AI+product). SF/NYC/remote US.",
    archetype: 'AI Product (Senior IC) — Platform',
    geo: 'SF + NYC + Remote US',
    comp: '$169K-$303K',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'none',
    rec: 'APPLY — top priority',
  },
  'glean-4007711005.md': {
    score: 2.5,
    verdict: 'Glean base PM role — SF Bay hybrid 3-4 days. 6+ yrs. Strong role but SF-only geo.',
    archetype: 'AI Product (Senior IC)',
    geo: 'SF Bay hybrid (excluded)',
    comp: '$105K-$240K',
    match: 4, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'SF-only; wide comp range suggests level could be junior-ish',
    rec: 'Skip — geo',
  },
  'glean-4525297005.md': {
    score: 2.5,
    verdict: 'Agent Security & Governance PM — SF Bay hybrid 4 days. Solid role, geo excluded.',
    archetype: 'AI Product (Senior IC)',
    geo: 'SF Bay hybrid (excluded)',
    comp: '$160K-$240K',
    match: 4, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'SF-only',
    rec: 'Skip — geo',
  },
  'glean-4525518005.md': {
    score: 2.5,
    verdict: 'AI Quality PM — SF Bay hybrid. 4+ yrs. LLM evaluation role.',
    archetype: 'AI Product (IC)',
    geo: 'SF Bay hybrid (excluded)',
    comp: '$160K-$240K',
    match: 4, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'SF-only',
    rec: 'Skip — geo',
  },
  'glean-4597178005.md': {
    score: 1.0,
    verdict: 'Connectors PM — Bangalore. Excluded.',
    archetype: 'AI Product (IC)',
    geo: 'Bangalore (excluded)',
    comp: 'not listed',
    match: 4, compScore: 2, geoScore: 1, cultural: 3,
    redFlags: 'geo',
    rec: 'Skip',
  },
  'glean-4641940005.md': {
    score: 1.0,
    verdict: 'Glean Protect PM — Bangalore. Excluded.',
    archetype: 'AI Product (Senior IC)',
    geo: 'Bangalore (excluded)',
    comp: 'not listed',
    match: 4, compScore: 2, geoScore: 1, cultural: 3,
    redFlags: 'geo',
    rec: 'Skip',
  },
  'glean-4659409005.md': {
    score: 4.5,
    verdict: "Glean Forward Deployed PM — NYC hybrid 4 days, $170-280K + equity, explicit founder framing: 'founding member of Glean's forward deployed team, autonomy and accountability of a founder, 0-to-1 product creation'. Vitor's exact profile. 25-50% travel.",
    archetype: 'Founding / Early-Stage PM (inside a larger co)',
    geo: 'NYC hybrid',
    comp: '$170K-$280K + equity',
    match: 5, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: '25-50% travel',
    rec: 'APPLY — top priority',
  },
  'harvey-288a7a0d-ed93-45.md': {
    score: 2.8,
    verdict: 'Staff PM Embedded Experience — SF, $220-260K. Strong platform + integrations work. Geo exclusion.',
    archetype: 'AI Product (Senior IC)',
    geo: 'SF (excluded)',
    comp: '$220K-$260K',
    match: 4, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF-only; "Partnerships" involvement reads adjacent-to-sales',
    rec: 'Skip — geo',
  },
  'harvey-2cbe13b9-a44b-47.md': {
    score: 4.2,
    verdict: "Harvey Staff PM New Verticals — NYC, $178.5-241.5K + equity, 8+ yrs. Agent PM work across strategic legal accounts. Strong NYC match.",
    archetype: 'AI Product (Senior IC) / Vertical Solutions PM',
    geo: 'NYC',
    comp: '$178.5K-$241.5K + equity',
    match: 5, compScore: 5, geoScore: 5, cultural: 4,
    redFlags: '"Influence new commercial models, pricing, packaging" — light growth-flavor to watch',
    rec: 'APPLY',
  },
  'harvey-39c40209-798d-47.md': {
    score: 2.8,
    verdict: "Staff PM Agent Platform — SF, $213.6-300K. 0-to-1 agent platform product work. Geo exclusion.",
    archetype: 'AI Product (Senior IC)',
    geo: 'SF (excluded)',
    comp: '$213.6K-$300K',
    match: 5, compScore: 5, geoScore: 1, cultural: 5,
    redFlags: 'SF-only',
    rec: 'Skip — geo',
  },
  'harvey-3b63c938-eee5-48.md': {
    score: 2.0,
    verdict: 'Innovation PM EMEA — London. Legal-flavored solutions role. Geo excluded.',
    archetype: 'Solutions / Vertical PM',
    geo: 'London (excluded)',
    comp: 'not listed',
    match: 3, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'geo; legal background preferred',
    rec: 'Skip — geo',
  },
  'harvey-8d092528-2554-42.md': {
    score: 2.8,
    verdict: 'Staff PM (SF) — Integrations + Partnerships at Harvey. $220-260K. Geo exclusion.',
    archetype: 'AI Product (Senior IC) — Integrations',
    geo: 'SF (excluded)',
    comp: '$220K-$260K',
    match: 4, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF-only; heavy partnerships orientation',
    rec: 'Skip — geo',
  },
  'harvey-e5272fbe-4431-48.md': {
    score: 4.0,
    verdict: "Harvey Innovation PM — NYC. Legal-world product innovation, sits between PM and forward-deployed. Requires legal background.",
    archetype: 'Forward-Deployed PM / Solutions',
    geo: 'NYC',
    comp: 'not listed',
    match: 3, compScore: 3, geoScore: 5, cultural: 4,
    redFlags: '"Experience at a top law firm or in-house legal team" is preferred — Vitor lacks legal background',
    rec: 'Consider — legal experience gap may hurt',
  },
  'langchain-27af5f96-b287-4b.md': {
    score: 4.4,
    verdict: "LangChain PM LangSmith — NYC, AI observability/eval for LLMs. LangChain is the agent ecosystem leader. Vitor's homelab + AI prototyping experience ⇒ natural fit.",
    archetype: 'AI Product (Senior IC)',
    geo: 'NYC',
    comp: 'not listed (LangChain competitive + equity)',
    match: 5, compScore: 4, geoScore: 5, cultural: 5,
    redFlags: 'comp not disclosed — verify in first conversation',
    rec: 'APPLY',
  },
  'mistral-ai-11087966-f183-44.md': {
    score: 1.5,
    verdict: 'Mistral AI Forge PM — Paris. Geo excluded.',
    archetype: 'AI Product (IC)',
    geo: 'Paris (excluded)',
    comp: 'not listed',
    match: 4, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'mistral-ai-6201f9a0-233f-4d.md': {
    score: 1.5,
    verdict: 'Mistral AI Studio PM — Paris. Geo excluded.',
    archetype: 'AI Product (IC)',
    geo: 'Paris (excluded)',
    comp: 'not listed',
    match: 4, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'mistral-ai-c08c3a0f-9899-4e.md': {
    score: 1.5,
    verdict: 'Mistral Context & Search PM — Paris. Geo excluded.',
    archetype: 'AI Product (IC)',
    geo: 'Paris (excluded)',
    comp: 'not listed',
    match: 4, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'mistral-ai-ca22a1ac-c87e-44.md': {
    score: 3.0,
    verdict: 'Mistral Cloud Partnerships PM — NYC. "Partnerships" in title is a yellow flag per Vitor\'s rules (sales-disguised risk). NYC geo works but verify role is product-craft, not partnership management.',
    archetype: 'Partnerships / Solutions (not pure PM)',
    geo: 'NYC',
    comp: 'not listed',
    match: 3, compScore: 3, geoScore: 5, cultural: 3,
    redFlags: '"Cloud Partnerships" title pattern matches sales-disguised-as-PM warning',
    rec: 'Consider cautiously — verify in screening call it is actual product work',
  },
  'mistral-ai-e769b26a-90e9-4c.md': {
    score: 1.5,
    verdict: 'Mistral Audio PM — Paris. Geo excluded.',
    archetype: 'AI Product (IC)',
    geo: 'Paris (excluded)',
    comp: 'not listed',
    match: 4, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'notion-35785e61-c4c3-44.md': {
    score: 4.4,
    verdict: "Notion Enterprise PM — NYC (3 days in-office Mon/Tue/Thu), $180-235K. Requires MCP + API + enterprise integrations experience — Vitor's homelab (k3s, Proxmox, self-hosted services) is rare-fit.",
    archetype: 'AI Product (Senior IC)',
    geo: 'NYC hybrid',
    comp: '$180K-$235K',
    match: 5, compScore: 5, geoScore: 5, cultural: 4,
    redFlags: 'none — "AI-pilled" and MCP experience are explicit upsides for Vitor',
    rec: 'APPLY',
  },
  'perplexity-f25e190e-0508-47.md': {
    score: 2.8,
    verdict: 'Perplexity PM Builder — SF, $230-330K + equity. "Computer" agentic product, small team. Geo exclusion.',
    archetype: 'AI Product (IC)',
    geo: 'SF (excluded)',
    comp: '$230K-$330K + equity',
    match: 5, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF-only',
    rec: 'Skip — geo',
  },
  'pinecone-24f9a4e3-472d-4e.md': {
    score: 4.3,
    verdict: 'Pinecone Principal PM Knowledge — NYC, $240-300K + equity, 5+ yrs PM with ML/LLM/GenAI. Retrieval quality and advanced RAG.',
    archetype: 'AI Product (Senior IC)',
    geo: 'NYC',
    comp: '$240K-$300K + equity',
    match: 4, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'BS/MS/PhD CS preferred — Vitor has MBA + Columbia full-stack cert, may need to frame technical background strongly',
    rec: 'APPLY',
  },
  'pinecone-7261adcb-026d-45.md': {
    score: 4.2,
    verdict: 'Pinecone Principal PM Database — NYC, $240-300K + equity, 7+ yrs PM for cloud infra products. Core DB product.',
    archetype: 'AI Product (Senior IC) — Infra',
    geo: 'NYC',
    comp: '$240K-$300K + equity',
    match: 4, compScore: 5, geoScore: 5, cultural: 5,
    redFlags: 'BS/MS/PhD CS preferred — same framing challenge as Knowledge PM',
    rec: 'APPLY',
  },
  'replit-cf236c47-218b-4a.md': {
    score: 2.8,
    verdict: 'Replit Senior PM — Foster City hybrid 3 days (M/W/F). Agentic dev tools. Geo excluded.',
    archetype: 'AI Product (Senior IC)',
    geo: 'Foster City hybrid (excluded — SF Bay)',
    comp: '$176K-$242K + equity',
    match: 5, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'Bay Area in-office',
    rec: 'Skip — geo',
  },
  'sierra-0c66e8ed-1c18-4b.md': {
    score: 2.5,
    verdict: "Sierra Voice PM — SF, $230-390K. 'Primarily in-person SF' per the JD. Great product, great comp, geo excluded.",
    archetype: 'AI Product (IC)',
    geo: 'SF in-person (excluded)',
    comp: '$230K-$390K',
    match: 5, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF in-person — Sierra is explicitly SF-centric',
    rec: 'Skip — geo',
  },
  'sierra-10d2e2f1-6657-40.md': {
    score: 2.5,
    verdict: 'Sierra Agent SDK PM — SF, $175-350K. Developer-facing PM for agent SDK. Geo excluded.',
    archetype: 'AI Product (IC)',
    geo: 'SF in-person (excluded)',
    comp: '$175K-$350K',
    match: 5, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF in-person',
    rec: 'Skip — geo',
  },
  'sierra-22ba107d-de01-4a.md': {
    score: 2.5,
    verdict: 'Sierra Ghostwriter PM — SF, $230-390K. "Agent-building agent" product, fascinating. Geo excluded.',
    archetype: 'AI Product (IC)',
    geo: 'SF in-person (excluded)',
    comp: '$230K-$390K',
    match: 5, compScore: 5, geoScore: 1, cultural: 4,
    redFlags: 'SF in-person',
    rec: 'Skip — geo',
  },
  'sierra-2e07f536-bbaa-4c.md': {
    score: 2.0,
    verdict: 'Sierra Agent Dev (Italian) — London. Geo excluded.',
    archetype: 'Agent PM',
    geo: 'London (excluded)',
    comp: '£150K-£315K',
    match: 3, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'sierra-38f06024-4ee9-47.md': {
    score: 2.0,
    verdict: 'Sierra Agent Dev (French) — London. Geo excluded.',
    archetype: 'Agent PM',
    geo: 'London (excluded)',
    comp: '£150K-£315K',
    match: 3, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'sierra-422cb7bb-ab03-44.md': {
    score: 2.0,
    verdict: 'Sierra Agent Dev (Spanish) — London. Geo excluded.',
    archetype: 'Agent PM',
    geo: 'London (excluded)',
    comp: '£150K-£315K',
    match: 3, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'sierra-4892f01e-8871-4b.md': {
    score: 2.0,
    verdict: 'Sierra Agent Dev (Arabic) — London. Geo excluded.',
    archetype: 'Agent PM',
    geo: 'London (excluded)',
    comp: '£150K-£315K',
    match: 3, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'sierra-5aaa2eeb-92bc-4b.md': {
    score: 2.0,
    verdict: 'Sierra Agent Dev — Tokyo. Geo excluded.',
    archetype: 'Agent PM',
    geo: 'Tokyo (excluded)',
    comp: 'not listed',
    match: 3, compScore: 3, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'sierra-65eb2c63-c936-4e.md': {
    score: 2.5,
    verdict: "Sierra Agent Dev - Healthcare — SF. Vertical PM in a strong vertical. Geo excluded.",
    archetype: 'Agent PM / Vertical',
    geo: 'SF in-person (excluded)',
    comp: 'not listed',
    match: 4, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'SF in-person',
    rec: 'Skip — geo',
  },
  'sierra-9dc1651d-43e9-49.md': {
    score: 2.5,
    verdict: 'Sierra Agent Data Platform PM — SF. Platform PM role, geo excluded.',
    archetype: 'AI Product (IC) — Platform',
    geo: 'SF in-person (excluded)',
    comp: 'not listed',
    match: 4, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'SF in-person',
    rec: 'Skip — geo',
  },
  'sierra-edf44ab4-538b-4e.md': {
    score: 2.0,
    verdict: 'Sierra Agent Development (base) — London. Geo excluded.',
    archetype: 'Agent PM',
    geo: 'London (excluded)',
    comp: '£150K-£315K',
    match: 3, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'sierra-effd7cd2-8a28-4b.md': {
    score: 2.0,
    verdict: 'Sierra Agent Dev (German) — London. Geo excluded.',
    archetype: 'Agent PM',
    geo: 'London (excluded)',
    comp: '£150K-£315K',
    match: 3, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'geo',
    rec: 'Skip — geo',
  },
  'sierra-fed8ca9a-0bb7-44.md': {
    score: 2.5,
    verdict: 'Sierra Agent Studio PM — SF. Platform-side PM for agent authoring. Geo excluded.',
    archetype: 'AI Product (IC)',
    geo: 'SF in-person (excluded)',
    comp: 'not listed',
    match: 4, compScore: 4, geoScore: 1, cultural: 4,
    redFlags: 'SF in-person',
    rec: 'Skip — geo',
  },
};

// Posting-legitimacy tier based on Vitor's strict freshness preferences:
//   <=5 days  = Fresh (the goal)
//   6-30 days = Old (still possible but saturation likely)
//   >30 days  = Irrelevant (probably already filled or moved on)
//   >90 days  = Ghost-Likely (almost certainly not an active role)
// Kept independent of the 1-5 global score (career-ops Block G design).
function legitimacyTier(days) {
  if (days == null) return { tier: 'Unknown',      note: 'no posting date available' };
  if (days <= 5)    return { tier: 'Fresh',        note: `${days} days old — within Vitor's goal window` };
  if (days <= 30)   return { tier: 'Old',          note: `${days} days old — past goal window; apply quickly if at all` };
  if (days <= 90)   return { tier: 'Irrelevant',   note: `${days} days old — likely already filled per Vitor's rules` };
  return { tier: 'Ghost-Likely', note: `${days} days old — almost certainly not an active role` };
}

async function main() {
  const jdsDir = 'jds';
  const reportsDir = 'reports';
  const entries = (await readdir(jdsDir)).filter(f => f.endsWith('.md'));

  let scored = 0, missing = 0, written = 0;
  const unscored = [];

  for (const filename of entries) {
    const jdPath = path.join(jdsDir, filename);
    const jd = await readFile(jdPath, 'utf-8');

    // Parse front-matter from JD file (produced by fetch-jds.mjs)
    const title = (jd.match(/^# (.+)$/m) || [])[1] || 'Unknown Role';
    const url = (jd.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1] || '';
    const company = (jd.match(/\*\*Company:\*\*\s+(.+)/) || [])[1] || 'Unknown';
    const location = (jd.match(/\*\*Location:\*\*\s+(.+)/) || [])[1] || '';
    const payHeader = (jd.match(/\*\*Compensation:\*\*\s+(.+)/) || [])[1] || '';
    const postedLine = (jd.match(/\*\*Posted:\*\*\s+(.+)/) || [])[1] || '';
    const daysMatch = postedLine.match(/\((\d+) days ago\)/);
    const postedDays = daysMatch ? parseInt(daysMatch[1], 10) : null;
    const leg = legitimacyTier(postedDays);

    const s = SCORING[filename] || SCORING_TIER1[filename];
    if (!s) {
      unscored.push(filename);
      missing++;
      continue;
    }
    scored++;

    const slug = filename.replace(/\.md$/, '');
    const reportPath = path.join(reportsDir, `v-${slug}.md`);

    const body = `# ${company} — ${title}

**URL:** ${url}
**Company:** ${company}
**Location (from JD):** ${location}
**Comp (from JD):** ${payHeader || s.comp}
**Posted:** ${postedLine || 'not available'}
**Legitimacy tier:** ${leg.tier} — ${leg.note}
**Evaluated:** 2026-04-21 by Claude (Opus 4.7) against modes/_profile.md
**Score:** ${s.score.toFixed(1)}/5
**Archetype:** ${s.archetype}
**Geography:** ${s.geo}
**Comp (interpreted):** ${s.comp}

## Verdict

${s.verdict}

## Recommendation

**${s.rec}**

${leg.tier === 'Old' || leg.tier === 'Irrelevant' || leg.tier === 'Ghost-Likely'
  ? `⚠️ **Freshness warning:** ${leg.note}. Vitor's rule: ≤5 days = goal, >30 days = probably irrelevant. ${leg.tier === 'Irrelevant' || leg.tier === 'Ghost-Likely' ? 'Verify it is still open before applying.' : 'Move fast.'}`
  : ''}

## Dimension scores (1-5 scale)

| Dimension | Score | Notes |
|-----------|:-----:|-------|
| CV match | ${s.match}/5 | How well Vitor's 10+ yrs PM + AI prototyping maps to the JD |
| Archetype fit | ${['', '1/5','2/5','3/5','4/5','5/5'][Math.max(1,Math.round((s.score+s.match)/2))]} | ${s.archetype} vs target list (AI Product IC / Founding PM / Senior hands-on Director) |
| Compensation | ${s.compScore}/5 | Vitor's sweet spot is $150K-$200K base; $200K+ = 5/5; below $150K requires concrete equity |
| Geography | ${s.geoScore}/5 | Equal-weight primary: LA / NYC / NYC-commutable / remote US / remote+HQ travel |
| Cultural signals | ${s.cultural}/5 | Company stage, team quality, mission, work style |
| Posting legitimacy | ${leg.tier} | ${leg.note} (independent of 1-5 global score per career-ops Block G design) |

## Red flags

${s.redFlags}

## Global score: ${s.score.toFixed(1)}/5

${s.score >= 4.0 ? '✅ High fit — worth pursuing actively.' : s.score >= 3.5 ? '⚠️ Decent fit — apply selectively.' : '❌ Below applying bar per Vitor\'s rules.'}
`;

    await writeFile(reportPath, body);
    written++;
  }

  console.log(`\nDone. scored=${scored} written=${written} missing=${missing}`);
  if (unscored.length) {
    console.log(`\nUnscored files (no entry in SCORING table):`);
    unscored.forEach(f => console.log('  ' + f));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
