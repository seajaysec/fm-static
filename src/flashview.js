// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
import { inspectFlash, inspectBackup, packageFlash, writePlan, regionEffect, compareLayouts, compareBytes, FLASH_SIZE, rangeText, address } from "./flash.js?v=2026-10-26.15";
import { sha256hex } from "./fm1pkg.js?v=2026-10-26.15";

const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const size = (n) => `${n.toLocaleString()} bytes`;
const cache = new WeakMap();
function layoutOf(pkg) {
  if (!cache.has(pkg)) cache.set(pkg, inspectFlash(packageFlash(pkg)));
  return cache.get(pkg);
}
function table(regions, plan = null) {
  const t = el("table", null, "flash-table"), caption = el("caption", "Declared ranges; end addresses are excluded.");
  const head = el("tr");
  for (const name of ["Region", "Address range", ...(plan ? ["Expected effect"] : [])]) { const th = el("th", name); th.scope = "col"; head.append(th); }
  const thead = el("thead"); thead.append(head);
  const body = el("tbody");
  for (const r of regions) {
    const row = el("tr"), title = el("th"); title.scope = "row";
    title.append(el("span", r.name), el("small", r.role));
    const addr = el("td"); addr.append(el("code", address(r.start)), el("span", " to "), el("code", address(r.end)));
    row.append(title, addr);
    if (plan) row.append(el("td", regionEffect(r, plan)));
    body.append(row);
  }
  t.append(caption, thead, body);
  return t;
}

function map(plan) {
  const root = el("div", null, "flash-map");
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", plan.known ? "Expected firmware write ranges: " + plan.ranges.map((r) => rangeText(r.start, r.end)).join("; ") : "Firmware write range unknown");
  if (plan.known) {
    for (const r of plan.ranges) {
      const band = el("span", null, "flash-band");
      band.style.left = `${100 * r.start / FLASH_SIZE}%`; band.style.width = `${100 * (r.end - r.start) / FLASH_SIZE}%`;
      root.append(band);
    }
  } else root.append(el("span", "Write range unknown", "flash-unknown"));
  return root;
}

export function setupFlashView() {
  let backup = null, selection = 0, current = null, previous = null;
  const picker = $("backup-file"), msg = $("backup-msg");
  picker.addEventListener("change", async () => {
    const file = picker.files[0];
    if (!file) return;
    const ticket = ++selection;
    backup = null; previous = null; render();
    $("backup-clear").hidden = false;
    msg.textContent = `Reading ${file.name}…`; msg.className = "small";
    try {
      if (file.size !== FLASH_SIZE) throw new Error("Choose a raw 1 MiB flash backup (.bin, 1,048,576 bytes), not a .fwsc package or a project export.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = inspectBackup(bytes), hash = await sha256hex(bytes);
      if (ticket !== selection) return;
      backup = { ...parsed, name: file.name, hash };
      msg.textContent = `${file.name} · 1 MiB · ${parsed.layout}. This file does not establish the connected device's model or current contents.`;
      msg.className = "small";
    } catch (e) {
      if (ticket !== selection) return;
      msg.textContent = e.message; msg.className = "small err";
    }
    previous = null; render();
  });
  $("backup-clear").addEventListener("click", () => {
    selection++; backup = null; picker.value = ""; previous = null;
    msg.textContent = "No backup loaded."; msg.className = "small";
    $("backup-clear").hidden = true; render();
  });

  function render() {
    const { pkg = null, ...options } = current || {};
    const key = [pkg, options.wipe, options.boot, options.stock, backup];
    if (previous && key.every((v, i) => v === previous[i])) return;
    previous = key;
    $("analysis-source").textContent = pkg
      ? `Shared firmware: ${pkg.name} · ${pkg.product}. Preview follows the options selected on Flash.`
      : "Choose firmware in the shared Firmware file panel, or inspect a backup on its own.";
    $("install-analysis-warning").replaceChildren(...(pkg ? layoutOf(pkg).warnings : []).map((w) => el("p", w, "warn")));
    const layout = pkg && layoutOf(pkg), plan = pkg && writePlan(pkg, options);
    $("flash-plan").hidden = !pkg;
    if (pkg) {
      $("flash-layout").textContent = `${layout.layout}, as declared by the selected package. Custom firmware can use data differently from its table.${options.wipe ? " The wipe uses the template's startup code, so its boot-file layout may differ from the selected package's table below." : ""}`;
      $("flash-map").replaceChildren(map(plan));
      $("flash-ranges").replaceChildren(...plan.ranges.map((r) => {
        const li = el("li"); li.append(el("b", r.label), el("code", rangeText(r.start, r.end))); return li;
      }));
      $("flash-caveat").textContent = plan.reason;
      $("flash-warnings").replaceChildren(...layout.warnings.map((w) => el("p", w, "warn")));
      $("flash-regions").replaceChildren(layout.regions.length ? table(layout.regions, plan) : el("p", "No validated physical ranges could be read from the file tables."));
    }
    $("backup-info").hidden = !backup;
    if (!backup) { $("backup-info").replaceChildren(); return; }
    const info = $("backup-info"); info.replaceChildren();
    info.append(el("p", `SHA-256: ${backup.hash}`, "mono"));
    for (const w of backup.warnings) info.append(el("p", w, "warn"));
    if (pkg) {
      info.append(el("h3", "Compared with the selected firmware"));
      const changes = compareLayouts(backup, layout);
      if (changes === null) info.append(el("p", "Layout comparison unavailable: one of the application tables is unknown, incomplete or damaged.", "warn"));
      else if (!changes.length) info.append(el("p", "The declared data-region addresses match. This does not establish that saved-data formats are compatible."));
      else {
        info.append(el("p", "Data-region addresses differ. Data left behind by one firmware may be read differently by the other; this page does not migrate it.", "warn"));
        const list = el("ul", null, "layout-changes");
        for (const c of changes) {
          const item = el("li"); item.append(el("b", c.name), el("span", `Backup: ${c.before ? rangeText(c.before.start, c.before.end) : "not declared"}`), el("span", `Package: ${c.after ? rangeText(c.after.start, c.after.end) : "not declared"}`)); list.append(item);
        }
        info.append(list);
      }
      const diff = compareBytes(backup, pkg, plan, options.stock);
      info.append(el("p", diff
        ? `${size(diff.different)} differ across ${size(diff.compared)} compared in the expected firmware write ranges.${diff.unavailable ? ` Another ${size(diff.unavailable)} cannot be compared because the final bytes are unavailable.` : ""}`
        : "Byte comparison unavailable: the loader's write range is unknown."));
      if (diff) {
        const s = diff.sectors;
        info.append(el("p", `${s.compared} complete 4 KiB sectors compared: ${s.matching} match, ${s.different} differ. ${s.erased} of these sectors are all 0xFF (erased) in the backup.`));
        info.append(el("p", "An erased or different sector alone does not prove a failed update; padding, another firmware or saved data can also explain it.", "small"));
      }
      info.append(el("p", "This compares two files, not the live FM-1. It excludes staging and cleanup writes and does not predict which sectors the loader will skip.", "small"));
    } else info.append(el("p", "Choose firmware in the shared Firmware file panel to compare its layout and expected write bytes with this backup."));
    const details = el("details"), summary = el("summary", "Backup region table"); details.append(summary);
    details.append(backup.regions.length ? table(backup.regions, plan) : el("p", "No validated physical ranges could be read from the file tables."));
    info.append(details);
  }
  return (next) => { current = next; render(); };
}
