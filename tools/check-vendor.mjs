// SPDX-License-Identifier: GPL-3.0-only
// Checks that the vendored fm1-base files still offer what src/updater.js and src/fm1pkg.js use from them, and that the
// recorded hashes match the files. Run by tools/sync-base.sh and by the weekly sync job; exit 1 means the adapter needs work.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
let bad = 0;
const need = (ok, what) => { console.log((ok ? "ok      " : "MISSING ") + what); if (!ok) bad++; };

const pin = Object.fromEntries(read("vendor/fm1-base/SOURCE").toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(" ")));
for (const f of ["web/fm1ota.js", "web/fm1pkg.js", "web/m-bootloader/fm1-uboot-1.2.fwsc"]) {
  const got = createHash("sha256").update(read("vendor/fm1-base/" + f.replace("web/", ""))).digest("hex");
  need(pin[f] === got, `${f} matches the hash in SOURCE`);
}
const ota = await import(new URL("vendor/fm1-base/fm1ota.js", root));
const U = ota.Updater && ota.Updater.prototype;
need(!!U, "fm1ota.js exports Updater");
for (const m of ["find", "waitFor", "serve", "install", "installBoot", "arm", "write", "resume"]) need(U && typeof U[m] === "function", `Updater.${m}()`);
need(typeof ota.pack7 === "function" && typeof ota.unpack7 === "function", "pack7 / unpack7");
const src = read("vendor/fm1-base/fm1ota.js").toString();
need(/\/fm-\?1\|felucca\|ota\|composite\|sinco\|usb-midi\/i/.test(src), "find() still filters ports by a name test the adapter's prefix passes");
need(/async install\(image, product, onStep, sha256\)/.test(src), "install(image, product, onStep, sha256) signature");
need(/step\("start"/.test(src) && /step\("verify"/.test(src) && /step\("loader"/.test(src) && /step\("write"/.test(src) && /step\("reboot"/.test(src) && /step\("done"/.test(src), "the step names the page shows");
const pkg = await import(new URL("vendor/fm1-base/fm1pkg.js", root));
need(typeof pkg.productOf === "function" && typeof pkg.logicalImage === "function", "fm1pkg.js exports productOf, logicalImage");
process.exit(bad ? 1 : 0);
