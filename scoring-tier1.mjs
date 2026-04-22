// scoring-tier1.mjs - Claude-curated scoring for the 125 JDs added during
// the 2026-04-22 Tier 1 portal expansion (probe-portals.mjs run).
//
// Same shape as score-all.mjs's SCORING object. Imported and merged into
// SCORING by score-all.mjs.

export const SCORING_TIER1 = {

  // ===== Algolia (London, international) =====
  'algolia-5435426004.md': { score: 1.5, verdict: "AI Search Director role but London-only. Geography excluded.", archetype: 'AI Product Director', geo: 'London (excluded)', comp: 'not stated', match: 4, compScore: 3, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'algolia-5725185004.md': { score: 1.5, verdict: "Senior PM Data role, London-only.", archetype: 'AI Product (IC)', geo: 'London (excluded)', comp: 'not stated', match: 4, compScore: 3, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'algolia-5729016004.md': { score: 1.5, verdict: "Principal PM Tech Platform, London-only.", archetype: 'AI Platform PM', geo: 'London (excluded)', comp: 'not stated', match: 4, compScore: 3, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },

  // ===== Anyscale (SF only) =====
  'anyscale-71f0d335-6b29-43.md': { score: 2.5, verdict: "Senior/Staff PM Ray Data, SF only. AI infra fit but geo excluded.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: '$219K-$250K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip unless remote negotiable' },
  'anyscale-b988fd59-9034-48.md': { score: 2.5, verdict: "PM Observability, SF only. Strong infra fit but geo excluded.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: '$220K-$265K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip unless remote negotiable' },

  // ===== Brex =====
  'brex-8432698002.md': { score: 2.8, verdict: "Staff PM SF, $240-300K. Top fintech, but SF-only.", archetype: 'Senior PM (fintech)', geo: 'SF (excluded)', comp: '$240K-$300K', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip - geo' },
  'brex-8432702002.md': { score: 4.5, verdict: "Staff PM NYC, $240-300K. Top fintech in his geo with great comp.", archetype: 'Senior PM (fintech)', geo: 'NYC', comp: '$240K-$300K', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'fintech-adjacent (not core for Vitor)', rec: 'APPLY' },
  'brex-8438580002.md': { score: 2.8, verdict: "Group PM SF, $280-350K. Top fintech but SF-only.", archetype: 'Senior PM (fintech)', geo: 'SF (excluded)', comp: '$280K-$350K', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip - geo' },
  'brex-8438581002.md': { score: 4.6, verdict: "Group PM NYC, $280-350K. Top fintech, his geo, exceptional comp. Player-coach IC+.", archetype: 'Senior PM / Hands-on Director', geo: 'NYC', comp: '$280K-$350K', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'fintech-adjacent', rec: 'APPLY' },

  // ===== Character.AI =====
  'character-ai-5aa34edd-33b0-4e.md': { score: 2.5, verdict: "PM Core Product, Redwood City. Consumer AI fit but Bay-only.", archetype: 'Consumer AI PM', geo: 'Bay Area (excluded)', comp: '$225K-$275K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'Bay-only', rec: 'Skip - geo' },

  // ===== Crusoe (SF/Sunnyvale) =====
  'crusoe-68cbbe99-8fd8-49.md': { score: 2.5, verdict: "Staff PM Compute, SF. AI cloud infra fit but geo excluded.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: '$208K-$253K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip - geo' },
  'crusoe-6cc6dcf0-e3a2-49.md': { score: 2.5, verdict: "Staff PM Managed Intelligence, SF. AI services fit but geo excluded.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: '$204K-$247K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip - geo' },
  'crusoe-ed9d0936-5f34-42.md': { score: 2.5, verdict: "Staff PM Orchestration (K8s), SF. Strong infra fit (Vitor runs k3s) but geo.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: '$208K-$253K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip - geo' },

  // ===== Databricks (mostly SF/Seattle/EU - one NYC) =====
  'databricks-7110499002.md': { score: 2.5, verdict: "Staff PM Security, SF. Geo excluded.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only, security niche', rec: 'Skip - geo' },
  'databricks-7110509002.md': { score: 2.0, verdict: "Staff PM Security, Seattle. Geo excluded.", archetype: 'AI Infra PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-7649409002.md': { score: 1.5, verdict: "Staff PM Amsterdam.", archetype: 'AI Infra PM', geo: 'Amsterdam (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'databricks-7649411002.md': { score: 1.5, verdict: "Staff PM Berlin.", archetype: 'AI Infra PM', geo: 'Berlin (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'databricks-7680573002.md': { score: 2.5, verdict: "Sr PM Free Edition, SF.", archetype: 'AI Product (IC)', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip - geo' },
  'databricks-7863365002.md': { score: 2.5, verdict: "Sr PM Data Governance, SF.", archetype: 'Data Platform PM', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only, governance niche', rec: 'Skip - geo' },
  'databricks-7863522002.md': { score: 2.0, verdict: "Sr PM Data Governance, Seattle.", archetype: 'Data Platform PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-7924423002.md': { score: 2.5, verdict: "Sr PM DBSQL, SF.", archetype: 'Data Platform PM', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only, SQL-niche', rec: 'Skip - geo' },
  'databricks-7929994002.md': { score: 2.0, verdict: "Sr PM DBSQL, Seattle.", archetype: 'Data Platform PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8040989002.md': { score: 2.5, verdict: "Staff PM Content Experience, SF.", archetype: 'Content/Learning PM', geo: 'SF (excluded)', comp: 'not stated', match: 3, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only, content-niche', rec: 'Skip - geo' },
  'databricks-8041821002.md': { score: 2.0, verdict: "Staff PM Content Experience, Seattle.", archetype: 'Content/Learning PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 3, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8133727002.md': { score: 1.0, verdict: "PM New Grad Amsterdam. Junior + international.", archetype: 'Junior PM', geo: 'Amsterdam (excluded)', comp: 'not stated', match: 1, compScore: 3, geoScore: 1, cultural: 5, redFlags: 'junior + international', rec: 'Skip' },
  'databricks-8136071002.md': { score: 2.8, verdict: "Sr PM Databricks AI, SF. Strong AI fit but SF-only.", archetype: 'AI Product (IC)', geo: 'SF (excluded)', comp: 'not stated', match: 5, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip unless remote negotiable' },
  'databricks-8136204002.md': { score: 2.0, verdict: "Sr PM Databricks AI, Seattle.", archetype: 'AI Product (IC)', geo: 'Seattle (excluded)', comp: 'not stated', match: 5, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8145800002.md': { score: 1.0, verdict: "PM New Grad Berlin.", archetype: 'Junior PM', geo: 'Berlin (excluded)', comp: 'not stated', match: 1, compScore: 3, geoScore: 1, cultural: 5, redFlags: 'junior + international', rec: 'Skip' },
  'databricks-8186386002.md': { score: 1.5, verdict: "Sr PM Lakeflow, Amsterdam.", archetype: 'Data Platform PM', geo: 'Amsterdam (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'databricks-8200284002.md': { score: 2.0, verdict: "Sr PM Compute Platform, Seattle.", archetype: 'AI Infra PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8200462002.md': { score: 2.5, verdict: "Sr PM Compute Platform, SF.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip - geo' },
  'databricks-8235785002.md': { score: 2.0, verdict: "Sr PM Free Edition, Seattle.", archetype: 'AI Product (IC)', geo: 'Seattle (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8326513002.md': { score: 2.5, verdict: "Sr PM Repos, SF. Dev tools fit but SF only.", archetype: 'Developer Tools PM', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip - geo' },
  'databricks-8326570002.md': { score: 2.0, verdict: "Sr PM Repos, Seattle.", archetype: 'Developer Tools PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8387085002.md': { score: 4.0, verdict: "Sr PM Technical, NYC. Databricks in his geo. Strong cultural tier.", archetype: 'AI/Data Platform PM', geo: 'NYC', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'comp not stated', rec: 'APPLY' },
  'databricks-8394060002.md': { score: 1.5, verdict: "Staff PM Technical, Amsterdam.", archetype: 'AI/Data Platform PM', geo: 'Amsterdam (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'databricks-8420607002.md': { score: 2.5, verdict: "Staff PM Serverless Workspaces, SF.", archetype: 'AI Infra PM', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip - geo' },
  'databricks-8420609002.md': { score: 2.8, verdict: "Staff PM AI Platform, SF. Strongest archetype match but SF-only.", archetype: 'AI Platform PM', geo: 'SF (excluded)', comp: 'not stated', match: 5, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'SF-only', rec: 'Skip unless remote negotiable' },
  'databricks-8427940002.md': { score: 2.0, verdict: "Staff PM AI Platform, Seattle.", archetype: 'AI Platform PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 5, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8427954002.md': { score: 2.0, verdict: "Staff PM Serverless Workspaces, Seattle.", archetype: 'AI Infra PM', geo: 'Seattle (excluded)', comp: 'not stated', match: 4, compScore: 5, geoScore: 1, cultural: 5, redFlags: 'Seattle-only', rec: 'Skip - geo' },
  'databricks-8466731002.md': { score: 3.5, verdict: "Learning PM Lead, US-anywhere. Databricks education niche; remote-friendly but adjacent to Vitor's lane.", archetype: 'Education/Learning PM', geo: 'US (remote OK)', comp: 'not stated', match: 3, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'education niche', rec: 'Apply selectively' },

  // ===== Datadog (NYC, except Paris) =====
  'datadog-7144556.md': { score: 3.0, verdict: "PM II Model Lab NYC. Mid-level title; AI focus is good fit but Vitor is over-leveled for II.", archetype: 'AI Product (IC)', geo: 'NYC', comp: 'not stated (Datadog NYC tier)', match: 4, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II under-level for 10+ yr PM', rec: 'Apply selectively' },
  'datadog-7555509.md': { score: 3.5, verdict: "PM II Semantic & Agentic Search AI NYC. Agentic AI fit, NYC; PM II under-level.", archetype: 'AI Product (IC)', geo: 'NYC', comp: 'not stated', match: 4, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II under-level', rec: 'Apply selectively' },
  'datadog-7555533.md': { score: 4.0, verdict: "Sr PM Networking NYC. Senior + NYC + Datadog; networking niche.", archetype: 'Senior PM (infra)', geo: 'NYC', comp: 'not stated', match: 3, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'networking-specific', rec: 'APPLY' },
  'datadog-7560326.md': { score: 4.0, verdict: "Sr PM Notebooks NYC. Devtools + AI-adjacent + NYC.", archetype: 'Developer Tools PM', geo: 'NYC', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'datadog-7583609.md': { score: 4.5, verdict: "Director PM Core Platforms NYC. Hands-on Director at scaled tech co, his geo.", archetype: 'Senior Director PM', geo: 'NYC', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'verify it is hands-on, not manager-of-managers', rec: 'APPLY' },
  'datadog-7608826.md': { score: 3.5, verdict: "Group PM Threat Detection / SIEM NYC. Security niche, less AI focus.", archetype: 'Security PM', geo: 'NYC', comp: 'not stated', match: 3, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'security-niche', rec: 'Apply selectively' },
  'datadog-7616721.md': { score: 4.7, verdict: "Director PM Applied AI NYC. Director + Applied AI + NYC + Datadog. Near-perfect.", archetype: 'AI Product Director', geo: 'NYC', comp: 'not stated', match: 5, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'verify hands-on IC+', rec: 'APPLY' },
  'datadog-7641271.md': { score: 3.0, verdict: "PM II Code Security NYC. Mid-level + security niche.", archetype: 'Security PM', geo: 'NYC', comp: 'not stated', match: 3, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II + security-niche', rec: 'Skip' },
  'datadog-7646496.md': { score: 3.0, verdict: "PM II Cloud Detection & Response NYC. Mid-level + security niche.", archetype: 'Security PM', geo: 'NYC', comp: 'not stated', match: 3, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II + security', rec: 'Skip' },
  'datadog-7654981.md': { score: 3.8, verdict: "Group PM Containers NYC. Group level + infra + NYC.", archetype: 'Senior PM (infra)', geo: 'NYC', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'containers-niche', rec: 'Apply selectively' },
  'datadog-7679601.md': { score: 4.0, verdict: "Director PM Security NYC. Director + NYC + Datadog; security-niche.", archetype: 'Senior Director PM', geo: 'NYC', comp: 'not stated', match: 3, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'security-niche, verify hands-on', rec: 'APPLY' },
  'datadog-7694469.md': { score: 1.5, verdict: "PM II RUM Paris.", archetype: 'Mid PM', geo: 'Paris (excluded)', comp: 'not stated', match: 3, compScore: 3, geoScore: 1, cultural: 5, redFlags: 'international + PM II', rec: 'Skip' },
  'datadog-7696404.md': { score: 4.5, verdict: "Sr PM AI Remediation NYC. AI + senior + NYC + Datadog. Strong fit.", archetype: 'AI Product (Senior IC)', geo: 'NYC', comp: 'not stated', match: 5, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'datadog-7704689.md': { score: 3.0, verdict: "PM II Custom Metrics NYC. Mid-level + observability-niche.", archetype: 'Mid PM (observability)', geo: 'NYC', comp: 'not stated', match: 3, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II', rec: 'Skip' },
  'datadog-7713577.md': { score: 3.0, verdict: "PM II Log Management NYC. Mid-level + log-niche.", archetype: 'Mid PM (observability)', geo: 'NYC', comp: 'not stated', match: 3, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II', rec: 'Skip' },
  'datadog-7723988.md': { score: 4.0, verdict: "Sr PM Integrations & Ecosystem NYC. Sr + NYC + integrations is API/platform-y.", archetype: 'Senior PM (platform)', geo: 'NYC', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'datadog-7763117.md': { score: 3.0, verdict: "PM II Network Path NYC. Mid + network-niche.", archetype: 'Mid PM (networking)', geo: 'NYC', comp: 'not stated', match: 2, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II + niche', rec: 'Skip' },
  'datadog-7776413.md': { score: 3.0, verdict: "PM II Identity Security NYC. Mid + security-niche.", archetype: 'Security PM', geo: 'NYC', comp: 'not stated', match: 3, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II', rec: 'Skip' },
  'datadog-7785350.md': { score: 4.5, verdict: "Sr PM Data Agent NYC. AI agent + Sr + NYC + Datadog. Strong fit.", archetype: 'AI Product (Senior IC)', geo: 'NYC', comp: 'not stated', match: 5, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'datadog-7798672.md': { score: 4.7, verdict: "Director PM AI Observability NYC. Director + AI + observability is the perfect intersection of his strengths. Top pick.", archetype: 'AI Product Director', geo: 'NYC', comp: 'not stated', match: 5, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'verify hands-on IC+', rec: 'APPLY' },
  'datadog-7800765.md': { score: 3.0, verdict: "PM II Risk-Based Alerting / SIEM NYC. Mid + security.", archetype: 'Security PM', geo: 'NYC', comp: 'not stated', match: 3, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II + niche', rec: 'Skip' },
  'datadog-7808839.md': { score: 3.5, verdict: "PM II AI & Data Security NYC. AI tagged but PM II + security niche.", archetype: 'AI Security PM', geo: 'NYC', comp: 'not stated', match: 4, compScore: 4, geoScore: 5, cultural: 5, redFlags: 'PM II', rec: 'Apply selectively' },
  'datadog-7833865.md': { score: 4.0, verdict: "Sr PM Code Security NYC. Sr + NYC + security niche.", archetype: 'Security PM', geo: 'NYC', comp: 'not stated', match: 3, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'security-niche', rec: 'APPLY' },

  // ===== Decagon =====
  'decagon-e31c0645-7325-43.md': { score: 4.5, verdict: "Sr Agent PM NYC, $200-285K. AI agent product in his geo with great comp.", archetype: 'AI Product (Senior IC)', geo: 'NYC', comp: '$200K-$285K', match: 5, compScore: 5, geoScore: 5, cultural: 4, redFlags: 'none', rec: 'APPLY' },
  'decagon-ee6c3e3f-b6ce-49.md': { score: 1.5, verdict: "Sr Agent PM London.", archetype: 'AI Product (Senior IC)', geo: 'London (excluded)', comp: '£145K-£200K', match: 5, compScore: 3, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },

  // ===== Descript =====
  'descript-6576153003.md': { score: 2.8, verdict: "PM AI Models, SF. Strong AI fit but SF-only.", archetype: 'AI Product (IC)', geo: 'SF (excluded)', comp: '$171K-$235K', match: 5, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip unless remote negotiable' },
  'descript-7413750003.md': { score: 4.0, verdict: "PM Editor, SF or Remote US. Consumer creator workflow + remote-OK.", archetype: 'Consumer AI PM', geo: 'Remote US', comp: '$171K-$235K', match: 4, compScore: 4, geoScore: 5, cultural: 4, redFlags: 'creative-tools is new domain', rec: 'APPLY' },
  'descript-7606367003.md': { score: 4.2, verdict: "PM API & Platform, SF or Remote US. Dev tools + remote-OK.", archetype: 'Developer Tools PM', geo: 'Remote US', comp: '$171K-$235K', match: 4, compScore: 4, geoScore: 5, cultural: 4, redFlags: 'none', rec: 'APPLY' },

  // ===== Elastic =====
  'elastic-7603577.md': { score: 2.5, verdict: "Technical PM Canada. Canada is borderline geo.", archetype: 'Technical PM', geo: 'Canada (borderline)', comp: 'not stated', match: 4, compScore: 4, geoScore: 2, cultural: 4, redFlags: 'Canada-only', rec: 'Skip unless remote negotiable' },
  'elastic-7624142.md': { score: 1.5, verdict: "Principal PM AI Observability, Spain.", archetype: 'AI Platform PM', geo: 'Spain (excluded)', comp: 'not stated', match: 5, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'elastic-7635293.md': { score: 1.5, verdict: "Sr PM Logs Observability, Spain.", archetype: 'Senior PM (observability)', geo: 'Spain (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },

  // ===== Glean =====
  'glean-4482380005.md': { score: 2.5, verdict: "PM Connectors SF Bay. Integrations PM but Bay-only.", archetype: 'Integration PM', geo: 'SF Bay (excluded)', comp: '$165K-$280K', match: 4, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'Bay-only', rec: 'Skip - geo' },
  'glean-4629292005.md': { score: 1.0, verdict: "PM Bangalore.", archetype: 'AI Product (IC)', geo: 'Bangalore (excluded)', comp: 'not stated', match: 4, compScore: 3, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip' },
  'glean-4651950005.md': { score: 4.4, verdict: "Forward Deployed PM Remote US. Customer-facing AI PM, his geo, founder-style.", archetype: 'Forward Deployed PM', geo: 'Remote US', comp: '~$170K-$280K', match: 5, compScore: 5, geoScore: 5, cultural: 4, redFlags: 'none', rec: 'APPLY' },
  'glean-4659407005.md': { score: 2.5, verdict: "Forward Deployed PM SF Bay. Same role, geo excluded.", archetype: 'Forward Deployed PM', geo: 'SF Bay (excluded)', comp: '~$170K-$280K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'Bay-only', rec: 'Skip - geo' },

  // ===== Harvey (legal industry — Vitor lacks legal background, hard skip per voice rule) =====
  'harvey-549b549c-b589-44.md': { score: 1.5, verdict: "Staff PM Agent Platform NYC, $213-300K. Strong on paper but Harvey requires legal-industry experience Vitor lacks; voice rule = skip.", archetype: 'AI Product (Senior IC)', geo: 'NYC', comp: '$213K-$300K', match: 4, compScore: 5, geoScore: 5, cultural: 4, redFlags: 'legal-industry background required (Vitor lacks)', rec: 'Skip per voice rule' },
  'harvey-7b468987-7236-42.md': { score: 1.0, verdict: "Staff PM Bengaluru. International + legal industry.", archetype: 'AI Product (Senior IC)', geo: 'Bengaluru (excluded)', comp: 'not stated', match: 4, compScore: 3, geoScore: 1, cultural: 4, redFlags: 'international + legal industry', rec: 'Skip' },
  'harvey-d71c8e88-f5da-47.md': { score: 1.5, verdict: "Staff PM Agent Platform Toronto, $132-199K. International + legal industry.", archetype: 'AI Product (Senior IC)', geo: 'Toronto (excluded)', comp: '$132K-$199K', match: 4, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international + legal industry + below comp floor', rec: 'Skip' },

  // ===== Intercom (all EU) =====
  'intercom-5379326.md': { score: 1.5, verdict: "Staff PM London.", archetype: 'AI Product (Senior IC)', geo: 'London (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'intercom-5663703.md': { score: 1.5, verdict: "PM London.", archetype: 'AI Product (IC)', geo: 'London (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'intercom-5663720.md': { score: 1.5, verdict: "Staff PM Dublin.", archetype: 'AI Product (Senior IC)', geo: 'Dublin (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'intercom-6758904.md': { score: 1.5, verdict: "Sr PM Web (Narrative/Content) London.", archetype: 'Web Content PM', geo: 'London (excluded)', comp: 'not stated', match: 3, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international + content-marketing-adjacent', rec: 'Skip - geo' },
  'intercom-7371973.md': { score: 1.5, verdict: "Staff PM Berlin.", archetype: 'AI Product (Senior IC)', geo: 'Berlin (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'intercom-7464291.md': { score: 1.5, verdict: "Staff/Sr AI PM London.", archetype: 'AI Product (Senior IC)', geo: 'London (excluded)', comp: 'not stated', match: 5, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'intercom-7464294.md': { score: 1.5, verdict: "Staff/Sr AI PM Berlin.", archetype: 'AI Product (Senior IC)', geo: 'Berlin (excluded)', comp: 'not stated', match: 5, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'intercom-7511855.md': { score: 1.5, verdict: "Sr PM Web Berlin.", archetype: 'Web PM', geo: 'Berlin (excluded)', comp: 'not stated', match: 3, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'intercom-7511861.md': { score: 1.5, verdict: "Sr PM Web Dublin.", archetype: 'Web PM', geo: 'Dublin (excluded)', comp: 'not stated', match: 3, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },

  // ===== Lambda Labs =====
  'lambda-labs-a78dfe47-1176-4d.md': { score: 3.0, verdict: "Staff External PM SF, $323-484K. Exceptional comp but SF-only; customer-facing infra.", archetype: 'Forward Deployed PM (infra)', geo: 'SF (excluded)', comp: '$323K-$484K', match: 4, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'SF-only (could negotiate?)', rec: 'Skip unless remote negotiable' },
  'lambda-labs-e0327962-391e-45.md': { score: 2.8, verdict: "Staff PM San Jose, $291-484K. Bay-only, networking-niche.", archetype: 'AI Infra PM', geo: 'San Jose (excluded)', comp: '$291K-$484K', match: 4, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'Bay-only + networking-niche', rec: 'Skip - geo' },

  // ===== Lightning AI =====
  'lightning-ai-2d77b496-ab0d-4e.md': { score: 4.0, verdict: "Technical PM Remote. AI infra + remote-friendly. Smaller co than Datadog/Databricks but AI-native.", archetype: 'AI Platform PM', geo: 'Remote', comp: 'not stated', match: 5, compScore: 4, geoScore: 5, cultural: 4, redFlags: 'comp not stated, verify US-remote', rec: 'APPLY' },

  // ===== LlamaIndex =====
  'llamaindex-0d746429-0038-4a.md': { score: 2.8, verdict: "Lead PM SF, $180-280K. RAG/AI infra fit but SF-only.", archetype: 'AI Platform PM', geo: 'SF (excluded)', comp: '$180K-$280K', match: 5, compScore: 5, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip unless remote negotiable' },

  // ===== Mercury (all Remote within Canada/US) =====
  'mercury-5817294004.md': { score: 4.0, verdict: "Sr PM Mission Control, Remote US. Operator/internal tools at fintech.", archetype: 'Senior PM (fintech ops)', geo: 'Remote US/Canada', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'fintech-adjacent, ops-internal-niche', rec: 'APPLY' },
  'mercury-5832762004.md': { score: 4.0, verdict: "Sr PM Ledger Remote US. Fintech infrastructure PM.", archetype: 'Senior PM (fintech infra)', geo: 'Remote US/Canada', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'fintech-niche', rec: 'APPLY' },
  'mercury-5867562004.md': { score: 4.6, verdict: "Sr PM API & Agentic Banking Remote US. AI + agentic + API + remote = strong fit.", archetype: 'AI Product (Senior IC)', geo: 'Remote US/Canada', comp: 'not stated', match: 5, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },

  // ===== Ramp =====
  'ramp-9972df9e-4133-4e.md': { score: 3.5, verdict: "PM Generalist (All Levels) NYC, $230-325K. Could be junior; verify level.", archetype: 'PM Generalist', geo: 'NYC', comp: '$230K-$325K', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'level ambiguous (All Levels)', rec: 'Apply selectively' },
  'ramp-bc828c32-cac3-42.md': { score: 4.2, verdict: "PM Financial Intelligence NYC, $230-325K. NYC + Ramp + AI-adjacent.", archetype: 'AI Product (IC, fintech)', geo: 'NYC', comp: '$230K-$325K', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'fintech-niche', rec: 'APPLY' },

  // ===== RunPod =====
  'runpod-5112001008.md': { score: 4.4, verdict: "Sr PM Remote USA, $175-225K. AI compute infra + remote + good comp.", archetype: 'AI Infra PM', geo: 'Remote US', comp: '$175K-$225K', match: 5, compScore: 5, geoScore: 5, cultural: 4, redFlags: 'none', rec: 'APPLY' },

  // ===== Sierra (international) =====
  'sierra-b4b762e6-8ce7-4e.md': { score: 1.5, verdict: "PM Agent Dev London.", archetype: 'AI Product (IC)', geo: 'London (excluded)', comp: 'not stated', match: 5, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },
  'sierra-dc443fd1-14bd-49.md': { score: 1.5, verdict: "PM Agent Dev Singapore.", archetype: 'AI Product (IC)', geo: 'Singapore (excluded)', comp: 'SGD 230K-445K', match: 5, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'international', rec: 'Skip - geo' },

  // ===== Stripe =====
  'stripe-6473321.md': { score: 1.0, verdict: "PM Revenue & Financial Automation Bengaluru.", archetype: 'PM (fintech)', geo: 'Bengaluru (excluded)', comp: 'not stated', match: 3, compScore: 3, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip' },
  'stripe-6651889.md': { score: 4.0, verdict: "PM Stripe Infrastructure Remote US. Infra + remote + Stripe.", archetype: 'AI Infra PM', geo: 'Remote US', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'stripe-6683456.md': { score: 1.5, verdict: "PM Terminal Toronto. International.", archetype: 'PM (hardware/payments)', geo: 'Toronto (excluded)', comp: 'not stated', match: 3, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'stripe-7176530.md': { score: 4.0, verdict: "PM Payments SF/NY/SEA/Remote-US. Payments-niche but his geo + Stripe.", archetype: 'PM (payments)', geo: 'NYC/Remote US', comp: 'not stated', match: 3, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'payments-specific', rec: 'APPLY' },
  'stripe-7392697.md': { score: 4.2, verdict: "PM Link Consumer Product SF/SEA/NY/Remote-US. Consumer fintech + NY + Stripe.", archetype: 'Consumer Product PM', geo: 'NYC/Remote US', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'stripe-7397265.md': { score: 3.8, verdict: "PM Terminal Device Expansion Seattle/SF/NY. Hardware-payments niche but NY ok.", archetype: 'PM (hardware/payments)', geo: 'NYC option', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'hardware-payments niche', rec: 'Apply selectively' },
  'stripe-7440429.md': { score: 1.5, verdict: "PM Support Products Dublin.", archetype: 'PM (support)', geo: 'Dublin (excluded)', comp: 'not stated', match: 2, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international + support-niche', rec: 'Skip' },
  'stripe-7486955.md': { score: 1.5, verdict: "PM Local Payment Methods EMEA Dublin.", archetype: 'PM (regional payments)', geo: 'Dublin (excluded)', comp: 'not stated', match: 2, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'stripe-7547596.md': { score: 1.5, verdict: "PM Local Payment Methods EMEA Barcelona.", archetype: 'PM (regional payments)', geo: 'Barcelona (excluded)', comp: 'not stated', match: 2, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'stripe-7550590.md': { score: 4.5, verdict: "Staff PM Stripe Apps & Extensibility SF/SEA/NYC/Chi/Toronto/US-Remote/Canada-Remote. Staff + dev tools/platform + many geo options.", archetype: 'Developer Tools PM', geo: 'NYC/Remote US', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'stripe-7561053.md': { score: 3.8, verdict: "PM Banking as a Service Chicago/Remote. Remote ok but BaaS niche.", archetype: 'PM (BaaS)', geo: 'Remote', comp: 'not stated', match: 3, compScore: 5, geoScore: 4, cultural: 5, redFlags: 'BaaS-niche', rec: 'Apply selectively' },
  'stripe-7561551.md': { score: 4.0, verdict: "PM Commerce Systems SF/SEA/NYC/Remote. Commerce platform + NYC option.", archetype: 'Platform PM', geo: 'NYC/Remote US', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'stripe-7580706.md': { score: 4.2, verdict: "PM Payments Intelligence US-anywhere. AI/intelligence framing + US-remote.", archetype: 'AI Product (IC)', geo: 'US (remote OK)', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'stripe-7625842.md': { score: 1.0, verdict: "PM Risk & Compliance Bengaluru.", archetype: 'PM (risk)', geo: 'Bengaluru (excluded)', comp: 'not stated', match: 2, compScore: 3, geoScore: 1, cultural: 5, redFlags: 'international + niche', rec: 'Skip' },
  'stripe-7655023.md': { score: 4.7, verdict: "Product Lead AI SF/Seattle/NY/Chicago. Product Lead + AI + NY option + Stripe. Top pick.", archetype: 'AI Product Lead', geo: 'NYC option', comp: 'not stated', match: 5, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'stripe-7721834.md': { score: 1.5, verdict: "PM Capital London.", archetype: 'PM (lending)', geo: 'London (excluded)', comp: 'not stated', match: 3, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international + lending-niche', rec: 'Skip - geo' },
  'stripe-7737124.md': { score: 1.0, verdict: "PM New Grad Accelerator. Junior.", archetype: 'Junior PM', geo: 'NYC option', comp: 'not stated', match: 1, compScore: 3, geoScore: 5, cultural: 5, redFlags: 'junior', rec: 'Skip' },
  'stripe-7768979.md': { score: 1.5, verdict: "PM EMEA Payments Lead Dublin.", archetype: 'Senior PM (regional)', geo: 'Dublin (excluded)', comp: 'not stated', match: 3, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip - geo' },
  'stripe-7812346.md': { score: 2.5, verdict: "PM IC-02 SF. Mid-level + SF-only.", archetype: 'Mid PM', geo: 'SF (excluded)', comp: 'in JD (mid-tier)', match: 3, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'SF-only + IC-02 mid level', rec: 'Skip - geo' },
  'stripe-7812856.md': { score: 4.5, verdict: "Staff PM Enterprise (Industries) SF/SEA/NY/Chi/Atlanta/Remote. Staff + Enterprise + many geo.", archetype: 'Senior PM (enterprise)', geo: 'NYC/Remote US', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'stripe-7819059.md': { score: 4.3, verdict: "Staff PM Payments SF/SEA/NYC/Remote. Staff + payments + remote.", archetype: 'Senior PM (payments)', geo: 'NYC/Remote US', comp: 'not stated', match: 4, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'payments-niche', rec: 'APPLY' },
  'stripe-7834628.md': { score: 1.0, verdict: "PM SEA Singapore.", archetype: 'PM (regional)', geo: 'Singapore (excluded)', comp: 'not stated', match: 3, compScore: 4, geoScore: 1, cultural: 5, redFlags: 'international', rec: 'Skip' },

  // ===== Suno =====
  'suno-0740427c-6afa-4f.md': { score: 4.6, verdict: "PM Artists & Creators LA, $180-280K. LA + consumer AI music + great comp + 6+ yrs PM. Top pick.", archetype: 'Consumer AI PM', geo: 'LA', comp: '$180K-$280K', match: 5, compScore: 5, geoScore: 5, cultural: 5, redFlags: 'none', rec: 'APPLY' },
  'suno-275eaa39-e1d5-40.md': { score: 3.5, verdict: "Sr PM Payments Platform NYC, $200-240K. NYC OK but role requires 3+ yrs payments-specific (Vitor lacks).", archetype: 'PM (payments)', geo: 'NYC', comp: '$200K-$240K', match: 3, compScore: 5, geoScore: 5, cultural: 4, redFlags: '3+ yrs payments-platform required (Vitor lacks)', rec: 'Skip per voice rule' },

  // ===== Tavus =====
  'tavus-7e517f76-1e34-4b.md': { score: 2.5, verdict: "PM SF. Consumer AI video but SF-only.", archetype: 'Consumer AI PM', geo: 'SF (excluded)', comp: 'not stated', match: 4, compScore: 4, geoScore: 1, cultural: 4, redFlags: 'SF-only', rec: 'Skip - geo' },
};
