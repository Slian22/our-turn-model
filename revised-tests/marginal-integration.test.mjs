import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,stepRun,finishRun,VERSION} from '../revised/engine.mjs';
import {makeConfig} from '../revised/config.mjs';

test('DOM-PRIORITY exposes the marginal operating rule separately from action ordering',()=>{
 const run=createRun({horizon:1});
 assert.equal(VERSION,'2.2.2');
 assert.equal(run.schema,'our-turn.revised.v4');
 assert.equal(run.config.priority.operatingMode,'marginal');
 assert.equal(run.config.priority.mode,'weighted');
 assert.equal(run.state.competitionLead,null);
 for(const patch of [{lambda:-1},{sharpness:-1},{hysteresis:-1},{operatingMode:'unknown'}])
  assert.throws(()=>makeConfig({priority:patch}));
});
const scarce={horizon:1,alignment:.05,initial:{humanPower:1000,aiPower:1000},
 resources:{constructionEnergyShare:0,maintenanceEnergyPerWork:0,policyEnergyShare:0}};
test('DOM-PRIORITY exchange rate changes actual powered compute while preserving the reserve',()=>{
 const human=stepRun(createRun({...scarce,priority:{lambda:1e-9}}));
 const ai=stepRun(createRun({...scarce,priority:{lambda:1e9}}));
 assert.ok(ai.state.last.effectiveCompute>human.state.last.effectiveCompute+1);
 for(const run of [human,ai])for(const p of run.state.history.filter(p=>p.ledger)){
  const l=p.ledger;
  assert.ok(l.humanCritical+l.humanFlexible>=l.protectedReserve-1e-9);
  assert.ok(l.competitionTargetAiShare>=0&&l.competitionTargetAiShare<=1);
  assert.ok(l.competitionActualAiShare>=0&&l.competitionActualAiShare<=1);
  const spent=l.humanCritical+l.humanFlexible+l.operation+l.maintenance+l.construction+
   l.policy+l.extraction+l.storageCharge+l.unused;
  assert.ok(Math.abs(l.available-spent)<=1e-8*Math.max(1,l.available));
 }
});
test('DOM-PRIORITY no-AI and legacy comparators remain explicit physical scenarios',()=>{
 const absent=finishRun(createRun({...scarce,aiEnabled:false}));
 assert.equal(absent.state.last.effectiveCompute,0);
 assert.equal(absent.state.last.ledger.competitionAiValue,0);
 const legacy=finishRun(createRun({...scarce,priority:{operatingMode:'legacy'}}));
 assert.equal(legacy.state.last.ledger.competitionMode,0);
 assert.equal(legacy.config.priority.operatingMode,'legacy');
 assert.ok(legacy.state.history.every(p=>Number.isFinite(p.H)));
});
