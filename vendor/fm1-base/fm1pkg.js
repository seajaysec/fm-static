// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Charles Vestal
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// FM-1 .fwsc packages in the browser: the package identity and the image the
// device reads during an update.

const BLOCKS = 20, BLK = 0x30, KEEP = 0x2F;

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

// the UFW entries of a logical image, by type (0 flash.bin, 100 ota.bin): {off, len}. The header and the
// entry list are ciphered with key 0xFFFF (felucca-bsp chip/ota.c ota_jl_enc); the CRCs are not checked here
export function ufwEntries(image) {
  const dec = (off, n) => {
    const b = image.slice(off, off + n);
    for (let i = 0, k = 0xFFFF; i < n; i++) { b[i] ^= k & 0xFF; k = ((k << 1) ^ (k & 0x8000 ? 0x1021 : 0)) & 0xFFFF; }
    return b;
  };
  const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
  const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const out = {};
  const n = Math.min(rd16(dec(0, 0x40), 8), 11);
  for (let i = 0; i < n; i++) {
    const e = dec(0x40 + i * 0x50, 0x50);
    out[rd16(e, 0)] = { off: rd32(e, 8), len: rd32(e, 12) };
  }
  return out;
}
