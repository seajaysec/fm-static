// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// No hardware: substitute discovery to inspect the adapter's port selection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Updater } from '../src/updater.js';
const source=readFileSync(new URL('../src/updater.js',import.meta.url),'utf8');
const spec=source.match(/from "([^"\n]+fm1ota\.js[^"\n]*)"/)[1];
const {Updater:Base}=await import(new URL(spec,new URL('../src/updater.js',import.meta.url)));
const names=['FM-1 other','FM-1 verified'];
const ports=()=>new Map(names.map((name,i)=>[i,{name,state:'connected'}]));
const access={inputs:ports(),outputs:ports()};
const up=new Updater(access,()=>{}), original=Base.prototype.find;
let seen;
try {
  Base.prototype.find=async function(filter){
    seen=[...this.access.inputs.values()].map(p=>p.name);
    for(const p of this.access.inputs.values()){
      const id={text:p.name.endsWith('verified')?'FM-1_11000300':'FM-1_700',model:'FM-1',version:700};
      if(!filter||filter(id))return {name:p.name,id,link:{close(){}}};
    }
    return null;
  };
  up.baseline=new Set(names);
  await up.find(id=>id.text==='FM-1_11000300');
  assert.equal(up.lastPort,'FM-1 verified');
  up.pinVerified('FM-1_11000300');
  assert.equal((await up.find(()=>true)).name,'FM-1 verified');
  assert.deepEqual(seen,['FM-1 FM-1 verified'],'next pass cannot choose the other unit, even if listed first');
  assert.throws(()=>up.pinVerified('FM-1_015'),/verified firmware port/);
  access.inputs.delete(1);access.outputs.delete(1);
  assert.equal(await up.find(()=>true),null,'missing verified port never falls back to the other unit');
  assert.deepEqual(seen,[]);
  console.log('Updater checks passed: next pass pins the verified port; another FM-1 is never substituted. No hardware accessed.');
} finally {Base.prototype.find=original;}
