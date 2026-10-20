import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,stepWorld,advanceWorld,branchWorld,saveWorld,restoreWorld} from '../spatial/world.mjs';
import {prepareRegion,integrateRegion} from '../spatial/local.mjs';
import {historyPoint} from '../spatial/observe.mjs';
import {uniform} from '../sim/rng.mjs';

const isolated=()=>createWorld({horizon:4,regions:[{id:'r',config:{shockProbability:0}}],links:[]});

test('RIR-01: imports reject unsafe counters and counters without allocation headroom',()=>{
 const world=stepWorld(isolated());
 for(const counter of [2**53,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER-4]){
  const data=JSON.parse(saveWorld(world));data.regions[0].state.nextProjectId=counter;
  assert.throws(()=>restoreWorld(JSON.stringify(data)),/project.*(counter|identifier|headroom)/i);
 }
});

test('RIR-01: imported counters cannot exceed five allocations per retained step',()=>{
 const world=stepWorld(isolated()),data=JSON.parse(saveWorld(world));
 data.regions[0].state.nextProjectId=100;
 assert.throws(()=>restoreWorld(JSON.stringify(data)),/project.*(counter|history)/i);
});

test('RIR-01: local allocation fails before generating unsafe or duplicate identifiers',()=>{
 const world=isolated(),region=prepareRegion(world.regions[0],world.config),before=saveWorld(world);
 for(const nextProjectId of [2**53,Number.MAX_SAFE_INTEGER-4]){
  const altered={...region,state:{...region.state,nextProjectId}};
  assert.throws(()=>integrateRegion(altered,{deliveredPower:28000,h:world.config.dt},world.config),
   /project.*(identifier|counter|limit|headroom)/i);
 }
 assert.equal(saveWorld(world),before);
});

test('RIR-01: the last exactly representable allocation has distinct safe IDs',()=>{
 const world=isolated(),region=prepareRegion(world.regions[0],world.config);
 const nextProjectId=Number.MAX_SAFE_INTEGER-5;
 const next=integrateRegion({...region,state:{...region.state,nextProjectId}},
  {deliveredPower:28000,h:world.config.dt},world.config);
 assert.equal(next.state.queue.length,5);
 assert.equal(next.state.nextProjectId,Number.MAX_SAFE_INTEGER);
 assert.equal(new Set(next.state.queue.map(p=>p.id)).size,5);
 assert.ok(next.state.queue.every(p=>Number.isSafeInteger(p.id)));
 assert.throws(()=>integrateRegion(prepareRegion(next,world.config),
  {deliveredPower:28000,h:world.config.dt},world.config),/project.*(identifier|counter|limit|headroom)/i);
});

test('RIR-02: imported tiny positive-cost attempts require actual completed work',()=>{
 for(const cost of [1e-11,1e-20])for(const funding of [0,cost/2]){
  let world=createWorld({horizon:1,regions:[{id:'r',config:{G0:0}}],links:[]});
  world=branchWorld(world,{regionId:'r',type:'shutdown',start:0,delay:0,cost,success:1,residual:0});
  world=stepWorld(world);assert.deepEqual(world.regions[0].state.policyLog,[]);
  const data=JSON.parse(saveWorld(world)),s=data.regions[0].state,draw=uniform(s.rng.policy);
  s.policyFunding=[funding];s.policyLog=[{index:0,t:0,outcome:'success',draw:draw.value}];
  s.rng.policy=draw.state;s.shutdown=true;s.residual=0;
  assert.throws(()=>restoreWorld(JSON.stringify(data)),/unfunded attempt/);
 }
});

test('RIR-02: free and fully funded tiny attempts still roundtrip and charge correctly',()=>{
 for(const cost of [0,1e-11]){
  let world=createWorld({horizon:1,regions:[{id:'r',config:{G0:1,H0:0,B0:0,F0:0,aE0:1,shockProbability:0}}],links:[]});
  world=branchWorld(world,{regionId:'r',type:'shutdown',start:0,delay:0,cost,success:1,residual:0});
  world=advanceWorld(world,1);
  assert.equal(world.regions[0].state.policyLog.length,1);
  assert.equal(world.regions[0].state.policyFunding[0],cost);
  assert.equal(world.regions[0].state.policyLog[0].t,cost);
  assert.deepEqual(restoreWorld(saveWorld(world)),world);
 }
});

const region=(id,H0,G0,humanEnergy=2)=>({id,config:{H0,G0,humanEnergy,humanLand:1,
 B0:0,F0:0,aE0:1,shockProbability:0,birth:0,death:0,shortfall:0}});
const transit=(raw=1e-12,reverse=false)=>createWorld({alignment:1,
 regions:[region('d',0,1e7),region('hub',raw/2,raw),region('s',20000,0,20)],
 links:[{id:'dh',from:'d',to:'hub',capacity:1e9},{id:'hs',from:'hub',to:'s',capacity:1e9}]
  .map(l=>reverse?{...l,from:l.to,to:l.from}:l)});

for(const reverse of [false,true])for(const raw of [1e-12,1e-8])
 test(`RIR-03: transit preserves local generation ${raw} with reverse=${reverse}`,()=>{
  const world=stepWorld(transit(raw,reverse)),hub=world.regions[1];
  assert.deepEqual(world.links.map(l=>l.flow),[reverse?-400000:400000,reverse?-400000:400000]);
  assert.equal(hub.power.imports,400000);assert.equal(hub.power.exports,400000);
  assert.equal(hub.power.deliveredPower,raw);assert.equal(hub.state.ledger.supply,raw);
  assert.equal(hub.state.sH,1);
  assert.deepEqual(restoreWorld(saveWorld(world)),world);
 });

test('RIR-03: checkpoint balance rejects a wholly erased tiny local delivery',()=>{
 const data=JSON.parse(saveWorld(stepWorld(transit()))),hub=data.regions[1];
 hub.power.deliveredPower=0;
 hub.state.ledger={supply:0,human:0,operation:0,research:0,construction:0,industry:0,policy:0,unused:0};
 hub.state.energyResidual=0;hub.state.sH=0;hub.state.minAdequacy=0;hub.state.window.at(-1).s=0;
 data.history[data.history.length-1]=historyPoint(data);
 assert.throws(()=>restoreWorld(JSON.stringify(data)),/power balance/);
});
