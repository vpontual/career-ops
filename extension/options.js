const input = document.getElementById("apiBase");
const statusEl = document.getElementById("status");

chrome.storage.sync.get("apiBase").then(({ apiBase }) => {
  if (apiBase) input.value = apiBase;
});

document.getElementById("save").addEventListener("click", async () => {
  const v = input.value.trim().replace(/\/$/, "");
  await chrome.storage.sync.set({ apiBase: v });
  statusEl.textContent = v ? `Saved: ${v}` : "Cleared — using defaults.";
  setTimeout(() => (statusEl.textContent = ""), 2500);
});
