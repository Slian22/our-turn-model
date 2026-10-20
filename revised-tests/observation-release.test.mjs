import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun,saveCheckpoint,restoreCheckpoint} from '../revised/engine.mjs';
import {observeInfrastructure} from '../revised/infrastructure.mjs';
import {planningProjection} from '../revised/dynamics.mjs';
import {selectPortfolio} from '../revised/planning.mjs';

const scenario=seed=>({horizon:2,dt:1,seed,
 initial:{hardware:0,humanPower:1000,aiPower:0,humanFactories:0,aiFactories:0},
 policy:{mode:'deficit',start:0,observationDelay:1},
 infrastructure:{observations:{enabled:true,noise:0,missingProbability:.5}}});
const sample=(seed,index)=>observeInfrastructure({deficit:.9,supply:1000,need:12000},
 {seed,index},{infrastructure:{observations:{enabled:true,noise:0,missingProbability:.5}}});

test('a missing current sensor releases an earlier due observation and triggers its policy',()=>{
 assert(Object.values(sample(14,0)).every(value=>value!==null));
 assert(Object.values(sample(14,1)).some(value=>value===null));
 const run=advanceRun(createRun(scenario(14)),1),controller=run.state.policyState.controller;
 assert.equal(controller.known?.t,0);
 assert.equal(controller.known.observedAt,1);
 assert(controller.known.deficit>.9);
 assert.equal(controller.pending.length,0);
 assert.equal(controller.history.length,1);
 assert.equal(run.state.policyState.actions.length,1);
 assert.equal(controller.signals[0].reason,'observed-deficit');
 assert.equal(run.state.policyState.actions[0].createdAt,1);
 assert.deepEqual(restoreCheckpoint(saveCheckpoint(run)),run);
});

test('all missing current sensors leave due observation and event releases independent',()=>{
 assert(Object.values(sample(49,0)).every(value=>value!==null));
 assert(Object.values(sample(49,1)).every(value=>value===null));
 const run=advanceRun(createRun({...scenario(49),events:[
  {id:'reported-funding',type:'funding',time:0,magnitude:.5,observationDelay:1}
 ]}),1),controller=run.state.policyState.controller;
 assert.equal(controller.known?.t,0);
 assert.equal(controller.pending.length,0);
 assert.deepEqual(controller.history.map(row=>row.t),[0]);
 assert.deepEqual(run.state.eventState.observedIds,['reported-funding']);
 assert.equal(run.state.policyState.actions.length,1);
 assert.equal(controller.signals[0].observedTime,0);
 assert.deepEqual(restoreCheckpoint(saveCheckpoint(run)),run);
});

test('every portfolio forecast retains the currently observed hysteretic leader',()=>{
 const run=createRun({horizon:2});
 const observation=planningProjection({...run.state,competitionLead:'ai'},run.config);
 let forecasts=0;
 selectPortfolio(observation,run.config,1,query=>{
  forecasts++;
  assert.equal(query.observation.competitionLead,'ai');
  return {effectiveCompute:0,feasible:true};
 });
 assert.equal(forecasts,6);
 assert.equal(run.state.competitionLead,null);
});
