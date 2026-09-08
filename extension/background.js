// Background service worker: fetches career-ops defaults from your VM's UI.
// Runs in the extension context (with host permissions), so it is not subject
// to page CORS — the content script asks it for the data via a message.
//
// The career-ops UI base URL is NOT hardcoded (this is a public repo). Set it
// once in the extension's Options page; it is stored locally in your browser.

async function fetchDefaults() {
  const { apiBase } = await chrome.storage.sync.get("apiBase");
  if (!apiBase) {
    return { ok: false, error: "No career-ops URL set. Open the extension's Options and enter your UI address." };
  }
  const base = apiBase.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/application-defaults`, { cache: "no-store" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${base}` };
    return { ok: true, data: await res.json(), base };
  } catch (e) {
    return { ok: false, error: `${base}: ${e && e.message ? e.message : e}` };
  }
}

// The application pack for the page the content script is standing on.
//
// ⚠ THE ANSWERS ARE NOT AUTOFILLED. They are shown. The pack marks each field
// as one of three things — VP's own vetted answer, a DRAFT to edit, or blank by
// design because only he can answer it — and only the first is safe to paste
// unread. generate-answers.mjs already refuses to draft address, comp, dates,
// EEO, work authorisation, prior employment and attestations; pasting a draft
// into a form without reading it would undo that discipline from the other end.
async function fetchPack(url) {
  const { apiBase } = await chrome.storage.sync.get("apiBase");
  if (!apiBase || !url) return { ok: false, error: "no career-ops URL set" };
  const base = apiBase.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/pack-answers?url=${encodeURIComponent(url)}`, { cache: "no-store" });
    if (res.status === 404) return { ok: false, error: "no pack for this page" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: `${base}: ${e && e.message ? e.message : e}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getDefaults") {
    fetchDefaults().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg && msg.type === "getPack") {
    fetchPack(msg.url).then(sendResponse);
    return true;
  }
});

// ── Inject the filler on demand, on ANY board ──────────────────────────────
//
// ⚠ THE FILLER WAS NEVER GREENHOUSE-SPECIFIC. content.js finds fields by their
// LABEL — label[for], aria-labelledby, a wrapping <label>, a sibling title node
// — and it already carries explicit handling for Ashby's and Workday's markup.
// The only thing that pinned it to three ATSs was `content_scripts.matches` in
// the manifest.
//
// Measured on the 287 pending cards on 2026-09-08: 93 were on a board the
// extension ran on and 194 were not. Of those 194, 61 had a FULLY ENUMERATED
// field list that the pipeline had already read and answered, and a further 15
// were Greenhouse forms served from an employer's own domain (stripe.com,
// careers.upstart.com, instacart.careers) that the match patterns never saw. So
// 76 applications were being filled by hand against a form the system had
// already parsed.
//
// Injecting on the toolbar click rather than widening `matches` keeps this
// opt-in: nothing runs on any page until VP asks for it, on the page he is
// looking at. `activeTab` grants access for that one tab, for that one click.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    // content.js guards on window.__careerOpsAutofillLoaded, so clicking again
    // on a board where the content script already ran is a no-op rather than a
    // second floating button.
  } catch (e) {
    console.error('career-ops: could not inject the filler —', e);
  }
});
