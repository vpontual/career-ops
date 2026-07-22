/**
 * Canonical JD front-matter parser — the single source of truth for reading the
 * `**Field:**` markdown JD files that fetch-jds.mjs writes. Replaces the copies
 * in rank-leads.mjs (parseJdFile) and stage-applications.mjs (parseJdMeta, a
 * subset with renamed fields — now a thin adapter over this).
 */

/**
 * @param {string} content  raw JD markdown
 * @param {string} [filename]
 * @returns {{filename:string,title:string,company:string,location:string,pay:string,url:string,posted_at:string|null,posted_days:number|null,body:string}}
 */
export function parseJd(content, filename = "") {
  const lines = String(content ?? "").split("\n");
  const jd = {
    filename, title: "", company: "", location: "", pay: "",
    posted_at: null, posted_days: null, body: "", url: "",
  };

  jd.title = (lines[0] || "").replace(/^#\s*/, "").trim();

  for (const line of lines.slice(0, 20)) {
    let m;
    if ((m = line.match(/^\*\*URL:\*\*\s*(.+)/i))) jd.url = m[1].trim();
    else if ((m = line.match(/^\*\*Company:\*\*\s*(.+)/i))) jd.company = m[1].trim();
    else if ((m = line.match(/^\*\*Location:\*\*\s*(.+)/i))) jd.location = m[1].trim();
    else if ((m = line.match(/^\*\*Compensation:\*\*\s*(.+)/i))) jd.pay = m[1].trim();
    else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)\s*\((\d+)\s*days/i))) {
      jd.posted_at = m[1];
      jd.posted_days = parseInt(m[2], 10);
    } else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)/i))) {
      jd.posted_at = m[1];
    }
  }

  const sepIdx = lines.findIndex((l) => l.trim() === "---");
  jd.body = sepIdx >= 0 ? lines.slice(sepIdx + 1).join("\n").trim() : String(content ?? "");
  return jd;
}
