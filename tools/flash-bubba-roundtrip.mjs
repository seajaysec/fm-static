// SPDX-License-Identifier: MIT
// Real-device roundtrip: 386dx → V15 (temporary updater) → Bubba → V15 → 386dx via fm-static.
// Usage (FM-1 plugged in, Chrome installed):
//   node tools/flash-bubba-roundtrip.mjs
// Env: FLASH_TEST_URL (default http://127.0.0.1:8873/), PLAYWRIGHT_MODULE
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright-core");
import { resolve } from "node:path";

const BASE = process.env.FLASH_TEST_URL || "http://127.0.0.1:8873/";
const V15 = resolve("/Users/seajay/Downloads/FM-1.fwsc");
const BUBBA = resolve("/tmp/bubba-machine-0.10.0-beta.fwsc");
const DX = resolve("/Users/seajay/Downloads/386dx.fwsc");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
});
const context = await browser.newContext();
await context.grantPermissions(["midi", "midi-sysex"], { origin: new URL(BASE).origin });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });

async function status() {
  return (await page.locator("#status").textContent().catch(() => "")) || "";
}
async function routeText() {
  return (await page.locator("#route-dev").innerText().catch(() => "")) || "";
}
async function devicesText() {
  return (await page.locator("#devices").innerText().catch(() => "")) || "";
}
async function waitDone(label, ms = 360000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    const st = await status();
    const cls = (await page.locator("#status").getAttribute("class").catch(() => "")) || "";
    const ev = (await page.locator("#route-events").innerText().catch(() => "")) || "";
    if (st && st !== last) { log("…", st.slice(0, 120)); last = st; }
    if (/\bok\b/.test(cls) && new RegExp(label.expectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(st)) {
      log("ok", label.name, "—", st);
      return;
    }
    if (/\berr\b/.test(cls) && st) {
      throw new Error(`${label.name} failed: ${st}\nroute:\n${await routeText()}\nevents:\n${ev}`);
    }
    await sleep(1500);
  }
  throw new Error(`${label.name} timed out.\nstatus=${await status()}\ndevices=${await devicesText()}\nroute=${await routeText()}\nevents=${await page.locator("#route-events").innerText().catch(() => "")}`);
}

async function loadPkg(path) {
  log("load", path);
  await page.locator("#file").setInputFiles(path);
  await page.waitForFunction(() => {
    const t = document.getElementById("file-msg")?.textContent || "";
    return /Ready for Flash|Ready/i.test(t) || /err/i.test(document.getElementById("file-msg")?.className || "");
  }, null, { timeout: 30000 });
  const msg = await page.locator("#file-msg").textContent();
  if (/err|damaged|not an/i.test(msg) && !/Ready/i.test(msg)) throw new Error("file load: " + msg);
  // trust checkbox for unverified (Bubba = mvave)
  const trust = page.locator("#trust");
  if (await trust.isVisible().catch(() => false)) {
    await page.locator("#trust-row").locator("label").click().catch(async () => { await trust.check({ force: true }); });
  }
}

async function connectIfNeeded() {
  const connect = page.locator("#connect");
  if (await connect.isVisible().catch(() => false) && await connect.isEnabled().catch(() => false)) {
    log("connect");
    await connect.click();
    await sleep(1500);
  }
  const rescan = page.locator("#rescan");
  if (await rescan.isEnabled().catch(() => false)) {
    await rescan.click();
    await sleep(2000);
  }
  log("devices:\n" + (await devicesText()));
  log("route:\n" + (await routeText()).slice(0, 800));
}

async function ackBackup() {
  const backup = page.locator("#backup");
  await page.waitForSelector("#backup-row:not([hidden])", { timeout: 15000 }).catch(() => {});
  if (await backup.isVisible().catch(() => false)) await backup.check({ force: true });
}

async function installNormal(name, expectId) {
  log("install", name);
  await ackBackup();
  const go = page.locator("#go");
  await page.waitForSelector("#install-row:not([hidden])", { timeout: 20000 });
  if (!(await go.isEnabled())) throw new Error("Install disabled for " + name + " why=" + (await page.locator("#why").textContent().catch(() => "")));
  await go.click();
  await waitDone({ name, expectId });
}

async function installBridge(expectId) {
  log("temporary updater →", expectId);
  await ackBackup();
  await page.waitForSelector("#bridge-row:not([hidden])", { timeout: 20000 });
  const btn = page.locator("#bridge-go");
  if (await btn.isDisabled()) throw new Error("bridge-go disabled. route:\n" + await routeText());
  await btn.click();
  await waitDone({ name: "bridge→V15", expectId });
}

await page.goto(BASE, { waitUntil: "networkidle" });
log("opened", BASE);

// --- 1) 386dx → V15 via temporary updater ---
await loadPkg(V15);
await connectIfNeeded();
{
  const route = await routeText();
  if (!/386|FM-1_386|Felucca-family|app/i.test(route + await devicesText())) {
    log("WARN: expected 386dx; got:\n", await devicesText(), "\n", route);
  }
}
await installBridge("FM-1_015");

// --- 2) V15 → Bubba ---
await loadPkg(BUBBA);
await connectIfNeeded();
await installNormal("Bubba", "FM-1_003");
{
  const d = await devicesText() + await routeText();
  if (!/bubba/i.test(d)) log("WARN: port name may not contain Bubba yet:\n", d);
  else log("Bubba port detected in UI");
}

// --- 3) Bubba → V15 (our leave path) ---
await loadPkg(V15);
await connectIfNeeded();
{
  const route = await routeText();
  if (!/Bubba Machine|ROUTE|V15-shaped|leave path/i.test(route)) {
    log("WARN: expected Bubba leave-path copy; route:\n", route.slice(0, 1200));
  } else log("Bubba leave-path route OK");
  if (/STOP|needs a V15-shaped/i.test(route) && !/matches Bubba/i.test(route)) {
    throw new Error("V15 blocked on Bubba unexpectedly:\n" + route);
  }
}
await installNormal("V15 leave", "FM-1_015");

// --- 4) V15 → 386dx ---
await loadPkg(DX);
await connectIfNeeded();
await installNormal("386dx", "FM-1_386");

log("ROUNDTRIP COMPLETE");
await sleep(3000);
await browser.close();
process.exit(0);
