// career-ops autofill — fills standard job-application fields, highlights what
// it touched, and NEVER submits. You review and click submit yourself.
(() => {
  "use strict";
  if (window.__careerOpsAutofillLoaded) return;
  window.__careerOpsAutofillLoaded = true;

  // ---- UI: floating button + toast -----------------------------------------
  const btn = document.createElement("button");
  btn.id = "co-autofill-btn";
  btn.type = "button";
  btn.textContent = "⚡ Fill (career-ops)";
  document.documentElement.appendChild(btn);

  function toast(html, kind = "info") {
    let t = document.getElementById("co-autofill-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "co-autofill-toast";
      document.documentElement.appendChild(t);
    }
    t.className = `co-${kind}`;
    t.innerHTML = html;
    t.style.display = "block";
  }

  // ---- field/question introspection ----------------------------------------
  function labelFor(el) {
    let parts = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) parts.push(l.innerText);
    }
    const wrapLabel = el.closest("label");
    if (wrapLabel) parts.push(wrapLabel.innerText);
    const grp = el.closest("div,section,fieldset,[role='group']");
    if (grp) {
      const l = grp.querySelector("label, legend, .label, [class*='label' i]");
      if (l && !l.contains(el)) parts.push(l.innerText);
    }
    parts.push(el.getAttribute("aria-label") || "");
    parts.push(el.getAttribute("placeholder") || "");
    parts.push(el.getAttribute("name") || "");
    parts.push(el.id || "");
    return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Group-level question (for radios/selects): fieldset legend, or nearest
  // preceding heading/label above the control's block.
  function groupQuestion(el) {
    const fs = el.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg) return lg.innerText.toLowerCase();
    }
    const grp = el.closest("[role='group'], .field, [class*='field' i], div");
    if (grp) {
      const l = grp.querySelector("label, legend, [class*='label' i], h1,h2,h3,h4");
      if (l) return l.innerText.toLowerCase();
    }
    return labelFor(el);
  }

  // ---- React-safe value setter ---------------------------------------------
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function markFilled(el) {
    el.classList.add("co-autofilled");
  }

  // ---- rule set (built from the fetched defaults) --------------------------
  function buildRules(d) {
    const id = d.identity || {}, wa = d.workAuth || {}, eeo = d.eeo || {}, lg = d.logistics || {};
    // Order matters: more specific patterns first.
    return [
      { re: /(first|given|legal first).{0,12}name/i, v: id.firstName, kind: "text" },
      { re: /(last|family|sur|legal last).{0,12}name/i, v: id.lastName, kind: "text" },
      { re: /preferred.{0,12}name/i, v: id.preferredName, kind: "text" },
      { re: /full.{0,6}name|^name$|your name/i, v: id.fullName, kind: "text" },
      { re: /e-?mail/i, v: id.email, kind: "text" },
      { re: /phone|mobile|tel(ephone)?/i, v: id.phone, kind: "text" },
      { re: /linkedin/i, v: id.linkedin, kind: "text" },
      { re: /github/i, v: id.github, kind: "text" },
      { re: /(website|portfolio|personal (site|url))/i, v: id.website, kind: "text" },
      { re: /(current )?(city|location)|where (do|are) you (live|based|located)|address/i, v: id.location, kind: "text" },
      // choices (selects / radios)
      { re: /(authoriz|eligible|legally).{0,30}work/i, v: wa.authorized, kind: "choice" },
      { re: /(sponsor|visa|work permit|require sponsorship)/i, v: wa.sponsorship, kind: "choice" },
      { re: /gender( identity)?/i, v: eeo.gender, kind: "choice" },
      { re: /(race|ethnic)/i, v: eeo.race, kind: "choice" },
      { re: /veteran/i, v: eeo.veteran, kind: "choice" },
      { re: /disab(ility|led)/i, v: eeo.disability, kind: "choice" },
      { re: /relocat/i, v: lg.relocation, kind: "choice" },
      { re: /(hear about|referral source|how did you (find|hear))/i, v: d.howHeard, kind: "text" },
    ].filter((r) => r.v); // drop rules with no value
  }

  function firstRule(rules, text, kind) {
    return rules.find((r) => (kind ? r.kind === kind : true) && r.re.test(text));
  }

  // Fuzzy option match: exact-ish, then startsWith, then substring on the
  // leading word (so "Yes" matches "Yes, I am authorized").
  function optionMatches(optText, value) {
    const o = optText.trim().toLowerCase();
    const v = value.trim().toLowerCase();
    if (!o) return false;
    if (o === v) return true;
    if (o.startsWith(v) || v.startsWith(o)) return true;
    const vHead = v.split(/[\s,/(]/)[0];
    return vHead.length >= 2 && (o === vHead || o.startsWith(vHead + " "));
  }

  function fillSelect(el, value) {
    for (const opt of el.options) {
      if (optionMatches(opt.text, value) || optionMatches(opt.value, value)) {
        el.value = opt.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function fillRadioGroup(radios, value) {
    for (const r of radios) {
      const optLabel = labelFor(r) || r.value || "";
      if (optionMatches(optLabel, value) || optionMatches(r.value, value)) {
        r.click();
        markFilled(r);
        return true;
      }
    }
    return false;
  }

  // ---- main fill pass -------------------------------------------------------
  function run(d) {
    const rules = buildRules(d);
    const filled = [];
    const skippedChoices = [];
    let files = 0;

    // Text inputs + textareas
    const textEls = document.querySelectorAll(
      "input[type='text'], input[type='email'], input[type='tel'], input[type='url'], input:not([type]), textarea"
    );
    for (const el of textEls) {
      if (el.disabled || el.readOnly || el.offsetParent === null) continue;
      if (el.value && el.value.trim()) continue; // don't clobber existing input
      const rule = firstRule(rules, labelFor(el), "text");
      if (rule) { setValue(el, rule.v); markFilled(el); filled.push(labelSummary(el, rule.v)); }
    }

    // Native selects
    for (const el of document.querySelectorAll("select")) {
      if (el.disabled || el.offsetParent === null) continue;
      if (el.value && el.selectedOptions[0] && el.selectedOptions[0].text.trim() && el.selectedIndex > 0) continue;
      const rule = firstRule(rules, groupQuestion(el), "choice");
      if (rule) {
        if (fillSelect(el, rule.v)) { markFilled(el); filled.push(`${short(groupQuestion(el))} → ${rule.v}`); }
        else skippedChoices.push(short(groupQuestion(el)));
      }
    }

    // Radio groups
    const seen = new Set();
    for (const r of document.querySelectorAll("input[type='radio']")) {
      const name = r.name || groupQuestion(r);
      if (seen.has(name)) continue;
      seen.add(name);
      const group = r.name ? document.querySelectorAll(`input[type='radio'][name="${CSS.escape(r.name)}"]`) : [r];
      const q = groupQuestion(r);
      const rule = firstRule(rules, q, "choice");
      if (rule) {
        if (fillRadioGroup(group, rule.v)) filled.push(`${short(q)} → ${rule.v}`);
        else skippedChoices.push(short(q));
      }
    }

    for (const f of document.querySelectorAll("input[type='file']")) if (f.offsetParent !== null) files++;

    // Summary toast
    const lines = [];
    lines.push(`<b>Filled ${filled.length} field${filled.length === 1 ? "" : "s"}.</b>`);
    if (filled.length) lines.push(`<ul>${filled.slice(0, 12).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
    const notes = [];
    if (files) notes.push(`${files} file upload${files === 1 ? "" : "s"} — attach your <b>cv.pdf</b> / <b>cover-letter.pdf</b> from career-ops manually.`);
    if (skippedChoices.length) notes.push(`Couldn't match a dropdown for: ${skippedChoices.slice(0, 6).map(escapeHtml).join(", ")} (custom widget — set manually).`);
    notes.push("Essay questions + salary left blank on purpose. <b>Review everything, then submit yourself.</b>");
    lines.push(`<div class="co-notes">${notes.map((n) => `<div>• ${n}</div>`).join("")}</div>`);
    toast(lines.join(""), filled.length ? "ok" : "warn");
  }

  function labelSummary(el, v) {
    return `${short(labelFor(el)) || el.name || el.id || "field"} → ${v.length > 40 ? v.slice(0, 37) + "…" : v}`;
  }
  function short(s) { return (s || "").split("\n")[0].trim().slice(0, 42); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---- wire the button ------------------------------------------------------
  btn.addEventListener("click", () => {
    toast("Fetching your career-ops defaults…", "info");
    chrome.runtime.sendMessage({ type: "getDefaults" }, (resp) => {
      if (chrome.runtime.lastError) { toast(`Extension error: ${chrome.runtime.lastError.message}`, "err"); return; }
      if (!resp || !resp.ok) {
        toast(`Couldn't reach career-ops (${escapeHtml((resp && resp.error) || "unknown")}). Is the VM UI up / are you on the LAN or Twingate?`, "err");
        return;
      }
      try { run(resp.data); }
      catch (e) { toast(`Fill error: ${escapeHtml(e.message)}`, "err"); }
    });
  });
})();
