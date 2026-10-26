// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
//
// An FM-1 .fwsc, read and rebuilt here. The identity string and the logical image
// (the file with its 20 marker bytes removed) come from the vendored reader.
// The header is a CRC-16/XMODEM stream, key 0xFFFF, which that reader names and
// which undoes itself. Nothing in this file is taken from another implementation.

import { productOf, logicalImage } from "../vendor/fm1-base/fm1pkg.js?v=2026-10-26.18";

export { productOf, logicalImage };

export const STOCK_V15_SHA256 = "db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a";
export const STOCK_HEAD_SHA256 = "d9f43191777656de01c7bed4f9e9ba2e34e94832c5d2ed02c3fc7ab7a6d9bd67";
export const APP_END = 0x93000;
export const WIPE_END = 0xBA000;

const MARKS = 20;
const STRIDE = 0x30;
const KEPT = 0x2f;
const ENTRY = 0x50;
const HEAD = 0x4000;
const LOADER_NAME = new TextEncoder().encode("FELUCCA-LOADER-1");

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };

// CRC-16/XMODEM. poly 0x1021, initial value 0, nothing reflected, nothing added at the end.
export function crc16(data, crc = 0) {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// The header stream: each byte is mixed with the low 8 bits of a CRC-16 register that starts at 0xFFFF.
// It is its own inverse.
function stream(src, key = 0xffff) {
  const out = src.slice();
  for (let i = 0; i < out.length; i++) {
    out[i] ^= key & 0xff;
    key = ((key << 1) & 0xffff) ^ ((key & 0x8000) ? 0x1021 : 0);
  }
  return out;
}

function contains(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

// The first 20 blocks, marker byte dropped, as one buffer. Same bytes the logical image starts with.
function packedHead(raw) {
  const out = new Uint8Array(MARKS * KEPT);
  for (let i = 0; i < MARKS; i++) {
    const from = i * STRIDE;
    const n = Math.min(KEPT, Math.max(0, raw.length - from));
    if (n) out.set(raw.subarray(from, from + n), i * KEPT);
  }
  return out;
}

export function checkIntegrity(raw) {
  const packed = packedHead(raw);
  const head = stream(packed.subarray(0, 0x40));
  packed.set(head, 0);
  const count = u16(packed, 8);
  const listEnd = 0x40 + count * ENTRY;
  if (crc16(packed.subarray(2, 0x40)) !== u16(packed, 0)) throw new Error("not an FM-1 .fwsc (header CRC mismatch)");
  if (listEnd > packed.length || crc16(packed.subarray(0x40, listEnd)) !== u16(packed, 2)) throw new Error("the package's entry list is damaged");
  for (let at = 0x40; at < listEnd; at += ENTRY) {
    const entry = stream(packed.subarray(at, at + ENTRY));
    if (u16(entry, 0) !== 0) continue;
    const fileAt = u32(entry, 8) + MARKS;
    const size = u32(entry, 12);
    if (fileAt + size > raw.length || crc16(raw.subarray(fileAt, fileAt + size)) !== u16(entry, 4)) throw new Error("flash.bin CRC mismatch: the file is damaged");
    return;
  }
  throw new Error("no flash.bin in the package");
}

// Plaintext header (0x400) and one plaintext record per directory entry.
function opened(lg) {
  const page = lg.slice(0, 0x400);
  const head = stream(page.subarray(0, 0x40));
  page.set(head, 0);
  const count = u16(page, 8);
  const records = [];
  for (let i = 0; i < count; i++) records.push(stream(page.subarray(0x40 + i * ENTRY, 0x40 + (i + 1) * ENTRY)));
  return { page, records };
}

function sealed(page, records) {
  const list = new Uint8Array(records.length * ENTRY);
  records.forEach((rec, i) => list.set(stream(rec), i * ENTRY));
  page.set(list, 0x40);
  put16(page, 2, crc16(list));
  put16(page, 0, crc16(page.subarray(2, 0x40)));
  page.set(stream(page.subarray(0, 0x40)), 0);
  return page;
}

function directory(lg) {
  const { records } = opened(lg);
  const out = {};
  for (const rec of records) out[u16(rec, 0)] = { off: u32(rec, 8), len: u32(rec, 12) };
  return out;
}

async function describe(lg) {
  const dir = directory(lg);
  const flash = dir[0];
  const loader = dir[100];
  let kind = "unknown";
  if (loader && loader.off + 0x88 <= lg.length) {
    const lead = lg.subarray(loader.off, loader.off + 0x88);
    if (u16(lead, 0) === 0xebaa && u16(lead, 2) === 0x5881 && u32(lead, 8) === 0x4de1) kind = "official";
    else if (contains(lead.subarray(0x48), LOADER_NAME)) kind = "app";
  }
  const off = flash ? flash.off : 0;
  const headHash = flash && off + HEAD <= lg.length ? await sha256hex(lg.subarray(off, off + HEAD)) : "";
  const startup = off && off + HEAD <= lg.length ? lg.slice(off, off + HEAD) : null;
  return { loader: kind, flashLen: flash ? flash.len : 0, flashOff: off, startup, stockHead: headHash === STOCK_HEAD_SHA256 };
}

export async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function inspect(bytes) {
  const raw = new Uint8Array(bytes);
  const product = productOf(raw);
  const id = /^([^_]+)_(\d+)$/.exec(product);
  if (!id) throw new Error(`not an FM-1 package (identity ${JSON.stringify(product)})`);
  checkIntegrity(raw);
  const sha256 = await sha256hex(raw);
  const image = logicalImage(raw);
  const info = await describe(image);
  const mvave = info.loader === "official" && /^FM-1_0[01]\d$/.test(product);
  const kind = sha256 === STOCK_V15_SHA256 ? "stock" : mvave ? "mvave" : contains(raw, LOADER_NAME) ? "felucca" : "other";
  return { product, model: id[1], size: raw.length, sha256, kind, ...info, image };
}

// Put the 20 marker bytes back. Byte i of the product lands in marker i, plus i + 1; unused markers are 0x7D.
function marked(image, product) {
  const raw = new Uint8Array(image.length + MARKS);
  for (let i = 0; i < MARKS; i++) {
    raw.set(image.subarray(i * KEPT, i * KEPT + KEPT), i * STRIDE);
    raw[i * STRIDE + KEPT] = i < product.length ? (product.charCodeAt(i) + i + 1) & 0xff : 0x7d;
  }
  raw.set(image.subarray(MARKS * KEPT), MARKS * STRIDE);
  return raw;
}

export function rebuild(lg, flashBin, product) {
  const { page, records } = opened(lg);
  const flash = records.find((rec) => u16(rec, 0) === 0);
  if (!flash) throw new Error("the template has no flash.bin");
  const oldLen = u32(flash, 12);
  const oldEnd = u32(flash, 8) + oldLen;
  const delta = flashBin.length - oldLen;
  for (const rec of records) {
    if (rec === flash) {
      put32(rec, 12, flashBin.length);
      put32(rec, 16, flashBin.length);
      put16(rec, 4, crc16(flashBin));
    } else if (u32(rec, 8) >= oldEnd) put32(rec, 8, u32(rec, 8) + delta);
  }
  put32(page, 4, lg.length + delta);
  const body = new Uint8Array(lg.length + delta);
  body.set(sealed(page, records), 0);
  body.set(flashBin, u32(flash, 8));
  body.set(lg.subarray(oldEnd), oldEnd + delta);
  return marked(body, product);
}

export function wipeFlash(stock, pkg) {
  if (stock.loader !== "official" || stock.flashOff !== pkg.flashOff) throw new Error("the template is not an official-loader package of this layout");
  if (pkg.flashLen > WIPE_END || pkg.flashLen < HEAD) throw new Error("this package's flash.bin does not fit the wipe range");
  const bin = new Uint8Array(WIPE_END).fill(0xff);
  bin.set(stock.image.subarray(stock.flashOff, stock.flashOff + HEAD), 0);
  bin.set(pkg.image.subarray(pkg.flashOff + HEAD, pkg.flashOff + pkg.flashLen), HEAD);
  return bin;
}

// Reach V15 before data cleanup, then install the selected firmware and wipe.
// Application-loader targets supply the first pass's startup-preserving writer.
export async function wipePasses(stock, pkg) {
  if (stock.kind !== "stock" || stock.sha256 !== STOCK_V15_SHA256) throw new Error("The wipe requires the verified official V15 package.");
  const final = await inspect(rebuild(stock.image, wipeFlash(stock, pkg), pkg.product));
  if (pkg.loader !== "app") return [stock, final];
  if (pkg.model !== "FM-1" || pkg.flashOff !== 0x400 || pkg.flashLen !== APP_END)
    throw new Error("The two-pass wipe requires a standard FM-1 application-loader package.");
  const bridge = await inspect(rebuild(pkg.image, stock.image.slice(stock.flashOff, stock.flashOff + stock.flashLen), stock.product));
  if (bridge.loader !== "app" || bridge.flashLen !== APP_END) throw new Error("The V15 application-only pass could not be prepared.");
  return [bridge, final];
}
