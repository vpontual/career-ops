import { readFile, appendFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";

// POST /api/leads
//
// Lightweight intake for job URLs surfaced outside the 4am Gmail poller —
// notably Llama Rider's cc-digest skill on Palomino, which parses CC's
// "Day Ahead" digest and finds roles the recruiter feeds miss.
//
// Body: { url, company?, role?, source? }
//   url        — required, the JD URL
//   company    — optional, falls back to "Unknown"
//   role       — optional, falls back to "Unknown"
//   source     — optional tag, defaults to "cc-digest"
//
// Behavior: appends a `- [ ] URL | company | role | source: <tag> | <date>` line
// to data/pipeline.md if the URL isn't already present (string match). The 4am
// cron's fetch-jds.mjs and rank-leads.mjs then pick it up like any other lead.

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";
const PIPELINE_PATH = path.join(DATA_ROOT, "data", "pipeline.md");

export const dynamic = "force-dynamic";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Minimal URL normalization: trim, drop UTM/click trackers, lowercase host.
// Mirrors the spirit of fetch-gmail-leads.mjs canonicalizeUrl without
// duplicating the full host-specific strip table — good enough for dedup.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gh_src", "ref", "ref_", "refid", "trk", "trkcampaign", "trackingid",
  "src", "lipi", "lici"
]);

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase();
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.set(k, v);
    }
    u.search = keep.toString();
    u.hash = "";
    return u.toString();
  } catch {
    return trimmed;
  }
}

function sanitizeField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\r\n|]/g, " ").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export async function POST(req: Request) {
  let body: { url?: unknown; company?: unknown; role?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const url = normalizeUrl(body.url);
  const company = sanitizeField(body.company, "Unknown");
  const role = sanitizeField(body.role, "Unknown");
  const source = sanitizeField(body.source, "cc-digest");

  // Ensure pipeline.md exists with a header.
  if (!existsSync(PIPELINE_PATH)) {
    await writeFile(PIPELINE_PATH, "# Pipeline\n\n## Pendientes\n\n", "utf-8");
  }

  // Dedup: check if URL string already appears anywhere in pipeline.md.
  // Cheap and good enough — fetch-gmail-leads.mjs uses the same approach.
  const existing = await readFile(PIPELINE_PATH, "utf-8");
  if (existing.includes(url)) {
    return NextResponse.json({ added: false, reason: "duplicate", url });
  }

  const line = `- [ ] ${url} | ${company} | ${role} | source: ${source} | ${todayIso()}\n`;
  await appendFile(PIPELINE_PATH, line, "utf-8");

  return NextResponse.json({ added: true, url, source });
}
