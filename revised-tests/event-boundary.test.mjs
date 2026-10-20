import test from 'node:test';
import assert from 'node:assert/strict';
import {makeConfig} from '../revised/config.mjs';
import {initialEventState} from '../revised/events.mjs';
import {createRun,advanceRun,saveCheckpoint,restoreCheckpoint} from '../revised/engine.mjs';

const event=(time,duration)=>({id:'boundary',type:'algorithm',time,magnitude:2,duration});

test('scenario validation rejects positive event durations that cannot advance their start time',()=>{
 for(const [time,duration] of [[1,1e-300],[1,Number.MIN_VALUE],[300,Number.MIN_VALUE]]){
  const options={horizon:300,events:[event(time,duration)]};
  assert.throws(()=>makeConfig(options),/duration.*resolution/i);
  assert.throws(()=>createRun(options),/duration.*resolution/i);
 }
});

test('direct event normalization rejects nonadvancing and nonfinite expiry endpoints',()=>{
 for(const [time,duration] of [[1,1e-300],[Number.MAX_VALUE,1]])
  assert.throws(()=>initialEventState({events:[event(time,duration)]}),/duration.*resolution/i);
 assert.throws(()=>initialEventState({events:[event(Number.MAX_VALUE,Number.MAX_VALUE)]}),/expiry.*finite/i);
});

test('small representable event windows remain valid and checkpoint consistently',()=>{
 for(const [time,duration,target] of [[0,Number.MIN_VALUE,1],[1,Number.EPSILON,2]]){
  const run=advanceRun(createRun({horizon:2,dt:1,events:[event(time,duration)]}),target);
  const record=run.state.eventState.records.find(row=>row.id==='boundary');
  const project=run.state.assetState.projects.find(row=>row.eventId==='boundary');
  assert(record.expiresAt>record.time);
  assert.equal(record.adoptionStatus,'expired');
  assert.equal(project.status,'expired');
  assert.equal(record.adoptedAt,null);
  assert.deepEqual(restoreCheckpoint(saveCheckpoint(run)),run);
 }
});
