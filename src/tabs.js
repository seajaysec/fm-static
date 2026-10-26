// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
export function setupTabs() {
  const tabs = [...document.querySelectorAll('.mode-tabs [role="tab"]')];
  function select(tab, focus = false) {
    for (const t of tabs) {
      const active = t === tab;
      t.setAttribute("aria-selected", String(active)); t.tabIndex = active ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !active;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => { if (!tab.disabled) select(tab); });
    tab.addEventListener("keydown", (event) => {
      if (tab.disabled) return;
      const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)
        : event.key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length]
        : event.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : null;
      if (next && !next.disabled) { event.preventDefault(); select(next, true); }
    });
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const section = document.getElementById(link.getAttribute("href").slice(1));
    const panel = section?.closest('[role="tabpanel"]');
    const tab = tabs.find((t) => t.getAttribute("aria-controls") === panel?.id);
    if (!tab) return;
    event.preventDefault();
    if (tab.disabled) return;
    select(tab);
    if (section.tagName === "DETAILS") section.open = true;
    section.focus({ preventScroll: true }); section.scrollIntoView({ block: "start" });
  });
  // Keep the install's progress in view; navigation resumes when it finishes.
  return (busy) => { if (busy) select(tabs[0]); for (const tab of tabs) tab.disabled = busy; };
}
