import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,stepRun,finishRun,summarize} from '../revised/engine.mjs';
import {physicalView,resourceRates} from '../revised/dynamics.mjs';
import {makeConfig} from '../revised/config.mjs';
import {humanStep} from '../revised/math.mjs';

test('DOM-MEM protects the reference population independently of full demand',()=>{
 const run=createRun({alignment:1});
 assert.equal(run.config.human.memEnergy,1);
 assert.equal(run.config.human.criticalEnergy+run.config.human.flexEnergy,2);
 const view=physicalView(run.state,run.config),rates=resourceRates(run.state,run.config);
 assert.equal(rates.reserve,8000);
 assert.ok(rates.reserve<view.criticalNeed+view.flexibleNeed);
 const depleted={...run.state,H:4000};
 assert.equal(resourceRates(depleted,run.config).reserve,8000);
});
test('DOM-MEM never delivers unwanted electricity or exceeds actual supply',()=>{
 const run=createRun({alignment:1,human:{memEnergy:2},initial:{humanPower:100,aiPower:0}});
 const rates=resourceRates(run.state,run.config);
 assert.ok(rates.reserve<=rates.sourcePower);
 const tiny={...run.state,H:1};
 assert.ok(resourceRates(tiny,run.config).reserve<=2);
});
test('DOM-QOL records delivered-energy welfare and population-weighted integral',()=>{
 const run=stepRun(createRun({horizon:1})),p=run.state.history.at(-1),l=p.ledger,old=run.state.history[0];
 const e=1000*(l.humanCritical+l.humanFlexible)/(l.h*old.H);
 assert.equal(p.perCapitaElectricity,e);
 assert.ok(Math.abs(p.qualityOfLife-.9*(-Math.expm1(-e/667)))<1e-12);
 assert.equal(p.qolPersonYears,run.state.accounts.qolPersonYears);
 assert.ok(p.qolPersonYears>0&&p.qualityOfLife!==p.q);
 assert.equal(summarize(run).qualityOfLife,p.qualityOfLife);
});
test('TH-PRIORITY changes actual constrained admission in both directions',()=>{
 const options={horizon:1,alignment:0,initial:{humanPower:10000,aiPower:0},resources:{materials:1},priority:{aiWeight:100,humanWeight:1}};
 const ai=stepRun(createRun(options));
 const human=stepRun(createRun({...options,priority:{aiWeight:1,humanWeight:100}}));
 assert.equal(ai.state.planning.priority.winner,'ai');
 assert.equal(human.state.planning.priority.winner,'human');
 assert.equal(ai.state.assetState.projects.find(p=>['power','factory','hardware'].includes(p.kind))?.owner,'ai');
 assert.equal(human.state.assetState.projects.find(p=>['power','factory','hardware'].includes(p.kind))?.owner,'human');
});
test('TH-V1 maximum includes an interior population peak',()=>{
 const c=makeConfig({human:{growth:.01,maximumMortality:.1,exposureTime:2}});
 const r=humanStep({H:100,exposure:0},1,1,c.human);
 assert.ok(r.maxPopulation>Math.max(100,r.H));
});
test('TH-V1 summary exposes all nine ordered groups with explicit resource units',()=>{
 const s=summarize(finishRun(createRun({horizon:1})));
 assert.equal(s.outputVectorV1.groups.length,9);
 assert.ok(s.qolPersonYears>0&&s.maxPopulation>=s.H);
});
