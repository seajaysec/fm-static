// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// Copyright (c) 2026 Julius Vitkauskas
// Flash table decoding and region names adapted from MIT-licensed formats.rs
// and sectormap.rs; see NOTICE.
// Inspection only: this module never communicates with a device or builds an update.
import { crc16, APP_END, WIPE_END } from "./fm1pkg.js?v=2026-10-26.9";

export const FLASH_SIZE = 0x100000;
export const BOOT_END = 0x4000;
const CHIP_KEY = 0x980f; // Common FM-1 key, not a key read from the connected device.
const rd16 = (b, p) => b[p] | b[p + 1] << 8;
const rd32 = (b, p) => (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0;
export const address = (n) => "0x" + n.toString(16).toUpperCase().padStart(5, "0");
export const rangeText = (start, end) => `${address(start)}–${address(end)} (end excluded)`;
const roles = { VM: "Settings", BTIF: "Bluetooth pairings", SEQ64: "Sequences", USR: "Sounds", USRFLASH: "Presets", USRTRIM: "Calibration", key_mac: "Factory identity", PRCT: "Protected code range" };

function decode(raw, key) {
  const b = raw.slice();
  for (let i = 0; i < b.length; i++) {
    b[i] ^= key & 255;
    key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return b;
}

function entry(b, table) {
  if (b.length !== 32 || crc16(b.subarray(2)) !== rd16(b, 0)) return null;
  const nameBytes = b.subarray(16, b.indexOf(0, 16) < 0 ? 32 : b.indexOf(0, 16));
  if (!nameBytes.length || nameBytes.some((x) => x < 32 || x > 126)) return null;
  const name = String.fromCharCode(...nameBytes), attr = b[12];
  const file = table === "app" && attr === 0x82;
  const start = rd32(b, 4) + (file ? BOOT_END : 0), length = rd32(b, 8);
  return { name, attr, start, end: start + length, length, table, file,
    role: roles[name] || (file ? "Application file" : table === "boot" ? "Boot file / region" : "Declared region"),
    dataCrc: rd16(b, 2) };
}

export function inspectFlash(bytes) {
  const warnings = [], boot = [], app = [];
  let complete = false;
  const header = decode(bytes.subarray(0, 32), 0xffff);
  const bootValid = header.length === 32 && crc16(header.subarray(2)) === rd16(header, 0);
  if (bootValid) {
    for (let at = 32; at < 0xa0 && at + 32 <= bytes.length; at += 32) {
      const e = entry(decode(bytes.subarray(at, at + 32), 0xffff), "boot");
      if (!e) break;
      boot.push(e);
    }
  } else warnings.push("Boot header not recognised or damaged.");
  for (let i = 0; i < 16; i++) {
    const at = BOOT_END + i * 32;
    if (at + 32 > bytes.length) break;
    const raw = decode(bytes.subarray(at, at + 32), CHIP_KEY ^ (i * 8));
    // An erased decoded record is the table terminator. A CRC failure in a
    // non-erased record is not proof that the directory ended there.
    if (raw.every((x) => x === 255)) { complete = true; break; }
    const e = entry(raw, "app");
    if (!e) break;
    app.push(e);
  }
  // Directory headers contain virtual addresses / sentinel lengths, not flash ranges.
  const physical = (e) => e.file || e.attr === 0x12 || e.attr === 0x92 || (e.table === "boot" && (e.attr === 0 || e.attr === 2));
  const invalid = [...boot, ...app].filter((e) => physical(e) && (e.start > FLASH_SIZE || e.end > FLASH_SIZE || (e.file && e.start < BOOT_END + 32)));
  if (invalid.length) warnings.push("A table entry points outside the supported flash layout; that table is not used.");
  const validBoot = invalid.some((e) => e.table === "boot") ? [] : boot;
  const validApp = invalid.some((e) => e.table === "app") ? [] : app;
  const recognised = validApp.some((e) => e.file && e.name === "app.bin" && e.length > 0);
  if (recognised && !complete) warnings.push("Application table is incomplete or damaged. Only validated entries are shown; layout matching is unavailable.");
  if (!recognised) warnings.push("Application layout unknown: the table is missing, damaged, or uses a different key or format. No stock layout is assumed.");
  const entries = [...validBoot, ...(recognised ? validApp : [])];
  const regions = entries.filter((e) => e.length > 0 && physical(e));
  const data = recognised ? validApp.filter((e) => e.attr === 0x12 || e.attr === 0x92) : [];
  const at = (name, start, end) => data.some((e) => e.name === name && e.start === start && e.end === end);
  const layout = recognised && !complete ? "Incomplete data layout" : at("VM", 0xba000, 0xda000) && at("SEQ64", 0xda000, 0xec000) && at("BTIF", 0xec000, 0xed000)
    ? "V16-style data layout" : at("VM", 0x93000, 0xe9000) && at("BTIF", 0xe9000, 0xea000)
      ? "V15-style data layout" : recognised ? "Custom data layout" : "Unknown data layout";
  const files = recognised ? validApp.filter((e) => e.file && e.length > 0) : [];
  for (const e of files) {
    if (e.end > bytes.length) { warnings.push(`${e.name}: file extends beyond the supplied image.`); continue; }
    // File payloads use independently keyed 32-byte blocks, relative to the app area.
    const plain = new Uint8Array(e.length);
    let copied = 0;
    for (let p = e.start - (e.start - BOOT_END) % 32; p < e.end; p += 32) {
      if (p + 32 > bytes.length) break;
      const block = decode(bytes.subarray(p, p + 32), CHIP_KEY ^ (((p - BOOT_END) >>> 2) & 0xffff));
      const lo = Math.max(e.start, p) - p, hi = Math.min(e.end, p + 32) - p;
      plain.set(block.subarray(lo, hi), copied); copied += hi - lo;
    }
    if (copied !== e.length || crc16(plain) !== e.dataCrc) warnings.push(`${e.name}: internal file checksum does not match.`);
  }
  return { layout, recognised, complete, bootValid, regions, data, warnings, bytes };
}

export function inspectBackup(bytes) {
  if (bytes.length !== FLASH_SIZE) throw new Error("Choose a raw 1 MiB flash backup (.bin, 1,048,576 bytes), not a .fwsc package or a project export.");
  return inspectFlash(bytes);
}

export function packageFlash(pkg) {
  return pkg.image.subarray(pkg.flashOff, pkg.flashOff + pkg.flashLen);
}

export function writePlan(pkg, { wipe = false, boot = false, stock = null } = {}) {
  const ranges = [];
  const valid = pkg.model === "FM-1" && pkg.flashLen >= BOOT_END && pkg.flashLen <= FLASH_SIZE && pkg.flashLen % 0x1000 === 0;
  if (!valid) return { known: false, ranges, reason: "Write ranges are unknown for this model or image size." };
  if (wipe && pkg.flashLen <= WIPE_END && pkg.flashOff === 0x400) {
    ranges.push({ start: 0, end: BOOT_END, source: stock ? "stock" : "unavailable", label: "Template startup code" });
    ranges.push({ start: BOOT_END, end: pkg.flashLen, source: "package", label: "Selected firmware" });
    if (pkg.flashLen < WIPE_END) ranges.push({ start: pkg.flashLen, end: WIPE_END, source: "erased", label: "Erase to 0xBA000" });
  } else if (pkg.loader === "official") {
    ranges.push({ start: 0, end: pkg.flashLen, source: "package", label: "Firmware and startup code" });
  } else if (pkg.loader === "app" && pkg.flashLen >= APP_END) {
    ranges.push({ start: BOOT_END, end: APP_END, source: "package", label: "Application area" });
  } else return { known: false, ranges, reason: "This loader's write range is unknown. The package extent alone cannot establish what it writes." };
  if (boot) ranges.push({ start: 0, end: BOOT_END, source: "unavailable", label: "Bootloader installed afterwards" });
  return { known: true, ranges, reason: "Expected firmware writes, based on the recognised loader design. Loader markers are not signatures. Staging and update-record cleanup may write elsewhere; this is not a complete erase map or a readback guarantee." };
}

export function regionEffect(region, plan) {
  if (!plan.known) return "Unknown";
  const overlaps = plan.ranges.filter((r) => r.start < region.end && region.start < r.end);
  if (!overlaps.length) return "Outside firmware write";
  const edges = [...new Set([region.start, region.end, ...overlaps.flatMap((r) => [Math.max(r.start, region.start), Math.min(r.end, region.end)])])].sort((a, b) => a - b);
  const covered = edges.slice(0, -1).reduce((n, a, i) => n + (overlaps.some((r) => r.start <= a && r.end >= edges[i + 1]) ? edges[i + 1] - a : 0), 0);
  return covered === region.length ? "Within firmware write" : "Partly within firmware write";
}

export function compareLayouts(before, after) {
  if (!before.recognised || !after.recognised || !before.complete || !after.complete) return null;
  const map = (layout) => new Map(layout.data.filter((e) => e.length && e.name !== "PRCT").map((e) => [e.name, e]));
  const a = map(before), b = map(after), changes = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const old = a.get(name), next = b.get(name);
    if (old?.start !== next?.start || old?.end !== next?.end) changes.push({ name, before: old, after: next });
  }
  return changes;
}

export function compareBytes(backup, pkg, plan, stock = null) {
  if (!plan.known) return null;
  const flash = packageFlash(pkg), template = stock && packageFlash(stock);
  let compared = 0, different = 0, unavailable = 0;
  const counts = new Uint16Array(256), differs = new Uint8Array(256), erased = new Uint16Array(256);
  // Last operation wins where the optional bootloader install overlaps the firmware.
  for (let at = 0; at < FLASH_SIZE; at++) {
    const r = plan.ranges.findLast((r) => r.start <= at && at < r.end);
    if (!r) continue;
    const byte = r.source === "package" ? flash[at] : r.source === "stock" ? template?.[at] : r.source === "erased" ? 255 : undefined;
    if (byte === undefined) { unavailable++; continue; }
    compared++;
    const sector = at >>> 12; counts[sector]++;
    if (backup.bytes[at] === 255) erased[sector]++;
    if (backup.bytes[at] !== byte) { different++; differs[sector] = 1; }
  }
  const sectors = { compared: 0, matching: 0, different: 0, erased: 0 };
  for (let i = 0; i < 256; i++) {
    if (counts[i] !== 4096) continue;
    sectors.compared++; sectors[differs[i] ? "different" : "matching"]++;
    if (erased[i] === 4096) sectors.erased++;
  }
  return { compared, different, unavailable, sectors };
}
