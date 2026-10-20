/** CORE-01: public checkpoint history observations retain their physical domains. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun,saveCheckpoint,restoreCheckpoint} from '../revised/engine.mjs';
import {encodeCheckpoint} from '../revised/checkpoint-codec.mjs';

const fields=['power','hardware','factoryWork','policyCost','landUsed','materialStock'];
const base=advanceRun(createRun({horizon:1}),.5);
const positions=[['initial',0],['interior',1],['final',base.state.history.length-1]];
assert.ok(positions[2][1]>positions[1][1],'Regression fixture needs distinct history positions');

for(const field of fields)for(const [position,index] of positions)for(const format of ['raw','table']){
 test(`negative history ${field} rejects at ${position} position in ${format} checkpoints`,()=>{
  const changed=structuredClone(base);changed.state.history[index][field]=-12345;
  const text=JSON.stringify(format==='table'?encodeCheckpoint(changed):changed);
  assert.throws(()=>restoreCheckpoint(text),new RegExp(`checkpoint: history ${field}`));
 });
}

test('public save rejects all six negative physical/history domains at every position',()=>{
 for(const field of fields)for(const [,index] of positions){
  const changed=structuredClone(base);changed.state.history[index][field]=-12345;
  assert.throws(()=>saveCheckpoint(changed),new RegExp(`checkpoint: history ${field}`));
 }
});

test('valid zero and positive history fields remain lossless in both public checkpoint formats',()=>{
 const runs=[base,
  advanceRun(createRun({horizon:1,initial:{hardware:0,humanPower:0,aiPower:0,
   humanFactories:0,aiFactories:0},resources:{materials:0}}),.5),
  advanceRun(createRun({horizon:1,policy:{mode:'fixed',start:0,delay:0,cost:.01,work:.01,type:'cap'}}),.5)];
 for(const run of runs){
  const raw=JSON.stringify(run);
  assert.equal(JSON.stringify(restoreCheckpoint(raw)),raw);
  assert.equal(JSON.stringify(restoreCheckpoint(JSON.stringify(encodeCheckpoint(run)))),raw);
  assert.equal(saveCheckpoint(run),raw);
 }
 for(const field of fields){
  const observed=runs.flatMap(run=>run.state.history.map(point=>point[field]));
  assert.ok(observed.some(value=>value===0),`${field} must exercise the valid zero boundary`);
  assert.ok(observed.some(value=>value>0),`${field} must exercise valid positive observations`);
 }
});
