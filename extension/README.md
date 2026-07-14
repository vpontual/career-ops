# career-ops autofill (browser extension)

Fills Greenhouse / Ashby / Lever job-application forms with your career-ops
defaults, highlights every field it touched, and **never submits** — you review
and click submit yourself. Works on any browser you're signed into; it pulls
your answers live from the career-ops UI on the VM.

## How it works

1. On a supported application page a floating **⚡ Fill (career-ops)** button
   appears (bottom-right).
2. Click it. The extension's background worker fetches
   `GET /api/application-defaults` from the career-ops UI base URL you set in
   Options, which parses your gitignored `application-defaults.md` server-side.
3. It matches form fields by their label/name/aria text and fills:
   name, email, phone, location (NYC), LinkedIn, website, GitHub, work
   authorization, sponsorship, EEO self-ID, relocation, "how did you hear".
4. It **skips on purpose**: file uploads (browser security — attach your
   `cv.pdf` / `cover-letter.pdf` yourself), essay questions, and salary. A toast
   summarizes what was filled and what needs a manual touch.

Because it reads `application-defaults.md` live, editing that file on the VM
updates the extension instantly — no rebuild.

## Install (unpacked)

1. Chromium/Chrome → `chrome://extensions` → toggle **Developer mode** (top-right).
2. **Load unpacked** → select this `extension/` folder.
3. **Required:** Extension **Details → Extension options** → enter the base URL
   where your career-ops UI is reachable (stored only in your browser).
4. You must be able to reach that URL (LAN or VPN) when you click Fill.

## Requirements on the VM

- The career-ops UI must expose `GET /api/application-defaults` (added 2026-07-14).
- `application-defaults.md` must exist on the VM (it's gitignored PII).

## Scope / limits (v0.1)

- **Native** inputs/selects/radios fill reliably. Some Ashby dropdowns are custom
  React widgets (not `<select>`); those are flagged in the toast to set manually.
- Cover-letter **text** auto-paste into "additional information" boxes is a
  planned follow-up (needs job-URL → staged-role matching).
- It never clears fields you've already filled, and never clicks submit.
