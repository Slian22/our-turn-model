import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,stepWorld,advanceWorld,branchWorld,worldView,saveWorld,restoreWorld} from '../spatial/world.mjs';
import {initialEvents} from '../spatial/events.mjs';

const close=(a,b)=>assert.ok(Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const zero={technologyProbability:0,pandemicProbability:0,disasterProbability:0};
const create=(eventConfig={},extra={})=>createWorld({horizon:4,dt:.1,eventMode:'scenario',eventConfig:{...zero,...eventConfig},
 regions:[{id:'a',config:{H0:10,G0:1000,B0:0,birth:0,death:0,shockProbability:0}}],links:[],...extra});

test('event mode defaults off and zero-probability variant preserves all physical dynamics',()=>{
 const options={horizon:3,seed:7};let off=createWorld(options),zeroEvents=createWorld({...options,eventMode:'scenario',eventConfig:zero});
 assert.equal(off.config.eventMode,'off');
 for(let i=0;i<96;i++){
  off=stepWorld(off);zeroEvents=stepWorld(zeroEvents);
  for(let j=0;j<7;j++){
   const {scenarioEvents:ignored,...a}=off.regions[j].state;
   const {scenarioEvents:ignored2,...b}=zeroEvents.regions[j].state;assert.deepEqual(a,b);
   assert.deepEqual(off.regions[j].power,zeroEvents.regions[j].power);
  }
 }
 const forcedOff=advanceWorld(createWorld({...options,eventMode:'off',eventConfig:{technologyProbability:1,pandemicProbability:1,disasterProbability:1}}),3);
 assert.deepEqual(off.regions.map(r=>r.state),forcedOff.regions.map(r=>r.state));
});

test('technology permanently caps essential-energy efficiency and affects reserve routing consistently',()=>{
 let w=create({technologyProbability:1,technologyGain:.5,maxEfficiency:.5},{alignment:1,
  regions:[{id:'a',config:{H0:10,G0:100,B0:0,shockProbability:0}},{id:'b',config:{H0:100,G0:0,B0:0,shockProbability:0}}],
  links:[{id:'ab',from:'a',to:'b',capacity:1000}]});
 const frozenConfig=w.regions[0].config;w=stepWorld(w);
 close(w.regions[0].state.scenarioEvents.efficiency,.5);close(worldView(w).links[0].flow,90);
 close(worldView(w).regions[1].sH,.9);assert.equal(w.regions[0].config.humanEnergy,2);
 assert.deepEqual(w.regions[0].config,frozenConfig);w=advanceWorld(w,2);
 close(w.regions[0].state.scenarioEvents.efficiency,.5);
 assert.equal(w.regions[0].state.scenarioEvents.history.filter(e=>e.kind==='technology'&&e.type==='event-start').length,3);
});

test('pandemic is an additional temporary mortality rate, expires exactly off grid, and logs start/end',()=>{
 let w=create({pandemicProbability:1,pandemicMortality:.1,pandemicDuration:.15});
 w=stepWorld(w);close(w.t,.1);close(w.regions[0].state.H,10*Math.exp(-.1*.1));
 w=stepWorld(w);close(w.t,.15);close(w.regions[0].state.H,10*Math.exp(-.1*.15));
 assert.equal(w.regions[0].state.scenarioEvents.active.length,0);
 w=stepWorld(w);close(w.t,.2);close(w.regions[0].state.H,10*Math.exp(-.1*.15));
 const h=w.regions[0].state.scenarioEvents.history;
 assert.deepEqual(h.map(e=>[e.type,e.t]),[['event-start',0],['event-end',.15]]);
});

test('disaster loss is separate from annual shocks; overlapping temporary effects compound within bounds',()=>{
 let w=create({pandemicProbability:1,pandemicMortality:.01,pandemicDuration:1.5,
  disasterProbability:1,disasterLoss:.2,disasterDuration:1.5},{dt:.25,
  regions:[{id:'a',config:{H0:1,G0:1000,B0:0,aE0:1,birth:0,death:0,shockProbability:1,shockMagnitude:.1}}]});
 w=stepWorld(w);close(worldView(w).regions[0].rawPower,720);close(w.regions[0].state.shockFactor,.9);
 w=advanceWorld(w,1);assert.equal(w.regions[0].state.scenarioEvents.active.length,4);
 close(worldView(w).regions[0].rawPower,576);
 close(w.regions[0].state.H,Math.exp(-.01*1-.02*.25));
 w=advanceWorld(w,.25);assert.equal(w.regions[0].state.scenarioEvents.active.length,2);
 assert.ok(w.regions[0].state.scenarioEvents.history.some(e=>e.type==='event-end'&&e.t===1.5));
});

test('event RNG/history is policy-independent, no duplicate annual preparation, checkpoint replay is exact',()=>{
 const base=create({technologyProbability:1,pandemicProbability:1,disasterProbability:1,
  pandemicDuration:1.3,disasterDuration:.7});
 const branch=branchWorld(base,{regionId:'a',type:'shutdown',start:.07,delay:.03,cost:1,success:.5,residual:.2});
 const a=advanceWorld(base,2.35),b=advanceWorld(branch,2.35);
 assert.deepEqual(a.regions[0].state.scenarioEvents,b.regions[0].state.scenarioEvents);
 assert.equal(a.regions[0].state.scenarioEvents.history.filter(e=>e.type==='event-start').length,9);
 const restored=restoreWorld(saveWorld(b));assert.deepEqual(restored,b);
 assert.deepEqual(advanceWorld(restored,1.65),advanceWorld(b,1.65));
 for(const mutate of [x=>x.regions[0].state.scenarioEvents.rng++,x=>x.regions[0].state.scenarioEvents.efficiency=.79,
  x=>x.regions[0].state.scenarioEvents.active[0].end++,x=>x.regions[0].state.scenarioEvents.history.pop()]){
  const x=JSON.parse(saveWorld(b));mutate(x);assert.throws(()=>restoreWorld(JSON.stringify(x)));
 }
});

test('bounded event configuration rejects unknown, negative, nonfinite and invalid mode inputs',()=>{
 for(const options of [{eventMode:'bad'},{eventConfig:{unknown:1}},{eventConfig:{technologyProbability:2}},
  {eventConfig:{pandemicMortality:-1}},{eventConfig:{disasterLoss:1}},{eventConfig:{disasterDuration:0}},
  {eventConfig:{maxEfficiency:Infinity}}])assert.throws(()=>createWorld(options));
});

test('restore rejects incomplete regional configurations and impossible demographic counters',()=>{
 const w=advanceWorld(create(),.5);
 for(const mutate of [x=>delete x.regions[0].config.birth,x=>x.regions[0].state.belowYears=40]){
  const x=JSON.parse(saveWorld(w));mutate(x);assert.throws(()=>restoreWorld(JSON.stringify(x)));
 }
});

test('view event records and maximum bounded hazards preserve finite nonnegative stocks and ledgers',()=>{
 let w=create({technologyProbability:1,technologyGain:.5,maxEfficiency:.8,pandemicProbability:1,
  pandemicMortality:.2,pandemicDuration:5,disasterProbability:1,disasterLoss:.8,disasterDuration:5},{dt:.25});
 while(w.t<4-1e-9){
  w=stepWorld(w);const v=worldView(w),r=v.regions[0];
  for(const k of ['H','B','Q','G','F','rawPower','deliveredPower'])assert.ok(Number.isFinite(r[k])&&r[k]>=0);
  const {supply,...paid}=r.ledger;close(supply,Object.values(paid).reduce((a,x)=>a+x,0));
  assert.ok(r.humanEfficiency>=0&&r.humanEfficiency<=.8);assert.ok(r.activePandemicRate>=0);
  assert.ok(r.disasterFactor>=0&&r.disasterFactor<=1);assert.deepEqual(restoreWorld(saveWorld(w)),w);
  for(const e of v.events){
   assert.deepEqual(Object.keys(e),['id','kind','regionId','start','end','magnitude']);
   assert.ok(['tech','pandemic','disaster'].includes(e.kind));assert.equal(e.regionId,'a');assert.ok(e.end>=e.start);
  }
  assert.equal(new Set(v.events.map(e=>e.id)).size,v.events.length);
 }
});

test('restore rejects erasing an already processed event year, including after effect expiry',()=>{
 const w=advanceWorld(create({pandemicProbability:1,pandemicDuration:.15}),.5);
 const x=JSON.parse(saveWorld(w));x.regions[0].state.scenarioEvents=initialEvents(x.regions[0].config.seed);
 assert.throws(()=>restoreWorld(JSON.stringify(x)));
});
