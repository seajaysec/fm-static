// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// DX7 bulk-bank validation and V15 voice storage. No firmware/update commands.
import { sha256hex } from "./fm1pkg.js?v=2026-10-26.18";
import { pack7, unpack7 } from "../vendor/fm1-base/fm1ota.js?v=2026-10-26.18";

export const FACTORY_BANK_HASHES = [
  "6a46c1eed389a775a1747f4488261c848e9ad43fdec6250ce2c8e004020428f9",
  "0f076624f75451ff5f1bbe92e44a8643c74ea9c56ccaaf190bf730d8ab730264",
  "5eab4699b4c50c82986d17726ea9997230efc1c5a7745ed7d251d31313e8b99d",
  "8142fb69249ad1d78a4665ebb2eb33f4e1b9689d2dfabce97077cc9da5d30308",
];

export function readBank(file) {
  const bytes = new Uint8Array(file);
  if (bytes.length !== 4104 || bytes[0] !== 0xf0 || bytes[1] !== 0x43 || bytes[2] > 15 ||
      bytes[3] !== 9 || bytes[4] !== 0x20 || bytes[5] !== 0 || bytes[4103] !== 0xf7)
    throw new Error("Choose one standard DX7 32-voice bank (.syx, 4,104 bytes). Single voices and other formats are not supported.");
  if (bytes.subarray(2, 4103).some(b => b > 127) || bytes.subarray(6, 4103).reduce((n, b) => n + b, 0) % 128)
    throw new Error("The DX7 bank has invalid MIDI data or a checksum mismatch. Nothing was sent.");
  const data = bytes.slice(6, 4102);
  const names = Array.from({length:32}, (_, n) => String.fromCharCode(...data.subarray(n * 128 + 118, n * 128 + 128)).replace(/[^ -~]/g, "?").trim());
  return { data, names };
}

export async function factoryBanks() {
  // All four files must be intact before the first device command is sent.
  return Promise.all(FACTORY_BANK_HASHES.map(async (hash, bank) => {
    const url = new URL(`../vendor/factory-voices/FM-1_factory_bank${bank + 1}.syx`, import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load factory bank ${bank + 1} (HTTP ${response.status}). Nothing was sent.`);
    const file = await response.arrayBuffer();
    if (await sha256hex(file) !== hash) throw new Error(`Factory bank ${bank + 1} does not match the pinned source. Nothing was sent.`);
    return {bank, ...readBank(file)};
  }));
}

// V15's storage commands: 0x21 erases a 4 KiB bank, 0x22 writes a block.
// Storage selector 5 is the voice-bank space, addressed relative to its start.
// Responses are command 0 with one status byte. The additive checksum includes
// the payload only. Bit packing is supplied by the existing MPL transport.
function message(command, payload) {
  const body = new Uint8Array(7 + payload.length);
  body.set([0, 0x59, command, payload.length & 255, payload.length >>> 8, 0]);
  body.set(payload, 6);
  body[body.length - 1] = (~payload.reduce((n, b) => n + b, 0)) & 255;
  return [0xf0, ...pack7(body), 0xf7];
}

async function acknowledged(link, bytes, timeout) {
  if (link.lost) throw new Error("The FM-1 disconnected.");
  link.drain();
  if (!link.send(bytes)) throw new Error("The MIDI command could not be sent.");
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const packet = await link.read(Math.min(250, end - Date.now()));
    if (link.lost) throw new Error("The FM-1 disconnected.");
    if (!packet || packet[0] !== 0xf0 || packet.at(-1) !== 0xf7 || packet.slice(1, -1).some(b => b > 127)) continue;
    const reply = unpack7(packet.slice(1, -1));
    if (reply.length !== 8 || reply[0] !== 0 || reply[1] !== 0x59 || reply[2] !== 0 || reply[3] !== 1 || reply[4] !== 0 || reply[5] !== 0 ||
        ((reply[6] + reply[7]) & 255) !== 255) continue;
    if (reply[6]) throw new Error(`V15 refused a voice-bank command (status ${reply[6]}).`);
    return;
  }
  throw new Error("V15 did not acknowledge the voice-bank command.");
}

export async function writeBanks(updater, selection, onProgress = () => {}, timeout = 5000) {
  if (!Array.isArray(selection) || !selection.length || selection.length > 4) throw new Error("Choose one to four voice banks.");
  const seen = new Set();
  const banks = selection.map(({bank, data}) => {
    if (!Number.isInteger(bank) || bank < 0 || bank > 3 || seen.has(bank) || !(data instanceof Uint8Array) || data.length !== 4096 || data.some(b => b > 127))
      throw new Error("Invalid voice-bank data or destination. Nothing was sent.");
    seen.add(bank);
    return {bank, data:data.slice()};
  });
  // The caller supplies a fresh updater pinned to the selected MIDI port.
  // Never follow a new port or choose a different FM-1 while replacing voices.
  if (!updater.target || updater.baseline) throw new Error("Select one FM-1 and refresh its connection first.");
  const device = await updater.find(id => id.text === "FM-1_015");
  if (!device) throw new Error("The selected port did not answer as V15. Nothing was sent.");
  let changed = false, completed = 0;
  try {
    if (device.id.text !== "FM-1_015" || device.name !== updater.target) throw new Error("The selected device changed. Nothing was sent.");
    for (const {bank, data} of banks) {
      const base = bank * 4096;
      changed = true;
      onProgress({bank, bytes:completed, total:banks.length * 4096, erasing:true});
      await acknowledged(device.link, message(0x21, [5, base & 255, base >>> 8, 0, 0]), timeout);
      for (let off = 0; off < 4096; off += 512) {
        const address = base + off;
        const payload = [5, address & 255, address >>> 8, 0, 0, 0, 2, 0, ...data.subarray(off, off + 512)];
        await acknowledged(device.link, message(0x22, payload), timeout);
        completed += 512;
        onProgress({bank, bytes:completed, total:banks.length * 4096, erasing:false});
      }
    }
    return {banks:banks.map(b => b.bank), bytes:completed};
  } catch (error) {
    error.mayHaveChangedBanks = changed;
    throw error;
  } finally { device.link.close(); }
}
