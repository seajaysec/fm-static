// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Chris Farrell
// Page logic: pick a .fwsc, find the FM-1 (or pick its MIDI port), install.
import { Updater, IS_OTA, PRESET_PORTS } from "./fm1ota.js";
import { inspect, APP_END } from "./fm1pkg.js";
import { createScope } from "./scope.js";
import { loadNames, saveNames } from "./ports.js";

const $ = (id) => document.getElementById(id);
const make = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

const state = {
  pkg: null, access: null, up: null, devices: [], selected: null, busy: false, scanning: false, done: false,
  names: loadNames(),          // port names the user added
  tried: new Map(),            // port -> "no answer" after a manual try
};
const scope = createScope($("scope"));

const log = (s) => { $("log").textContent += s + "\n"; $("log").scrollTop = 1e9; };
const say = (s, cls = "") => { const e = $("status"); e.textContent = s; e.className = cls; };
const lcd = (s) => { $("lcd").textContent = s; };

const SEGMENTS = 40;
$("bar").replaceChildren(...Array.from({ length: SEGMENTS }, () => make("i")));
const bar = (pct) => { const on = Math.round((pct / 100) * SEGMENTS); [...$("bar").children].forEach((c, i) => c.classList.toggle("on", i < on)); };

const MESSAGES = {
  notfound: "No FM-1 answered. Use a USB data cable, close other apps that use MIDI, and pick its port in the list if it shows up under another name.",
  model: "That device is not the model this package is for.",
  lost: "The USB connection was lost. Replug it; the page will find it again. If the FM-1 is in update mode, press Finish update.",
  noloader: "The update loader did not appear. Replug the USB cable; the FM-1 stays in update mode until it is finished, then press Finish update.",
  noreturn: "The FM-1 did not come back on its own. Power-cycle it, then press Rescan.",
  stopped: "The device stopped answering. Replug it and press Install again.",
};

const kindText = {
  stock: ["official V15", "the unmodified official M-VAVE firmware"],
  felucca: ["looks like Felucca", "contains Felucca's loader marker text (not a signature: this page cannot verify who made the file)"],
  other: ["unknown origin", "carries its own update loader, which this page cannot vouch for"],
};

const loaderText = {
  official: "M-VAVE's update loader: it rewrites the whole flash.bin, the FM-1's startup code included",
  app: "an app-area-only loader (Felucca's design): it writes the firmware and leaves the startup code and saved data alone",
  unknown: "not one this page recognises",
};

// ------------------------------------------------------------ update paths ---
// Step 1 of an update runs in the firmware the FM-1 has now, and that firmware decides whether to accept the
// package. Firmwares built on Felucca (identity version 700 and up) apply the checks of Felucca's ota.c; what the
// others (M-VAVE's own, and firmwares built on it) check is not known here.
const family = (id) => (id.version === 15 ? "v15" : id.version >= 700 ? "app" : "mvave");

// before Install: what the running firmware is likely to do with this package (a note, never a block)
function pathNote(dev, pkg) {
  if (!dev || !pkg || IS_OTA(dev.id)) return "";
  const fam = family(dev.id), big = pkg.flashLen !== APP_END;
  if (fam === "app" && pkg.loader === "official") {
    return `Your FM-1 runs ${dev.id.text}, a Felucca-based firmware. It accepts a package with M-VAVE's loader only if the FM-1's startup code is still official V15's; after a rescue that rewrote the whole flash, it refuses.` +
      (big ? " This package's app area is also larger than V15's, which recent Felucca-based firmwares refuse." : "") +
      " A refusal writes nothing.";
  }
  if (fam === "mvave" && pkg.loader === "app") {
    return `Your FM-1 runs ${dev.id.text}, not official V15. This package's loader writes the app area only (up to 0x${APP_END.toString(16)}); whatever the current firmware keeps above that stays in flash. Some Felucca-based firmwares ask you to install official V15 first on this path: going straight across has been reported to brick an FM-1.`;
  }
  return "";
}

// after a step-1 stop on a Felucca-based firmware: the request count says which check refused (Felucca's ota.c
// ota_stage: 2 reads of the UFW header, 1 of the loader's header, then the startup code compared 512 bytes at a time)
function stepOneRefusal(e, pkg) {
  if (e.code !== "stopped" || e.step !== 1 || !e.from || family(e.from) !== "app") return "";
  const head = `The firmware on your FM-1 (${e.from.text}) refused the package; nothing was written.`;
  if (e.served === 2 && pkg.flashLen !== APP_END)
    return `${head} Its app area is larger than official V15's, which this firmware does not install. Install official V15 first (it installs from here), then this package from V15.`;
  if (e.served === 3)
    return `${head} It does not accept this package's update loader.`;
  if (e.served === 4 && pkg.loader === "official")
    return `${head} The package carries M-VAVE's loader, which would rewrite the FM-1's startup code, and the startup code on your FM-1 is not official V15's (as after a rescue that rewrote the whole flash with a Felucca-based image). From this firmware only packages with an app-area-only loader install. Getting back to V15's startup code needs a full-flash rescue (the chip's UBOOT mode), which this page does not do.`;
  return "";
}

// ---------------------------------------------------------------- firmware ---

async function loadFile(file) {
  state.pkg = null; state.done = false;
  $("fileinfo").hidden = true;
  if (file) {
    try {
      const pkg = await inspect(await file.arrayBuffer());
      pkg.name = file.name;
      state.pkg = pkg;
      const [k, why] = kindText[pkg.kind];
      $("f-name").textContent = file.name;
      $("f-id").textContent = pkg.product;
      $("f-size").textContent = `${(pkg.size / 1024).toFixed(0)} KiB`;
      $("f-sha").textContent = pkg.sha256;
      $("f-kind").textContent = `${k}: ${why}`;
      $("f-kind").className = pkg.kind === "other" ? "warn" : "";
      $("f-loader").textContent = loaderText[pkg.loader] +
        (pkg.flashLen !== APP_END ? `; app area larger than V15's (flash.bin 0x${pkg.flashLen.toString(16)})` : "");
      $("trust-row").hidden = pkg.kind !== "other";
      $("trust").checked = false;
      $("fileinfo").hidden = false;
      say("");
    } catch (e) {
      say(`${file.name}: ${e.message}`, "err");
    }
  }
  refresh();
}

$("file").addEventListener("change", () => loadFile($("file").files[0]));
const drop = $("drop");
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
$("trust").addEventListener("change", refresh);

// -------------------------------------------------------------- port names ---

function applyNames() {
  if (state.up) state.up.setPatterns([...PRESET_PORTS, ...state.names]);
}

function renderNames() {
  $("presets").replaceChildren(...PRESET_PORTS.map((n) => make("li", { className: "chip fixed", textContent: n, title: "built in" })));
  $("custom").replaceChildren(...state.names.map((n, i) => {
    const input = make("input", { value: n, size: Math.max(6, n.length + 1), ariaLabel: "Port name" });
    input.addEventListener("change", () => {
      const v = input.value.trim();
      if (v) state.names[i] = v; else state.names.splice(i, 1);
      commitNames();
    });
    const rm = make("button", { className: "x", textContent: "×", title: "Remove", ariaLabel: `Remove ${n}` });
    rm.addEventListener("click", () => { state.names.splice(i, 1); commitNames(); });
    return make("li", { className: "chip mine" }, input, rm);
  }));
}

function commitNames() {
  state.names = [...new Set(state.names.map((x) => x.trim()).filter(Boolean))];
  saveNames(state.names);
  applyNames();
  renderNames();
  scan();
}

function addName(name) {
  const v = name.trim();
  if (!v || PRESET_PORTS.some((p) => p.toLowerCase() === v.toLowerCase()) || state.names.includes(v)) return;
  state.names.push(v);
  commitNames();
}

$("add-name").addEventListener("submit", (e) => { e.preventDefault(); addName($("new-name").value); $("new-name").value = ""; });
renderNames();

// ------------------------------------------------------------------ device ---

async function connect() {
  if (!navigator.requestMIDIAccess) {
    say("This browser has no Web MIDI. Use Chrome or Edge on a computer (Firefox and Safari do not work).", "err");
    return;
  }
  try {
    state.access = await navigator.requestMIDIAccess({ sysex: true });
  } catch (e) {
    say("MIDI (SysEx) access was not allowed. Allow it in the site settings (the icon at the left of the address bar) and press Connect again.", "err");
    return;
  }
  state.up = new Updater(state.access, log);
  applyNames();
  let t = null;
  state.access.onstatechange = () => { clearTimeout(t); t = setTimeout(() => { if (!state.busy) scan(); }, 700); };
  $("connect").hidden = true;
  $("devices").hidden = false;
  await scan();
}

async function scan() {
  if (!state.up || state.scanning || state.busy) return;
  state.scanning = true;
  try {
    const found = await state.up.scan();
    const keep = state.devices.filter((d) => d.manual && state.up.ports().includes(d.name) && !found.some((f) => f.name === d.name));
    const alive = [];
    for (const d of keep) { const r = await state.up.probe(d.name); if (r) alive.push({ ...r, manual: true }); }
    state.devices = [...found, ...alive];
    if (!state.devices.some((d) => d.name === state.selected)) state.selected = state.devices[0]?.name ?? null;
    renderDevices();
  } finally { state.scanning = false; refresh(); }
}

function renderDevices() {
  const list = $("device-list");
  list.replaceChildren();
  for (const d of state.devices) {
    const r = make("input", { type: "radio", name: "dev", checked: d.name === state.selected });
    r.addEventListener("change", () => { state.selected = d.name; refresh(); });
    const stuck = IS_OTA(d.id);
    const parts = [r, make("span", { className: "dname", textContent: d.name }),
      make("span", { className: "lcdtxt", textContent: `${d.id.text} ${stuck ? "update mode" : "running"}` })];
    if (d.manual && !state.up.patterns.some((p) => d.name.toLowerCase().includes(p.toLowerCase()))) {
      const keep = make("button", { className: "small", textContent: "Remember this name", title: "Find it by this name next time" });
      keep.addEventListener("click", (e) => { e.preventDefault(); addName(d.name); });
      parts.push(keep);
    }
    list.append(make("label", { className: "dev" + (d.name === state.selected ? " sel" : "") }, ...parts));
  }
  $("none").hidden = state.devices.length > 0;

  // every MIDI port, always: this is the picker
  const rows = state.up.ports().filter((n) => !state.devices.some((d) => d.name === n)).map((n) => {
    const answered = state.tried.get(n);
    const b = make("button", { className: "small", textContent: answered ? "Try again" : "Try this port" });
    b.addEventListener("click", () => tryPort(n, b));
    const note = answered || (state.up.isKnown(n) ? "usual name, no answer" : "not probed");
    return make("li", {}, make("span", { className: "dname", textContent: n }), make("span", { className: "lcdtxt", textContent: note }), b);
  });
  $("ports").replaceChildren(...rows);
  $("ports-empty").hidden = rows.length > 0;
}

// the user says this port is the FM-1: only then is it sent anything
async function tryPort(name, button) {
  button.disabled = true;
  state.up.allow(name);
  const r = await state.up.probe(name);
  if (!r) { state.tried.set(name, "no answer"); renderDevices(); return; }
  state.tried.delete(name);
  state.devices.push({ ...r, manual: true });
  state.selected = name;
  renderDevices();
  refresh();
}

// ----------------------------------------------------------------- install ---

function selectedDevice() { return state.devices.find((d) => d.name === state.selected) || null; }

function refresh() {
  const dev = selectedDevice(), pkg = state.pkg;
  const resume = dev && IS_OTA(dev.id);
  const model = dev && (resume ? dev.id.model.replace(/^ota-/i, "") : dev.id.model);
  let why = "";
  if (!pkg) why = "Choose a firmware file.";
  else if (!state.access) why = "Connect your FM-1.";
  else if (!dev) why = "No device selected.";
  else if (model !== pkg.model) why = `The device is ${dev.id.text}, the package is for ${pkg.product}.`;
  else if (pkg.kind === "other" && !$("trust").checked) why = "Confirm the box above to install a package of unknown origin.";
  $("go").textContent = resume ? "Finish update" : "Install";
  $("go").disabled = state.busy || !!why;
  $("why").textContent = state.busy ? "" : why;
  const note = why || state.done || state.busy ? "" : pathNote(dev, pkg);
  $("path").textContent = note;
  $("path").hidden = !note;
  $("rescan").disabled = state.busy || !state.up;
  $("file").disabled = state.busy;

  // the rail: a stage lights when it is done; the scope and the display say what is connected
  $("st-file").dataset.state = pkg ? "done" : "now";
  $("st-dev").dataset.state = dev ? "done" : pkg ? "now" : "";
  $("st-go").dataset.state = state.done ? "done" : state.busy || !why ? "now" : "";
  if (!state.busy && !state.done) {
    scope.set({ mode: dev ? "locked" : "static" });
    lcd(dev ? `${dev.id.text} locked on ${dev.name}` : state.access ? "no signal" : "waiting");
  }
}

async function install() {
  const dev = selectedDevice(), pkg = state.pkg;
  if (!dev || !pkg || state.busy) return;
  const resume = IS_OTA(dev.id);
  state.busy = true; refresh();
  const up = new Updater(state.access, log);
  up.setPatterns(state.up.patterns);
  up.select(dev.name);
  for (const d of state.devices) up.allow(d.name);
  const total = Math.max(1, Math.round(pkg.image.length / 512));
  let pct = 0;
  const to = (p, text) => { pct = p; bar(p); scope.set({ mode: "write", progress: p / 100 }); lcd(text ?? `writing ${Math.round(p)}%`); };
  const step = (k, a) => {
    log(`${k} ${a ?? ""}`);
    if (k === "start") { say(`Starting the update on ${a}. Do not unplug the FM-1.`); to(0, "starting"); }
    if (k === "verify") { say("Checking the package"); to(Math.min(6, (a / 24) * 6), "checking"); }
    if (k === "loader") { say("Switching to update mode"); to(6, "update mode"); }
    if (k === "write") { say("Writing. Do not unplug the FM-1 or close this page."); to(6 + Math.min(1, a / total) * 90); }
    if (k === "reboot") { say("Restarting"); to(97, "restarting"); }
    if (k === "done") to(100, "done");
  };
  try {
    if (resume) {
      const done = await up.resume(pkg.image, step, pkg.product);
      if (!done) throw Object.assign(new Error(), { code: "stopped" });
      say(`Done: the FM-1 runs ${pkg.product}.`, "ok");
    } else {
      const id = await up.install(pkg.image, pkg.product, step);
      say(`Done: the FM-1 runs ${id}.`, "ok");
    }
    scope.set({ mode: "locked" });
  } catch (e) {
    log(String(e && e.stack || e));
    say(e.code === "mismatch" ? `Written, but the FM-1 reports ${e.detail}, not ${pkg.product}.` : (stepOneRefusal(e, pkg) || MESSAGES[e.code] || `Error: ${e.message}`), "err");
    scope.set({ mode: "error" }); lcd("stopped"); bar(pct);
  }
  state.busy = false;
  setTimeout(scan, 1500);
  state.done = pct === 100 && !$("status").classList.contains("err");
  refresh();
}

window.addEventListener("beforeunload", (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ""; } });
$("connect").addEventListener("click", connect);
$("rescan").addEventListener("click", scan);
$("go").addEventListener("click", install);
refresh();
