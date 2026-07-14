# Company Blacklist

Your own do-not-apply list (user layer, opt-in). Copy this file to
`data/blacklist.md` and edit it — the system never creates or populates it for
you, and no scan/update ever touches it.

When `data/blacklist.md` exists, postings from listed companies are dropped
before scoring (`rank-leads.mjs`), never staged, and hidden from the UI. Matched
case- and punctuation-insensitively ("Acme Corp." catches a feed that says
"acme corp"). A blacklist entry never changes any score — it is a gate, not a
signal. Absent file = no filtering.

| Company | Since | Scope | Reason |
|---------|-------|-------|--------|
| Acme Corp | 2026-01-15 | company | example: post-interview process signals |
| Globex | 2026-02-01 | company | example: repeated applications, zero conversion |
