import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun,finishRun,saveCheckpoint,restoreCheckpoint} from '../revised/engine.mjs';
import {encodeCheckpoint} from '../revised/checkpoint-codec.mjs';

const COMPETITION=['competitionMode','competitionHumanValue','competitionAiValue','competitionLogRatio',
 'competitionTargetAiShare','competitionActualAiShare','competitionObserved','competitionLeader',
 'competitionFlip','competitionPool','protectedReserve','competitionHumanAtFloor','queuePendingCount'];
const clone=value=>structuredClone(value);
const advanced=()=>advanceRun(createRun({horizon:1,dt:.25}),.5);
function roundTrips(run){
 for(const text of [saveCheckpoint(run),JSON.stringify(encodeCheckpoint(run))]){
  const restored=restoreCheckpoint(text);assert.deepEqual(restored,run);
  assert.deepEqual(finishRun(restored),finishRun(run));
 }
}
function rejectsBoth(run){
 assert.throws(()=>restoreCheckpoint(JSON.stringify(run)),/checkpoint|Invalid|finite/i);
 assert.throws(()=>restoreCheckpoint(JSON.stringify(encodeCheckpoint(run))),/checkpoint|Invalid|finite/i);
}

test('DOM-SUGGESTED marginal competition memory and numeric interval cells resume exactly',()=>{
 for(const run of [createRun({horizon:1}),advanced()]){
  assert.ok(Object.hasOwn(run.state,'competitionLead'));
  assert.ok(run.state.competitionLead===null||['human','ai'].includes(run.state.competitionLead));
  for(const point of run.state.history){
   for(const field of ['queuePendingCount','autonomousWork','humanOwnedPower'])assert.equal(typeof point[field],'number');
   assert.ok(point.competitionLead===null||['human','ai'].includes(point.competitionLead));
   if(point.ledger)for(const field of COMPETITION)assert.equal(typeof point.ledger[field],'number',field);
  }
  roundTrips(run);
 }
});

test('DOM-SUGGESTED chronological competition leader cannot be forged in either checkpoint format',()=>{
 const initial=createRun({horizon:1});
 assert.equal(initial.state.competitionLead,null);
 const forgedInitial=clone(initial);forgedInitial.state.competitionLead='ai';rejectsBoth(forgedInitial);
 const base=advanced();assert.notEqual(base.state.competitionLead,null);
 for(const value of [null,'invalid',base.state.competitionLead==='ai'?'human':'ai']){
  const run=clone(base);run.state.competitionLead=value;rejectsBoth(run);
 }
});

test('DOM-SUGGESTED marginal values, target/actual shares and lead transitions are independently replayed',()=>{
 const base=advanced();
 for(const field of COMPETITION)assert.equal(typeof base.state.last.ledger[field],'number',field);
 for(const field of COMPETITION){
  const run=clone(base),old=run.state.history.at(-1).ledger[field];
  const value=['competitionMode','competitionObserved','competitionLeader','competitionFlip','competitionHumanAtFloor'].includes(field)?1-old:old+1;
  run.state.history.at(-1).ledger[field]=value;run.state.last.ledger[field]=value;
  rejectsBoth(run);
 }
});

test('DOM-SUGGESTED physical history snapshots and held leader reject invented observations',()=>{
 const base=advanced();
 for(const field of ['queuePendingCount','autonomousWork','humanOwnedPower','competitionLead'])
  assert.ok(Object.hasOwn(base.state.history.at(-1),field),field);
 for(const field of ['queuePendingCount','autonomousWork','humanOwnedPower','competitionLead']){
  const run=clone(base),point=run.state.history.at(-1);
  point[field]=field==='competitionLead'?(point[field]==='ai'?'human':'ai'):point[field]+1;
  rejectsBoth(run);
 }
});

test('DOM-SUGGESTED zero contested pool retains an unobserved null leader and round trips',()=>{
 const run=advanceRun(createRun({horizon:1,alignment:1,initial:{H:1,hardware:0,humanPower:1,aiPower:0,
  humanFactories:0,aiFactories:0,ageBands:[0]},human:{criticalEnergy:1,criticalFloor:1,flexEnergy:0,
   memEnergy:1,landPerMillion:0,growth:0},ai:{expansion:0}}),.5);
 assert.equal(run.state.competitionLead,null);
 for(const point of run.state.history.slice(1)){
  assert.equal(point.ledger.competitionObserved,0);assert.equal(point.ledger.competitionPool,0);
  assert.equal(point.ledger.competitionFlip,0);assert.equal(point.competitionLead,null);
 }
 roundTrips(run);
});

test('DOM-SUGGESTED legacy operating comparator remains checkpoint-compatible',()=>{
 const run=advanceRun(createRun({horizon:1,priority:{operatingMode:'legacy'}}),.5);
 assert.ok(run.state.history.slice(1).every(row=>row.ledger.competitionMode===0));
 roundTrips(run);
});

test('DOM-SUGGESTED positive marginal values that underflow retain their log-domain checkpoint comparison',()=>{
 const run=advanceRun(createRun({horizon:1,initial:{H:1,q:1e6,hardware:100,humanPower:2000,aiPower:0,
  humanFactories:0,aiFactories:0,ageBands:[0]},human:{criticalEnergy:100,criticalFloor:100,flexEnergy:0,
   landPerMillion:0,growth:0,qolScale:100},ai:{difficulty:10,researchReference:1e12,researchElasticity:10,
   growth:Number.MIN_VALUE,expansion:0},priority:{lambda:Number.MIN_VALUE},resources:{constructionEnergyShare:0}}),.25);
 const ledger=run.state.history[1].ledger;
 assert.equal(ledger.competitionHumanValue,0);assert.equal(ledger.competitionAiValue,0);
 assert.ok(ledger.competitionLogRatio>500);assert.equal(ledger.competitionTargetAiShare,0);
 assert.equal(run.state.competitionLead,'human');roundTrips(run);
});

test('DOM-SUGGESTED zero marginal values, zero sharpness and unavailable AI replay explicitly',()=>{
 for(const options of [{priority:{lambda:0}},{priority:{sharpness:0}},
  {human:{qolMaximum:0}},{human:{qolMaximum:0},priority:{lambda:0}},{aiEnabled:false}]){
  const run=advanceRun(createRun({horizon:1,...options}),.25);roundTrips(run);
 }
});

test('DOM-SUGGESTED a paid shutdown changes the committed leader once and checkpoints preserve that flip',()=>{
 const run=advanceRun(createRun({horizon:1,dt:.125,priority:{lambda:10000},policy:{mode:'fixed',
  start:.25,delay:0,cost:0,work:0,type:'shutdown',success:1,coverage:1,residual:0}}),.75);
 const ledgers=run.state.history.slice(1).map(row=>row.ledger);
 assert.equal(ledgers[0].competitionLeader,1);
 assert.equal(ledgers.reduce((v,row)=>v+row.competitionFlip,0),1);
 assert.equal(run.state.competitionLead,'human');roundTrips(run);
});

test('DOM-SUGGESTED an empty contested interval retains the previously observed leader',()=>{
 const run=advanceRun(createRun({horizon:1,dt:.125,priority:{lambda:10000},
  infrastructure:{outages:[{start:.25,duration:.25,zone:'both',availability:0}]}}),.75);
 const unobserved=run.state.history.filter(row=>row.ledger?.competitionObserved===0);
 assert.ok(unobserved.length>0);
 for(const row of unobserved){
  assert.equal(row.competitionLead,'ai');assert.equal(row.ledger.competitionLeader,1);
  assert.equal(row.ledger.competitionFlip,0);
 }
 roundTrips(run);
});
