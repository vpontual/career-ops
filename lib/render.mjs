/**
 * Canonical CV / cover-letter HTML rendering — single source of truth for the
 * PDF templates, replacing the byte-identical copies of `htmlForCv` (tailor-cv,
 * render-pdfs, stage-applications) and the profile-based `htmlForCoverLetter`
 * (render-pdfs, stage-applications).
 *
 * Output is preserved exactly (same CSS, same markdown conversion). The
 * cover-letter's "Re:" line varies per caller, so it's passed in as `metaLine`.
 *
 * NOTE: batch-stage.mjs keeps its own cover variant (module-level contact vars +
 * a `Re: role, company` meta format) — a separate cleanup, intentionally not
 * folded in here to avoid changing its output. `renderPdf()` also stays
 * per-file (PDF margins legitimately differ by document type).
 */

/** Minimal markdown → HTML for the cv.md format (headings, bold, links, lists). */
function cvMarkdownToHtml(cvMd) {
  const lines = String(cvMd ?? "").split("\n");
  const html = [];
  let inList = false;
  for (let line of lines) {
    line = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    line = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    if (/^# /.test(line)) { if (inList) { html.push("</ul>"); inList = false; } html.push(`<h1>${line.slice(2)}</h1>`); }
    else if (/^## /.test(line)) { if (inList) { html.push("</ul>"); inList = false; } html.push(`<h2>${line.slice(3)}</h2>`); }
    else if (/^### /.test(line)) { if (inList) { html.push("</ul>"); inList = false; } html.push(`<h3>${line.slice(4)}</h3>`); }
    else if (/^- /.test(line)) { if (!inList) { html.push("<ul>"); inList = true; } html.push(`<li>${line.slice(2)}</li>`); }
    else if (line.trim() === "") { if (inList) { html.push("</ul>"); inList = false; } html.push(""); }
    else { if (inList) { html.push("</ul>"); inList = false; } html.push(`<p>${line}</p>`); }
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

/** Full CV HTML document (Letter, print CSS). Byte-identical to the old copies. */
export function renderCvHtml(cvMd) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #111; }
    h1 { font-size: 22pt; margin: 0 0 0.1in 0; letter-spacing: -0.02em; }
    h2 { font-size: 13pt; margin: 0.16in 0 0.04in 0; border-bottom: 1px solid #888; padding-bottom: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
    h3 { font-size: 11pt; margin: 0.12in 0 0.02in 0; }
    p { margin: 0.04in 0; }
    ul { margin: 0.05in 0 0.1in 0.25in; padding: 0; }
    li { margin: 0.02in 0; }
    a { color: #1a4faa; text-decoration: none; }
    strong { font-weight: 600; }
  </style></head><body>${cvMarkdownToHtml(cvMd)}</body></html>`;
}

/**
 * Full cover-letter HTML document. Contact details are parsed from the YAML
 * `profile` string (same regexes as the old copies); `metaLine` is the caller-
 * supplied "Re:" / heading line (render-pdfs passes a heading; stage passes
 * `Re: <role> - <company>`).
 */
export function renderCoverLetterHtml(text, profile, metaLine = "") {
  const p = String(profile ?? "");
  const candName = (p.match(/full_name:\s*"([^"]+)"/) || [])[1] || "Vitor Pontual";
  const email = (p.match(/email:\s*"([^"]+)"/) || [])[1] || "";
  const phone = (p.match(/phone:\s*"([^"]+)"/) || [])[1] || "";
  const linkedin = (p.match(/linkedin:\s*"([^"]+)"/) || [])[1] || "";
  const today = new Date().toISOString().slice(0, 10);
  const escaped = String(text ?? "").split("\n")
    .map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .join("<br>\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #111; padding: 0; }
    .head { border-bottom: 1px solid #ccc; padding-bottom: 0.15in; margin-bottom: 0.25in; }
    .name { font-size: 18pt; font-weight: 600; letter-spacing: -0.01em; }
    .contact { font-size: 9.5pt; color: #555; margin-top: 4px; }
    .meta { font-size: 9pt; color: #666; margin: 0.25in 0; }
    .body { margin: 0.1in 0; }
  </style></head><body>
    <div class="head">
      <div class="name">${candName}</div>
      <div class="contact">${[email, phone, linkedin].filter(Boolean).join(" · ")}</div>
    </div>
    <div class="meta">${today}${metaLine ? "<br>" + metaLine : ""}</div>
    <div class="body">${escaped}</div>
  </body></html>`;
}
