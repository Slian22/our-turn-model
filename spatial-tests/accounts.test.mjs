import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,stepWorld,advanceWorld,saveWorld,restoreWorld} from '../spatial/world.mjs';
import {allocatePool} from '../sim/resources.mjs';
import {safeAllocatePool} from '../spatial/allocation.mjs';

test('restore rejects unpaid factory capacity and false last-interval work accounts (QM08/09 witnesses)',()=>{
 const w=stepWorld(createWorld({horizon:2,regions:[{id:'r',config:{shockProbability:0}}],links:[]}));
 for(const kind of ['unpaid','work']){
  const x=JSON.parse(saveWorld(w)),r=x.regions[0];
  if(kind==='unpaid'){
   const p=r.state.queue.find(p=>p.kind==='factory'),extra=p.land;
   p.amount*=2;p.energy*=2;p.land*=2;r.state.landUsed+=extra;
  }else r.work.used=0;
  assert.throws(()=>restoreWorld(JSON.stringify(x)),kind);
 }
});

test('commissioned plus queued energy/work match cumulative paid accounts at coarse and fine dt',()=>{
 for(const dt of [.1,1]){
  const w=advanceWorld(createWorld({horizon:6,dt}),6);
  for(const r of w.regions){
   const queued=r.state.queue.reduce((a,p)=>a+p.energy,0);
   assert.ok(Math.abs(r.state.cumulativeBuildEnergy-r.state.commissionedBuildEnergy-queued)<1e-6);
   const work=r.state.queue.reduce((a,p)=>a+p.amount*w.config.workWeights[p.kind],0);
   assert.ok(Math.abs(r.state.cumulativeBuildWork-r.state.commissionedBuildWork-work)<1e-6);
  }
  assert.deepEqual(restoreWorld(saveWorld(w)),w);
 }
});

test('safe allocation normalizes only finite overflowing claims and preserves ordinary results exactly',()=>{
 for(const [supply,claim] of [[100,1e308],[1000,1e306]]){
  const result=safeAllocatePool({supply,needH:supply,needA:supply,claimH:claim,claimA:claim});
  assert.equal(result.human,supply/2);assert.equal(result.other,supply/2);assert.equal(result.unused,0);
 }
 for(const claimH of [0,1,100,1e10])for(const supply of [0,1,1000]){
  const options={supply,needH:300,needA:500,claimH,claimA:200,reserve:40};
  assert.deepEqual(safeAllocatePool(options),allocatePool(options));
 }
 for(const claimH of [Infinity,NaN,-1])assert.throws(()=>safeAllocatePool({supply:1,needH:1,needA:1,claimH,claimA:1}));
});

test('restore reconciles commissioned quantities with every installed stock',()=>{
 const w=advanceWorld(createWorld({horizon:6}),5);
 for(const [stock,land] of [['F','landFab'],['G','landPower'],['B','landBlock']]){
  const x=JSON.parse(saveWorld(w)),r=x.regions[0];r.state[stock]+=1000;r.state.landUsed+=1000*r.config[land];
  assert.throws(()=>restoreWorld(JSON.stringify(x)),stock);
 }
});
