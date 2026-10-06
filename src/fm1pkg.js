// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
// Copyright (C) 2026 Chris Farrell (modifications)
//
// From Felucca's web/fm1pkg.js (https://github.com/hugelton/Felucca).
// Modified 2026-10-06 by Chris Farrell for fm-static: reduced to reading a package
// (identity, CRC check, origin hint, logical image); the package building code is removed.
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

// -> { product, model, size, sha256, kind: "stock" | "felucca" | "other", image }; throws on a bad file
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
  return { product, model: m[1], size: raw.length, sha256, kind, image: logicalImage(raw) };
}
