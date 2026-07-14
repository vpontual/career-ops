import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

// Read-only endpoint that parses the (gitignored) application-defaults.md into
// JSON for the browser autofill extension. Only the deterministic, per-role-
// invariant answers are exposed — essay questions ("why interested") stay manual.
// LAN + Twingate gated (same as the rest of the UI); no CORS header, so it is
// reachable only same-origin or from the extension's background worker (which
// holds an explicit host permission for this host).

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";
const DEFAULTS_PATH = path.join(DATA_ROOT, "application-defaults.md");

function field(md: string, labelRe: string): string {
  // Colon is OPTIONAL: identity fields are "**Legal first name:** Vitor" but
  // yes/no fields are written as questions "**Open to remote?** Yes" (no colon).
  const m = md.match(new RegExp(`\\*\\*${labelRe}:?\\*\\*\\s+([^\\n]+)`, "i"));
  return m ? m[1].trim() : "";
}

// Extract the short "why interested" fallback answer (the < 100-word version)
// from the "### \"Why are you interested...\"" block, skipping its instruction lines.
function whyInterested(md: string): string {
  const m = md.match(/###\s+"?Why are you interested[^\n]*\n([\s\S]*?)(?=\n#{2,3}\s|\n---|\n##\s|$)/i);
  if (!m) return "";
  const block = m[1];
  const idx = block.toLowerCase().indexOf("fallback:");
  const rest = idx >= 0 ? block.slice(idx + "fallback:".length) : block;
  return rest
    .split("\n")
    .map(l => l.replace(/^>\s?/, "").trim())
    .filter(l => l && !/^(default|first:|framing|if the form|fallback)/i.test(l))
    .join(" ")
    .trim();
}

export async function GET() {
  let md: string;
  try {
    md = await readFile(DEFAULTS_PATH, "utf-8");
  } catch {
    return NextResponse.json(
      { error: "application-defaults.md not found on the server" },
      { status: 404 }
    );
  }

  const yesNo = (re: string) => (/yes/i.test(field(md, re)) ? "Yes" : "No");
  const firstName = field(md, "Legal first name");
  const lastName = field(md, "Legal last name");

  const defaults = {
    identity: {
      firstName,
      lastName,
      preferredName: field(md, "Preferred name") || firstName,
      fullName: `${firstName} ${lastName}`.trim(),
      email: field(md, "Email \\(for ATS logins\\)") || field(md, "Email \\(canonical inbox\\)"),
      phone: field(md, "Phone"),
      location: field(md, "Current city \\(NYC roles\\)") || field(md, "Current city"),
      linkedin: field(md, "LinkedIn"),
      website: field(md, "Personal website / portfolio"),
      github: field(md, "GitHub"),
      yearsExperience: field(md, "Years of experience"),
    },
    essays: {
      whyInterested: whyInterested(md),
    },
    workAuth: {
      authorized: yesNo("Authorized to work in the United States\\?"),
      sponsorship: yesNo("Will you require visa sponsorship now or in the future\\?"),
    },
    eeo: {
      gender: field(md, "Gender identity"),
      race: field(md, "Race / ethnicity"),
      veteran: field(md, "Veteran status"),
      disability: field(md, "Disability status"),
    },
    logistics: {
      startDate: field(md, "Available start date"),
      relocation: yesNo("Open to relocation\\?"),
      remote: yesNo("Open to remote\\?"),
    },
    howHeard:
      (md.match(/How did you hear about us\?[\s\S]*?Default:\s*"([^"]+)"/i) || [])[1] ||
      "LinkedIn job alert",
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(defaults, { headers: { "Cache-Control": "no-store" } });
}
