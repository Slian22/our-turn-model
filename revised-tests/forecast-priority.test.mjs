/** Independent C4 regression: known usage memory and public hazard visibility. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun} from '../revised/engine.mjs';
import {planningProjection,prepareState,currentPriority} from '../revised/dynamics.mjs';
import {selectPortfolio} from '../revised/planning.mjs';

const options={horizon:3,dt:.25,alignment:0,
 initial:{H:10,hardware:1000,humanPower:1,aiPower:1,humanFactories:1,aiFactories:1},
 priority:{processingReference:100,humanUsageReference:1}};

test('C4 public projection carries actual preceding human usage instead of repeating bootstrap demand',()=>{
 const run=advanceRun(createRun(options),1),s=prepareState(run.state,run.config);
 const observed=planningProjection(s,run.config),ledger=s.last.ledger;
 const actual=(ledger.humanCritical+ledger.humanFlexible)/ledger.h;
 assert.equal(observed.human.previousUsage,actual);
 const livePriority=currentPriority(s,run.config);
 assert.equal(livePriority.winner,'ai');
 assert.equal(currentPriority({...s,last:null},run.config).winner,'human');
 const initial=planningProjection(createRun(options).state,run.config);
 assert.equal(initial.human.previousUsage,null);
 const callbacks=[];
 selectPortfolio(observed,run.config,1,query=>{
  callbacks.push(query.observation.human.previousUsage);return {effectiveCompute:1};
 });
 assert.equal(callbacks.length,6);assert.ok(callbacks.every(value=>value===actual));
});

test('C4 forecast callbacks receive current outages and exclude all future outage schedules',()=>{
 const run=advanceRun(createRun({...options,infrastructure:{outages:[
  {start:.5,duration:1,zone:'ai',availability:.9},
  {start:2,duration:1,zone:'human',availability:0},
 ]}}),1);
 const s=prepareState(run.state,run.config),observed=planningProjection(s,run.config),before=JSON.stringify(run);
 const callbacks=[];
 selectPortfolio(observed,run.config,1,query=>{
  callbacks.push(structuredClone(query.config.infrastructure.outages));
  query.config.infrastructure.outages.length=0;
  return {effectiveCompute:1};
 });
 assert.equal(callbacks.length,6);
 assert.ok(callbacks.every(rows=>rows.length===1&&rows[0].start===.5));
 assert.equal(JSON.stringify(run),before);
 assert.equal(run.config.infrastructure.outages.length,2);
});
