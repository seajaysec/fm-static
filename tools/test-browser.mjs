// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// With the site served locally: node tools/test-browser.mjs V15.fwsc V16.fwsc
// Needs playwright-core (or PLAYWRIGHT_MODULE pointing to its index.mjs) and Chrome.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect, rebuild } from "../src/fm1pkg.js";
import { packageFlash, FLASH_SIZE } from "../src/flash.js";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const [oldPath, nextPath, appPath] = process.argv.slice(2);
if (!oldPath || !nextPath) throw new Error("Pass V15.fwsc and V16.fwsc fixture paths.");
const old = await inspect(readFileSync(oldPath));
assert.equal(old.product, "FM-1_015");
assert.equal((await inspect(readFileSync(nextPath))).product, "FM-1_016");
const backup = Buffer.alloc(FLASH_SIZE, 255); backup.set(packageFlash(old));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  // Only this in-memory MIDI device exists in the test browser. No hardware access.
  await page.addInitScript(() => {
    window.midiCalls = 0;
    const input = { name: "FM-1", state: "connected", open: async () => {}, onmidimessage: null };
    const output = { name: "FM-1", state: "connected", open: async () => {}, send: (data) => {
      if (data[1] !== 0) throw new Error("A write command was attempted during a read-only UI test");
      const body = [0, 0x59, 0x11, 0, 0, 0, ...new TextEncoder().encode("FM-1_900")];
      while (body.length < 34) body.push(0);
      const packed = []; let acc = 0, bits = 0;
      for (const b of body) { acc |= b << bits; bits += 8; while (bits >= 7) { packed.push(acc & 127); acc >>>= 7; bits -= 7; } }
      if (bits) packed.push(acc & 127);
      setTimeout(() => input.onmidimessage?.({ data: [240, ...packed, 247] }), 0);
    } };
    window.midiAccess = { inputs: new Map([[0, input]]), outputs: new Map([[0, output]]), addEventListener() {} };
    window.midiInput = input; window.midiOutput = output;
    Object.defineProperty(navigator, "requestMIDIAccess", { value: async () => { window.midiCalls++; return window.midiAccess; } });
    window.usbPickedPID = 0x8057;
    Object.defineProperty(navigator, "usb", { value: { requestDevice: async () => ({ vendorId: 0x4c4a, productId: window.usbPickedPID, productName: "WL82 UBOOT1.00" }) } });
  });
  await page.goto(process.env.FLASH_TEST_URL || "http://127.0.0.1:8873");
  assert.equal(await page.locator("#tab-advanced").innerText(), "Layout Analysis");
  assert.equal(await page.locator('.workflow').count(), 2);
  assert.equal(await page.locator('img[src^="diagrams/"]').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 1024, 780, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of ['flash', 'advanced', 'recovery', 'about']) {
      await page.locator('#tab-' + mode).click();
      assert.equal(await page.locator('#st-file').isVisible(), true, 'shared picker visible on ' + mode);
      assert.equal(await page.locator('#connect').isVisible(), mode === 'flash', 'connection step is visible only on Flash');
      assert.equal(await page.locator('#connect').isDisabled(), true, 'connection requires a loaded package');
      assert.equal(await page.locator('#firmware-loaded').isVisible(), false);
      assert.equal(await page.locator('.package-details:visible').count(), 0);
      const flow = mode === 'flash' ? page.locator('#st-map .workflow') : mode === 'advanced' ? page.locator('.analysis-workflow') : null;
      if (flow) assert.equal(await flow.locator(':scope > li').count(), 4);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, mode + ' overflow at ' + width);
      if (flow) {
        assert.equal(await flow.evaluate(e => e.scrollWidth > e.clientWidth), false, 'workflow overflow at ' + width);
        assert.equal(await flow.locator('p').evaluateAll(es => es.every(e => parseFloat(getComputedStyle(e).fontSize) >= 14)), true);
      }
      if (mode === 'about') {
        assert.equal(await page.locator('.feature-table').evaluate(e => e.scrollWidth > e.clientWidth), false, 'comparison overflow at ' + width);
        if (width <= 900) assert.equal(await page.locator('.feature-table tbody tr:not(.feature-section)').evaluateAll(rows => rows.every(row => row.querySelector('th').getBoundingClientRect().width >= row.getBoundingClientRect().width - 2)), true, 'mobile feature headings use full row width');
      }
      if (width === 1440 || width === 390) {
        await page.locator(mode === 'about' ? '#feature-comparison' : '#panel-' + mode).screenshot({ path: '/tmp/fm-static-' + mode + '-' + width + '.png' });
        if (mode === 'about') {
          await page.locator('.mode-tabs').evaluate(e => e.scrollIntoView({ block: 'start' }));
          await page.screenshot({ path: '/tmp/fm-static-about-preview-' + width + '.png' });
        }
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#tab-flash').click();
  assert.equal(await page.locator("#tab-flash").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#panel-advanced").isVisible(), false);
  assert.equal(await page.locator('[role="tab"]').count(), 4);
  assert.equal(await page.locator('#panel-flash #st-map').isVisible(), true, 'workflow is visible on default Flash tab');
  assert.equal(await page.locator('#panel-flash #desktop-recovery').count(), 0);
  assert.equal(await page.locator('.feature-table td').evaluateAll(cells => cells.every(cell => [...cell.querySelectorAll('.feature-value')].every(value => value.dataset.status && value.querySelector('.feature-mark')))), true, 'all comparison entries use status marks');
  assert.equal(await page.locator('.feature-table td:last-child .feature-value[data-status="supported"]').evaluateAll(values => values.every(value => value.dataset.tool && value.querySelector('a.feature-provider'))), true, 'external checks identify their tools');
  const gating = page.locator('.feature-table tr').filter({ has: page.locator('th[scope="row"]').filter({ hasText: /^V15-first gating$/ }) });
  assert.equal(await gating.locator('td.featured .feature-mark.status-supported').count(), 1);
  assert.equal(await gating.locator('td:last-child .feature-mark.status-supported').count(), 2);
  await page.locator('#tab-flash').focus();
  await page.keyboard.press('End');
  assert.equal(await page.locator('#tab-about').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-flash').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#tab-about').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#tab-flash').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);
  await page.locator('#connect').evaluate(e => e.dispatchEvent(new MouseEvent('click', {bubbles:true})));
  assert.equal(await page.evaluate(() => window.midiCalls), 0, 'connection handler also enforces firmware prerequisite');
  await page.locator('#file').setInputFiles({name:'invalid.fwsc',mimeType:'application/octet-stream',buffer:Buffer.alloc(3)});
  await page.waitForFunction(() => document.querySelector('#file-msg').classList.contains('err'));
  assert.equal(await page.locator('#connect').isDisabled(), true, 'invalid initial file does not unlock connection');
  assert.equal(await page.locator('#firmware-loaded').isVisible(), false);
  await page.screenshot({ path: "/tmp/flash-tabs-default.png" });
  await page.locator("#tab-flash").focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#tab-advanced").getAttribute("aria-selected"), "true");
  await page.screenshot({ path: "/tmp/flash-tabs-advanced.png" });
  await page.locator("#backup-inspection > summary").click();
  await page.locator('#backup-inspection a[href="#desktop-recovery"]').click();
  assert.equal(await page.locator("#tab-recovery").getAttribute("aria-selected"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "desktop-recovery");
  assert.equal(await page.locator("#desktop-recovery a").count(), 4);
  await page.screenshot({ path: "/tmp/flash-recovery.png" });
  await page.locator("#tab-advanced").click();
  await page.locator(".compact-diagram").screenshot({ path: "/tmp/flash-layout-diagram.png" });
  await page.locator("#backup-file").setInputFiles({ name: "old-flash.bin", mimeType: "application/octet-stream", buffer: backup });
  await page.waitForFunction(() => document.querySelector("#backup-info").textContent.includes("SHA-256"));
  assert.equal(await page.evaluate(() => window.midiCalls), 0);
  assert.match(await page.locator("#backup-msg").innerText(), /V15-style/);
  assert.equal(await page.locator('#st-file').evaluate(e => e.closest('[role="tabpanel"]')), null);
  assert.equal(await page.locator('#analysis-file').count(), 0);
  await page.locator('#file').setInputFiles(nextPath);
  await page.waitForFunction(() => document.querySelector('#analysis-source').textContent.includes('FM-1_016'));
  assert.equal(await page.locator('#f-id').textContent(), 'FM-1_016', 'analysis uses shared firmware');
  assert.equal(await page.locator('#firmware-loaded').isVisible(), true);
  assert.equal(await page.locator('#analysis-fileinfo').isVisible(), true);
  assert.equal(await page.locator('#st-file #file-details').count(), 0);
  await page.locator('#analysis-file-details > summary').click();
  assert.equal(await page.locator('#analysis-f-id').innerText(), 'FM-1_016');
  assert.equal(await page.locator('#analysis-file-details').textContent(), await page.locator('#file-details').textContent(), 'both tabs show identical facts and checks');
  await page.locator('#analysis-file-details > summary').click();
  await page.locator('#tab-flash').click();
  assert.equal(await page.locator('#fileinfo').isVisible(), true);
  assert.equal(await page.locator('#connect').isEnabled(), true);
  assert.equal(await page.locator('#fileinfo').evaluate(e => e.nextElementSibling.id), 'st-start');
  await page.locator('#tab-advanced').click();
  assert.equal(await page.evaluate(() => window.midiCalls), 0);
  await page.locator('#flash-details > summary').click();
  assert.match(await page.locator('#flash-layout').innerText(), /V16-style/);
  assert.match(await page.locator('#flash-regions').innerText(), /DX7.bin/);
  assert.match(await page.locator('#backup-info').innerText(), /Data-region addresses differ/);
  assert.match(await page.locator('#flash-ranges').innerText(), /0xA9000/);
  await page.locator('#file').setInputFiles(oldPath);
  await page.waitForFunction(() => document.querySelector('#analysis-source').textContent.includes('FM-1_015'));
  await page.locator('#tab-flash').click();
  assert.match(await page.locator('#flash-selection').innerText(), /FM-1_015/);
  assert.equal(await page.locator('#f-id').textContent(), 'FM-1_015', 'shared changes reach Flash');
  await page.locator('#tab-advanced').click();
  await page.locator('#file').setInputFiles({ name: 'invalid.fwsc', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3) });
  await page.waitForFunction(() => document.querySelector('#file-msg').classList.contains('err'));
  assert.equal(await page.locator('#file-msg').isVisible(), true);
  assert.match(await page.locator('#analysis-source').innerText(), /FM-1_015/);
  assert.equal(await page.locator('#f-id').textContent(), 'FM-1_015', 'invalid replacement preserves shared selection');
  assert.equal(await page.locator('#analysis-f-id').textContent(), 'FM-1_015');
  assert.equal(await page.locator('#firmware-loaded').isVisible(), true);
  await page.locator('#file').setInputFiles(nextPath);
  await page.waitForFunction(() => document.querySelector('#analysis-source').textContent.includes('FM-1_016'));
  assert.equal(await page.evaluate(() => window.midiCalls), 0);
  // A saved updater page uses the same shared selection without MIDI access.
  await page.locator('#file').setInputFiles({name:'saved-updater.html',mimeType:'text/html',buffer:Buffer.from('<script type="application/octet-stream">'+readFileSync(oldPath).toString('base64')+'</script>')});
  await page.waitForFunction(() => document.querySelector('#f-id').textContent === 'FM-1_015');
  assert.match(await page.locator('#analysis-source').innerText(), /FM-1_015/);
  // Hold old discoveries until a newer local choice is committed.
  for (const kind of ['page', 'github', 'workbench']) {
    let release, started, requests = 0;
    const gate = new Promise(r => release = r), began = new Promise(r => started = r);
    const url = kind === 'page' ? 'https://firmware.example/installer' : kind === 'github' ? 'https://github.com/test/shared-picker' : 'https://open.m-vave.com/fm1-workbench';
    const pattern = kind === 'page' ? 'https://firmware.example/**' : kind === 'github' ? 'https://api.github.com/repos/test/shared-picker**' : 'https://api.github.com/repos/m-vave/fm1_open/releases/latest';
    await page.route(pattern, async route => {
      requests++;
      if(requests === 1) { started(); await gate; }
      const path = new URL(route.request().url()).pathname;
      const body = kind === 'page' ? '<a href="/old.fwsc">old</a>' : kind === 'workbench' ? {assets:[]} : path.endsWith('/shared-picker') ? {name:'shared-picker',default_branch:'main'} : path.includes('/git/trees/') ? {tree:[{type:'blob',path:'old.fwsc'}]} : [];
      await route.fulfill({contentType:kind==='page'?'text/html':'application/json',body:typeof body==='string'?body:JSON.stringify(body)});
    });
    await page.locator('#url').fill(url);
    await page.locator('#url-form button').click(); await began;
    assert.equal(await page.locator('#connect').isDisabled(), true, 'lookup blocks connection until settled');
    await page.locator('#file').setInputFiles(nextPath);
    await page.waitForFunction(() => document.querySelector('#f-id').textContent === 'FM-1_016' && document.querySelector('#file-msg').textContent.startsWith('Ready'));
    release(); await page.waitForLoadState('networkidle');
    assert.equal(requests, 1, 'stale '+kind+' lookup stops before further requests');
    assert.equal(await page.locator('#f-id').textContent(), 'FM-1_016');
    assert.equal(await page.locator('#url-msg').isVisible(), false, 'stale '+kind+' lookup cannot overwrite shared feedback: '+await page.locator('#url-msg').textContent());
    await page.unroute(pattern);
  }
  assert.equal(await page.evaluate(() => window.midiCalls), 0);
  let failedDownloads = 0;
  await page.route('https://firmware.example/retry**', async route => {
    const path = new URL(route.request().url()).pathname;
    if(path === '/retry') return route.fulfill({contentType:'text/html',body:'<a href="/retry-bad.fwsc">A</a><a href="/retry-good.fwsc">B</a>'});
    if(route.request().method() === 'HEAD') return route.fulfill({status:200});
    if(path === '/retry-bad.fwsc') { failedDownloads++; return route.fulfill({status:500,body:'Failed'}); }
    return route.fulfill({contentType:'application/octet-stream',body:readFileSync(nextPath)});
  });
  await page.locator('#url').fill('https://firmware.example/retry');
  await page.locator('#url-form button').click();
  await page.waitForFunction(() => document.querySelectorAll('#url-results button').length === 2);
  await page.locator('#url-results button').first().click();
  await page.waitForFunction(() => document.querySelector('#url-msg').classList.contains('err'));
  await page.locator('#url-sort').selectOption('name');
  await page.locator('#url-results button').first().click();
  await page.waitForFunction(() => document.querySelector('#url-msg').classList.contains('err'));
  assert.equal(failedDownloads, 2, 'failed download can be retried');
  await page.locator('#url-results button').last().click();
  await page.waitForFunction(() => document.querySelector('#file-selection').textContent.includes('retry-good.fwsc'));
  assert.equal(await page.locator('#f-id').textContent(), 'FM-1_016', 'another result remains selectable after failure');
  assert.equal(await page.evaluate(() => window.midiCalls), 0);
  await page.unroute('https://firmware.example/retry**');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: '/tmp/fm-static-shared-firmware-' + width + '.png' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#tab-flash').click();
  await page.locator("#trust").check(); await page.locator("#connect").click();
  await page.locator("#wipe").waitFor({ state: "visible" });
  await page.locator("#boot-help").evaluate(e => e.open = true);
  await page.locator("#boot-check").click();
  assert.match(await page.locator("#boot-msg").innerText(), /M-Flasher/);
  assert.equal(await page.locator('#boot-msg a[href^="https://"]').getAttribute("target"), "_blank");
  assert.doesNotMatch(await page.locator("#boot-msg").innerText(), /firmware does not start/);
  await page.evaluate(() => window.usbPickedPID = 0x1234);
  await page.locator("#boot-check").click();
  assert.match(await page.locator("#boot-msg").innerText(), /not the expected FM-1 ROM download ID/);
  await page.locator("#wipe").check();
  assert.match(await page.locator("#wipe-info").innerText(), /not a complete settings or Bluetooth reset/);
  await page.locator("#tab-advanced").click();
  assert.match(await page.locator("#flash-ranges").innerText(), /0xBA000/);
  await page.locator("#flash-plan").evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "/tmp/flash-inspection-desktop.png" });
  await page.locator("#backup-inspection").evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "/tmp/flash-inspection-backup.png" });
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((t) => document.documentElement.dataset.theme = t, theme);
    await page.locator("#flash-details").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no page overflow");
    await page.screenshot({ path: `/tmp/flash-inspection-mobile-${theme}.png` });
    await page.locator(".compact-diagram").screenshot({ path: `/tmp/flash-layout-diagram-${theme}.png` });
  }
  await page.locator("#backup-file").setInputFiles({ name: "wrong.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(13) });
  await page.waitForFunction(() => document.querySelector("#backup-msg").classList.contains("err"));
  assert.equal(await page.locator("#backup-info").isVisible(), false);
  assert.equal(await page.locator("#f-id").textContent(), "FM-1_016");
  await page.locator("#backup-file").setInputFiles({ name: "unknown.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(FLASH_SIZE, 255) });
  await page.waitForFunction(() => document.querySelector("#backup-info").textContent.includes("Layout comparison unavailable"));
  await page.locator("#backup-clear").click();
  assert.equal(await page.locator("#backup-info").isVisible(), false);
  assert.equal(await page.locator("#f-id").textContent(), "FM-1_016");
  await page.locator("#tab-flash").click();
  await page.locator("#file").setInputFiles(oldPath);
  await page.waitForFunction(() => document.querySelector("#f-id").textContent === "FM-1_015");
  assert.equal(await page.locator("#wipe").isChecked(), false);
  assert.match(await page.locator("#flash-ranges").textContent(), /0x93000/);
  // Outer package CRCs pass, but an internal application CRC does not.
  const damaged = packageFlash(old).slice(); damaged[0x5000] ^= 1;
  await page.locator("#flash-details").evaluate((e) => e.open = false);
  await page.locator("#file").setInputFiles({ name: "damaged-app.fwsc", mimeType: "application/octet-stream", buffer: Buffer.from(rebuild(old.image, damaged, old.product)) });
  await page.waitForFunction(() => document.querySelector("#flash-warnings").textContent.includes("checksum does not match"));
  assert.equal(await page.locator("#install-analysis-warning").isVisible(), true, "internal corruption visible on Flash");
  assert.match(await page.locator("#install-analysis-warning").innerText(), /checksum does not match/);
  await page.locator("#tab-advanced").click();
  assert.equal(await page.locator("#flash-warnings").isVisible(), true, "internal corruption visible with details closed");
  await page.locator("#tab-flash").click();
  if (appPath) {
    assert.equal((await inspect(readFileSync(appPath))).loader, "app");
    await page.locator("#file").setInputFiles(appPath);
    await page.locator("#bootl").waitFor({ state: "visible" });
    await page.locator("#bootl").check();
    assert.match(await page.locator("#flash-ranges").textContent(), /Bootloader installed afterwards/);
    await page.locator("#bootl").uncheck();
    assert.doesNotMatch(await page.locator("#flash-ranges").textContent(), /Bootloader installed afterwards/);
  }
  await page.locator('#tab-about').click();
  await page.locator('#panel-about a[href="#st-map"]').click();
  assert.equal(await page.locator('#tab-flash').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'st-map');
  await page.locator('#tab-about').click();
  await page.locator('#comparison-notes a[href="#desktop-recovery"]').click();
  assert.equal(await page.locator('#tab-recovery').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#f-id').textContent(), appPath ? (await inspect(readFileSync(appPath))).product : old.product);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#tab-about').click();
  await page.locator('#feature-comparison').evaluate(e => e.scrollIntoView());
  await page.screenshot({ path: '/tmp/fm-static-about-mobile-dark.png' });
  // Port availability changes during a scan must invalidate old replies and queue a fresh scan.
  await page.locator('#tab-flash').click();
  await page.evaluate(async () => {
    const url = new URL('src/updater.js', location.href); url.search = new URL(document.querySelector('script[type="module"]').src).search;
    const {Updater} = await import(url.href);
    window.scanCount = 0;
    Updater.prototype.scan = async function() {
      window.scanCount++;
      const found = this.ports().filter(n => n === 'FM-1').map(name => ({name,id:{text:'FM-1_900',model:'FM-1',version:900}}));
      if(window.holdScan) { window.holdScan = false; await new Promise(resolve => window.finishScan = resolve); }
      return found;
    };
    window.holdScan = true;
  });
  await page.locator('#rescan').click();
  await page.waitForFunction(() => typeof window.finishScan === 'function');
  assert.equal(await page.locator('#device-list input').count(), 0, 'old replies disappear while checking');
  assert.equal(await page.locator('#install-row').isVisible(), false, 'no install using an old scan');
  await page.evaluate(() => {
    window.midiInput.state = window.midiOutput.state = 'disconnected';
    window.midiAccess.onstatechange({port:window.midiInput});
    window.finishScan();
  });
  await page.waitForFunction(() => window.scanCount >= 2 && document.querySelector('#scan-status').textContent.includes('0 available'));
  assert.equal(await page.locator('#device-list input').count(), 0, 'late old reply is discarded');
  assert.equal(await page.locator('#ports li').count(), 0, 'disconnected ports excluded');
  await page.evaluate(() => {
    window.midiInput.state = window.midiOutput.state = 'connected';
    const candidate = {name:'Virtual MIDI',state:'connected',open:async()=>{}};
    window.midiAccess.inputs.set(1,candidate);
    window.midiAccess.outputs.set(1,{...candidate,send:()=>{throw Error('Unrequested probe');}});
    window.midiAccess.onstatechange({port:window.midiInput});
  });
  await page.waitForFunction(() => document.querySelector('#scan-status').textContent.includes('2 available') && document.querySelector('#device-list input'));
  assert.match(await page.locator('#ports').textContent(), /Available MIDI port · not checked for an FM-1/);
  const scans = await page.evaluate(() => window.scanCount);
  await page.evaluate(() => window.midiAccess.onstatechange({port:window.midiInput}));
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.scanCount), scans, 'opening a port does not start an endless rescan');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(previous => window.scanCount > previous && document.querySelector('#scan-status').textContent.startsWith('Checked'), scans);
  assert.equal(await page.evaluate(() => window.midiCalls), 1, 'fresh scan reuses permission');
  await page.evaluate(async () => {
    const url=new URL('src/updater.js',location.href);url.search=new URL(document.querySelector('script[type="module"]').src).search;
    const {Updater}=await import(url.href);window.goodScan=Updater.prototype.scan;
    Updater.prototype.scan=async()=>{throw Error('Port unavailable');};
  });
  await page.locator('#rescan').click();
  await page.waitForFunction(()=>document.querySelector('#scan-status').classList.contains('err'));
  assert.match(await page.locator('#ports').textContent(), /Not checked; refresh devices/);
  assert.doesNotMatch(await page.locator('#ports').textContent(), /Checking for an FM-1 reply/);
  await page.evaluate(async () => {
    const url=new URL('src/updater.js',location.href);url.search=new URL(document.querySelector('script[type="module"]').src).search;
    (await import(url.href)).Updater.prototype.scan=window.goodScan;
  });
  await page.locator('#rescan').click();
  await page.waitForFunction(()=>document.querySelector('#scan-status').textContent.startsWith('Checked'));
  await page.setViewportSize({width:390,height:1000});
  await page.locator('#ports').evaluate(e => e.closest('details').open = true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#st-dev').screenshot({path:'/tmp/fm-static-current-ports-mobile.png'});
  // Isolated tab controller: test the install navigation lock without flashing.
  const navigation = await browser.newPage();
  await navigation.goto(process.env.FLASH_TEST_URL || 'http://127.0.0.1:8873');
  await navigation.setContent('<div class="mode-tabs" role="tablist">' + ['flash','advanced','recovery','about'].map((name,i) => '<button id="tab-' + name + '" role="tab" aria-controls="panel-' + name + '" aria-selected="' + (i===0) + '">' + name + '</button>').join('') + '</div>' + ['flash','advanced','recovery','about'].map(name => '<div id="panel-' + name + '" role="tabpanel"></div>').join(''));
  await navigation.evaluate(async () => { window.lockTabs = (await import(new URL('src/tabs.js', location.href).href)).setupTabs(); });
  await navigation.locator('#tab-about').click();
  await navigation.evaluate(() => window.lockTabs(true));
  assert.equal(await navigation.locator('#tab-flash').getAttribute('aria-selected'), 'true');
  assert.equal(await navigation.locator('[role="tab"]:disabled').count(), 4);
  await navigation.evaluate(() => window.lockTabs(false));
  await navigation.locator('#tab-recovery').click();
  assert.equal(await navigation.locator('#tab-recovery').getAttribute('aria-selected'), 'true');
  await navigation.close();
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: shared firmware, layout analysis, sequential gates, MIDI refresh races and errors, recovery help, mobile themes. No device writes.");
} finally { await browser.close(); }
