// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// File checks and a simulated V15 transport. Never opens MIDI hardware.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readBank, writeBanks, factoryBanks, FACTORY_BANK_HASHES} from '../src/banks.js';
import {sha256hex} from '../src/fm1pkg.js';
import {unpack7} from '../vendor/fm1-base/fm1ota.js';

const files = Array.from({length:4}, (_, bank) => readFileSync(new URL(`../vendor/factory-voices/FM-1_factory_bank${bank+1}.syx`,import.meta.url)));
const banks = files.map((file,bank) => ({bank, ...readBank(file)}));
for (let i=0;i<4;i++) assert.equal(await sha256hex(files[i]),FACTORY_BANK_HASHES[i]);
assert.equal(banks[0].names[0],'PIANO 1');
assert.equal(banks[1].names[2],'BASS 1');
assert.equal(banks.reduce((n,b)=>n+b.names.length,0),128);
assert.throws(()=>readBank(files[0].subarray(1)),/standard DX7/);
const bad=files[0].slice();bad[200]^=1;
assert.throws(()=>readBank(bad),/checksum/);
const high=files[0].slice();high[200]|=128;
assert.throws(()=>readBank(high),/invalid MIDI/);
const joined=Buffer.concat([files[0],files[1]]);
assert.throws(()=>readBank(joined),/standard DX7/);

// Asset integrity is checked before the caller can start cleanup.
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>new Response(readFileSync(url));
assert.equal((await factoryBanks()).length,4);
globalThis.fetch=async url=>{const b=Buffer.from(readFileSync(url));b[200]^=1;return new Response(b);};
await assert.rejects(factoryBanks(),/pinned source/);
globalThis.fetch=originalFetch;

// Captured V15 success acknowledgement, independently of our frame builder.
const ACK=[0xf0,0,0x32,1,8,0,0,0,0,0x7f,1,0xf7];
function mock({identity='FM-1_015',name='selected',lost=false,failAt=-1,malformedFirst=false}={}) {
  const packets=[], commands=[], q=[];let closed=false;
  const link={lost,drain(){q.length=0;},send(packet){
    packets.push(packet);const body=unpack7(packet.slice(1,-1));commands.push(body);
    assert.equal(body.length,7+body[3]+256*body[4]);
    assert.equal(body.slice(6).reduce((n,b)=>n+b,0)&255,255,'payload checksum');
    if(commands.length!==failAt){if(malformedFirst)q.push([0xf0,0,0xf7]);q.push(ACK);}
    return true;
  },async read(){return q.shift()||null;},close(){closed=true;}};
  return {target:'selected',baseline:null,packets,commands,get closed(){return closed;},
    async find(filter){const id={text:identity};return filter(id)?{name,id,link}:null;}};
}
const up=mock({malformedFirst:true}), progress=[];
const result=await writeBanks(up,banks,p=>progress.push(p));
assert.deepEqual(result,{banks:[0,1,2,3],bytes:16384});
assert.equal(up.commands.length,36);
assert.equal(up.closed,true);
assert.deepEqual(up.packets[0],[0xf0,0,0x32,5,0x29,0,0,0x40,2,0,0,0,0,0x20,0x1f,0xf7],'captured erase command');
for(let bank=0;bank<4;bank++) {
  const erase=up.commands[bank*9];assert.equal(erase[2],33);assert.equal(erase[6],5);
  assert.equal(erase[7]+erase[8]*256,bank*4096);
  const parts=[];
  for(let k=0;k<8;k++) {const body=up.commands[bank*9+1+k];assert.equal(body[2],34);assert.equal(body[6],5);assert.equal(body[7]+body[8]*256,bank*4096+k*512);assert.deepEqual(body.slice(9,14),[0,0,0,2,0]);parts.push(...body.slice(14,-1));}
  assert.deepEqual(new Uint8Array(parts),banks[bank].data);
}
assert.equal(progress.at(-1).bytes,16384);
const single=mock();await writeBanks(single,[{bank:2,data:banks[0].data}]);
assert.equal(single.commands.length,9);assert.equal(single.commands[0][8],0x20,'custom bank 3 only');
for(const options of [{identity:'FM-1_016'},{identity:'FM-1_700'},{name:'other'},{lost:true}]) {
  const denied=mock(options);await assert.rejects(writeBanks(denied,banks));assert.equal(denied.packets.length,0);
}
const invalid=mock();await assert.rejects(writeBanks(invalid,[{bank:4,data:banks[0].data}]));assert.equal(invalid.packets.length,0);
await assert.rejects(writeBanks(invalid,[banks[0],banks[0]]));
const stalled=mock({failAt:2});
await assert.rejects(writeBanks(stalled,banks,()=>{},5),e=>e.mayHaveChangedBanks&&/acknowledge/.test(e.message));
assert.equal(stalled.packets.length,2,'a missing acknowledgement stops all later writes and erases');
assert.equal(stalled.closed,true);
console.log('Voice-bank checks passed: pinned data, DX7 framing/checksum, exact destinations and payloads, V15-only identity, selected-port lock, acknowledgements and failure stop. No hardware accessed.');
