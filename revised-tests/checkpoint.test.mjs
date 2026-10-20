import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun,finishRun,saveCheckpoint,restoreCheckpoint,branchRun} from '../revised/engine.mjs';
import {requestProjects} from '../revised/assets.mjs';
import {configurationId} from '../revised/identity.mjs';

const clone=run=>structuredClone(run);
const fresh=()=>clone(createRun({horizon:3}));
const encode=run=>JSON.stringify(run);
const rejects=run=>assert.throws(()=>restoreCheckpoint(encode(run)),/checkpoint|finite|Invalid/i);
function pending(){
 const run=fresh();run.state.assetState=requestProjects(run.state.assetState,
  [{id:'review-hardware',kind:'hardware',owner:'ai',amount:1}],0,run.config);return run;
}

test('initial, advanced and branched checkpoints round trip exactly',()=>{
 for(const run of [createRun({horizon:3}),advanceRun(createRun({horizon:3}),1.5),
  branchRun(advanceRun(createRun({horizon:3}),1),{mode:'fixed',start:1,type:'cap',cost:0,work:0})]){
  const saved=saveCheckpoint(run);assert.equal(saveCheckpoint(restoreCheckpoint(saved)),saved);
 }
});
test('lossless table checkpoints restore every run field and retain legacy small exports',async()=>{
 const {encodeCheckpoint}=await import('../revised/checkpoint-codec.mjs');
 for(const run of [createRun({horizon:3}),advanceRun(createRun({horizon:3}),1.5),
  branchRun(advanceRun(createRun({horizon:3}),1),{mode:'fixed',start:1,type:'cap'})]){
  assert.equal(JSON.stringify(restoreCheckpoint(JSON.stringify(encodeCheckpoint(run)))),JSON.stringify(run));
  assert.equal(saveCheckpoint(run),JSON.stringify(run),'Small raw checkpoints retain their original representation');
 }
});
test('checkpoint file limits apply to UTF-8 bytes before parsing',()=>{
 assert.throws(()=>restoreCheckpoint('"'+'\u4e16'.repeat(8_500_000)+'"'),RangeError);
});
test('legacy saves reject hidden metadata and accessors before JSON can drop or evaluate them',()=>{
 for(const mutate of [
  r=>Object.defineProperty(r.state.accounts,'hidden',{value:999,enumerable:false}),
  r=>{r.state.accounts[Symbol('hidden')]=999;},
  r=>{r.state.assetState.assets.extra=999;},
 ]){const run=fresh();mutate(run);assert.throws(()=>saveCheckpoint(run),/codec|checkpoint|JSON/i);}
 const run=fresh();let calls=0;
 Object.defineProperty(run.state.accounts,'personYears',{enumerable:true,get(){calls++;return 0;}});
 assert.throws(()=>saveCheckpoint(run),/codec|checkpoint|JSON/i);assert.equal(calls,0,'Serialization must not execute getters');
});
test('legacy and table formats share the observed-policy schema',()=>{
 const run=fresh(),row={t:0,observedAt:0,arbitrary:999};
 run.state.policyState.controller.history=[row];run.state.policyState.controller.known=row;
 assert.throws(()=>saveCheckpoint(run),/checkpoint|field|observation/i);
 rejects(run);
});

function observationAvailability(run,value){
 const next=clone(run);
 for(const policy of [next.state.policyState,...next.state.policyArchive]){
  const controller=policy.controller;
  for(const row of [...controller.history,...controller.pending,...(controller.known?[controller.known]:[])]){
   if(value===undefined)delete row.powerAvailability;else row.powerAvailability=value;
  }
 }
 return next;
}
test('observed power availability survives raw and table storage without dropping legacy observations',async()=>{
 const {encodeCheckpoint}=await import('../revised/checkpoint-codec.mjs');
 const base=advanceRun(createRun({horizon:1,policy:{observationDelay:0}}),.125);
 assert.ok(base.state.policyState.controller.history.length>0);
 for(const value of [0,.5,1,undefined]){
  const run=observationAvailability(base,value),raw=JSON.stringify(run);
  assert.equal(JSON.stringify(restoreCheckpoint(raw)),raw);
  assert.equal(JSON.stringify(restoreCheckpoint(JSON.stringify(encodeCheckpoint(run)))),raw);
  assert.equal(saveCheckpoint(run),raw);
 }
});
test('malformed observed power availability rejects in both public checkpoint formats',async()=>{
 const {encodeCheckpoint}=await import('../revised/checkpoint-codec.mjs');
 const base=advanceRun(createRun({horizon:1,policy:{observationDelay:0}}),.125);
 for(const value of [-.01,1.01,NaN,Infinity,'0.5',null]){
  const run=observationAvailability(base,value);
  assert.throws(()=>saveCheckpoint(run),/checkpoint|observation|powerAvailability|finite/i);
  assert.throws(()=>restoreCheckpoint(JSON.stringify(run)),/checkpoint|observation|powerAvailability|finite/i);
  assert.throws(()=>restoreCheckpoint(JSON.stringify(encodeCheckpoint(run))),/checkpoint|observation|powerAvailability|finite/i);
 }
});

test('valid time-zero events and no-AI controls round trip before processing',()=>{
 for(const aiEnabled of [true,false]){
  const run=createRun({horizon:3,aiEnabled,events:[{id:'zero',type:'algorithm',time:0,magnitude:2}]});
  const text=saveCheckpoint(run);assert.equal(saveCheckpoint(restoreCheckpoint(text)),text);
 }
});
test('unmodified annual event, policy and branch streams replay exactly',()=>{
 const run=advanceRun(createRun({horizon:3,eventMode:'annual',annualProbability:1,
  policy:{mode:'fixed',start:.5,delay:.25,type:'shutdown'}}),1.5);
 for(const candidate of [run,branchRun(run,{mode:'fixed',start:2,type:'cap'})]){
  const restored=restoreCheckpoint(saveCheckpoint(candidate));
  assert.equal(saveCheckpoint(finishRun(restored)),saveCheckpoint(finishRun(candidate)));
 }
});
test('forged fully paid progress cannot shorten lead or erase energy/work funding',()=>{
 const run=pending(),p=run.state.assetState.projects[0];
 p.readyAt=0;p.energyRequired=0;p.progress=1;p.workDone=p.workRequired;
 p.remainingEnergy=0;p.remainingWork=0;run.state.assetState.accounts.workDone=p.workDone;rejects(run);
 const work=pending(),q=work.state.assetState.projects[0];
 q.progress=1;q.energySpent=q.energyRequired;q.workDone=q.workRequired;q.remainingEnergy=q.remainingWork=0;
 work.state.assetState.accounts.energySpent=q.energySpent;work.state.assetState.accounts.workDone=q.workDone;rejects(work);
});
test('new cohorts require a bijective completed construction project',()=>{
 const run=fresh(),a=clone(run.state.assetState.assets.find(a=>a.kind==='power'));
 Object.assign(a,{id:`asset-${run.state.assetState.nextId++}`,birth:0,rated:1e6,
  footprint:0,materials:0,embodiedEnergy:0,embodiedWork:0});run.state.assetState.assets.push(a);rejects(run);
});
test('initial efficiency and intrinsic adopted technology require paid provenance',()=>{
 for(const mutate of [r=>{r.state.assetState.assets[0].hardwareEfficiency=1000;},
  r=>{r.state.assetState.assets[0].manufacturingEfficiency=1000;},r=>{r.state.technology.algorithm=2;}]){
  const run=fresh();mutate(run);rejects(run);
 }
});
test('event adoption cannot outrun its pending paid project',()=>{
 const run=clone(advanceRun(createRun({horizon:3,events:[{id:'adopt',type:'algorithm',time:.5,
  magnitude:5,adoptionDelay:10,adoptionEnergy:999,adoptionWork:999}]}),.625));
 const record=run.state.eventState.records[0];record.adoptionStatus='adopted';record.adoptedAt=.5;
 run.state.eventState.adoptedIds=[record.id];rejects(run);
});
test('request cache and asset receipts must identify their actual project and amount',()=>{
 for(const mutate of [r=>{r.state.assetState.requestIds={};},
  r=>{r.state.assetState.requestIds['review-hardware'].receipt.projectId='project-999';},
  r=>{r.state.assetState.requestIds['review-hardware'].receipt.amount=200;},
  r=>{r.state.assetState.receipts=[{requestId:'missing',kind:'adoption',status:'completed',completedAt:0}];}]){
  const run=pending();mutate(run);rejects(run);
 }
});
test('finite input scalars cannot overflow derived physical capacity',()=>{
 const run=fresh();run.state.assetState.assets[0].hardwareEfficiency=1e308;rejects(run);
});
test('recomputed configuration identity does not excuse incompatible physical lead',()=>{
 const run=pending();run.config.assets.hardware.delay=10;run.configId=configurationId(run.config);rejects(run);
});
test('recomputed growth and demographic configuration must match recorded interval dynamics',()=>{
 for(const mutate of [r=>{r.config.ai.growth*=2;},r=>{r.config.human.growth*=2;}]){
  const run=clone(advanceRun(createRun({horizon:3}),.5));mutate(run);run.configId=configurationId(run.config);rejects(run);
 }
 const initial=fresh();initial.state.q=initial.state.history[0].q=1e308;rejects(initial);
});
test('completed funding requires exact full progress, including tiny projects',()=>{
 const run=fresh();run.state.assetState=requestProjects(run.state.assetState,
  [{id:'tiny',kind:'hardware',owner:'ai',amount:1e-9}],0,run.config);
 run.state.assetState.projects[0].energyRequired=0;rejects(run);
});
test('unpaid demolition cannot release land or recycled material with balanced aggregates',()=>{
 const run=clone(advanceRun(createRun({horizon:3,initial:{ageBands:[0]},assets:{hardware:{life:.1}},
  resources:{constructionEnergyShare:0}}),.5));
 const a=run.state.assetState.assets.find(a=>a.kind==='hardware');a.cleared=true;a.clearedAt=run.state.t;
 const recycled=a.materials*run.config.resources.recycling;
 run.state.assetState.materials+=recycled;run.state.assetState.accounts.recycledRecovered+=recycled;
 run.state.assetState.accounts.materialsDisposed+=a.materials-recycled;rejects(run);
});
test('unpaid active policy and forged cancelling funding receipts reject',()=>{
 const run=clone(advanceRun(createRun({horizon:3,policy:{mode:'fixed',type:'cap',start:0,delay:2,
  cost:999,work:999,cap:0,coverage:1}}),.5));run.state.policyState.actions[0].status='active';rejects(run);
 const receipts=clone(advanceRun(createRun({horizon:3,policy:{mode:'fixed',type:'cap',start:0,cost:2,work:2}}),.5));
 receipts.state.policyState.receipts.push(
  {id:'positive',requestId:'missing',kind:'policy-funding',time:999,intervalStart:999,energy:1000,work:1000},
  {id:'negative',requestId:'missing',kind:'policy-funding',time:-1,intervalStart:-1,energy:-1000,work:-1000});rejects(receipts);
});
test('history must reconcile actual construction work and physical energy sources',()=>{
 const base=advanceRun(createRun({horizon:3}),.5),work=clone(base);
 for(const point of work.state.history.slice(1))point.ledger.constructionWork=0;
 work.state.last.ledger.constructionWork=0;rejects(work);
 const source=clone(base),ledger=source.state.history[1].ledger;
 ledger.available+=1000;ledger.unused+=1000;ledger.sourcePower=ledger.available/ledger.h;
 source.state.accounts.availableEnergy+=1000;source.state.accounts.unusedEnergy+=1000;rejects(source);
});
test('scheduler and nested schema fields are bound to valid checkpoint state',()=>{
 const scheduler=clone(advanceRun(createRun({horizon:3}),.5));scheduler.state.nextDecision=1e9;rejects(scheduler);
 const unknown=fresh();unknown.state.history[0].unrecognized=123;rejects(unknown);
});
test('genuinely paid targeted retrofit and event adoption retain replay and efficiency',()=>{
 let run=clone(createRun({horizon:3,ai:{growth:0},initial:{hardware:2,ageBands:[0]},
  events:[{id:'paid',type:'algorithm',time:.25,magnitude:2,adoptionEnergy:1,adoptionWork:1,adoptionDelay:.25}]}));
 run.state.assetState=requestProjects(run.state.assetState,[{id:'paid-retrofit',kind:'retrofit',owner:'ai',amount:2,
  target:'hardware',targetIds:[run.state.assetState.assets[0].id],multiplier:2}],0,run.config);
 run=advanceRun(run,2);const restored=restoreCheckpoint(saveCheckpoint(run));
 assert.equal(restored.state.assetState.assets[0].hardwareEfficiency,2);
 assert.equal(restored.state.eventState.records[0].adoptionStatus,'adopted');
 assert.equal(saveCheckpoint(finishRun(restored)),saveCheckpoint(finishRun(run)));
});
test('checkpoint consistency rejects free resources, unpaid progress and forged history',()=>{
 const base=JSON.parse(saveCheckpoint(advanceRun(createRun({horizon:3}),1.5)));
 for(const corrupt of [
  r=>{r.state.assetState.materials+=1;},
  r=>{r.state.assetState.projects[0].progress=2;},
  r=>{r.state.H*=2;},
  r=>{r.state.history[1].ledger.operation+=1;},
  r=>{r.state.eventState.rngState^=1;},
  r=>{r.config.ai.growth*=2;},
  r=>{r.state.unknownField=1;},
  r=>{r.state.assetState.nextId=1;},
 ]){
  const r=structuredClone(base);corrupt(r);assert.throws(()=>restoreCheckpoint(JSON.stringify(r)));
 }
});
test('completed projects require exact full progress even inside accounting tolerances',()=>{
 const run=clone(advanceRun(createRun({horizon:3,events:[{id:'small-debt',type:'algorithm',time:0,
  magnitude:2,adoptionEnergy:1,adoptionWork:1,adoptionDelay:0}]}),.5));
 const p=run.state.assetState.projects.find(p=>p.eventId==='small-debt');assert.equal(p.status,'completed');
 const epsilon=1e-10;p.progress=1-epsilon;p.energySpent=p.energyRequired*p.progress;p.workDone=p.workRequired*p.progress;
 p.remainingEnergy=p.energyRequired-p.energySpent;p.remainingWork=p.workRequired-p.workDone;
 run.state.assetState.accounts.energySpent-=p.remainingEnergy;run.state.assetState.accounts.workDone-=p.remainingWork;
 rejects(run);
});
test('cached last measurements and world account fields cannot forge policy signals or summaries',()=>{
 const base=clone(advanceRun(createRun({horizon:3}),.5));
 for(const corrupt of [
  r=>{r.state.last.deficit=.7;},r=>{r.state.last.criticalAdequacy=7;},
  r=>{r.state.last.researchCapacity+=100;},r=>{r.state.last.effectiveCompute+=100;},
  r=>{r.state.last.energyAdequacy=-1;},r=>{r.state.last.landAdequacy=.3;},
  r=>{r.state.accounts.unrecognized=1;},
 ]){const run=clone(base);corrupt(run);rejects(run);}
});
