// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// Page logic: pick a .fwsc, find the FM-1 (or pick its MIDI port), see what the page observed, install.
import { Updater, IS_OTA, PRESET_PORTS } from "./updater.js?v=2026-10-26.14";
import { inspect, rebuild, wipeFlash, sha256hex, productOf, logicalImage, APP_END, WIPE_END } from "./fm1pkg.js?v=2026-10-26.14";
import { loadNames, saveNames } from "./ports.js?v=2026-10-26.14";
import { setupFlashView } from "./flashview.js?v=2026-10-26.14";
import { setupTabs } from "./tabs.js?v=2026-10-26.14";

// the page version (tools/stamp.sh): shown in the footer; the page and this script must agree
const VERSION = "2026-10-26.14";
const $ = (id) => document.getElementById(id);
const make = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const hex = (n) => "0x" + n.toString(16);
// Both tabs use the same package-details markup and data; disclosure state stays local to each tab.
for (const prefix of ["", "analysis-"]) {
  const content = $("package-details-template").content.cloneNode(true);
  for (const node of content.querySelectorAll("[id]")) node.id = prefix + node.id;
  $(prefix + "fileinfo").prepend(content);
}
const updateFlashView = setupFlashView();
const updateTabs = setupTabs();

const state = {
  pkg: null, access: null, up: null, devices: [], selected: null, busy: false, fileLoading: false, scanning: false, done: false,
  names: loadNames(),          // port names the user added
  tried: new Map(),            // port -> "no answer" after a manual try
  frozen: null,                // the device facts as they were when the install started
  progress: null,              // { pct, label } of the step being done, drawn inside the last event
  events: [],                  // what happened during the install, shown on the route
  refusedStartup: false,       // the running firmware stopped at its startup-code check (see stepOneRefusal)
  donor: null,                 // a Felucca-family package whose startup code answers that check
  stock: null,                 // the official V15 package (inspected): its loader and startup code build a wipe package
  known: new Map(),            // Felucca-family packages loaded on this page, by identity: reused as that package
};

const log = (s) => { $("logbox").hidden = false; $("log").textContent += s + "\n"; $("log").scrollTop = 1e9; };
const say = (s, cls = "") => { const e = $("status"); e.textContent = s; e.className = cls; };
// The progress of the step in progress is drawn inside that step of the chain (the last event), not apart from it.
let shown = -1;
const progress = (pct, label) => { state.progress = pct == null ? null : { pct, label }; const k = pct == null ? -1 : Math.round(pct); if (k !== shown) { shown = k; renderRoute(); } };

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
  mvave: "looks like one of M-VAVE's own releases (its identity is one of theirs); the page cannot verify who made the file",
  felucca: "contains Felucca's loader marker text (a text match anyone can put in a file, not a signature: this page cannot verify who made it)",
  other: "unknown origin: it carries its own update loader, which this page cannot vouch for",
};

const loaderText = {
  official: "M-VAVE's update loader. Felucca's source says it rewrites the whole flash.bin, the FM-1's startup code included.",
  app: "An app-area-only loader (Felucca's design). It writes the firmware area and, per Felucca's source, leaves the startup code and the data area alone.",
  unknown: "Not one this page recognises.",
};

// What the header can and cannot say about who made a package. Identity numbers and sizes are all there is: no maker
// string is in any package inspected, so a name is only ever offered as "the shape of".
function shapeText(pkg) {
  if (pkg.kind === "stock") return "The official package: its hash is the unmodified M-VAVE V15's.";
  if (pkg.kind === "mvave") return `The shape of an M-VAVE release (${pkg.product}): M-VAVE's loader and V15's package layout. Only V15's own hash is known to this page.`;
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
const family = (id) => (id.open ? "open" : id.version === 15 ? "v15" : id.version >= 700 ? "app" : id.version <= 19 ? "official" : "mvave");
// identity numbers: up to 19 are M-VAVE's own releases, 20..699 builds on M-VAVE's update system, 700 and up Felucca-family
const familyText = { open: "M-VAVE's Open firmware", official: "an official M-VAVE release other than V15", mvave: "a custom build on M-VAVE's update system", app: "a Felucca-family firmware" };

// What was observed before anything is sent: facts only. Nothing here predicts what the FM-1's firmware will do; that
// is shown when it happens (events, below).
// -> [{ state: go | info | detour | barrier | idle, plate, title, text }]
function fileChecks(pkg) {
  const out = [];
  const add = (st, plate, title, text) => out.push({ state: st, plate, title, text });
  if (pkg) {
    add("go", "CLEAR", "Package checksums match", `${pkg.product}. The header and flash.bin checksums match.`);
    add("info", "SEEN", "What the file is", shapeText(pkg));
    if (pkg.provenance) add("go", "BUILT", "Built by GitHub Actions", `${builtText(pkg.provenance)}${pkg.provenance.workflow ? ", workflow " + pkg.provenance.workflow : ""}. GitHub reports this record for this file's hash; it shows where the file came from, not that the code is safe.`);
    else if (pkg.provenance === null) add("info", "SEEN", "No GitHub build record", `GitHub holds no build attestation for this exact file in ${pkg.provenanceRepo}, so nothing here says where it was built.`);
  }
  return out;
}
function devChecks(dev, pkg) {
  const out = [];
  const add = (st, plate, title, text) => out.push({ state: st, plate, title, text });
  if (dev) {
    const usual = state.up.patterns.some((p) => dev.name.toLowerCase().includes(p.toLowerCase()));
    if (!usual) {
      add("detour", "BYPASSED", `Port “${dev.name}”`, "That is not a usual FM-1 name. An updater that finds the FM-1 by name could have reported it missing. This page found it by asking the port who it is.");
    } else add("go", "CLEAR", `Port “${dev.name}”`, "Answered the FM-1 identity query.");
    if (IS_OTA(dev.id)) {
      add("info", "SEEN", "FM-1 is in update mode", `${dev.id.text}: an update was cut off. Finish update writes the package to it.`);
    } else {
      const fam = family(dev.id);
      if (fam === "v15") add("go", "CLEAR", "Running official V15", "The starting point installers expect.");
      else if (fam === "open") add("info", "SEEN", `Running ${dev.id.text}`, "M-VAVE's Open firmware. Its updater takes only a package it has been told about first: this page tells it the package's SHA-256, and it accepts only M-VAVE's own FM-1 firmware. To install anything else, put M-VAVE's own firmware back first.");
      else add("detour", "BYPASSED", `Running ${dev.id.text}`,
        `${familyText[fam][0].toUpperCase()}${familyText[fam].slice(1)}. An installer that only starts from official V15 or its own releases could have stopped here. This page does not stop.`);
    }
    if (pkg && unverified(pkg) && !$("trust").checked)
      add("idle", "WAITING", "Source not confirmed", "Install appears once you confirm, in the box under the file's checks, that the file comes from a source you trust.");
    if (pkg && !IS_OTA(dev.id) && dev.id.model !== pkg.model)
      add("barrier", "STOP", "Wrong model", `The device is ${dev.id.text}, the package is for ${pkg.product}. This is the one thing this page refuses.`);
  }
  if (!out.length) add("idle", "WAITING", "No FM-1 selected", "Pick your FM-1 above, or press Rescan.");
  return out;
}

// what happens during an install, in order, as it happens
function note(st, plate, title, text) {
  state.events.push({ state: st, plate, title, text }); $("after").hidden = false; renderRoute();
  // the chain grows downward while an install runs: keep its newest step in view (only if it is off screen)
  const last = $("route-events").lastElementChild;
  if (state.busy && last) last.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

const wipeOn = () => $("wipe").checked;
const bootOn = () => $("bootl").checked;
// a package whose maker this page cannot vouch for: anything but the official V15 and files with Felucca's marker
const unverified = (p) => p.kind === "other" || p.kind === "mvave";
const items = (list) => list.map((c) => {
  const li = make("li", { className: "cp" }, make("span", { className: "plate" }, make("span", { textContent: c.plate })),
    make("div", {}, make("b", { textContent: c.title }), make("p", { textContent: c.text })));
  li.dataset.state = c.state;
  return li;
});

// The facts about the device are frozen when an install starts: the device is not the one it was afterwards
// (it restarts as the new firmware), and the route must keep saying what was true at the start.
function renderRoute() {
  for (const prefix of ["", "analysis-"]) $(prefix + "route-file").replaceChildren(...items(fileChecks(state.pkg)));
  $("route-dev").replaceChildren(...items(state.frozen || devChecks(selectedDevice(), state.pkg)));
  const evs = items(state.events), last = evs[evs.length - 1];
  if (last && state.busy && state.progress) {
    const body = last.lastElementChild;
    body.append(make("div", { className: "bar", role: "progressbar", ariaValueMin: 0, ariaValueMax: 100, ariaValueNow: Math.round(state.progress.pct), ariaLabel: state.progress.label }, make("i", { style: `width:${state.progress.pct}%` })),
      make("p", { className: "small", textContent: state.progress.label }));
  }
  $("route-events").replaceChildren(...evs);
}

// after a step-1 stop on a Felucca-family firmware: the request count says which check refused (Felucca's ota.c
// ota_stage: 2 reads of the UFW header, 1 of the loader's header, then the startup code compared 512 bytes at a time)
function stepOneRefusal(e, pkg) {
  // The request counts are read from Felucca's ota.c and a second Felucca-family build's (both compiled and run on the host); other
  // Felucca-family builds are assumed to share them and are not checked.
  if (e.code !== "stopped" || e.step !== 1 || !e.from || family(e.from) !== "app") return "";
  const head = `${e.from.text} stopped after reading ${e.served} parts of the package, and nothing was written.`;
  if (e.served === 2 && pkg.flashLen !== APP_END)
    return `${head} In Felucca's code that is the check that the package's flash.bin is exactly V15's size (this one's is ${hex(pkg.flashLen)}). Some Felucca-family builds do not make that check. A package of V15's size gets past it, though it can still be stopped at the startup-code check.`;
  if (e.served === 3) return `${head} It does not accept this package's update loader.`;
  if (e.served === 4 && pkg.loader === "official")
    return `${head} It looked at the package's startup code (the first 16 KB of its flash image) and would not take it. An older Felucca-family firmware refuses when that differs from the startup code on your FM-1, which is the case after a rescue that wrote another firmware's image, or with a replacement boot loader such as m-bootloader. A firmware built on a recent fm1-base accepts any startup code the chip can start from, so installing one of those first is the other way through. The restore step below answers the older kind of check.`;
  return "";
}

// ---------------------------------------------------------------- firmware ---

let fileEpoch = 0;
const currentFileRequest = (ticket) => ticket === fileEpoch && !state.busy;
async function loadFile(file, source = "", ticket = ++fileEpoch) {
  if (!file || state.busy) return;
  state.fileLoading = true;
  const msg = $("file-msg"); msg.className = "small"; msg.textContent = `Reading ${file.name}…`;
  refresh();
  try {
    const pkg = await inspect(await file.arrayBuffer());
    if (ticket !== fileEpoch || state.busy) return;
    pkg.name = file.name;
    state.pkg = pkg; state.done = false; state.refusedStartup = false; state.donor = null; state.events = []; state.frozen = null;
    $("after").hidden = true;
    $("wipe").checked = false; $("bootl").checked = false; $("backup").checked = false;
    $("drop-name").textContent = file.name;
    if (source) provenance(pkg, source);
    if (isFamilyFile(pkg)) state.known.set(pkg.product, pkg);
    if (pkg.kind === "stock" || (pkg.kind === "mvave" && !state.stock)) state.stock = pkg;
    for (const prefix of ["", "analysis-"]) {
      const field = (id) => $(prefix + id);
      field("f-name").textContent = file.name;
      field("f-source").textContent = source; field("f-source").hidden = field("f-source-t").hidden = !source;
      field("f-id").textContent = pkg.product;
      field("f-size").textContent = `${(pkg.size / 1024).toFixed(0)} KiB`;
      field("f-sha").replaceChildren(...pkg.sha256.match(/.{1,8}/g).map((g) => make("span", { textContent: g })));
      field("f-kind").textContent = kindText[pkg.kind];
      field("f-kind").className = unverified(pkg) ? "warn" : "";
      field("f-loader").textContent = loaderText[pkg.loader];
    }
    $("trust-row").hidden = !unverified(pkg); $("trust").checked = false;
    $("file-selection").textContent = `${pkg.product} · ${file.name}`;
    msg.textContent = "Ready for Flash and Layout Analysis.";
    say("");
  } catch (e) {
    if (ticket !== fileEpoch || state.busy) return;
    msg.className = "small err";
    msg.textContent = `${file.name}: ${e.message} ${state.pkg ? "The previous firmware selection is unchanged." : "No firmware selected."}`;
  } finally {
    if (ticket === fileEpoch) { state.fileLoading = false; refresh(); }
  }
}

// A saved web page can carry firmware packages as base64 text (M-VAVE's Workbench holds the Open firmware and the original V15
// that way). Long base64 runs are decoded and kept when they are valid FM-1 packages (checksums and all).
async function embeddedPackages(text) {
  const found = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/=]{60000,}/g)) {
    try {
      const bin = Uint8Array.from(atob(m[0]), (c) => c.charCodeAt(0));
      const pkg = await inspect(bin);
      found.push({ bytes: bin, product: pkg.product, kib: Math.round(bin.length / 1024) });
    } catch (_) { /* not a package: an image, a script, a sound bank */ }
  }
  return found;
}

async function pickFile(file) {
  if (!file || state.busy) return;
  const ticket = ++fileEpoch;
  state.fileLoading = false; refresh();
  $("url-results").replaceChildren(); $("url-msg").hidden = true;
  if (file && /\.html?$/i.test(file.name)) {
    state.fileLoading = true; refresh();
    try {
    urlMsg(`Looking for firmware inside ${file.name}…`);
    const pkgs = await embeddedPackages(await file.text());
    if (ticket !== fileEpoch || state.busy) return;
    if (!pkgs.length) { urlMsg(`No firmware package found inside ${file.name}.`, "small err"); return; }
    const use = (p) => loadFile(new File([p.bytes], `${p.product}.fwsc`), `inside ${file.name}`);
    if (pkgs.length === 1) { urlMsg(""); await use(pkgs[0]); return; }
    urlMsg(`${pkgs.length} firmware packages are inside ${file.name}. Pick one:`);
    $("url-results").replaceChildren(...pkgs.map((p) => {
      const b = make("button", { className: "small", type: "button", textContent: "Use this file" });
      b.addEventListener("click", () => { $("url-results").replaceChildren(); urlMsg(""); use(p); });
      return make("li", {}, make("span", { className: "dname", textContent: p.product }), make("span", { className: "meta", textContent: `${p.kib} KiB, inside the page` }), b);
    }));
    } catch (e) { if (currentFileRequest(ticket)) urlMsg(`Could not read ${file.name}: ${e.message}`, "small err"); }
    finally { if (ticket === fileEpoch) { state.fileLoading = false; refresh(); } }
    return;
  }
  await loadFile(file, "", ticket);
}
$("file").addEventListener("change", () => {
  const file = $("file").files[0];
  $("file").value = ""; // Let choosing the same file again count as a new selection.
  pickFile(file);
});

// ------------------------------------------------- firmware from an address ---
// The browser fetches the page itself and looks for .fwsc addresses in its source: nothing goes through any server of
// ours. A site must allow other pages to read it (CORS) or the browser refuses; many do not.
const FWSC = /[A-Za-z0-9_\-.\/%+:@~=&?]*?\.fwsc(?![A-Za-z0-9])/g;
const MAX_FILE = 8 * 1024 * 1024;
const urlMsg = (s, cls = "small") => { const m = $("url-msg"); m.textContent = s; m.className = cls; m.hidden = !s; };
const blocked = "The browser could not read that address. Most often the site does not allow other pages to read it, or it is unreachable. Download the file there and drop it into the box above.";

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim());
  const len = +r.headers.get("content-length") || 0;
  if (len > MAX_FILE) throw new Error("that file is far larger than any FM-1 firmware");
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_FILE) throw new Error("that file is far larger than any FM-1 firmware");
  return buf;
}

async function useUrl(u, ticket = ++fileEpoch) {
  if (!currentFileRequest(ticket)) return;
  state.fileLoading = true; refresh();
  urlMsg(`Fetching ${u.pathname.split("/").pop()} from ${u.host}…`);
  try {
    const buf = await fetchBytes(u.href);
    if (ticket !== fileEpoch || state.busy) return;
    const name = decodeURIComponent(u.pathname.split("/").pop() || "firmware.fwsc");
    urlMsg("");
    $("url-results").replaceChildren();
    await loadFile(new File([buf], name), u.href, ticket);
  } catch (e) { if (ticket === fileEpoch) urlMsg(e instanceof TypeError ? blocked : `Could not fetch that file: ${e.message}.`, "small err"); }
  finally { if (ticket === fileEpoch) { state.fileLoading = false; refresh(); } }
}

$("url-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (state.busy) return;
  const ticket = ++fileEpoch;
  state.fileLoading = true; refresh();
  try {
  $("url-results").replaceChildren();
  let page;
  let raw = $("url").value.trim();
  if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && /\./.test(raw)) raw = "https://" + raw;   // "example.com/page" works too
  try { page = new URL(raw); if (!/^https?:$/.test(page.protocol)) throw 0; } catch (_) { urlMsg("That is not a web address. Paste the page's address, for example https://example.com/installer.", "small err"); return; }
  if (/\.fwsc$/i.test(page.pathname)) { await useUrl(page, ticket); return; }
  if (await knownSource(page, ticket) || !currentFileRequest(ticket)) return;
  if (page.hostname === "github.com" || page.hostname === "www.github.com") { await githubRepo(page, ticket); return; }
  urlMsg(`Reading ${page.host}…`);
  let text;
  try {
    const r = await fetch(page.href);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim());
    text = await r.text();
  } catch (e) { if (currentFileRequest(ticket)) urlMsg(e instanceof TypeError ? blocked : `Could not read that page: ${e.message}.`, "small err"); return; }
  if (!currentFileRequest(ticket)) return;
  const found = new Map();
  for (const m of text.replace(/\\\//g, "/").matchAll(FWSC)) {
    try { const u = new URL(m[0], page); if (/^https?:$/.test(u.protocol)) found.set(u.href, u); } catch (_) { /* not an address */ }
  }
  // drop what is not a file name (a bare ".fwsc" in a script) and what the site says does not exist
  for (const [k, u] of found) if ((u.pathname.split("/").pop() || "").length <= 5) found.delete(k);
  await Promise.all([...found].map(async ([k, u]) => {
    try { const r = await fetch(u.href, { method: "HEAD" }); if (r.status === 404 || r.status === 410) found.delete(k); } catch (_) { /* cannot tell: keep it */ }
  }));
  if (!currentFileRequest(ticket)) return;
  if (!found.size) { urlMsg(`No .fwsc files appear in that page's source. Pages that build their list with a separate script are not followed; download the file and drop it above.`, "small err"); return; }
  if (found.size === 1) { await useUrl([...found.values()][0], ticket); return; }
  showList([...found.values()], [], ticket);
  } finally { if (ticket === fileEpoch) { state.fileLoading = false; refresh(); } }
});

// ------------------------------------------------------ places we know ---
// M-VAVE's Workbench page does not allow other pages to read it, but the same Workbench is a download on their GitHub releases, and
// the Open firmware and the original V15 are inside it. Pasting the Workbench's address (or its repository's) leads there.
const ref = (href, text) => make("a", { href, textContent: text, target: "_blank", rel: "noopener" });
async function knownSource(page, ticket) {
  if (!currentFileRequest(ticket)) return true;
  const isWorkbench = /(^|\.)open\.m-vave\.com$/i.test(page.hostname) ||
    (/(^|\.)github\.com$/i.test(page.hostname) && /^\/m-vave\/fm1_open(\/|$)/i.test(page.pathname));
  if (isWorkbench) {
    let asset = null, tag = "";
    try {
      const rel = await (await fetch("https://api.github.com/repos/m-vave/fm1_open/releases/latest")).json();
      asset = (rel.assets || []).find((a) => /Workbench\.html$/i.test(a.name)); tag = rel.tag_name || "";
    } catch (_) { /* offline or rate limited: the releases page is still the place */ }
    if (!currentFileRequest(ticket)) return true;
    urlMsg("M-VAVE's Workbench page can't be read from here (their site doesn't allow it). The same Workbench is a download on their GitHub releases, and the Open firmware and the original V15 are inside it. Save the file, then drop it in the box above.");
    const link = Object.assign(ref(asset ? asset.browser_download_url : "https://github.com/m-vave/fm1_open/releases/latest", asset ? "Download" : "Open the releases"), { className: "dl" });
    $("url-results").replaceChildren(make("li", {},
      make("span", { className: "dname", textContent: asset ? asset.name : "FM1 Open Workbench" }),
      make("span", { className: "meta", textContent: asset ? `release ${tag}` : "the latest release" }), link));
    return true;
  }
  if (/(^|\.)m-vave\.com$/i.test(page.hostname) && /\/download/i.test(page.pathname)) {
    urlMsg("M-VAVE's download page can't be read from here. Download the FM-1 firmware (.fwsc) there, then drop it in the box above.");
    $("url-results").replaceChildren(make("li", {}, make("span", { className: "dname", textContent: "M-VAVE downloads" }), make("span", { className: "meta", textContent: "FM-1 firmware: the .fwsc link" }), Object.assign(ref("https://www.m-vave.com/download", "Open"), { className: "dl" })));
    return true;
  }
  return false;
}

// ------------------------------------------------------------ GitHub repos ---
// GitHub keeps build attestations (signed records of which workflow built a file from which commit) and looks them up by
// the file's SHA-256, per repo. -> { repo, ref, commit, workflow, builder } | null (none) | undefined (could not ask).
// This reports what GitHub says; the signature is not checked here, and anyone can attest a file in their own repo.
async function attestation(owner, repo, sha256) {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/attestations/sha256:${sha256}`);
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    for (const a of (await r.json()).attestations || []) {
      const st = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(a.bundle.dsseEnvelope.payload), (c) => c.charCodeAt(0))));
      if (!(st.subject || []).some((s) => (s.digest || {}).sha256 === sha256)) continue;
      const def = (st.predicate || {}).buildDefinition || {}, dep = (def.resolvedDependencies || [])[0] || {};
      const m = /github\.com\/([^@/]+\/[^@]+)@(.+)$/.exec(dep.uri || "");
      return { repo: m ? m[1] : `${owner}/${repo}`, ref: m ? m[2].replace(/^refs\/(tags|heads)\//, "") : "", commit: (dep.digest || {}).gitCommit || "",
        workflow: ((def.externalParameters || {}).workflow || {}).path || "", builder: (((st.predicate || {}).runDetails || {}).builder || {}).id || "" };
    }
    return null;
  } catch (_) { return undefined; }
}
const builtText = (a) => `built by GitHub Actions from ${a.repo}${a.ref ? " " + a.ref : ""}${a.commit ? ", commit " + a.commit.slice(0, 7) : ""}`;

async function provenance(pkg, source) {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//.exec(source);
  if (!m) return;
  const a = await attestation(m[1], m[2], pkg.sha256);
  if (state.pkg === pkg) { pkg.provenance = a; pkg.provenanceRepo = `${m[1]}/${m[2]}`; refresh(); }
}
// github.com's own pages cannot be read by other pages, but its API and raw file host can. A repo's committed .fwsc
// files (default branch and gh-pages) load directly. Release downloads cannot be read by a web page (GitHub redirects
// them to a host that does not allow it), so those are listed with a link to download them and drop them above.
// The API allows 60 anonymous requests an hour per address; a lookup uses about five.
async function githubRepo(page, ticket) {
  if (!currentFileRequest(ticket)) return;
  const [owner, repo] = page.pathname.split("/").filter(Boolean);
  if (!owner || !repo) { urlMsg("That GitHub address has no repository in it. Use https://github.com/owner/repo.", "small err"); return; }
  const api = async (path) => {
    if (!currentFileRequest(ticket)) throw new Error("Superseded lookup");
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, "")}${path}`);
    if (!currentFileRequest(ticket)) throw new Error("Superseded lookup");
    if (r.status === 403 || r.status === 429) throw new Error("GitHub's limit for anonymous lookups was reached; try again in an hour, or paste the address of a file in the repo");
    if (r.status === 404) throw new Error("no such repository, or it is private");
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim());
    return r.json();
  };
  urlMsg(`Reading ${owner}/${repo} on GitHub…`);
  try {
    const info = await api("");
    const branches = (await api("/branches?per_page=100")).map((b) => b.name);
    const want = [...new Set([info.default_branch, ...branches.filter((b) => b === "gh-pages")])];
    const found = new Map();                       // address -> URL, for files that can be loaded
    let truncated = false;
    for (const br of want) {
      const tree = await api(`/git/trees/${encodeURIComponent(br)}?recursive=1`);
      if (tree.truncated) truncated = true;
      for (const e of tree.tree) if (e.type === "blob" && /\.fwsc$/i.test(e.path)) {
        const u = new URL(`https://raw.githubusercontent.com/${owner}/${info.name}/${encodeURIComponent(br)}/${e.path.split("/").map(encodeURIComponent).join("/")}`);
        found.set(u.href, u);
      }
    }
    const loadable = new Set([...found.values()].map((u) => decodeURIComponent(u.pathname.split("/").pop()).toLowerCase()));
    const rel = (await api("/releases?per_page=30")).flatMap((r) => r.assets.filter((a) => /\.fwsc$/i.test(a.name)).map((a) => ({ name: a.name, tag: r.tag_name, href: a.browser_download_url })))
      .filter((a) => !loadable.has(a.name.toLowerCase()));
    const rows = (await api("/releases?per_page=30")).flatMap((r) => r.assets.filter((a) => /\.fwsc$/i.test(a.name)));
    const digests = new Map(rows.map((a) => [a.name, (a.digest || "").replace(/^sha256:/, "")]));
    await Promise.all(rel.slice(0, 10).map(async (a) => { const d = digests.get(a.name); if (d) { const b = await attestation(owner, info.name, d); if (b) a.built = builtText(b); else if (b === null) a.built = "no GitHub build record"; } }));
    if (!currentFileRequest(ticket)) return;
    if (!found.size && !rel.length) { urlMsg(`No .fwsc files in ${owner}/${repo}: not committed on ${want.join(" or ")}, and none attached to a release. Its firmware may need building from source, which this page cannot do.`, "small err"); return; }
    if (found.size === 1 && !rel.length) { await useUrl([...found.values()][0]); return; }
    showList([...found.values()], rel, ticket);
    if (truncated) urlMsg($("url-msg").textContent + " (GitHub cut the file list short for a very large repo.)");
  } catch (e) { if (currentFileRequest(ticket)) urlMsg(e instanceof TypeError ? blocked : `Could not read that repository: ${e.message}.`, "small err"); }
}

// the version in a file name: dotted numbers (v0.9.17) if there are any, else the last short number (FM-1+VA-102).
// Names with none sort last.
const versionOf = (u) => {
  const n = decodeURIComponent(u.pathname.split("/").pop());
  const dotted = n.match(/\d+(?:\.\d+)+/);
  if (dotted) return dotted[0].split(".").map(Number);
  const runs = n.match(/\d{1,4}(?![\da-f])/g);
  return runs ? [Number(runs[runs.length - 1])] : null;
};
const byVersion = (x, y) => {
  const a = versionOf(x), b = versionOf(y);
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
};
const byName = (x, y) => decodeURIComponent(x.pathname).localeCompare(decodeURIComponent(y.pathname), undefined, { numeric: true });

function showList(urls, downloadOnly = [], ticket = fileEpoch) {
  if (!currentFileRequest(ticket)) return;
  let listTicket = ticket;
  const sel = make("select", { id: "url-sort", ariaLabel: "Sort the files" },
    make("option", { value: "version", textContent: "Newest first, by the version in the name" }),
    make("option", { value: "name", textContent: "A to Z" }));
  const row = make("li", { className: "sortrow" }, sel);
  const only = downloadOnly.map((a) => make("li", {}, make("span", { className: "dname", textContent: a.name }),
    make("span", { className: "meta", textContent: `release ${a.tag}${a.built ? ": " + a.built : ""}. GitHub only lets you download this one yourself, then drop it in the box above` }),
    make("a", { href: a.href, target: "_blank", rel: "noopener", textContent: "Download", className: "dl" })));
  const draw = () => currentFileRequest(listTicket) && $("url-results").replaceChildren(row, ...[...urls].sort(sel.value === "name" ? byName : byVersion).map((u) => {
    const b = make("button", { className: "small", type: "button", textContent: "Use this file" });
    b.addEventListener("click", () => {
      if (!currentFileRequest(listTicket)) return;
      listTicket = ++fileEpoch;
      useUrl(u, listTicket);
    });
    return make("li", {}, make("span", { className: "dname", textContent: decodeURIComponent(u.pathname.split("/").pop()) }), make("span", { className: "meta", textContent: u.host + u.pathname.replace(/[^/]*$/, "") }), b);
  }), ...only);
  sel.addEventListener("change", draw);
  draw();
  urlMsg(urls.length ? `${urls.length + downloadOnly.length} firmware files found. Pick one:` : `${downloadOnly.length} firmware files found, none that a web page can read. Download one and drop it in the box above:`);
}
// The whole shared panel accepts files, including its heading and loaded-file sign.
const drop = $("st-file");
const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state.busy ? "none" : "copy";
  if (!state.busy) drop.classList.add("over");
});
drop.addEventListener("dragleave", (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => {
  drop.classList.remove("over");
  if (!carriesFiles(e)) return;
  e.preventDefault(); e.stopPropagation();
  const file = e.dataTransfer.files[0];
  if (file) pickFile(file);
});
// A missed drop must not navigate away or download the local file. Keep native
// file inputs elsewhere (backup, donor, official package) working normally.
for (const ev of ["dragover", "drop"]) document.addEventListener(ev, (e) => {
  if (!carriesFiles(e) || e.target instanceof HTMLInputElement && e.target.type === "file" && !e.target.disabled) return;
  e.preventDefault();
  if (ev === "drop") {
    drop.classList.remove("over");
    if (!state.busy) {
      $("file-msg").className = "small err";
      $("file-msg").textContent = "Drop firmware in the Firmware file panel, or click its file picker. Your selection has not changed.";
    }
  }
});
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

let scanAgain = false, portRevision = 0, portSnapshot = "", portTimer;
// Opening a port also fires statechange; only availability/identity changes need another scan.
function portSignature() {
  return JSON.stringify([state.access.inputs, state.access.outputs].map((ports) =>
    [...ports].filter(([, p]) => p.state !== "disconnected").map(([key, p]) => [key, p.id, p.name]).sort()));
}
function portsChanged() {
  const signature = portSignature();
  if (signature === portSnapshot) return;
  portSnapshot = signature; portRevision++;
  if (state.busy) return; // The installer owns MIDI while writing and rescans afterwards.
  state.devices = []; state.tried.clear(); scanAgain = true;
  $("scan-status").textContent = "MIDI ports changed. Checking again…";
  renderDevices(); refresh();
  clearTimeout(portTimer);
  if (!state.scanning) portTimer = setTimeout(scan, 150);
}

async function connect() {
  if (state.busy || state.fileLoading || !state.pkg) return;
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
  portSnapshot = portSignature();
  state.access.onstatechange = portsChanged;
  $("connect-row").hidden = true;
  $("st-dev").hidden = false;
  await scan();
}

async function scan() {
  if (!state.up || state.busy) return;
  if (state.scanning) { scanAgain = true; return; }
  clearTimeout(portTimer);
  do {
    scanAgain = false; state.scanning = true;
    const revision = portRevision;
    state.devices = []; state.tried.clear();
    $("scan-status").className = "small";
    $("scan-status").textContent = "Checking available MIDI ports for an FM-1…";
    renderDevices(); refresh();
    try {
      const found = await state.up.scan();
      if (revision !== portRevision) { scanAgain = true; continue; }
      const ports = state.up.ports();
      state.devices = found.filter((d) => ports.includes(d.name)).map((d) => ({ ...d, manual: state.up.allowed.has(d.name) }));
      if (!state.devices.some((d) => d.name === state.selected)) state.selected = state.devices[0]?.name ?? null;
      for (const name of ports) if (state.up.isKnown(name) && !state.devices.some((d) => d.name === name)) state.tried.set(name, "No FM-1 reply this scan");
      $("scan-status").textContent = `Checked at ${new Date().toLocaleTimeString()}: ${ports.length} available MIDI input/output ${ports.length === 1 ? "pair" : "pairs"}; ${state.devices.length} ${state.devices.length === 1 ? "device replied" : "devices replied"}.`;
    } catch (e) {
      $("scan-status").className = "small err";
      $("scan-status").textContent = `Could not finish checking MIDI ports: ${e.message}. Press Refresh devices to try again.`;
    } finally { state.scanning = false; renderDevices(); refresh(); }
  } while (scanAgain && !state.busy);
}

function renderDevices() {
  const list = $("device-list");
  list.replaceChildren();
  for (const d of state.devices) {
    const r = make("input", { type: "radio", name: "dev", checked: d.name === state.selected, ariaLabel: d.name });
    r.addEventListener("change", () => { state.selected = d.name; state.refusedStartup = false; state.events = []; state.frozen = null; $("after").hidden = true; $("backup").checked = false; refresh(); });
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
  $("none").hidden = state.scanning || scanAgain || state.devices.length > 0;

  // Available input/output pairs are candidates, not proof of an attached FM-1.
  const rows = state.up.ports().filter((n) => !state.devices.some((d) => d.name === n)).map((n) => {
    const answered = state.tried.get(n);
    const b = make("button", { className: "small", textContent: answered ? "Check again" : "Check this port", disabled: state.scanning || scanAgain || state.busy });
    b.addEventListener("click", () => tryPort(n, b));
    const note = answered || (state.up.isKnown(n)
      ? state.scanning || scanAgain ? "Checking for an FM-1 reply…" : "Not checked; refresh devices"
      : "Available MIDI port · not checked for an FM-1");
    return make("li", {}, make("span", { className: "dname", textContent: n }), make("span", { className: "meta", textContent: note }), b);
  });
  $("ports").replaceChildren(...rows);
  $("ports-empty").hidden = rows.length > 0;
}

// the user says this port is the FM-1: only then is it sent anything
async function tryPort(name, button) {
  if (state.busy || state.scanning || scanAgain) return;
  button.disabled = true;
  state.up.allow(name);
  state.selected = name;
  await scan();
}

// Recheck when returning to the page, without requesting permission again.
window.addEventListener("focus", () => {
  if (state.access && !state.busy && !document.hidden) scan();
});
document.addEventListener("visibilitychange", () => {
  if (state.access && !state.busy && !document.hidden) scan();
});

// ------------------------------------------------------------- boot mode ---
// A FM-1 whose firmware does not start falls back to the chip's ROM boot mode (WL80UBOOT, USB vendor 4C4A): not a MIDI
// device, so Web MIDI never sees it; WebUSB can list it (nothing is opened or sent).
if (navigator.usb) $("boot-help").hidden = false;
$("boot-check").addEventListener("click", async () => {
  const box = $("boot-msg");
  box.replaceChildren();
  let dev = null;
  try { dev = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x4C4A }] }); } catch (e) { log(`usb: ${e.name}`); }
  const link = (href, text) => make("a", { href, textContent: text, rel: "noopener", target: href.startsWith("#") ? "_self" : "_blank" });
  if (!dev) box.append(make("p", { className: "small", textContent: "No USB recovery device was chosen. If the picker was empty, check power and use a USB data cable straight into the computer. This alone does not tell us why MIDI is missing." }));
  else box.append(
    make("p", { className: "warn", textContent: `Selected JieLi USB device: ${dev.productName || "unknown name"}, ${dev.vendorId.toString(16)}:${dev.productId.toString(16)}. ${dev.productId === 0x8057 ? "This ID is used by the FM-1's ROM download mode; it is not a MIDI update port." : "This product ID is not the expected FM-1 ROM download ID (8057)."} USB identification alone does not prove which model is attached or why it entered this mode.` }),
    make("p", {}, "This page cannot flash through ROM download mode. For an FM-1 in that mode, use ",
      link("https://github.com/jvitkauskas/m-flasher", "M-Flasher"), " for a full backup and recovery. ",
      link("#desktop-recovery", "See the recovery routes and alternatives"), ".")
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

// ------------------------------------------------------------- area wipe ---
// The package this page writes for an area wipe: the official loader, V15's startup code, the chosen firmware's app area
// and erased flash (0xFF) up to WIPE_END. The format is the one of Baudgirl's releases (V15 with another flash.bin), which
// rebuild() reproduces byte for byte.
async function wipePackage(pkg) {
  const stock = state.stock;
  const raw = rebuild(stock.image, wipeFlash(stock, pkg), pkg.product);
  const built = await inspect(raw);
  return built;
}

$("stock-open").addEventListener("click", () => { $("sdlg-main").textContent = state.pkg ? state.pkg.name : ""; $("sdlg-msg").hidden = true; $("stock-dialog").showModal(); });
$("sdlg-close").addEventListener("click", () => $("stock-dialog").close());
$("stockfile").addEventListener("change", async () => {
  const f = $("stockfile").files[0], msg = $("sdlg-msg");
  if (!f) return;
  try {
    const d = await inspect(await f.arrayBuffer());
    if (d.kind === "stock" || d.kind === "mvave") { d.name = f.name; state.stock = d; $("stock-dialog").close(); }
    else { msg.textContent = `${f.name} is not the official V15 package (its hash is not V15's).`; msg.className = "small err"; msg.hidden = false; }
  } catch (e) { msg.textContent = `${f.name}: ${e.message}`; msg.className = "small err"; msg.hidden = false; }
  refresh();
});
$("wipe").addEventListener("change", refresh);
$("bootl").addEventListener("change", refresh);
$("backup").addEventListener("change", refresh);

function refresh() {
  updateTabs(state.busy);
  const dev = selectedDevice(), pkg = state.pkg;
  const resume = dev && IS_OTA(dev.id);
  const model = dev && (resume ? dev.id.model.replace(/^ota-/i, "") : dev.id.model);
  let why = "";
  if (state.scanning || scanAgain) why = "Checking the current MIDI devices.";
  else if (state.fileLoading) why = "Reading the firmware file.";
  else if (!pkg) why = "Choose firmware in the shared Firmware file panel.";
  else if (!state.access) why = "Waiting for your FM-1: press Connect above.";
  else if (!dev) why = "Waiting for an FM-1 to be selected above.";
  else if (model !== pkg.model) why = `The device is ${dev.id.text}, the package is for ${pkg.product}.`;
  else if (unverified(pkg) && !$("trust").checked) why = "Confirm the box above to install a package of unknown origin.";
  $("go").textContent = resume ? "Finish update" : "Install";
  $("install-row").hidden = !!why || state.busy || state.done || (wipeOn() && !state.stock) || (!resume && !$("backup").checked);
  const canWipe = !!pkg && !!dev && !resume && !why && !state.busy && !state.done && pkg.flashLen <= WIPE_END && pkg.flashOff === 0x400;
  $("wipe-row").hidden = !canWipe;
  const canOpts = !!pkg && !!dev && !resume && !why && !state.busy && !state.done;
  $("backup-row").hidden = !canOpts;
  $("boot-row").hidden = !(canOpts && pkg.loader === "app");   // M-VAVE's own firmware has no installer for it
  if (canWipe) {
    $("wipe-info").textContent = state.stock
      ? `Writes ${pkg.product} and erases the remaining space below ${hex(WIPE_END)}. Saved data in that range is lost. This is not a complete settings or Bluetooth reset: V16's settings and stock V15/V16 Bluetooth pairings are beyond it. The template's startup code is also written. Using ${state.stock.name || "the template package"}.`
      : "Needs the official V15 package: M-VAVE's loader and the startup code it writes come from it.";
    $("wipe-pick").hidden = !!state.stock;
  }
  $("rescan").disabled = state.busy || state.scanning || scanAgain || !state.up;
  $("rescan").textContent = state.scanning || scanAgain ? "Checking devices…" : "Refresh devices";
  $("connect-row").hidden = !!state.access;
  $("firmware-inputs").disabled = state.busy;
  $("file").disabled = state.busy;
  $("connect").disabled = !pkg || state.fileLoading || state.busy;
  $("connect-hint").textContent = state.fileLoading ? "Wait for the firmware file to finish loading." : !pkg ? "Load a firmware file first." : "Next: this page checks the FM-1 against the file.";
  $("firmware-loaded").hidden = !pkg;
  $("fileinfo").hidden = $("analysis-fileinfo").hidden = !pkg;
  $("flash-selection").textContent = pkg ? `Selected firmware: ${pkg.name} · ${pkg.product}` : "Choose firmware in the shared Firmware file panel to begin.";

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
  $("restore-go").disabled = state.busy || state.scanning || scanAgain || state.fileLoading || !src || !$("risk").checked;

  $("st-file").dataset.state = pkg ? "done" : "now";
  $("st-dev").dataset.state = dev ? "done" : pkg ? "now" : "";
  updateFlashView({ pkg, wipe: !resume && wipeOn(), boot: !resume && bootOn() && pkg?.loader === "app", stock: state.stock });
  renderRoute();
}

// m-bootloader's installer package (vendored, fm1-base's web/m-bootloader): its hash must be the recorded one and it must carry
// m-bootloader's identity, FM-1_099; it has no flash.bin: the running firmware stages its writer, which rewrites the boot area
async function bootPackage() {
  const base = new URL("../vendor/fm1-base/", import.meta.url);
  const raw = new Uint8Array(await (await fetch(new URL("m-bootloader/fm1-uboot-1.2.fwsc", base))).arrayBuffer());
  const pin = (await (await fetch(new URL("SOURCE", base))).text()).split("\n").find((l) => l.startsWith("web/m-bootloader/fm1-uboot-1.2.fwsc "));
  const got = await sha256hex(raw);
  if (!pin || pin.split(" ")[1] !== got || productOf(raw) !== "FM-1_099") throw new Error("the bundled m-bootloader package is not the recorded one");
  return logicalImage(raw);
}

async function install(startup = null) {
  const dev = selectedDevice(), pkg = state.pkg;
  if (!dev || !pkg || state.busy || state.scanning || scanAgain || state.fileLoading) return;
  const resume = IS_OTA(dev.id);
  state.frozen = devChecks(dev, pkg);
  state.busy = true; state.refusedStartup = false; state.events = []; refresh();
  const up = new Updater(state.access, log);
  up.setPatterns(state.up.patterns);
  up.select(dev.name);
  for (const d of state.devices) up.allow(d.name);
  let sent = pkg;
  if (!resume && wipeOn() && state.stock) {
    sent = await wipePackage(pkg);
    log(`wipe package: ${sent.product}, flash.bin ${hex(sent.flashLen)}, ${sent.image.length} bytes`);
  }
  const total = Math.max(1, Math.round(sent.image.length / 512));
  let pct = 0;
  const to = (p, text) => { pct = p; progress(p, text ?? `Writing ${Math.round(p)}%`); };
  let reads = 0, wrote = false;
  const step = (k, a) => {
    log(`${k} ${a ?? ""}`);
    if (k === "start") note("info", "STARTED", "Update started", `Asked ${a} to start an update.` + (sent !== pkg ? ` Application/data wipe: the package written covers flash up to ${hex(WIPE_END)}.` : ""));
    if (k === "verify") reads = a;
    if (k === "loader") note("go", "ACCEPTED", "Step 1: accepted", `${dev.id.text} read ${reads} parts of the package, found nothing to refuse, and restarted into the update loader.`);
    if (k === "write" && !wrote) { wrote = true; note("info", "WRITING", "Update loader running", "Writing the package to the FM-1. Do not unplug it."); }
    if (k === "reboot") note("go", "WRITTEN", "Written", "The package is on the FM-1. Waiting for it to restart.");
    if (k === "done") note("go", "DONE", "Running the new firmware", `${a}.`);
    if (k === "bootstart") note("info", "BOOT", "Installing m-bootloader", "The firmware is installed. It now stages m-bootloader's installer and restarts into it.");
    if (k === "bootwrite") note("info", "WRITING", "m-bootloader", "Writing the boot area. The FM-1 restarts by itself.");
    if (k === "bootdone") note("go", "DONE", "m-bootloader installed", `The FM-1 runs ${a}. Hold PLAY while switching on for the recovery menu, REC for update mode.`);
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
      const id = await up.install(sent.image, pkg.product, step, { sha256: sent.sha256, startup });
      say(`Done: the FM-1 runs ${id}.`, "ok");
      if (bootOn() && pkg.loader === "app") {
        try {
          say("Installing m-bootloader. The FM-1 restarts by itself.");
          const bid = await up.installBoot(await bootPackage(), pkg.product, step);
          say(`Done: the FM-1 runs ${bid}, with m-bootloader.`, "ok");
        } catch (be) {
          log(String(be && be.stack || be));
          if (be.code !== "bootrefused" && be.code !== "lost" && be.code !== "noreturn") throw be;
          note("barrier", "REFUSED", "m-bootloader", be.code === "bootrefused" ? `${pkg.product} is installed, but m-bootloader could not be: nothing else was changed.` : be.message);
          say(`Done: the FM-1 runs ${id}. m-bootloader was not installed.`, "ok");
        }
      }
    }
  } catch (e) {
    log(String(e && e.stack || e));
    const refusal = stepOneRefusal(e, pkg);
    state.refusedStartup = !startup && e.served === 4 && pkg.loader === "official" && !!refusal;
    if (e.code === "open") note("barrier", "REFUSED", "M-VAVE's Open firmware", `${e.message} Nothing was sent.`);
    if (refusal) note("barrier", "REFUSED", "Step 1: refused by the FM-1's firmware", refusal);
    else if (e.code === "stopped" && e.step === 1) note("barrier", "REFUSED", "Step 1: stopped by the FM-1's firmware", `${e.from.text} stopped after reading ${e.served} parts of the package, and nothing was written. Which check stopped it is not known for this firmware.`);
    say(e.code === "open" ? e.message : e.code === "mismatch" ? `Written, but the FM-1 reports ${e.detail}, not ${pkg.product}.` : ((refusal || (e.code === "stopped" && e.step === 1)) ? "Stopped: the FM-1's firmware refused the package. Nothing was written. Details on the route above." : (MESSAGES[e.code] || `Error: ${e.message}`)), "err");
    state.frozen = null;
    progress(null);
  }
  state.busy = false;
  progress(null);
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

if ($("ver-page").textContent !== VERSION) {
  $("ver-script").textContent = ` — but its script is ${VERSION}: an old copy is cached. Reload with Cmd/Ctrl+Shift+R.`;
  $("ver-script").className = "warn";
}
