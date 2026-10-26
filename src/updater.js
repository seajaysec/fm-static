// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
//
// The update protocol is fm1-base's (vendor/fm1-base/fm1ota.js, MPL-2.0, copied unmodified: see vendor/fm1-base/SOURCE).
// This file adds what that one does not do, without copying any of its internals:
//   - finding the FM-1 under any port name: the page asks the ports it is allowed to ask (usual FM-1 names, ports the
//     user picked, ports that appeared during an update), whatever they are called
//   - following the ports as the FM-1 restarts into its update loader and back (the loader's USB id differs, and macOS
//     can keep an earlier name for it)
//   - an optional answer for step 1's comparison of the startup code (the restore step)
//   - what step 1 did when it stopped, so the page can say which check refused
// fm1-base's find() only probes ports whose name looks like an FM-1's. To let it probe the ports we choose, it is given a
// view of the MIDI ports that holds only those, under a name its own test accepts.
import { Updater as Base, unpack7 } from "../vendor/fm1-base/fm1ota.js?v=2026-10-26.19";

export const IS_OTA = (id) => /^ota-/i.test(id.model);
// port names probed without asking (substrings, any case); any other port only after the user picks it
// ("FM1": M-VAVE's Open firmware names its port "FM1 Community")
export const PRESET_PORTS = ["FM-1", "FM1", "Felucca", "OTA", "Composite", "SINCO", "USB-MIDI"];
// M-VAVE's own Open firmware reports FM-1_80000NN (V14: FM-1_8000014), which fm1-base's test for an Open firmware ("FM1_OFFICIAL_OPEN",
// "FM1_COMMUNITY_n") does not match, so its arming step would be skipped and the firmware's updater would refuse. M-VAVE's own
// Workbench treats FM-1_8NNNNNN as open too; community builds in that range with more digits (FM-1_8000100) are left alone.
const MVAVE_OPEN = /^FM-1_80000\d\d$/;
const tagOpen = (id) => { if (id && MVAVE_OPEN.test(id.text)) id.open = true; return id; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFIX = "FM-1 ";   // makes a port name pass fm1-base's own test; removed again from what we return

// errors carry a code the page translates (the same codes as fm1-base's): notfound, model, stopped, noloader, lost,
// noreturn, mismatch (detail: the identity the device reports), badreq, open, bootrefused
function fail(code, msg, detail = "") { const e = new Error(msg); e.code = code; e.detail = detail; return e; }

// M-VAVE's Open firmware restarts into an update loader that names itself "ota-FM1C_" and a build id in hex ("ota-FM1C_d017fb65e70aca97"):
// fm1-base reads an identity as a name, "_" and digits, so it never sees this loader. The loader otherwise speaks the same protocol, so
// when fm1-base finds nothing the allowed ports are asked here, with a link of the same shape as fm1-base's (which it does not export).
const HS_QUERY = [0xF0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7F, 0xF7];
class Link {
  constructor(input, output) {
    this.input = input; this.output = output; this.q = []; this.waiter = null;
    input.onmidimessage = (ev) => {
      if (ev.data[0] !== 0xF0) return;
      this.q.push(Array.from(ev.data));
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
    };
  }
  get lost() { return this.input.state === "disconnected" || this.output.state === "disconnected"; }
  send(bytes) { try { this.output.send(bytes); return true; } catch (_) { return false; } }
  drain() { this.q.length = 0; }
  async read(ms) {
    if (!this.q.length) {
      let tm;
      await Promise.race([new Promise((r) => { this.waiter = r; }), new Promise((r) => { tm = setTimeout(r, ms); })]);
      clearTimeout(tm); this.waiter = null;
    }
    return this.q.shift() || null;
  }
  close() { this.input.onmidimessage = null; }
}
const openLoaderId = (pkt) => {
  const d = unpack7(pkt.slice(1, -1));
  if (d.length !== 34 || d[0] !== 0 || d[1] !== 0x59 || d[2] !== 0x11) return null;
  const text = String.fromCharCode(...d.slice(6, 33)).replace(/\0+$/, "");
  return /^ota-FM1C_[0-9a-f]+$/.test(text) ? { text, model: "ota-FM1C", version: 0, open: true } : null;
};

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
    this.step1 = null; this.step1From = null; this.last = null; this.lastPort = null;
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

  // A reboot may change the port name. Start the next pass only on the port
  // that actually returned the expected identity, not any other known FM-1.
  pinVerified(product) {
    if (!this.lastPort || this.last?.text !== product) throw fail("notfound", "The verified firmware port is no longer known. Refresh devices before continuing.");
    this.select(this.lastPort);
    this.baseline = null;
  }

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
    const dev = await Base.prototype.find.call(self, filter) || await this.findOpenLoader(accept, filter);
    if (dev && dev.name.startsWith(PREFIX)) dev.name = dev.name.slice(PREFIX.length);
    if (dev) { this.last = tagOpen(dev.id); this.lastPort = dev.name; }
    return dev;
  }

  // M-VAVE's Open firmware's update loader (see above): the same handshake, an identity fm1-base does not read
  async findOpenLoader(accept, filter) {
    const view = this.view(accept), outs = [...view.outputs.values()];
    for (const input of view.inputs.values()) {
      const output = outs.find((o) => o.name === input.name);
      if (!output) continue;
      try { await input.open(); await output.open(); } catch (_) { continue; }
      const link = new Link(input, output);
      for (let k = 0; k < 2; k++) {
        link.drain();
        if (!link.send(HS_QUERY)) break;
        const end = Date.now() + 1000;
        while (Date.now() < end) {
          const pkt = await link.read(end - Date.now());
          if (!pkt) break;
          const id = openLoaderId(pkt);
          if (id && (!filter || filter(id))) return { link, id, name: input.name.slice(PREFIX.length) };
        }
      }
      link.close();
    }
    return null;
  }

  // ask one port who it is (the FM-1's identity query; harmless to other gear but sent only on request)
  async probe(name) {
    const self = Object.create(this);
    self.access = this.view((n) => n === name);
    const dev = await Base.prototype.find.call(self, null);
    if (!dev) return null;
    dev.link.close();
    return { name, id: tagOpen(dev.id) };
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
