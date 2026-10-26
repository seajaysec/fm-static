// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// Run: node tools/test-flash.mjs [optional real .fwsc files...]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { crc16, inspect } from "../src/fm1pkg.js";
import { inspectFlash, inspectBackup, packageFlash, writePlan, regionEffect, compareLayouts, compareBytes, FLASH_SIZE } from "../src/flash.js";

// Synthetic wire-format fixtures: fields are encoded independently of the parser.
function record(name, start, length, attr, key, dataCrc = 0) {
  const b = Buffer.alloc(32, 255);
  b.writeUInt16LE(dataCrc, 2); b.writeUInt32LE(start, 4); b.writeUInt32LE(length, 8); b[12] = attr;
  b.fill(0, 16); b.write(name, 16, 16, "ascii"); b.writeUInt16LE(crc16(b.subarray(2)), 0);
  for (let i = 0; i < 32; i++) { b[i] ^= key & 255; key = ((key << 1) ^ (key & 32768 ? 0x1021 : 0)) & 65535; }
  return b;
}
function fixture(v16 = false) {
  const bytes = new Uint8Array(FLASH_SIZE).fill(255);
  const records = [
    ["app_area_head", 0x2000140, 0x90000, 0x83],
    ["app.bin", 0x200, 32, 0x82],
    ["VM", v16 ? 0xba000 : 0x93000, v16 ? 0x20000 : 0x56000, 0x12],
    ["BTIF", v16 ? 0xec000 : 0xe9000, 0x1000, 0x92],
    [v16 ? "SEQ64" : "USR", v16 ? 0xda000 : 0xea000, 0x12000, 0x92],
  ];
  records.forEach((r, i) => bytes.set(record(...r, 0x980f ^ (i * 8)), 0x4000 + 32 * i));
  const end = Buffer.alloc(32, 255);
  for (let i = 0, k = 0x980f ^ (records.length * 8); i < 32; i++) { end[i] ^= k & 255; k = ((k << 1) ^ (k & 32768 ? 0x1021 : 0)) & 65535; }
  bytes.set(end, 0x4000 + 32 * records.length);
  return bytes;
}
function pkg(loader = "official", length = 0xa9000) {
  return { model: "FM-1", loader, flashLen: length, flashOff: 0x400, image: new Uint8Array(length + 0x400).fill(42) };
}
const byteCounts = (...args) => { const { sectors, ...counts } = compareBytes(...args); return counts; };

test("V15 and V16 declared regions decode; virtual directory header is not a flash address", () => {
  const old = inspectFlash(fixture()), next = inspectFlash(fixture(true));
  assert.equal(old.layout, "V15-style data layout"); assert.equal(next.layout, "V16-style data layout");
  assert.equal(next.regions.find((e) => e.name === "app.bin").start, 0x4200);
  assert.ok(!next.regions.some((e) => e.name === "app_area_head"));
  assert.deepEqual(compareLayouts(old, next).map((c) => c.name).sort(), ["BTIF", "SEQ64", "USR", "VM"]);
  assert.deepEqual(compareLayouts(old, inspectFlash(fixture())), []);
  assert.ok(old.warnings.some((w) => w.includes("checksum"))); // synthetic app payload is intentionally invalid
});
test("damaged / unfamiliar data never falls back to stock addresses", () => {
  const bytes = fixture(); bytes[0x4020] ^= 1;
  const layout = inspectFlash(bytes);
  assert.equal(layout.recognised, false); assert.deepEqual(layout.regions, []);
  assert.equal(compareLayouts(layout, inspectFlash(fixture())), null);
  assert.equal(inspectFlash(new Uint8Array(0)).recognised, false);
  assert.equal(inspectBackup(new Uint8Array(FLASH_SIZE).fill(255)).recognised, false);
});
test("valid CRC with overflowing region lengths remains untrusted", () => {
  const bytes = fixture(); bytes.set(record("VM", 0xfffff000, 0xfffffff0, 0x12, 0x980f ^ 16), 0x4040);
  const layout = inspectFlash(bytes); assert.equal(layout.recognised, false);
  assert.ok(layout.warnings.some((w) => w.includes("outside")));
});
test("a damaged later entry never makes a partial table appear complete", () => {
  const bytes = fixture(true); bytes[0x4040] ^= 1;
  const partial = inspectFlash(bytes);
  assert.equal(partial.recognised, true); assert.equal(partial.complete, false);
  assert.equal(partial.layout, "Incomplete data layout");
  assert.ok(partial.warnings.some((w) => w.includes("incomplete")));
  assert.equal(compareLayouts(partial, partial), null);
  assert.equal(compareLayouts(partial, inspectFlash(fixture(true))), null);
});
test("backup accepts only a raw full-flash-sized file", () => {
  for (const n of [0, 0x93000, FLASH_SIZE - 1, FLASH_SIZE + 1]) assert.throws(() => inspectBackup(new Uint8Array(n)), /1 MiB/);
});
test("known loaders have distinct write limits and unknown loaders do not guess", () => {
  assert.deepEqual(writePlan(pkg()).ranges.map((r) => [r.start, r.end]), [[0, 0xa9000]]);
  assert.deepEqual(writePlan(pkg("app")).ranges.map((r) => [r.start, r.end]), [[0x4000, 0x93000]]);
  for (const p of [pkg("unknown"), pkg("app", 0x92000), pkg("official", 0xa9001), { ...pkg(), model: "SMK-37" }]) assert.equal(writePlan(p).known, false);
});
test("cleanup includes voice-region overlaps without claiming a whole settings reset", () => {
  const plan = writePlan(pkg(), { wipe: true });
  const next = inspectFlash(fixture(true)), old = inspectFlash(fixture());
  for (const [name, effect] of [["VM", "Outside"], ["BTIF", "Within"], ["SEQ64", "Partly within"]]) assert.equal(regionEffect(next.regions.find((e) => e.name === name), plan), `${effect} planned writes`);
  assert.equal(regionEffect(old.regions.find((e) => e.name === "VM"), plan), "Partly within planned writes");
  assert.equal(regionEffect(old.regions.find((e) => e.name === "BTIF"), plan), "Outside planned writes");
});
test("comparison counts only available final bytes, excludes untouched data, and honours later boot install", () => {
  const p = pkg(), backup = { bytes: new Uint8Array(FLASH_SIZE).fill(42) };
  backup.bytes[0x5000] = 0; backup.bytes[0xed000] = 0;
  assert.deepEqual(byteCounts(backup, p, writePlan(p)), { compared: 0xa9000, different: 1, unavailable: 0 });
  const plan = writePlan(p, { wipe: true });
  assert.deepEqual(byteCounts(backup, p, plan), { compared: 0xba000 - 0x4000, different: 1 + 0x11000, unavailable: 0x8000 });
  const boot = writePlan(p, { boot: true });
  assert.deepEqual(byteCounts(backup, p, boot), { compared: 0xa9000 - 0x4000, different: 1, unavailable: 0x4000 });
  assert.equal(compareBytes(backup, p, writePlan(pkg("unknown"))), null);
  assert.deepEqual(byteCounts(backup, p, writePlan(p, { wipe: true, stock: p }), p), { compared: 0xba000, different: 1 + 0x11000, unavailable: 0x4000 });
});
test("sector diagnostics count whole comparable sectors and distinguish erased bytes from corruption", () => {
  const p = pkg(), backup = { bytes: new Uint8Array(FLASH_SIZE).fill(42) };
  backup.bytes[0x5000] = 0; backup.bytes.fill(255, 0x6000, 0x7000);
  backup.bytes.fill(255, 0xed000); // outside the compared write range
  assert.deepEqual(compareBytes(backup, p, writePlan(p)).sectors, { compared: 169, matching: 167, different: 2, erased: 1 });
  assert.deepEqual(compareBytes(backup, p, writePlan(p, { boot: true })).sectors, { compared: 165, matching: 163, different: 2, erased: 1 });
});
test("bounded arbitrary inputs do not crash the inspector or invent recognised layouts", () => {
  let seed = 7;
  for (let n = 0; n < 100; n++) {
    const b = new Uint8Array(0x4300);
    for (let i = 0; i < b.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; b[i] = seed >>> 24; }
    assert.equal(inspectFlash(b).recognised, false);
  }
});
for (const file of process.argv.slice(2)) test(`real package: ${file}`, async () => {
  const p = await inspect(readFileSync(file)), layout = inspectFlash(packageFlash(p));
  assert.ok(layout.recognised, "application table recognised"); assert.deepEqual(layout.warnings, []);
  if (p.product === "FM-1_015") assert.equal(layout.layout, "V15-style data layout");
  if (p.product === "FM-1_016") assert.equal(layout.layout, "V16-style data layout");
  console.log(`${p.product}: ${layout.layout}; internal file checksums match`);
});
