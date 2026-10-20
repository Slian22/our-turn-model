import test from 'node:test';
import assert from 'node:assert/strict';
import {makeConfig} from '../revised/config.mjs';
import {initialAssetState,requestProjects,advanceAssets} from '../revised/assets.mjs';
import {createRun,advanceRun,finishRun,saveCheckpoint,restoreCheckpoint} from '../revised/engine.mjs';
import {resourceRates,nextBoundary,integrateState} from '../revised/dynamics.mjs';
import {encodeCheckpoint} from '../revised/checkpoint-codec.mjs';

const near=(a,b)=>assert.ok(Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const project=(state,id)=>state.projects.find(p=>p.requestId===id);
const requests=[{id:'ai-first',kind:'power',owner:'ai',amount:1},
 {id:'human-second',kind:'power',owner:'human',amount:1},
 {id:'ai-third',kind:'power',owner:'ai',amount:1}];

function options(share=0,energy=2,work=3){
 return {horizon:1,alignment:0,dt:1,initial:{H:1,hardware:0,humanPower:100,aiPower:0,
  humanFactories:1,aiFactories:0,ageBands:[0]},
  human:{criticalEnergy:1e-9,criticalFloor:1e-9,flexEnergy:0,growth:0,technologyRate:0,serviceBaseline:1000},
  ai:{growth:0,expansion:0,investmentEnergyLimit:energy,investmentWorkLimit:work},
  priority:{mode:'weighted',tieBreak:'ai',humanWeight:0},
  resources:{constructionEnergyShare:1,humanConstructionShare:share,maintenanceEnergyPerWork:0},
  assets:{factoryProductivity:100,power:{life:100,endPerformance:1,delay:0,energy:4,work:6,maintenance:0},
   factory:{life:100,endPerformance:1,maintenance:0},hardware:{life:100,endPerformance:1,maintenance:0}}};
}

test('zero AI financing caps leave both reserved and common human construction funded',()=>{
 for(const humanShare of [0,.5,1])for(const [energy,work] of [[0,0],[0,100],[100,0]]){
  const c=makeConfig(options(humanShare,energy,work)),state=requestProjects(initialAssetState(c),requests,0,c);
  const before=JSON.stringify(state);
  const result=advanceAssets(state,0,1,{energy:100,work:100,humanShare,preferredOwner:'ai',
   aiEnergyLimit:energy,aiWorkLimit:work},c);
  assert.equal(project(result.state,'human-second').status,'completed');
  for(const id of ['ai-first','ai-third'])assert.equal(project(result.state,id).progress,0);
  assert.equal(JSON.stringify(state),before,'Funding preserves its input state');
 }
});

test('AI caps apply to total AI spending across projects and do not consume a human reservation',()=>{
 for(const humanShare of [0,.5,1]){
  const c=makeConfig(options(humanShare)),state=requestProjects(initialAssetState(c),requests,0,c);
  const result=advanceAssets(state,0,1,{energy:100,work:100,humanShare,preferredOwner:'ai',
   aiEnergyLimit:4,aiWorkLimit:6},c);
  const ai=result.state.projects.filter(p=>p.owner==='ai');
  near(ai.reduce((v,p)=>v+p.energySpent,0),4);near(ai.reduce((v,p)=>v+p.workDone,0),6);
  assert.equal(project(result.state,'human-second').status,'completed');
  near(result.energyUsed,8);near(result.workUsed,12);
 }
});

test('scheduler funding boundaries match actual owner-specific executor caps, including zero caps',()=>{
 for(const humanShare of [0,.5,1])for(const [energy,work] of [[0,0],[0,100],[100,0],[2,3]]){
  const run=createRun(options(humanShare,energy,work)),c=run.config;
  const state={...run.state,nextDecision:1,assetState:requestProjects(run.state.assetState,requests,0,c)};
  const rates=resourceRates(state,c,Number.MIN_VALUE),boundary=nextBoundary(state,c,rates);
  const expected=humanShare===1||energy===0||work===0?6/100:6/97;
  near(boundary,expected);
  const end=integrateState(state,c,boundary,rates);
  near(project(end.assetState,'human-second').progress,1);
  if(project(end.assetState,'human-second').status!=='completed'){
   // Funding stays exact: a sub-ULP debt must receive a real positive interval,
   // rather than being forgiven by the predictor or completion code.
   const remainderRates=resourceRates(end,c,Number.MIN_VALUE),paidAt=nextBoundary(end,c,remainderRates);
   assert.ok(paidAt>end.t&&paidAt-end.t<=1e-12);
   const settled=integrateState(end,c,paidAt-end.t,remainderRates);
   assert.equal(project(settled.assetState,'human-second').status,'completed');
  }
  const ai=end.assetState.projects.filter(p=>p.owner==='ai');
  assert.ok(ai.reduce((v,p)=>v+p.energySpent,0)<=energy*boundary+1e-12);
  assert.ok(ai.reduce((v,p)=>v+p.workDone,0)<=work*boundary+1e-12);
  if(energy===0||work===0)for(const p of ai)assert.equal(p.progress,0);
  const half=integrateState(state,c,boundary/2,rates),secondRates=resourceRates(half,c,Number.MIN_VALUE);
  near(nextBoundary(half,c,secondRates),boundary);
  const split=integrateState(half,c,boundary-half.t,secondRates);
  near(project(split.assetState,'human-second').progress,1);
  for(const id of ['ai-first','human-second','ai-third']){
   near(project(split.assetState,id).energySpent,project(end.assetState,id).energySpent);
   near(project(split.assetState,id).workDone,project(end.assetState,id).workDone);
  }
 }
});

test('cooling-released regional surplus reaches humans without consuming offered storage',()=>{
 const config={horizon:1,dt:.25,alignment:1,initial:{H:1,hardware:10000,humanPower:0,aiPower:10,
  humanFactories:0,aiFactories:0,ageBands:[0]},
  human:{criticalEnergy:1,criticalFloor:1,flexEnergy:0,landPerMillion:0,growth:0,maximumMortality:0},
  ai:{expansion:0},resources:{constructionEnergyShare:0,policyEnergyShare:0},
  infrastructure:{grid:{enabled:true,aiToHuman:10},cooling:{enabled:true,maxHeatPower:0},
   storage:{enabled:true,capacity:1,initial:1,dischargePower:100}}};
 const run=advanceRun(createRun(config),.25);
 near(run.state.accounts.humanEnergy,.25);near(run.state.accounts.operationEnergy,0);
 near(run.state.infrastructure.storageDischarged,0);near(run.state.infrastructure.storage,1);
 for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
  const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
  assert.deepEqual(finishRun(restored),finishRun(run));
 }
});

test('finite storage depletion checkpoints replay offered physical power and exact paid depletion',()=>{
 const run=advanceRun(createRun({horizon:1,dt:.25,alignment:1,
  initial:{H:1,hardware:0,humanPower:0,aiPower:0,humanFactories:0,aiFactories:0,ageBands:[0]},
  human:{criticalEnergy:10,criticalFloor:10,flexEnergy:0,landPerMillion:0,growth:0,maximumMortality:0},
  ai:{expansion:0},resources:{constructionEnergyShare:0,policyEnergyShare:0},
  infrastructure:{storage:{enabled:true,capacity:1,initial:1,dischargePower:100}}}),.25);
 assert.deepEqual(run.state.history.map(p=>p.t),[0,.1,.25]);
 near(run.state.accounts.humanEnergy,1);near(run.state.infrastructure.storageDischarged,1);
 near(run.state.infrastructure.storage,0);
 for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
  const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
  assert.deepEqual(finishRun(restored),finishRun(run));
 }
});
