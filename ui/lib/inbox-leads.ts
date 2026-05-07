import { readFile } from "fs/promises";
import path from "path";

const DATA_ROOT = process.env.CAREER_OPS_ROOT ?? "/data";
const INBOX_LEADS_PATH = path.join(DATA_ROOT, "data", "inbox-leads.md");

export interface RankedLead {
  tier: number;            // 1-5
  title: string;
  company: string;
  archetype: string;       // e.g. "Senior PM" / "AI Product PM"
  url: string;
  ageDays: number | null;  // null = "?" in the source
  ageWarning: boolean;     // true if the markdown row had ⚠ next to age
  verdict: string;         // before the "— ⚠" split
  redFlags: string;        // after "— ⚠"
}

export interface RankedSnapshot {
  generatedAt: string | null;
  filtersLine: string | null;
  leads: RankedLead[];
}

export async function loadInboxLeads(): Promise<RankedSnapshot> {
  let content: string;
  try {
    content = await readFile(INBOX_LEADS_PATH, "utf-8");
  } catch {
    return { generatedAt: null, filtersLine: null, leads: [] };
  }

  const lines = content.split("\n");
  let generatedAt: string | null = null;
  let filtersLine: string | null = null;
  for (const line of lines.slice(0, 8)) {
    let m;
    if ((m = line.match(/^>\s*Generated:\s*(.+)/i))) generatedAt = m[1].trim();
    else if ((m = line.match(/^>\s*Filters:\s*(.+)/i))) filtersLine = m[1].trim();
  }

  const leads: RankedLead[] = [];
  let currentTier: number | null = null;
  let pending: Partial<RankedLead> | null = null;
  let pendingVerdictLines: string[] = [];

  const flushPending = () => {
    if (pending && pending.title && pending.url && currentTier != null) {
      const fullVerdict = pendingVerdictLines.join(" ").trim();
      let verdict = fullVerdict;
      let redFlags = "";
      const split = fullVerdict.match(/^(.*?)\s+—\s+⚠\s*(.+)$/);
      if (split) {
        verdict = split[1].trim();
        redFlags = split[2].trim();
      }
      leads.push({
        tier: currentTier,
        title: pending.title!,
        company: pending.company ?? "",
        archetype: pending.archetype ?? "",
        url: pending.url!,
        ageDays: pending.ageDays ?? null,
        ageWarning: pending.ageWarning ?? false,
        verdict,
        redFlags,
      });
    }
    pending = null;
    pendingVerdictLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");

    // Section header: "## Score 5 — Excellent fit (apply now) (3)"
    let m;
    if ((m = line.match(/^##\s*Score\s+(\d+)/i))) {
      flushPending();
      currentTier = parseInt(m[1], 10);
      continue;
    }
    // Unscored bucket
    if (/^##\s*Unscored/i.test(line)) {
      flushPending();
      currentTier = 0;
      continue;
    }

    // Lead header line: "- [ ] **TITLE** @ COMPANY · Xd[⚠] · ARCHETYPE"
    const headerMatch = line.match(
      /^-\s*\[\s*\]\s*\*\*(.+?)\*\*\s*@\s*(.+?)(?:\s*·\s*(\d+|\?)\s*d\s*(⚠)?)?(?:\s*·\s*(.+))?$/
    );
    if (headerMatch) {
      flushPending();
      pending = {
        title: headerMatch[1].trim(),
        company: headerMatch[2].trim(),
        ageDays: headerMatch[3] && headerMatch[3] !== "?" ? parseInt(headerMatch[3], 10) : null,
        ageWarning: Boolean(headerMatch[4]),
        archetype: (headerMatch[5] ?? "").trim(),
      };
      pendingVerdictLines = [];
      continue;
    }

    // Bare URL line (continuation) — must be a hard URL; usually the last line of a block
    if (/^\s+https?:\/\/\S+\s*$/.test(line) && pending) {
      pending.url = line.trim();
      continue;
    }

    // Indented verdict continuation
    if (/^\s+\S/.test(line) && pending) {
      pendingVerdictLines.push(line.trim());
      continue;
    }

    // Blank line ends the block
    if (line.trim() === "" && pending) {
      // Don't flush yet — verdict + URL may still arrive after blanks in some
      // formats. Keep the pending object until the next non-blank that
      // isn't part of this block.
    }
  }
  flushPending();

  return { generatedAt, filtersLine, leads };
}

export function tierColor(tier: number): { fg: string; border: string; bg: string; label: string } {
  switch (tier) {
    case 5: return { fg: "text-emerald-300", border: "border-emerald-400/50", bg: "bg-emerald-500/10", label: "Excellent" };
    case 4: return { fg: "text-blue-300", border: "border-blue-400/50", bg: "bg-blue-500/10", label: "Strong" };
    case 3: return { fg: "text-amber-300", border: "border-amber-400/50", bg: "bg-amber-500/10", label: "Worth a look" };
    case 2: return { fg: "text-slate-400", border: "border-slate-500/50", bg: "bg-slate-500/10", label: "Weak" };
    case 1: return { fg: "text-red-300", border: "border-red-400/50", bg: "bg-red-500/10", label: "Skip" };
    default: return { fg: "text-slate-400", border: "border-slate-700", bg: "bg-slate-800/40", label: "Unscored" };
  }
}

export function ageColor(days: number | null): string {
  if (days == null) return "text-slate-500 border-slate-700";
  if (days <= 5) return "text-emerald-300 border-emerald-400/40 bg-emerald-500/10";
  if (days <= 14) return "text-blue-300 border-blue-400/40 bg-blue-500/10";
  if (days <= 30) return "text-amber-300 border-amber-400/40 bg-amber-500/10";
  return "text-red-300 border-red-400/40 bg-red-500/10";
}
