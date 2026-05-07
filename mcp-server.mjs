#!/usr/bin/env node
// MCP stdio server exposing the career-ops pipeline as agent-queryable state.
//
// Acts as a thin protocol adapter over the UI's HTTP API:
//   - GET  /api/roles           — list with filters
//   - GET  /api/roles/{id}      — full role pack (JD + report + cover letter)
//   - POST /api/status          — mutate role status
//
// The UI is the source of truth so we never re-implement parsing here.
//
// Env:
//   CAREER_OPS_UI_URL   default http://localhost:3340
//
// Run:
//   node mcp-server.mjs           # stdio
//   npm run mcp                   # via package.json script

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const UI_BASE = (process.env.CAREER_OPS_UI_URL ?? "http://localhost:3340").replace(/\/$/, "");

async function uiGet(pathAndQuery) {
  const res = await fetch(`${UI_BASE}${pathAndQuery}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`UI ${pathAndQuery} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function uiPost(path, body) {
  const res = await fetch(`${UI_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UI ${path} → ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

function encodeUrlId(url) {
  return Buffer.from(url, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function asJson(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// --- Tool implementations --------------------------------------------------

async function listRoles(args = {}) {
  const params = new URLSearchParams();
  if (args.status) params.set("status", Array.isArray(args.status) ? args.status.join(",") : String(args.status));
  if (args.min_score != null) params.set("min_score", String(args.min_score));
  if (args.fresh_days != null) params.set("fresh_days", String(args.fresh_days));
  if (args.company) params.set("company", String(args.company));
  if (args.query) params.set("q", String(args.query));
  if (args.staged_only) params.set("staged_only", "true");
  if (args.limit != null) params.set("limit", String(args.limit));
  const qs = params.toString();
  const data = await uiGet(`/api/roles${qs ? `?${qs}` : ""}`);
  return asJson(data);
}

async function getRole(args = {}) {
  const url = String(args.url ?? "").trim();
  if (!url) throw new Error("url is required");
  const id = encodeUrlId(url);
  const data = await uiGet(`/api/roles/${id}`);
  return asJson(data);
}

async function pipelineStats() {
  const data = await uiGet("/api/roles");
  const rows = data.rows ?? [];

  const scoreBucket = { "5": 0, "4-4.9": 0, "3-3.9": 0, "<3": 0, unscored: 0 };
  const freshness = { fresh: 0, mature: 0, stale: 0, ancient: 0, "ghost-likely": 0, reposted: 0, unknown: 0 };
  const companyCounts = new Map();
  let staged = 0;
  let scored = 0;

  for (const r of rows) {
    if (r.score == null) scoreBucket.unscored++;
    else if (r.score >= 5) scoreBucket["5"]++;
    else if (r.score >= 4) scoreBucket["4-4.9"]++;
    else if (r.score >= 3) scoreBucket["3-3.9"]++;
    else scoreBucket["<3"]++;

    const f = r.computedLegitimacy ?? "unknown";
    if (f in freshness) freshness[f]++;
    else freshness.unknown++;

    if (r.score != null) scored++;
    if (r.stagedSlug) staged++;
    companyCounts.set(r.company, (companyCounts.get(r.company) ?? 0) + 1);
  }

  const topCompanies = [...companyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([company, count]) => ({ company, count }));

  return asJson({
    totalCount: data.totalCount,
    byStatus: data.byStatus,
    scoreBucket,
    freshness,
    scored,
    staged,
    topCompanies,
    lastScannedAt: data.lastScannedAt
  });
}

async function setRoleStatus(args = {}) {
  const url = String(args.url ?? "").trim();
  const status = String(args.status ?? "").trim();
  if (!url || !status) throw new Error("url and status are required");
  const allowed = new Set(["under_review", "applied", "rejected", "archived", "clear"]);
  if (!allowed.has(status)) throw new Error(`status must be one of: ${[...allowed].join(", ")}`);

  const result = await uiPost("/api/status", {
    url,
    status,
    company: args.company ?? "",
    role: args.role ?? "",
    note: args.note
  });
  return asJson(result);
}

// --- MCP wiring ------------------------------------------------------------

const TOOLS = [
  {
    name: "list_roles",
    description: "List roles in the career-ops pipeline. Filters compose with AND. Returns rows with score, status, freshness, ATS, staged-pack pointer, and dual-pill posted/updated ages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          description: "Status filter — one of new, under_review, applied, rejected, archived. Pass an array or comma-separated string for multiple.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
          ]
        },
        min_score: { type: "number", minimum: 0, maximum: 5, description: "Minimum fit score (0–5). High-fit threshold is 4.0." },
        fresh_days: { type: "integer", minimum: 0, description: "Max age in days — uses min(posted, updated). Vitor's freshness rule: ≤5d goal." },
        company: { type: "string", description: "Substring match against company (case-insensitive)." },
        query: { type: "string", description: "Substring match against company + role." },
        staged_only: { type: "boolean", description: "Only return roles with a staged application pack (cover letter + tailored CV)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Cap rows returned (server-enforced max 500)." }
      }
    }
  },
  {
    name: "get_role",
    description: "Get full detail for one role: pipeline row, scoring report, JD text, and cover letter (when staged). Identify by URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", description: "Canonical role URL as it appears in pipeline.md." }
      }
    }
  },
  {
    name: "pipeline_stats",
    description: "Aggregate pipeline metrics: counts by status, score bucket, freshness tier, top companies, scored/staged totals.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "set_role_status",
    description: "Mutate a role's application status. Writes to data/applications.md. Use 'clear' to remove all status lines for a URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url", "status"],
      properties: {
        url: { type: "string" },
        status: { type: "string", enum: ["under_review", "applied", "rejected", "archived", "clear"] },
        company: { type: "string", description: "Optional — included in the tracker line for readability." },
        role: { type: "string", description: "Optional — included in the tracker line for readability." },
        note: { type: "string", description: "Optional free-text note appended after the status line." }
      }
    }
  }
];

const HANDLERS = {
  list_roles: listRoles,
  get_role: getRole,
  pipeline_stats: pipelineStats,
  set_role_status: setRoleStatus
};

const server = new Server(
  { name: "career-ops", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
  try {
    return await handler(req.params.arguments ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
