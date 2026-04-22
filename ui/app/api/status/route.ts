import { readFile, writeFile, appendFile } from "fs/promises";
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

// Append a tracker line to applications.md. The pipeline reader scans for any line
// containing a URL + a status keyword, so format is forgiving — we just need a URL
// and one of: applied / rejected / archived / under review (default).
//
// Format: `- [x] {url} | {company} | {role} | {Status} {date}{note ? " — " + note : ""}`
async function appendStatusLine(url: string, status: string, company: string, role: string, note?: string) {
  const label = STATUS_LABEL[status] ?? "Under review";
  const checkbox = status === "applied" ? "x" : " ";
  const noteSuffix = note ? ` — ${note.replace(/[\r\n|]/g, " ").trim()}` : "";
  const line = `- [${checkbox}] ${url} | ${company} | ${role} | ${label} ${todayIso()}${noteSuffix}\n`;

  // Ensure file exists with a header
  try {
    await readFile(APPLICATIONS_PATH, "utf-8");
  } catch {
    await writeFile(APPLICATIONS_PATH, "# Applications tracker\n\n", "utf-8");
  }

  await appendFile(APPLICATIONS_PATH, line, "utf-8");
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
