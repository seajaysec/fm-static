// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Chris Farrell
//
// The update protocol is fm1-base's (vendor/fm1-base/fm1ota.js, MPL-2.0, copied unmodified: see vendor/fm1-base/PIN).
// This file adds what that one does not do, without copying any of its internals:
//   - finding the FM-1 under any port name: the page asks the ports it is allowed to ask (usual FM-1 names, ports the
//     user picked, ports that appeared during an update), whatever they are called
//   - following the ports as the FM-1 restarts into its update loader and back (the loader's USB id differs, and macOS
//     can keep an earlier name for it)
//   - an optional answer for step 1's comparison of the startup code (the restore step)
//   - what step 1 did when it stopped, so the page can say which check refused
// fm1-base's find() only probes ports whose name looks like an FM-1's. To let it probe the ports we choose, it is given a
// view of the MIDI ports that holds only those, under a name its own test accepts.
import { Updater as Base } from "../vendor/fm1-base/fm1ota.js?v=2026-10-25.24";

export const IS_OTA = (id) => /^ota-/i.test(id.model);
// port names probed without asking (substrings, any case); any other port only after the user picks it
export const PRESET_PORTS = ["FM-1", "Felucca", "OTA", "Composite", "SINCO", "USB-MIDI"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFIX = "FM-1 ";   // makes a port name pass fm1-base's own test; removed again from what we return

// errors carry a code the page translates (the same codes as fm1-base's): notfound, model, stopped, noloader, lost,
// noreturn, mismatch (detail: the identity the device reports), badreq, open, bootrefused
function fail(code, msg, detail = "") { const e = new Error(msg); e.code = code; e.detail = detail; return e; }

const live = (m) => [...m.values()].filter((p) => p.state !== "disconnected");
const named = (p) => new Proxy(p, {
  get(t, k) { if (k === "name") return PREFIX + (t.name || ""); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; },
  set(t, k, v) { t[k] = v; return true; },
});

export class Updater extends Base {
  constructor(access, log) {
    super(access, log);
    this.allowed = new Set();               // ports the user chose although their names are none of the usual ones
    this.patterns = PRESET_PORTS.slice();   // the user's own names can be added (see setPatterns)
    this.target = null;                     // the port picked for the first contact (several FM-1s may be connected)
    this.baseline = null;                   // the ports before an update started (see watch())
    this.startup = null;                    // { at, bytes }: the answer to step 1's startup-code comparison
    this.step1 = null; this.step1From = null; this.last = null;
  }

  inputNames() {
    return [...new Set(live(this.access.inputs).map((i) => i.name || ""))];
  }
  allow(name) { this.allowed.add(name); }
  setPatterns(list) { this.patterns = list.map((x) => String(x).trim()).filter(Boolean); }
  isKnown(name) {
    const n = (name || "").toLowerCase();
    return this.patterns.some((p) => n.includes(p.toLowerCase())) || this.allowed.has(name);
  }
  select(name) { this.target = name; if (name) this.allow(name); }

  // every MIDI port that has both an input and an output of the same name
  ports() {
    const outs = new Set(live(this.access.outputs).map((o) => o.name));
    return this.inputNames().filter((n) => outs.has(n));
  }

  // remember the ports now: the port name can change when the device restarts (the loader has another USB product id,
  // and macOS names a port from its own cache keyed by vendor/product id and USB location). After this, a port that
  // is new also counts.
  watch() { this.baseline = new Set(this.inputNames()); }

  // the MIDI ports fm1-base's find() may look at: the ones accept(name) allows, in and out of the same name
  view(accept) {
    const outs = live(this.access.outputs);
    const outNames = new Set(outs.map((o) => o.name));
    const ins = live(this.access.inputs).filter((i) => outNames.has(i.name) && accept(i.name));
    const names = new Set(ins.map((i) => i.name));
    return {
      inputs: new Map(ins.map((p, k) => [k, named(p)])),
      outputs: new Map(outs.filter((o) => names.has(o.name)).map((p, k) => [k, named(p)])),
    };
  }

  // every in/out pair with the same port name that answers the handshake (fm1-base's find, on the ports we allow)
  async find(filter) {
    const accept = (name) => {
      const known = this.isKnown(name);
      const fresh = this.baseline && !this.baseline.has(name || "");
      if (!known && !fresh) return false;                               // never probe other gear
      if (!this.baseline && this.target && name !== this.target) return false;
      return true;
    };
    const self = Object.create(this);
    self.access = this.view(accept);
    const dev = await Base.prototype.find.call(self, filter);
    if (dev) { dev.name = dev.name.slice(PREFIX.length); this.last = dev.id; }
    return dev;
  }

  // ask one port who it is (the FM-1's identity query; harmless to other gear but sent only on request)
  async probe(name) {
    const self = Object.create(this);
    self.access = this.view((n) => n === name);
    const dev = await Base.prototype.find.call(self, null);
    if (!dev) return null;
    dev.link.close();
    return { name, id: dev.id };
  }

  // probe the ports with a usual FM-1 name; -> [{ name, id }]
  async scan() {
    const found = [];
    for (const name of this.ports()) {
      if (!this.isKnown(name)) continue;
      const d = await this.probe(name);
      if (d) found.push(d);
    }
    return found;
  }

  // step 1 (the running firmware reads the package, finish address 0xE0000000) is where an answer can be substituted,
  // and what it did is kept
  async serve(link, image, finishAddr, idleMs, onProgress) {
    let img = image;
    if (finishAddr === 0xE0000000 && this.startup) { img = image.slice(); img.set(this.startup.bytes, this.startup.at); }
    const r = await super.serve(link, img, finishAddr, idleMs, onProgress);
    if (finishAddr === 0xE0000000) { this.step1 = r; this.step1From = this.last; }
    return r;
  }

  // opts: { sha256 (of the package file: M-VAVE's Open firmware is told it), startup ({ at, bytes }: the restore step) }
  async install(image, product, onStep, opts = {}) {
    const step = onStep || (() => {});
    this.step1 = null; this.step1From = null;
    this.startup = opts.startup || null;
    try {
      return await super.install(image, product, (k, ...a) => { if (k === "start") this.watch(); step(k, ...a); }, opts.sha256);
    } catch (e) {
      // the firmware stopped reading in step 1: say after how many requests, and which firmware it was
      if (e.code === "stopped" && this.step1 && !this.step1.finished) Object.assign(e, { step: 1, served: this.step1.served, from: this.step1From });
      throw e;
    } finally { this.startup = null; }
  }

  // resume: the device is already in update mode (loader) -> true when the write finished; with the product, the FM-1 must
  // come back running it
  async resume(image, onStep, product = null) {
    const step = onStep || (() => {});
    const model = product && product.split("_")[0];
    const ota = await this.find((id) => (model ? id.model === "ota-" + model : IS_OTA(id)));
    if (!ota) return false;
    this.watch();   // the restarted device may come back under another port name
    const s = await this.write(ota, image, step);
    if (!s.finished) return false;
    if (product) {
      step("reboot");
      await sleep(3000);
      const back = await this.waitFor((id) => id.model === model, 40000);
      if (!back) throw fail("noreturn", "The FM-1 did not return after resuming the write.");
      back.link.close();
      if (back.id.text !== product) throw fail("mismatch", "The FM-1 reports a different firmware after resuming.", back.id.text);
      step("done", back.id.text);
    }
    return true;
  }
}
