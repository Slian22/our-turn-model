import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun,finishRun,saveCheckpoint,restoreCheckpoint} from '../revised/engine.mjs';
import {encodeCheckpoint} from '../revised/checkpoint-codec.mjs';

const clone=value=>structuredClone(value);
const advanced=()=>advanceRun(createRun({horizon:2}),.5);
function rejectsBoth(run){
 assert.throws(()=>restoreCheckpoint(JSON.stringify(run)),/checkpoint|Invalid|finite|Infrastructure/i);
 assert.throws(()=>restoreCheckpoint(JSON.stringify(encodeCheckpoint(run))),/checkpoint|Invalid|finite|Infrastructure/i);
}

test('MEM measurements and population extrema survive raw/table checkpoint continuation',()=>{
 for(const initial of [true,false]){
  const run=initial?createRun({horizon:2}):advanced();
  assert.equal(typeof run.state.accounts.qolPersonYears,'number');
  assert.equal(typeof run.state.accounts.maxPopulation,'number');
  for(const row of run.state.history){
   assert.equal(typeof row.qualityOfLife,'number');
   assert.equal(typeof row.perCapitaElectricity,'number');
   assert.equal(typeof row.qolPersonYears,'number');
  }
  for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
   const restored=restoreCheckpoint(text);
   assert.deepEqual(restored,run);
   assert.deepEqual(finishRun(restored),finishRun(run));
  }
 }
});

test('adjacent floating-point retirement boundaries preserve exact physical priority replay',()=>{
 const run=advanceRun(createRun({horizon:3,dt:.1,alignment:0,policy:{mode:'none'},eventMode:'off',events:[]}),2.3);
 assert.ok(run.state.history.some(p=>p.ledger?.start===1.2&&p.ledger.end===1.2000000000000002));
 for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
  const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
  assert.deepEqual(finishRun(restored),finishRun(run));
 }
});

test('time-zero checkpoints retain unmeasured welfare and exact initial extrema',()=>{
 const run=createRun({horizon:2});
 assert.equal(run.state.last,null);
 assert.equal(run.state.history[0].qualityOfLife,0);
 assert.equal(run.state.history[0].perCapitaElectricity,0);
 assert.equal(run.state.accounts.qolPersonYears,0);
 assert.equal(run.state.accounts.maxPopulation,run.config.initial.H);
 const forged=clone(run);forged.state.accounts.minPopulation-=1;rejectsBoth(forged);
});

test('current exposure and every cumulative history demographic cell are replay-bound',()=>{
 for(const mutate of [
  r=>{r.state.exposure=r.state.exposure===0?.5:0;},
  r=>{r.state.history[0].extraDeaths=1;},
  r=>{r.state.history[1].extraDeaths+=1;},
  r=>{r.state.history[1].shortagePersonYears+=1;},
 ]){const run=clone(advanced());mutate(run);rejectsBoth(run);}
});

test('population extrema and starvation episode/duration totals are interval-replayed',()=>{
 for(const field of ['minPopulation','maxPopulation','minAdequacy','shortageYears','shortageEpisodes',
  'energyShortfall','landShortfallPersonYears']){
  const run=clone(advanced());
  run.state.accounts[field]=field==='minPopulation'?run.state.accounts[field]-1:run.state.accounts[field]+1;
  rejectsBoth(run);
 }
});

test('maximum population includes a demographic turning point between saved samples',()=>{
 const run=advanceRun(createRun({horizon:1,human:{growth:.01,maximumMortality:.5,exposureTime:.25},
  infrastructure:{outages:[{start:0,duration:1,zone:'both',availability:.1}]}}),.5);
 const sampledMaximum=Math.max(...run.state.history.map(row=>row.H));
 assert.ok(run.state.accounts.maxPopulation>sampledMaximum,
  'Exposure growth can turn population downward before the first sampled endpoint');
 assert.deepEqual(restoreCheckpoint(saveCheckpoint(run)),run);
 const forged=clone(run);forged.state.accounts.maxPopulation=sampledMaximum;rejectsBoth(forged);
});

test('delivered MEM welfare and cumulative welfare person-years reject forged cached summaries',()=>{
 for(const mutate of [
  r=>{r.state.last.qualityOfLife=.123456;},
  r=>{r.state.last.perCapitaElectricity=123.456;},
  r=>{r.state.history[0].qualityOfLife=.1;},
  r=>{r.state.history[1].qualityOfLife=.123456;},
  r=>{r.state.history[1].perCapitaElectricity=123.456;},
  r=>{r.state.history[1].qolPersonYears+=1;},
  r=>{r.state.accounts.qolPersonYears+=1;},
 ]){const run=clone(advanced());mutate(run);rejectsBoth(run);}
});

test('dimensionless priority measurements are physically bound in checkpoint replay',()=>{
 const base=advanced();assert.ok(base.state.last.priority);
 for(const mutate of [
  r=>{r.state.last.priority.aiScore+=1;},
  r=>{r.state.last.priority.humanScore+=1;},
  r=>{r.state.last.priority.winner=r.state.last.priority.winner==='ai'?'human':'ai';},
  r=>{r.state.last.priority.extra=1;},
  r=>{const v=r.state.last.priority.aiScore+1;r.state.last.ledger.aiPriorityScore=v;r.state.history.at(-1).ledger.aiPriorityScore=v;r.state.last.priority.aiScore=v;},
  r=>{const v=r.state.last.priority.humanScore+1;r.state.last.ledger.humanPriorityScore=v;r.state.history.at(-1).ledger.humanPriorityScore=v;r.state.last.priority.humanScore=v;},
 ]){const run=clone(base);mutate(run);rejectsBoth(run);}
});

test('optional infrastructure and paid primary extraction survive both checkpoint formats',()=>{
 const run=advanceRun(createRun({horizon:2,infrastructure:{
  extraction:{enabled:true,oreStock:100,extractionRate:.1,capacity:10,energyPerMaterial:1,workPerMaterial:1},
  storage:{enabled:true,capacity:100,initial:50,chargePower:10,dischargePower:10,chargeEfficiency:.9,dischargeEfficiency:.8},
  grid:{enabled:true,humanReliability:.95,aiReliability:.9,humanToAi:100,aiToHuman:100,loss:.05},
 }}),.5);
 assert.ok(run.state.infrastructure.primarySupplied>0);
 assert.equal(run.state.assetState.accounts.primarySupplied,run.state.infrastructure.primarySupplied);
 for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
  const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
  assert.deepEqual(finishRun(restored),finishRun(run));
 }
});

test('balanced material inflow cannot claim extraction absent from interval ledgers',()=>{
 const run=clone(advanceRun(createRun({horizon:2,infrastructure:{extraction:{enabled:true,
  oreStock:100,extractionRate:.1,capacity:10,energyPerMaterial:1,workPerMaterial:1}}}),.5));
 run.state.infrastructure.primarySupplied+=1;run.state.infrastructure.oreRemaining-=1;
 run.state.infrastructure.extractionEnergy+=1;run.state.infrastructure.extractionWork+=1;
 run.state.assetState.accounts.primarySupplied+=1;run.state.assetState.materials+=1;
 rejectsBoth(run);
});

test('infrastructure state rejects hidden mechanisms and forged storage/mining/water accumulators',()=>{
 for(const mutate of [
  r=>{r.state.infrastructure.extra=1;},
  r=>{r.state.infrastructure.storage+=1;},
  r=>{r.state.infrastructure.oreRemaining+=1;},
  r=>{r.state.infrastructure.extractionEnergy+=1;},
  r=>{r.state.infrastructure.waterConsumed+=1;},
 ]){const run=clone(advanced());mutate(run);rejectsBoth(run);}
});

test('service/cooling limits, exact outage boundaries and demographic schedules resume identically',()=>{
 const scenarios=[
  {infrastructure:{services:{enabled:true,foodPerPerson:1,foodSupply:2e9,waterPerPerson:1,waterSupply:3e9}}},
  {infrastructure:{cooling:{enabled:true,waterAvailable:1e9,wue:1,ewif:.1,pue:1.2,maxHeatPower:1000,
   temperature:30,referenceTemperature:20,deratingPerDegree:.01}}},
  {infrastructure:{outages:[{start:.13,duration:.07,zone:'both',availability:0}]}},
  {human:{growthSchedule:[{time:.14,growth:.02},{time:.31,growth:0}]},
   initial:{powerAgeBands:[0,.3],factoryAgeBands:[.2],hardwareAgeBands:[.1,.4]}},
 ];
 for(const config of scenarios){
  const run=advanceRun(createRun({horizon:1,...config}),.5);
  for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
   const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
   assert.deepEqual(finishRun(restored),finishRun(run));
  }
 }
});

test('diagnostic interval extrema, physical constraints and material availability are replay-bound',()=>{
 const base=advanced(),ledger=base.state.last.ledger;
 const fields=['minimumPopulation','maximumPopulation','landAdequacy','materialFree','policyAccess',
  'regionalPowerLimited','storageLimited','coolingWaterLimited','heatLimited','refiningLimited','workLimited','energyLimited'];
 for(const field of fields)assert.equal(typeof ledger[field],'number',`${field} is a numeric wire cell`);
 assert.deepEqual(restoreCheckpoint(saveCheckpoint(base)),base);
 for(const field of fields){
  const run=clone(base),value=field.endsWith('Limited')||field==='policyAccess'?1-ledger[field]:ledger[field]+1;
  run.state.last.ledger[field]=value;run.state.history.at(-1).ledger[field]=value;
  rejectsBoth(run);
 }
});

test('observed AI demand/efficiency schedules retain raw and table checkpoint priority replay',()=>{
 for(const workloadMode of ['fixed-utilisation','fixed-work']){
  const run=advanceRun(createRun({horizon:1,initial:{hardwareEfficiency:2,manufacturingEfficiency:3},
   ai:{workloadMode,demandSchedule:[{time:.13,desiredHardware:120000,utilisation:.2},
    {time:.31,desiredHardware:130000,utilisation:.9}]}}),.5);
  for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
   const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
   assert.deepEqual(finishRun(restored),finishRun(run));
  }
 }
});

test('signed baseline demographic decline round trips separately from shortage deaths',()=>{
 const run=advanceRun(createRun({horizon:1,aiEnabled:false,human:{growth:-.01,maximumMortality:0,
  growthSchedule:[{time:.13,growth:-.02},{time:.31,growth:.005}]}}),.5);
 assert.ok(run.state.accounts.births<0,'The historical births field carries signed baseline net change');
 assert.equal(run.state.accounts.extraDeaths,0);
 for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
  const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
  assert.deepEqual(finishRun(restored),finishRun(run));
 }
 const forged=clone(run);forged.state.accounts.extraDeaths=-1;rejectsBoth(forged);
});

test('policy access diagnostics identify paid interventions awaiting actual authority',()=>{
 const run=advanceRun(createRun({horizon:1,policy:{mode:'fixed',start:0,delay:0,cost:0,work:0,authorized:false}}),.25);
 assert.equal(run.state.last.ledger.policyAccess,1);
 assert.deepEqual(restoreCheckpoint(saveCheckpoint(run)),run);
 const forged=clone(run);forged.state.last.ledger.policyAccess=0;
 forged.state.history.at(-1).ledger.policyAccess=0;rejectsBoth(forged);
});
