# career-ops autofill (browser extension)

Fills job-application forms **on any board** with your career-ops answers,
highlights every field it touched, and **never submits** — you review and click
submit yourself. It pulls your answers live from the career-ops UI on the VM.

## How it works

1. **On Greenhouse, Ashby or Lever** a floating **⚡ Fill (career-ops)** button
   appears (bottom-right) on its own.
2. **On any other board** — Oracle, Workday, amazon.jobs, google.com, NYC Jobs —
   click the extension's **toolbar icon** and the filler injects into that tab.
   Nothing runs on any page until you ask.
3. Either way it fetches `GET /api/application-defaults` from the career-ops UI
   base URL you set in Options, which parses your gitignored
   `application-defaults.md` server-side.
4. It matches form fields by their label/name/aria text and fills: name, email,
   phone, location (NYC), LinkedIn, website, GitHub, work authorization,
   sponsorship, EEO self-ID, relocation, "how did you hear".
5. It then asks `GET /api/pack-answers?url=<this page>` for the application pack
   career-ops built for **this specific role**, and shows it beside the form.
6. It **skips on purpose**: file uploads (browser security — attach your
   `cv.pdf` / `cover-letter.pdf` yourself), essay questions, and salary. A toast
   summarizes what was filled and what needs a manual touch.

Because it reads `application-defaults.md` live, editing that file on the VM
updates the extension instantly — no rebuild.

## The pack panel shows three kinds of answer, and they are not interchangeable

| | meaning | what to do |
|---|---|---|
| ✅ green | your own vetted answer from `application-defaults.md` | paste as is |
| ✏️ amber | a **draft** written from `cv.md` | **read it before sending** |
| ⚠ red | blank by design — only you can answer it | write it yourself |

The red group is address, comp, dates, EEO, work authorization, prior
employment and attestations. career-ops refuses to draft those, and the panel
never offers them as text to paste; a drafted answer there would be invented.

**The panel shows answers. It does not type them.** Only the defaults in step 4
are filled automatically.

## Why the filler works on boards it was never written for

It finds fields by their **label** — `label[for]`, `aria-labelledby`, a wrapping
`<label>`, a sibling title node — not by any ATS-specific selector, and it
carries explicit handling for Ashby's and Workday's markup. It was only ever
limited by the manifest's `content_scripts.matches`, which is why the toolbar
click exists.

Measured over 287 pending career-ops cards: 194 had to be filled by hand, and 61
of those were forms career-ops had **already read and answered** on a host this
extension never ran on, plus 15 Greenhouse forms served from an employer's own
domain (`stripe.com`, `careers.upstart.com`, `instacart.careers`).

## Install (unpacked)

1. Chromium/Chrome → `chrome://extensions` → toggle **Developer mode** (top-right).
2. **Load unpacked** → select this `extension/` folder.
3. **Required:** Extension **Details → Extension options** → enter the base URL
   where your career-ops UI is reachable (stored only in your browser).
4. You must be able to reach that URL (LAN or VPN) when you click Fill.
5. **After any change to these files, hit Reload** on the extension in
   `chrome://extensions`. An unpacked extension does not pick up edits on its own.

> ## ⚠ Which copy is your browser actually loading?
>
> This folder is the copy **bundled inside the career-ops repo**. On VP's laptop
> Brave loads a *different* checkout — `~/Dev/career-ops-extension` — so an edit
> made only here changes nothing in the browser and looks like a broken feature.
> Confirm before assuming a change is live:
>
> ```bash
> python3 - <<'EOF'
> import json, glob
> for p in glob.glob('~/.config/BraveSoftware/*/*/Preferences'.replace('~','/home/vp')):
>     d = json.load(open(p))
>     for eid, s in d.get('extensions', {}).get('settings', {}).items():
>         if 'career' in str(s.get('path','')).lower():
>             print(eid[:12], s.get('path'))
> EOF
> ```
>
> Keep both copies identical, and reload after either.

## Requirements on the VM

- The career-ops UI must expose `GET /api/application-defaults` (added 2026-07-14).
- `application-defaults.md` must exist on the VM (it's gitignored PII).

## Scope / limits (v0.1)

- **Native** inputs/selects/radios fill reliably. Some Ashby dropdowns are custom
  React widgets (not `<select>`); those are flagged in the toast to set manually.
- Cover-letter **text** auto-paste into "additional information" boxes is a
  planned follow-up (needs job-URL → staged-role matching).
- It never clears fields you've already filled, and never clicks submit.
