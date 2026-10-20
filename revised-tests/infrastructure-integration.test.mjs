import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun,stepRun,finishRun,saveCheckpoint,restoreCheckpoint} from '../revised/engine.mjs';
import {requestProjects} from '../revised/assets.mjs';
import {planningProjection} from '../revised/dynamics.mjs';
import {selectPortfolio,demandPlan} from '../revised/planning.mjs';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<=1e-9*Math.max(1,Math.abs(expected)),`${actual} != ${expected}`);
const minimal={horizon:1,dt:.25,alignment:1,
 human:{criticalEnergy:1,criticalFloor:1,flexEnergy:0,landPerMillion:0,growth:0,maximumMortality:0},
 initial:{H:1,hardware:0,humanPower:0,aiPower:0,humanFactories:0,aiFactories:0,ageBands:[0]},
 ai:{expansion:0},resources:{constructionEnergyShare:0,policyEnergyShare:0}};

function conserved(run){
 for(const point of run.state.history.slice(1)){
  const l=point.ledger;
  close(l.available,l.generatedEnergy+l.storageDischarge);
  close(l.available,l.humanCritical+l.humanFlexible+l.operation+l.maintenance+l.construction+
   l.policy+l.extraction+l.storageCharge+l.unused);
 }
}

test('TH-N5 inaccessible regional surplus cannot serve humans through undepleted storage',()=>{
 // AI generation has no link to the human zone. The quarter TWh reaching
 // humans must therefore be drawn from central storage even with excess AI generation.
 const start=createRun({...minimal,initial:{...minimal.initial,aiPower:10},
  infrastructure:{grid:{enabled:true},storage:{enabled:true,capacity:1,initial:1,dischargePower:10}}});
 const run=stepRun(start),l=run.state.last.ledger;
 close(l.humanCritical,.25);close(l.storageDischarge,.25);
 close(run.state.infrastructure.storage,.75);close(l.generatedEnergy,2.5);
 close(l.available,2.75);close(l.unused,2.5);conserved(run);
 assert.equal(start.state.infrastructure.storage,1);
});

test('TH-N5 an offered but unused storage discharge never becomes source or unused energy',()=>{
 const start=createRun({...minimal,initial:{...minimal.initial,humanPower:10},
  infrastructure:{storage:{enabled:true,capacity:1,initial:1,dischargePower:10}}});
 const run=stepRun(start),l=run.state.last.ledger;
 close(l.generatedEnergy,2.5);close(l.storageDischarge,0);close(l.available,2.5);
 close(l.unused,2.25);close(run.state.infrastructure.storage,1);conserved(run);
});

test('TH-N4 primary extraction depletes the same paid ore under a whole or two half advances',()=>{
 const options={...minimal,initial:{...minimal.initial,humanPower:100},
  infrastructure:{extraction:{enabled:true,oreStock:1,extractionRate:100,capacity:100,energyPerMaterial:1}}};
 const whole=advanceRun(createRun(options),.25);
 const halves=advanceRun(advanceRun(createRun(options),.125),.125);
 for(const run of [whole,halves]){
  close(run.state.infrastructure.primarySupplied,1);close(run.state.infrastructure.oreRemaining,0);
  close(run.state.infrastructure.extractionEnergy,1);conserved(run);
  assert.ok(run.state.history.some(p=>p.t>0&&p.t<.125),'exact depletion creates an interior boundary');
 }
 assert.deepEqual(whole.state.infrastructure,halves.state.infrastructure);
});

test('TH-N5 stored electricity delivers the same one TWh under a whole or two half advances',()=>{
 const options={...minimal,human:{...minimal.human,criticalEnergy:10,criticalFloor:10},
  infrastructure:{storage:{enabled:true,capacity:1,initial:1,dischargePower:100}}};
 const whole=advanceRun(createRun(options),.25);
 const halves=advanceRun(advanceRun(createRun(options),.125),.125);
 for(const run of [whole,halves]){
  close(run.state.infrastructure.storageDischarged,1);close(run.state.infrastructure.storage,0);
  close(run.state.accounts.humanEnergy,1);conserved(run);
 }
 assert.deepEqual(whole.state.infrastructure,halves.state.infrastructure);
});

test('TH-N5 storage-funded construction resolves a near-unity boundary contraction',()=>{
 // The project costs 99% of stored energy. A fixed-point loop based on storage/h
 // contracts h by 0.99 and cannot be made reliable with an arbitrary iteration cap.
 const base=createRun({...minimal,alignment:0,initial:{...minimal.initial,H:1e-6},
  assets:{hardware:{energy:1,work:0,delay:0}},
  resources:{constructionEnergyShare:1,policyEnergyShare:0},
  infrastructure:{storage:{enabled:true,capacity:1,initial:1,dischargePower:1e6}}});
 const inventory=requestProjects(base.state.assetState,
  [{id:'almost-storage',kind:'hardware',owner:'ai',amount:.99}],0,base.config);
 const run={...base,state:{...base.state,assetState:inventory,nextDecision:1}};
 const stepped=stepRun(run);
 assert.ok(stepped.state.t>0);assert.ok(stepped.state.t<=.25);
 const project=stepped.state.assetState.projects.find(p=>p.requestId==='almost-storage');
 assert.equal(project.status,'completed');close(project.energySpent,.99);
 conserved(stepped);
});

test('TH-N3 a measured negative net baseline remains distinct from shortage mortality',()=>{
 const run=advanceRun(createRun({...minimal,human:{...minimal.human,growth:-.02},
  initial:{...minimal.initial,humanPower:10}}),.25);
 close(run.state.H,Math.exp(-.005));close(run.state.accounts.extraDeaths,0);
 close(run.state.accounts.births,Math.exp(-.005)-1);
 assert.ok(run.state.accounts.births<0);conserved(run);
});

test('TH-N4/N5 every C4 candidate receives current public infrastructure without resetting endowments',()=>{
 const run=advanceRun(createRun({...minimal,human:{...minimal.human,criticalEnergy:10,criticalFloor:10},
  infrastructure:{storage:{enabled:true,capacity:1,initial:1,dischargePower:100}}}),.25);
 assert.equal(run.state.infrastructure.storage,0);
 const observation=planningProjection(run.state,run.config),seen=[];
 selectPortfolio(observation,run.config,.25,query=>{
  assert.deepEqual(query.observation.infrastructure,run.state.infrastructure);
  seen.push(query.observation.infrastructure);
  return {effectiveCompute:0,feasible:true};
 });
 assert.equal(seen.length,6);
 assert.ok(seen.every(snapshot=>snapshot!==observation.infrastructure),'candidate snapshots are detached');
});

test('TH-N7 observed task utilisation drives physical power orders for both workload modes',()=>{
 // A 1 MW block running for one year uses 0.00876 TWh at full power.
 // 100 blocks with idle fraction .2 and useful workload .1 need .24528 TWh/y.
 for(const [workloadMode,hardwareEfficiency,expected] of [
  ['fixed-utilisation',1,.24528],['fixed-work',2,.21024]]){
  const run=createRun({...minimal,initial:{...minimal.initial,hardware:100,hardwareEfficiency},
   ai:{expansion:0,workloadMode,demandSchedule:[{time:0,desiredHardware:100,utilisation:.1}]}});
  const plan=demandPlan(planningProjection(run.state,run.config),run.config,.25);
  close(plan.diagnostics.ai.powerNeed,expected);
 }
});

test('TH-N5/N6 a cooling-curtailed AI load releases deliverable regional surplus for humans',()=>{
 const run=stepRun(createRun({...minimal,initial:{...minimal.initial,hardware:10000,aiPower:10},
  infrastructure:{grid:{enabled:true,aiToHuman:10},cooling:{enabled:true,maxHeatPower:0}}}));
 close(run.state.accounts.operationEnergy,0);close(run.state.accounts.humanEnergy,.25);
 close(run.state.accounts.unusedEnergy,2.25);conserved(run);
});

const fractionStorageOptions=i=>({horizon:2,dt:.25,
 initial:{H:1,hardware:100,humanPower:0,aiPower:0,humanFactories:1,aiFactories:1},
 human:{growth:0,technologyRate:0},infrastructure:{storage:{enabled:true,capacity:i/13,initial:i/13,
  dischargePower:3+i/7,dischargeEfficiency:.11+(i%8)/10}}});

test('TH-N5 tiny fractional residual storage remains spendable through the next representable instant',()=>{
 // This formerly stopped at t=0.028946533768569066 with a positive 9.6e-20 TWh stock.
 const run=finishRun(createRun(fractionStorageOptions(3)));
 assert.equal(run.state.t,2);conserved(run);
 const restored=restoreCheckpoint(saveCheckpoint(run));
 assert.deepEqual(restored.state.infrastructure,run.state.infrastructure);
});

for(let i=1;i<=80;i++)test(`TH-N5 fractional storage ${i}/13 preserves finite debits and checkpoint replay`,()=>{
 const options=fractionStorageOptions(i),run=finishRun(createRun(options)),state=run.state.infrastructure;
 assert.equal(run.state.t,2);assert.ok(state.storage>=0);conserved(run);
 close(state.storage+state.storageDischarged/options.infrastructure.storage.dischargeEfficiency,
  options.infrastructure.storage.initial+state.storageCharged);
 const restored=restoreCheckpoint(saveCheckpoint(run));
 assert.deepEqual(restored.state.infrastructure,state);
});
