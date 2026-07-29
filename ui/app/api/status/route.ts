import { readFile, writeFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";
const APPLICATIONS_PATH = path.join(DATA_ROOT, "data", "applications.md");

const ALLOWED = new Set(["under_review", "applied", "rejected", "archived", "clear"]);
const STATUS_LABEL: Record<string, string> = {
  under_review: "Under review",
  applied: "Applied",
  rejected: "Rejected",
  archived: "Archived"
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Append a tracker row to applications.md.
//
// The file is a markdown TABLE, not a list. followup-cadence, analyze-patterns,
// verify-pipeline, dedup-tracker and merge-tracker all parse it by splitting on
// "|" and requiring >=9 columns; this route used to write "- [x] url | ..."
// list rows, which every one of those readers silently skipped. So the UI's
// "Mark as Applied" button recorded a status the tooling could never see.
// The URL goes in Notes because ui/lib/pipeline.ts matches rows by URL regex.
const TABLE_HEADER = [
  "# Applications tracker",
  "",
  "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |",
  "|---|------|---------|------|-------|--------|-----|--------|-------|",
  ""
].join("\n");

async function appendStatusLine(url: string, status: string, company: string, role: string, note?: string) {
  const label = STATUS_LABEL[status] ?? "Under review";

  let content = "";
  try {
    content = await readFile(APPLICATIONS_PATH, "utf-8");
  } catch {
    content = "";
  }
  if (!content.includes("| # |")) content = TABLE_HEADER;

  // next row number
  let next = 1;
  for (const line of content.split("\n")) {
    if (!line.startsWith("|")) continue;
    const n = parseInt(line.split("|")[1]?.trim() ?? "", 10);
    if (!isNaN(n) && n >= next) next = n + 1;
  }

  const clean = (v: string) => v.replace(/[\r\n|]/g, " ").trim();
  const notes = [note ? clean(note) : "", url].filter(Boolean).join(" ");
  const row = `| ${next} | ${todayIso()} | ${clean(company) || "-"} | ${clean(role) || "-"} | - | ${label} | - | - | ${notes} |\n`;

  if (!content.endsWith("\n")) content += "\n";
  await writeFile(APPLICATIONS_PATH, content + row, "utf-8");
}

// Clear status: rewrite applications.md without any line referencing this URL.
async function clearStatusLines(url: string) {
  let content = "";
  try {
    content = await readFile(APPLICATIONS_PATH, "utf-8");
  } catch {
    return;
  }
  const filtered = content
    .split("\n")
    .filter(line => !line.includes(url))
    .join("\n");
  await writeFile(APPLICATIONS_PATH, filtered, "utf-8");
}

export async function POST(req: Request) {
  let body: { url?: string; status?: string; company?: string; role?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { url, status, company = "", role = "", note } = body;
  if (!url || !status || !ALLOWED.has(status)) {
    return NextResponse.json({ error: "url and valid status required" }, { status: 400 });
  }
  // URL must look plausible — defends against junk being appended
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "url must be http(s)" }, { status: 400 });
  }

  if (status === "clear") {
    await clearStatusLines(url);
  } else {
    await appendStatusLine(url, status, company, role, note);
  }

  revalidatePath("/");
  return NextResponse.json({ ok: true });
}
