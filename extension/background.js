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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getDefaults") {
    fetchDefaults().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
});
