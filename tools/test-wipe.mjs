// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// node tools/test-wipe.mjs V15.fwsc application-loader.fwsc
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect, wipePasses, APP_END, WIPE_END, sha256hex } from '../src/fm1pkg.js';
import { ufwEntries } from '../vendor/fm1-base/fm1pkg.js';
const [stockPath, targetPath] = process.argv.slice(2);
if (!stockPath || !targetPath) throw Error('Pass V15 and an application-loader firmware fixture.');
const stock = await inspect(readFileSync(stockPath)), target = await inspect(readFileSync(targetPath));
assert.equal(stock.kind, 'stock'); assert.equal(target.loader, 'app');
const original = await sha256hex(target.image);
const [first, final] = await wipePasses(stock, target);
assert.equal(first.product, 'FM-1_015'); assert.equal(first.loader, 'app');
assert.equal(first.flashLen, APP_END);
assert.deepEqual(first.image.slice(first.flashOff, first.flashOff + first.flashLen), stock.image.slice(stock.flashOff, stock.flashOff + stock.flashLen));
const writer = p => {const e=ufwEntries(p.image)[100];return p.image.slice(e.off,e.off+e.len);};
assert.deepEqual(writer(first),writer(target), 'first pass retains the application-only writer');
assert.deepEqual(writer(final),writer(stock), 'final pass uses the official writer');
assert.equal(final.product,target.product); assert.equal(final.flashLen,WIPE_END);
const bin = final.image.slice(final.flashOff,final.flashOff+final.flashLen);
assert.deepEqual(bin.slice(0,0x4000),stock.startup);
assert.deepEqual(bin.slice(0x4000,target.flashLen),target.image.slice(target.flashOff+0x4000,target.flashOff+target.flashLen));
assert.ok(bin.slice(target.flashLen).every(b=>b===255));
assert.equal(await sha256hex(target.image),original,'preparation does not mutate the selected package');
await assert.rejects(wipePasses({...stock,kind:'mvave'},target),/verified official V15/);
await assert.rejects(wipePasses(stock,{...target,flashLen:APP_END+0x1000}),/standard FM-1/);
assert.equal((await wipePasses(stock,stock)).length,1);
console.log('Wipe package checks passed: exact writers and payloads, erased tail, identities, template and layout guards. No hardware accessed.');
