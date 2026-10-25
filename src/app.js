// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Chris Farrell
// Page logic: pick a .fwsc, find the FM-1 (or pick its MIDI port), see what the page observed, install.
import { Updater, IS_OTA, PRESET_PORTS } from "./fm1ota.js";
import { inspect, APP_END } from "./fm1pkg.js";
import { loadNames, saveNames } from "./ports.js";

const $ = (id) => document.getElementById(id);
const make = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const hex = (n) => "0x" + n.toString(16);

const state = {
  pkg: null, access: null, up: null, devices: [], selected: null, busy: false, scanning: false, done: false,
  names: loadNames(),          // port names the user added
  tried: new Map(),            // port -> "no answer" after a manual try
  refusedStartup: false,       // the running firmware stopped at its startup-code check (see stepOneRefusal)
  donor: null,                 // a Felucca-family package whose startup code answers that check
  known: new Map(),            // Felucca-family packages loaded on this page, by identity: reused as that package
};

const log = (s) => { $("log").textContent += s + "\n"; $("log").scrollTop = 1e9; };
const say = (s, cls = "") => { const e = $("status"); e.textContent = s; e.className = cls; };
const phase = (s) => { $("phase").textContent = s; };
const bar = (pct) => { $("road-fill").style.width = `${pct}%`; };

const MESSAGES = {
  notfound: "No FM-1 answered. Use a USB data cable, close other apps that use MIDI, and pick its port in the list if it shows up under another name.",
  model: "That device is not the model this package is for.",
  lost: "The USB connection was lost. Replug it; the page will find it again. If the FM-1 is in update mode, press Finish update.",
  noloader: "The update loader did not appear. Replug the USB cable; the FM-1 stays in update mode until it is finished, then press Finish update.",
  noreturn: "The FM-1 did not come back on its own. Power-cycle it, then press Rescan.",
  stopped: "The device stopped answering. Replug it and press Install again.",
};

const kindText = {
  stock: "official V15, the unmodified M-VAVE firmware",
  felucca: "contains Felucca's loader marker text (a text match anyone can put in a file, not a signature: this page cannot verify who made it)",
  other: "unknown origin: it carries its own update loader, which this page cannot vouch for",
};

const loaderText = {
  official: "M-VAVE's update loader. It rewrites the whole flash.bin, the FM-1's startup code included.",
  app: "An app-area-only loader (Felucca's design). It writes the firmware and leaves the startup code and saved data alone.",
  unknown: "Not one this page recognises.",
};

// What the header can and cannot say about who made a package. Identity numbers and sizes are all there is: no maker
// string is in any package inspected, so a name is only ever offered as "the shape of".
function shapeText(pkg) {
  if (pkg.kind === "stock") return "The official package: its hash is the unmodified M-VAVE V15's.";
  if (pkg.loader === "official" && pkg.flashLen > APP_END)
    return `Recognised: the shape of a Baudgirl release (M-VAVE's loader, app area up to ${hex(pkg.flashLen)} against V15's ${hex(APP_END)}; true of every one inspected, though the header carries no maker name). `;
  if (pkg.loader === "app")
    return "A Felucca-family package. Several firmwares share this structure, so the file cannot say which one it is.";
  return "No known shape.";
}

// ------------------------------------------------------------ the route ---
// Step 1 of an update runs in the firmware the FM-1 has now, and that firmware decides whether to accept the package.
// Firmwares built on Felucca (identity version 700 and up) apply the checks of Felucca's ota.c, read here. What M-VAVE's
// own firmware and the firmwares built on it check is not known.
const family = (id) => (id.version === 15 ? "v15" : id.version >= 700 ? "app" : "mvave");

// -> [{ state: go | note | stop | detour | info | unknown, plate, title, text }]
function checks(dev, pkg) {
  const out = [];
  const add = (st, plate, title, text) => out.push({ state: st, plate, title, text });
  if (pkg) {
    add("go", "CLEAR", "Package intact", `${pkg.product}. The header and flash.bin checksums match.`);
    add("info", "SEEN", "What the file is", shapeText(pkg));
  }
  if (dev) {
    const usual = state.up.patterns.some((p) => dev.name.toLowerCase().includes(p.toLowerCase()));
    if (!usual) {
      add("detour", "BYPASSED", `Port “${dev.name}”`, "That is not a usual FM-1 name. An updater that finds the FM-1 by name would have reported it missing. This page found it by asking the port who it is.");
    } else add("go", "CLEAR", `Port “${dev.name}”`, "Answered the FM-1 identity query.");
    if (IS_OTA(dev.id)) {
      add("note", "NOTE", "FM-1 is in update mode", `${dev.id.text}: an update was cut off. Finish update writes the package to it.`);
    } else {
      const fam = family(dev.id);
      if (fam === "v15") add("go", "CLEAR", "Running official V15", "The starting point the installers we read accept.");
      else add("detour", "BYPASSED", `Running ${dev.id.text}`,
        (fam === "app" ? "A Felucca-family firmware. " : "A custom build on M-VAVE's update system. ") +
        "An installer that only starts from official V15 or its own releases would have stopped here. This page does not stop.");
    }
  }
  if (dev && pkg && !IS_OTA(dev.id)) {
    const fam = family(dev.id);
    if (dev.id.model !== pkg.model) add("barrier", "STOP", "Wrong model", `The device is ${dev.id.text}, the package is for ${pkg.product}. This is the one thing this page refuses.`);
    else if (fam === "app" && pkg.loader === "official") {
      add("barrier", "WOULD STOP", "Startup code",
        `${dev.id.text} installs a package with M-VAVE's loader only if the FM-1's startup code is still official V15's, because that loader would rewrite it. After a rescue that wrote a Felucca-family image the startup code is not V15's, and it refuses. A refusal writes nothing.` +
        (pkg.flashLen !== APP_END ? ` This package's app area is also larger than V15's, which recent Felucca-family firmwares refuse outright.` : ""));
    } else if (fam === "mvave" && pkg.loader === "app") {
      add("note", "NOTE", "Crossing families",
        `This package's loader writes the app area only (up to ${hex(APP_END)}). Whatever ${dev.id.text} keeps above that stays in flash. Some Felucca-family projects warn that going straight from a custom firmware has bricked an FM-1; the one report is not explained, and this page cannot tell whether it applies to your pair.`);
    } else if (fam === "app" && pkg.loader === "app") add("go", "CLEAR", "Same family", "A Felucca-family firmware installing a Felucca-family package: the path that loader is built for.");
    else if (fam === "v15") add("go", "CLEAR", "Path from V15", "The path these packages are built for.");
    else add("unknown", "UNKNOWN", "Package against the running firmware", `${dev.id.text} is closed. Whether it accepts this package is not known; a refusal writes nothing.`);
  }
  if (!out.length) add("idle", "WAITING", "Choose a file and connect your FM-1", "The checkpoints appear here.");
  return out;
}

function renderRoute() {
  $("route").replaceChildren(...checks(selectedDevice(), state.pkg).map((c) => {
    const li = make("li", { className: "cp" }, make("span", { className: "plate" }, make("span", { textContent: c.plate })),
      make("div", {}, make("b", { textContent: c.title }), make("p", { textContent: c.text })));
    li.dataset.state = c.state;
    return li;
  }));
}

// after a step-1 stop on a Felucca-family firmware: the request count says which check refused (Felucca's ota.c
// ota_stage: 2 reads of the UFW header, 1 of the loader's header, then the startup code compared 512 bytes at a time)
function stepOneRefusal(e, pkg) {
  if (e.code !== "stopped" || e.step !== 1 || !e.from || family(e.from) !== "app") return "";
  const head = `The firmware on your FM-1 (${e.from.text}) refused the package at request ${e.served}; nothing was written.`;
  if (e.served === 2 && pkg.flashLen !== APP_END)
    return `${head} Its app area is larger than official V15's, which this firmware does not install. Install official V15 first (it installs from here), then this package from V15.`;
  if (e.served === 3) return `${head} It does not accept this package's update loader.`;
  if (e.served === 4 && pkg.loader === "official")
    return `${head} It compared the startup code in your FM-1's flash with the package's. The package carries M-VAVE's loader, which would rewrite that region, and yours is not official V15's (as after a rescue that wrote a whole Felucca-family image). The restore mode below can answer that check.`;
  return "";
}

// ---------------------------------------------------------------- firmware ---

async function loadFile(file) {
  state.pkg = null; state.done = false; state.refusedStartup = false; state.donor = null;
  $("fileinfo").hidden = true;
  if (file) {
    try {
      const pkg = await inspect(await file.arrayBuffer());
      pkg.name = file.name;
      $("drop-name").textContent = file.name;
      state.pkg = pkg;
      if (isFamilyFile(pkg)) state.known.set(pkg.product, pkg);
      $("f-name").textContent = file.name;
      $("f-id").textContent = pkg.product;
      $("f-size").textContent = `${(pkg.size / 1024).toFixed(0)} KiB`;
      $("f-sha").replaceChildren(...pkg.sha256.match(/.{1,8}/g).map((g) => make("span", { textContent: g })));
      $("f-kind").textContent = kindText[pkg.kind];
      $("f-kind").className = pkg.kind === "other" ? "warn" : "";
      $("f-loader").textContent = loaderText[pkg.loader];
      $("f-shape").textContent = shapeText(pkg);
      $("trust-row").hidden = pkg.kind !== "other";
      $("trust").checked = false;
      $("fileinfo").hidden = false;
      say("");
    } catch (e) {
      $("drop-name").textContent = "No file chosen";
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
    const r = make("input", { type: "radio", name: "dev", checked: d.name === state.selected, ariaLabel: d.name });
    r.addEventListener("change", () => { state.selected = d.name; state.refusedStartup = false; refresh(); });
    const stuck = IS_OTA(d.id);
    const parts = [r, make("span", { className: "dname", textContent: d.name }),
      make("span", { className: "meta", textContent: `${d.id.text} ${stuck ? "update mode" : "running"}` })];
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
    return make("li", {}, make("span", { className: "dname", textContent: n }), make("span", { className: "meta", textContent: note }), b);
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

// ------------------------------------------------------------- boot mode ---
// A FM-1 whose firmware does not start falls back to the chip's ROM boot mode (WL80UBOOT, USB vendor 4C4A): not a MIDI
// device, so Web MIDI never sees it; WebUSB can list it (nothing is opened or sent).
if (navigator.usb) $("boot-check").hidden = false;
$("boot-check").addEventListener("click", async () => {
  const box = $("boot-msg");
  box.replaceChildren();
  let dev = null;
  try { dev = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x4C4A }] }); } catch (e) { log(`usb: ${e.name}`); }
  const link = (href, text) => make("a", { href, textContent: text, rel: "noopener" });
  if (!dev) box.append(make("p", { className: "small", textContent: "No boot-mode device was found or chosen. Replug the FM-1 with a USB data cable straight into the computer and try again." }));
  else box.append(
    make("p", { className: "err", textContent: `Your FM-1 is in the chip's boot mode (${dev.productName || "WL80UBOOT"}, ${dev.vendorId.toString(16)}:${dev.productId.toString(16)}). Its firmware does not start, so it has no MIDI port for this page to find.` }),
    make("p", {}, "Sorry: this page can't write to it from there, and it should be easier than this. The open tool ", link("https://github.com/kagaimiq/jl-uboot-tool", "jl-uboot-tool"),
      " talks to that mode, but it ships no loader for this chip family (its README lists WL82/AC791N as unknown), so expect some work. ",
      link("https://github.com/kurogedelic/FM-1-transporter", "FM-1 Transporter"), " is the recovery Felucca-family projects document. Neither is tested here.")
  );
  box.hidden = false;
});

// ----------------------------------------------------------------- install ---

function selectedDevice() { return state.devices.find((d) => d.name === state.selected) || null; }

// a Felucca-family package: app-area loader, startup code not V15's
const isFamilyFile = (d) => d.loader === "app" && !d.stockHead && !!d.startup;
const donorFits = (d, pkg) => isFamilyFile(d) && d.flashOff === pkg.flashOff;

// the package whose startup code answers the check: the one chosen in the dialog, else a Felucca-family package
// loaded on this page before (the same firmware as the FM-1 runs if there is one, else any: those carried identical
// startup code in every package inspected, and if one is wrong the firmware refuses again and nothing is written)
function startupSource(dev, pkg) {
  if (state.donor) return { d: state.donor, why: "the file you chose" };
  const same = dev && state.known.get(dev.id.text);
  if (same && donorFits(same, pkg)) return { d: same, why: `${same.name}, which you loaded earlier and is the firmware your FM-1 runs` };
  const any = [...state.known.values()].find((d) => donorFits(d, pkg));
  if (any) return { d: any, why: `${any.name}, which you loaded earlier (a different Felucca-family firmware than ${dev ? dev.id.text : "the one on your FM-1"}; their startup code was identical in every package inspected)` };
  return null;
}

$("donor-open").addEventListener("click", () => {
  const dev = selectedDevice();
  $("dlg-main").textContent = state.pkg ? state.pkg.name : "";
  $("dlg-run").textContent = dev ? dev.id.text : "";
  $("dlg-msg").hidden = true;
  $("donor-dialog").showModal();
});
$("dlg-close").addEventListener("click", () => $("donor-dialog").close());
$("donor").addEventListener("change", async () => {
  const f = $("donor").files[0], msg = $("dlg-msg");
  if (!f) return;
  try {
    const d = await inspect(await f.arrayBuffer());
    d.name = f.name;
    if (donorFits(d, state.pkg)) { state.donor = d; $("donor-dialog").close(); }
    else { msg.textContent = `${f.name} (${d.product}) carries no Felucca-family startup code. Pick a package of the firmware your FM-1 runs now.`; msg.className = "small err"; msg.hidden = false; }
  } catch (e) { msg.textContent = `${f.name}: ${e.message}`; msg.className = "small err"; msg.hidden = false; }
  refresh();
});
$("risk").addEventListener("change", refresh);

function refresh() {
  const dev = selectedDevice(), pkg = state.pkg;
  const resume = dev && IS_OTA(dev.id);
  const model = dev && (resume ? dev.id.model.replace(/^ota-/i, "") : dev.id.model);
  let why = "";
  if (!pkg) why = "Waiting for a firmware file, chosen in the first box above.";
  else if (!state.access) why = "Waiting for your FM-1: press Connect above.";
  else if (!dev) why = "Waiting for an FM-1 to be selected above.";
  else if (model !== pkg.model) why = `The device is ${dev.id.text}, the package is for ${pkg.product}.`;
  else if (pkg.kind === "other" && !$("trust").checked) why = "Confirm the box above to install a package of unknown origin.";
  $("go").textContent = resume ? "Finish update" : "Install";
  $("go").disabled = state.busy || !!why;
  $("why").textContent = state.busy ? "" : why;
  $("rescan").disabled = state.busy || !state.up;
  $("file").disabled = state.busy;

  $("restore").hidden = !(state.refusedStartup && pkg && dev && !state.done);
  const big = !!pkg && pkg.flashLen > APP_END;
  $("risk-data").hidden = !big;
  $("risk-more").textContent = big ? " and replace saved data above 0x93000" : "";
  const src = pkg && dev ? startupSource(dev, pkg) : null;
  $("donor-info").textContent = src
    ? `Startup code: from ${src.why}. Only its first 16 KB is read.`
    : "Needed: a package of the firmware your FM-1 runs now, for its startup code. This is in addition to the file you chose, which is what gets written.";
  $("donor-info").className = "small" + (src ? "" : " warn");
  $("donor-open").textContent = src ? "Use a different file for the startup code" : "Choose the file for the startup code";
  $("restore-go").disabled = state.busy || !src || !$("risk").checked;

  $("st-file").dataset.state = pkg ? "done" : "now";
  $("st-dev").dataset.state = dev ? "done" : pkg ? "now" : "";
  $("st-go").dataset.state = state.done ? "done" : state.busy || !why ? "now" : "";
  renderRoute();
  if (!state.busy && !state.done) phase(dev ? `${dev.id.text} on ${dev.name}` : state.access ? "No FM-1 selected" : "");
}

async function install(startup = null) {
  const dev = selectedDevice(), pkg = state.pkg;
  if (!dev || !pkg || state.busy) return;
  const resume = IS_OTA(dev.id);
  state.busy = true; state.refusedStartup = false; refresh();
  const up = new Updater(state.access, log);
  up.setPatterns(state.up.patterns);
  up.select(dev.name);
  for (const d of state.devices) up.allow(d.name);
  const total = Math.max(1, Math.round(pkg.image.length / 512));
  let pct = 0;
  const to = (p, text) => { pct = p; bar(p); phase(text ?? `Writing ${Math.round(p)}%`); };
  const step = (k, a) => {
    log(`${k} ${a ?? ""}`);
    if (k === "start") { say(`Starting the update on ${a}. Do not unplug the FM-1.`); to(0, "Starting"); }
    if (k === "verify") { say("Checking the package"); to(Math.min(6, (a / 24) * 6), "Checking the package"); }
    if (k === "loader") { say("Switching to update mode"); to(6, "Update mode"); }
    if (k === "write") { say("Writing. Do not unplug the FM-1 or close this page."); to(6 + Math.min(1, a / total) * 90); }
    if (k === "reboot") { say("Restarting"); to(97, "Restarting"); }
    if (k === "done") to(100, "Done");
  };
  try {
    if (resume) {
      const done = await up.resume(pkg.image, step, pkg.product);
      if (!done) throw Object.assign(new Error(), { code: "stopped" });
      say(`Done: the FM-1 runs ${pkg.product}.`, "ok");
    } else {
      const id = await up.install(pkg.image, pkg.product, step, startup);
      say(`Done: the FM-1 runs ${id}.`, "ok");
    }
  } catch (e) {
    log(String(e && e.stack || e));
    const refusal = stepOneRefusal(e, pkg);
    state.refusedStartup = !startup && e.served === 4 && pkg.loader === "official" && !!refusal;
    say(e.code === "mismatch" ? `Written, but the FM-1 reports ${e.detail}, not ${pkg.product}.` : (refusal || MESSAGES[e.code] || `Error: ${e.message}`), "err");
    phase("Stopped"); bar(pct);
  }
  state.busy = false;
  setTimeout(scan, 1500);
  state.done = pct === 100 && !$("status").classList.contains("err");
  refresh();
}

window.addEventListener("beforeunload", (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ""; } });
$("connect").addEventListener("click", connect);
$("rescan").addEventListener("click", scan);
$("go").addEventListener("click", () => install());
$("restore-go").addEventListener("click", () => {
  const src = startupSource(selectedDevice(), state.pkg);
  if (src && $("risk").checked) install({ at: state.pkg.flashOff, bytes: src.d.startup });
});
refresh();
