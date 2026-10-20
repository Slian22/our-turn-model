import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,finishRun} from '../revised/engine.mjs';
import {requestProjects} from '../revised/assets.mjs';
import {resourceRates,nextBoundary} from '../revised/dynamics.mjs';

test('shared construction completion splits the interval at paid work, not the next grid endpoint',()=>{
 const run=createRun({horizon:3,dt:1,initial:{H:1,hardware:0,humanPower:100,humanFactories:1,aiFactories:0,aiPower:0,ageBands:[0]},
  human:{criticalEnergy:1e-9,criticalFloor:1e-9,flexEnergy:0,growth:0},
  resources:{maintenanceEnergyPerWork:0,humanConstructionShare:.5,constructionEnergyShare:1},
  assets:{power:{delay:0,energy:0,work:40,maintenance:0,endPerformance:1},factory:{maintenance:0,endPerformance:1}}});
 let s={...run.state,nextDecision:1};
 s.assetState=requestProjects(s.assetState,[{id:'work-only',kind:'power',owner:'human',amount:1}],0,run.config);
 const rates=resourceRates(s,run.config),exact=40/rates.availableWork;
 assert.ok(exact>0&&exact<1);
 assert.ok(Math.abs(nextBoundary(s,run.config,rates)-exact)<1e-12);
});
test('construction event timing approaches the same trajectory under grid refinement',()=>{
 const outputs=[.2,.1,.05,.025].map(dt=>finishRun(createRun({horizon:12,dt,alignment:0,
  initial:{humanPower:9000,aiPower:1000},policy:{mode:'none'},events:[],eventMode:'off'})));
 const distances=outputs.slice(1).map((r,i)=>Math.max(...['H','q','exposure'].map(k=>Math.abs(r.state[k]-outputs[i].state[k])/Math.max(1,Math.abs(outputs.at(-1).state[k])))));
 assert.ok(distances[2]<distances[1]*.8,JSON.stringify(distances));
});
