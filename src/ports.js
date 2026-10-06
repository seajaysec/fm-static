// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Chris Farrell
// The port names the user added ("remembered"), kept in this browser only.
const KEY = "fm-static.ports";

export function loadNames() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch (_) { return []; }
}

export function saveNames(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { /* private window: lasts until reload */ }
}
