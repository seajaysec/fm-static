// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
// Copyright (C) 2026 Chris Farrell (modifications)
//
// From Felucca's web/fm1pkg.js (https://github.com/hugelton/Felucca).
// Modified 2026-10-06 by Chris Farrell for fm-static: reduced to reading a package
// (identity, CRC check, origin hint, logical image); the package building code is removed.
// Added 2026-10-25 (Chris Farrell, own code, from reading packages): rebuild(), a package with the same parts as a template
// package and another flash.bin.
// Modified 2026-10-24: the package's update parts (which loader, flash.bin's size and place, its startup code, whether
// that is official V15's).
//
// Reading an FM-1 .fwsc in the browser: its identity, an integrity check, and the image the
// device addresses during an update. Nothing is modified.

const BLOCKS = 20, BLK = 0x30, KEEP = 0x2F;
export const STOCK_V15_SHA256 = "db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a";
const LOADER_MARK = new TextEncoder().encode("FELUCCA-LOADER-1");

const T = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
  T[i] = c & 0xFFFF;
}
export function crc16(d, crc = 0) {
  for (let i = 0; i < d.length; i++) crc = ((crc << 8) & 0xFFFF) ^ T[((crc >> 8) ^ d[i]) & 0xFF];
  return crc;
}
function enc(buf, off, size, key = 0xFFFF) {
  for (let i = 0; i < size; i++) {
    buf[off + i] ^= key & 0xFF;
    key = ((key * 2) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xFFFF;
  }
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// the package identity ("FM-1_904"): one marker byte after each of the first 20 blocks
export function productOf(fwsc) {
  if (fwsc.length < BLOCKS * BLK) throw new Error("not an FM-1 package (too short)");
  let s = "";
  for (let i = 0; i < BLOCKS; i++) {
    const m = fwsc[i * BLK + KEEP];
    if (m !== 0x7D) s += String.fromCharCode((m - i - 1) & 0xFF);
  }
  return s;
}

// the image the device addresses during an update: the .fwsc without the 20 marker bytes
export function logicalImage(fwsc) {
  const out = new Uint8Array(fwsc.length - BLOCKS);
  for (let i = 0; i < BLOCKS; i++) out.set(fwsc.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
  out.set(fwsc.subarray(BLOCKS * BLK), BLOCKS * KEEP);
  return out;
}

// UFW header, entry list and flash.bin CRCs: catches a damaged or wrong file before anything is sent
export function checkIntegrity(raw) {
  const h = new Uint8Array(BLOCKS * KEEP);
  for (let i = 0; i < BLOCKS; i++) h.set(raw.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
  enc(h, 0, 0x40);
  const nent = u16(h, 8), hsize = 0x40 + nent * 0x50;
  if (crc16(h.subarray(2, 0x40)) !== u16(h, 0)) throw new Error("not an FM-1 .fwsc (header CRC mismatch)");
  if (hsize > h.length || crc16(h.subarray(0x40, hsize)) !== u16(h, 2)) throw new Error("the package's entry list is damaged");
  const skew = BLOCKS * BLK - h.length;
  for (let off = 0x40; off < hsize; off += 0x50) {
    const e = h.slice(off, off + 0x50);
    enc(e, 0, 0x50);
    if (u16(e, 0) !== 0) continue;                     // flash.bin
    const at = u32(e, 8) + skew, size = u32(e, 12);
    if (at + size > raw.length || crc16(raw.subarray(at, at + size)) !== u16(e, 4)) throw new Error("flash.bin CRC mismatch: the file is damaged");
    return;
  }
  throw new Error("no flash.bin in the package");
}

// The update parts of a package, as the running firmware sees them in step 1: flash.bin (the head [0, 0x4000), the
// SPL and isd_config, then the app area) and ota.bin (the update loader the firmware stages). Taken from the logical
// image, where the UFW entry offsets point.
export const STOCK_HEAD_SHA256 = "d9f43191777656de01c7bed4f9e9ba2e34e94832c5d2ed02c3fc7ab7a6d9bd67";   // official V15's
export const APP_END = 0x93000;   // flash.bin's size in official V15: the head and the app area
const HEAD_LEN = 0x4000;

function entries(lg) {
  const h = lg.slice(0, 0x400);
  enc(h, 0, 0x40);
  const out = {};
  for (let i = 0, n = u16(h, 8); i < n; i++) {
    const e = h.slice(0x40 + i * 0x50, 0x90 + i * 0x50);
    enc(e, 0, 0x50);
    out[u16(e, 0)] = { off: u32(e, 8), len: u32(e, 12) };   // 0 flash.bin, 100 ota.bin
  }
  return out;
}

// loader: "official" (M-VAVE's: it rewrites the whole flash.bin, head included), "app" (an app-area-only loader, as
// Felucca's: it never writes the head), or "unknown". The tests are the ones a running Felucca-based firmware applies
// in step 1 (known CRCs; the loader marker in its first LZ4 literals).
async function parts(lg) {
  const e = entries(lg), fl = e[0], ota = e[100];
  let loader = "unknown";
  if (ota && ota.off + 0x88 <= lg.length) {
    const b = lg.subarray(ota.off, ota.off + 0x88);
    if (u16(b, 0) === 0xEBAA && u16(b, 2) === 0x5881 && u32(b, 8) === 0x4DE1) loader = "official";
    else if (hasMark(b.subarray(0x48))) loader = "app";
  }
  const head = fl && fl.off + HEAD_LEN <= lg.length ? await sha256hex(lg.subarray(fl.off, fl.off + HEAD_LEN)) : "";
  const flashOff = fl ? fl.off : 0;
  // the startup code as this package carries it: the bytes a running firmware compares in step 1
  const startup = flashOff && flashOff + HEAD_LEN <= lg.length ? lg.slice(flashOff, flashOff + HEAD_LEN) : null;
  return { loader, flashLen: fl ? fl.len : 0, flashOff, startup, stockHead: head === STOCK_HEAD_SHA256 };
}

export async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hasMark(raw) {
  outer: for (let i = 0; i + LOADER_MARK.length <= raw.length; i++) {
    if (raw[i] !== LOADER_MARK[0]) continue;
    for (let k = 1; k < LOADER_MARK.length; k++) if (raw[i + k] !== LOADER_MARK[k]) continue outer;
    return true;
  }
  return false;
}

// -> { product, model, size, sha256, kind: "stock" | "felucca" | "other", loader, flashLen, stockHead, image };
// throws on a bad file
export async function inspect(bytes) {
  const raw = new Uint8Array(bytes);
  const product = productOf(raw);
  const m = /^([^_]+)_(\d+)$/.exec(product);
  if (!m) throw new Error(`not an FM-1 package (identity ${JSON.stringify(product)})`);
  checkIntegrity(raw);
  const sha256 = await sha256hex(raw);
  // "stock": the SHA-256 of the unmodified official V15. "felucca": the file contains Felucca's loader marker
  // string; that is a text match anyone can put in a file, NOT a signature, so it is only a hint.
  // Anything else is of unknown origin. The page vouches for nothing but the official hash.
  const kind = sha256 === STOCK_V15_SHA256 ? "stock" : hasMark(raw) ? "felucca" : "other";
  const image = logicalImage(raw);
  return { product, model: m[1], size: raw.length, sha256, kind, ...(await parts(image)), image };
}

// ---------------------------------------------------------------- rebuild ---
// A package is a UFW header (entry list) followed by flash.bin and the other parts. A Baudgirl release is the official
// V15 package with a different, larger flash.bin: the head, the other parts and the header fields are V15's, only
// flash.bin's length and CRC, the offsets of the parts after it, the total length and the header CRCs differ. rebuild()
// makes that package from a template (the official V15 package's logical image, inspect().image) and a flash.bin.
// product: the identity string for the 20 marker bytes ("FM-1_102"). Returns the raw .fwsc bytes.
export function rebuild(lg, flashBin, product) {
  const h = lg.slice(0, 0x400);
  enc(h, 0, 0x40);
  const n = u16(h, 8);
  const ents = [];
  for (let i = 0; i < n; i++) { const e = h.slice(0x40 + i * 0x50, 0x90 + i * 0x50); enc(e, 0, 0x50); ents.push(e); }
  const f = ents.find((e) => u16(e, 0) === 0);
  if (!f) throw new Error("the template has no flash.bin");
  const oldLen = u32(f, 12), oldEnd = u32(f, 8) + oldLen, delta = flashBin.length - oldLen;
  const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
  const put16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
  for (const e of ents) {
    if (e === f) { put32(e, 12, flashBin.length); put32(e, 16, flashBin.length); put16(e, 4, crc16(flashBin)); }   // length and its aligned copy
    else if (u32(e, 8) >= oldEnd) put32(e, 8, u32(e, 8) + delta);
  }
  put32(h, 4, lg.length + delta);
  const region = new Uint8Array(n * 0x50);
  ents.forEach((e, i) => { const x = e.slice(); enc(x, 0, 0x50); region.set(x, i * 0x50); });
  h.set(region, 0x40);
  put16(h, 2, crc16(region));
  put16(h, 0, crc16(h.subarray(2, 0x40)));
  enc(h, 0, 0x40);
  const out = new Uint8Array(lg.length + delta);
  out.set(h, 0);
  out.set(flashBin, u32(f, 8));
  out.set(lg.subarray(oldEnd), oldEnd + delta);
  const raw = new Uint8Array(out.length + BLOCKS);
  for (let i = 0; i < BLOCKS; i++) {
    raw.set(out.subarray(i * KEEP, i * KEEP + KEEP), i * BLK);
    raw[i * BLK + KEEP] = i < product.length ? (product.charCodeAt(i) + i + 1) & 0xFF : 0x7D;
  }
  raw.set(out.subarray(BLOCKS * KEEP), BLOCKS * BLK);
  return raw;
}

// "Full wipe": flash.bin as the official update loader writes it when the package covers the whole range up to WIPE_END
// (the largest a package inspected goes to). The head is the template's (V15's), the app area is the target's, the rest is
// erased flash (0xFF), so the loader erases and writes every sector through WIPE_END.
export const WIPE_END = 0xBA000;
export function wipeFlash(stock, pkg) {
  if (stock.loader !== "official" || stock.flashOff !== pkg.flashOff) throw new Error("the template is not an official-loader package of this layout");
  if (pkg.flashLen > WIPE_END || pkg.flashLen < 0x4000) throw new Error("this package's flash.bin does not fit the wipe range");
  const fb = new Uint8Array(WIPE_END).fill(0xFF);
  fb.set(stock.image.subarray(stock.flashOff, stock.flashOff + 0x4000), 0);
  fb.set(pkg.image.subarray(pkg.flashOff + 0x4000, pkg.flashOff + pkg.flashLen), 0x4000);
  return fb;
}
