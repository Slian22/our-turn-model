import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,stepWorld,advanceWorld,branchWorld,restoreWorld,saveWorld} from '../spatial/world.mjs';

const imported=world=>JSON.parse(saveWorld(world));
const restore=x=>restoreWorld(JSON.stringify(x));
const roundtrip=world=>assert.deepEqual(restoreWorld(saveWorld(world)),world);

test('R02 generated large-supply checkpoint uses the integration ledger tolerance and continues exactly',()=>{
 let world=createWorld({horizon:100,dt:1,workScale:100,workWeights:{power:.1},
  regions:[{id:'r',config:{H0:0,B0:1,G0:1e7,F0:1e8,aE0:1,aF0:1,land:1.5e8,landPower:.001,landFab:0,
   hardwareGrowth:0,fabGrowth:0,powerGrowth:.2,embodiedPower:.01,industryEnergy:0,shockProbability:0,improvement:'none'}}],links:[]});
 for(let i=0;i<75;i++)world=stepWorld(world);
 assert.ok(Math.abs(world.regions[0].state.energyResidual)>1e-5);
 const restored=restoreWorld(saveWorld(world));assert.deepEqual(restored,world);
 assert.deepEqual(stepWorld(restored),stepWorld(world));
 for(const residual of [1e6,null]){
  const x=imported(world);x.regions[0].state.energyResidual=residual;assert.throws(()=>restore(x));
 }
 const x=imported(world);x.regions[0].state.ledger.unused-=1000;assert.throws(()=>restore(x));
});

for(const field of ['weight','extra'])test(`R03 restored outcome windows reject unknown ${field} fields`,()=>{
 const world=advanceWorld(createWorld({horizon:1,dt:.05,alignment:1,eventMode:'scenario',
  eventConfig:{technologyProbability:0,pandemicProbability:0,disasterProbability:1,disasterLoss:.8,disasterDuration:.05},
  regions:[{id:'r',config:{H0:10,G0:20,B0:0,F0:0,aE0:1,birth:0,death:0,shortfall:0,shockProbability:0}}],links:[]}),.1);
 roundtrip(world);
 const x=imported(world);x.regions[0].state.window.at(-1)[field]=1000;
 assert.throws(()=>restore(x),/Unknown outcome window key/);
});

for(const kind of ['hardware','power','factory','powerAutomation','fabAutomation'])test(`R04 ${kind} cannot commission before its configured lead time`,()=>{
 const world=stepWorld(createWorld({horizon:4,regions:[{id:'r',config:{shockProbability:0}}],links:[]}));
 const x=imported(world),project=x.regions[0].state.queue.find(p=>p.kind===kind);assert.ok(project);
 project.requestedDue=.0625;project.due=.0625;
 assert.throws(()=>restore(x),/project order time/);
});

test('R04 requested due dates cannot imply orders after the checkpoint',()=>{
 const world=stepWorld(createWorld({horizon:4,regions:[{id:'r',config:{shockProbability:0}}],links:[]}));
 const x=imported(world),project=x.regions[0].state.queue.find(p=>p.kind==='hardware');
 project.requestedDue=3;project.due=3;
 assert.throws(()=>restore(x),/project order time/);
});

test('R04 canonical commissioning is the prescribed rounded requested date, not any later grid tick',()=>{
 const world=stepWorld(createWorld({horizon:4,regions:[{id:'r',config:{shockProbability:0}}],links:[]}));
 const x=imported(world),project=x.regions[0].state.queue.find(p=>p.kind==='hardware');
 project.due+=world.config.dt;
 assert.throws(()=>restore(x),/project commissioning/);
});

test('R04 genuine off-grid order times and canonical commissioning round-trip at multiple dt values',()=>{
 for(const dt of [.005,.1,1]){
  let world=createWorld({horizon:4,dt,regions:[{id:'r',config:{shockProbability:0,
   hardwareDelay:.27,powerDelay:.37,fabDelay:.47,automationDelay:.57}}],links:[]});
  world=branchWorld(world,{regionId:'r',type:'cap',start:.07,delay:0,cost:0,duration:.11,cap:1000});
  for(const target of [.07,.1,.18,.4,1]){
   world=advanceWorld(world,target-world.t);roundtrip(world);
   assert.deepEqual(stepWorld(restoreWorld(saveWorld(world))),stepWorld(world));
  }
 }
});

test('R06 omitted wiring accepts long names and generates bounded unique IDs without changing the star',()=>{
 const names=['root','a'.repeat(58),'a'.repeat(64),'a'.repeat(63)+'b','regional-link-1','1','hearth-1'];
 const world=createWorld({regions:names.map(id=>({id}))});
 assert.equal(world.links.length,names.length-1);
 assert.equal(new Set(world.links.map(l=>l.id)).size,world.links.length);
 world.links.forEach((l,i)=>{
  assert.match(l.id,/^[a-zA-Z0-9_-]{1,64}$/);assert.equal(l.from,'root');assert.equal(l.to,names[i+1]);assert.equal(l.capacity,1000);
 });
 roundtrip(world);
});

test('R06 ordinary default and short-name wiring retain their IDs and ordering',()=>{
 assert.deepEqual(createWorld().links.map(l=>l.id),['hearth-upland','hearth-sunbelt','hearth-delta','hearth-plateau','hearth-coast','hearth-frontier']);
 assert.deepEqual(createWorld({regions:[{id:'root'},{id:'other'}]}).links.map(l=>l.id),['hearth-other']);
});
