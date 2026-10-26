// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Chris Farrell
//
// Back up and restore what an FM-1 keeps (projects, presets, banks). The protocol is fm1-base's (vendor/fm1-base/backup-protocol.txt,
// MPL-2.0, the lines of its backup page between "backup protocol" markers, copied verbatim): a firmware that includes fm1-base's
// backup code answers it. What differs per firmware is four constants, which fm1-base's page fills in for each firmware
// ({{NAME}}, {{ID}}, {{MAGIC}}, {{BACKUP_VERSION}}, {{EXT}}); the ones this page knows are in FIRMWARES. A firmware not listed here is
// not asked: the page says whose tool holds its saves instead.

// each: match (the package identity of the firmware), name, magic (the four letters its backup starts with), version, ext, keeps
export const FIRMWARES = [
  { match: /^FM-1_1000$|^FM-1_10\d{6}$/, id: "FM-1_10", name: "LOOM-8", magic: "LM8B", version: 1, ext: "loom8", keeps: "the projects and user presets (not its samples)" },
  { match: /^FM-1_710\d{6}$/, id: "FM-1_710", name: "Mutable Dreams", magic: "MDDB", version: 1, ext: "mddb", keeps: "the project, preferences and user banks" },
];
export const knownFirmware = (identityText) => FIRMWARES.find((f) => f.match.test(identityText || "")) || null;

// the families this page tells apart by the identity a firmware reports (family() in app.js gives the key)
export const FAMILY_NAME = {
  mvave: "M-VAVE's own firmware", open: "M-VAVE's Open firmware", baudgirl: "a build on M-VAVE's update system (the shape of Baudgirl's releases)",
  felucca: "a Felucca-family firmware", other: "a firmware this page does not know",
};
// where the saves of a family are kept, for the families this page cannot read itself
export const WHERE = {
  mvave: "M-VAVE's firmware keeps presets and patterns in the FM-1; M-VAVE's own tools read them. This page cannot.",
  open: "M-VAVE's Workbench (open.m-vave.com) reads and saves projects, samples and voices: Projects & sounds, Read & save.",
  baudgirl: "Baudgirl's Device Manager saves and restores its presets: https://baudgirl.com/work/FM-1+VA/device-manager",
  felucca: "This firmware does not include the backup code this page speaks. Its own editor or page is the place to save what it keeps.",
  other: "This page does not know where this firmware keeps its saves.",
};

// the backup protocol for one firmware: fm1-base's text with its placeholders for this firmware filled in
const cache = new Map();
export async function protocolFor(fw) {
  if (cache.has(fw.id)) return cache.get(fw.id);
  const text = await (await fetch(new URL("../vendor/fm1-base/backup-protocol.txt", import.meta.url))).text();
  const withFw = text.replace(/const FW = \{[^;]*\};/, `const FW = ${JSON.stringify({ name: fw.name, id: fw.id, magic: fw.magic, version: fw.version, ext: fw.ext })};`);
  if (withFw === text) throw new Error("the vendored backup protocol has no FW line to fill in");
  const PB = new Function(`${withFw}\nreturn PB;`)();
  cache.set(fw.id, PB);
  return PB;
}

// A backup's file name says whose it is: <firmware>__<family>__<identity>__<date>.<ext> ("__" because identities contain "_")
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function backupName(fw, family, identity, date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${slug(fw.name)}__${family}__${identity}__${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}.${fw.ext}`;
}
export function parseBackupName(name) {
  const m = /^(.+?)__([a-z]+)__(.+?)__(\d{8})\.([a-z0-9]+)$/i.exec(name || "");
  return m ? { firmware: m[1], family: m[2], identity: m[3], date: m[4], ext: m[5] } : null;
}

// what the page can say about restoring this file to this FM-1. "formatOk": the firmware's own protocol accepted the file's header.
export function verdict({ file, formatOk, fw, family, identity }) {
  if (!formatOk) return { level: "no", text: `This is not a backup that ${fw.name} can take (its file format does not match).` };
  if (!file) return { level: "maybe", text: `The file's name doesn't say where it came from, but it has the format of a ${fw.name} backup. ${fw.name} will check it again and ask on the FM-1 before anything changes.` };
  if (file.identity === identity) return { level: "yes", text: `Taken from this same firmware (${identity}). It should restore.` };
  if (file.family === family && slug(file.firmware) === slug(fw.name)) return { level: "likely", text: `Taken from ${fw.name} ${file.identity}, you now run ${identity}. Same firmware, other version: it should restore if the backup format did not change, and ${fw.name} checks that itself.` };
  return { level: "unlikely", text: `Taken from ${file.firmware} (${file.family}, ${file.identity}). This FM-1 runs ${fw.name} (${family}). Backups of different firmwares use different formats; this one's header matches a ${fw.name} backup, but it is not guaranteed to restore as you expect.` };
}
