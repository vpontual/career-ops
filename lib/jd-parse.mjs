/**
 * Canonical JD front-matter parser — the single source of truth for reading the
 * `**Field:**` markdown JD files that fetch-jds.mjs writes. Replaces the copies
 * in rank-leads.mjs (parseJdFile) and stage-applications.mjs (parseJdMeta, a
 * subset with renamed fields — now a thin adapter over this).
 */

/**
 * @param {string} content  raw JD markdown
 * @param {string} [filename]
 * @returns {{filename:string,title:string,company:string,location:string,pay:string,url:string,apply_url:string,posted_at:string|null,posted_days:number|null,updated_at:string|null,updated_days:number|null,body:string}}
 */
export function parseJd(content, filename = "") {
  const lines = String(content ?? "").split("\n");
  const jd = {
    filename, title: "", company: "", location: "", pay: "",
    posted_at: null, posted_days: null, updated_at: null, updated_days: null, body: "", url: "",
    apply_url: "", post_until: "",
  };

  jd.title = (lines[0] || "").replace(/^#\s*/, "").trim();

  for (const line of lines.slice(0, 20)) {
    let m;
    if ((m = line.match(/^\*\*URL:\*\*\s*(.+)/i))) jd.url = m[1].trim();
    // WHERE THE FORM ACTUALLY IS, when the source is an aggregator. `url` stays
    // the row identity — scan-history.tsv, pipeline.md and every dedup path
    // join on it — so an Indeed viewjob link keeps its place there while this
    // carries the employer's own apply URL from jobspy's `job_url_direct`.
    // Empty for every JD written before 2026-09-02 and for direct-board
    // sources, which need no second URL: callers use `apply_url || url`.
    //
    // ⚠ It may be a short link (grnh.se) or a tracker (click.appcast.io).
    // Resolving it is lib/apply-url.mjs's job, not this parser's — a parser
    // that makes network calls cannot be used in a test.
    else if ((m = line.match(/^\*\*Apply:\*\*\s*(.+)/i))) jd.apply_url = m[1].trim();
    // NYC's published close date (fetch-civic.mjs). Optional and civic-only;
    // absence means "no date published", never "no deadline".
    else if ((m = line.match(/^\*\*Post Until:\*\*\s*(.+)/i))) jd.post_until = m[1].trim();
    else if ((m = line.match(/^\*\*Company:\*\*\s*(.+)/i))) jd.company = m[1].trim();
    else if ((m = line.match(/^\*\*Location:\*\*\s*(.+)/i))) jd.location = m[1].trim();
    else if ((m = line.match(/^\*\*Compensation:\*\*\s*(.+)/i))) jd.pay = m[1].trim();
    else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)\s*\((\d+)\s*days/i))) {
      jd.posted_at = m[1];
      jd.posted_days = parseInt(m[2], 10);
    } else if ((m = line.match(/^\*\*Updated:\*\*\s*([^\s(]+)\s*\((\d+)\s*days/i))) {
      // WHEN THE EMPLOYER LAST TOUCHED THE REQUISITION. fetch-jds has written
      // this line since it was built - 684 JDs on disk carry it - and nothing
      // ever parsed it, so the single best available signal of active hiring
      // intent was sitting unread next to the one everything used instead.
      //
      // posted_at answers "when did this appear". updated_at answers "is anyone
      // still working it", which is the question VP actually asked when he said
      // freshness should mean "the employer actually wants it filled soon".
      jd.updated_at = m[1];
      jd.updated_days = parseInt(m[2], 10);
    } else if ((m = line.match(/^\*\*Updated:\*\*\s*([^\s(]+)/i))) {
      jd.updated_at = m[1];
    } else if ((m = line.match(/^\*\*Posted:\*\*\s*([^\s(]+)/i))) {
      jd.posted_at = m[1];
    }
  }

  const sepIdx = lines.findIndex((l) => l.trim() === "---");
  jd.body = sepIdx >= 0 ? lines.slice(sepIdx + 1).join("\n").trim() : String(content ?? "");
  return jd;
}
