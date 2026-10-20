import test from 'node:test';
import assert from 'node:assert/strict';
import {makeConfig} from '../revised/config.mjs';
import {capabilityStep,humanStep,support,efficiency,energyPerBlock,demandStep} from '../revised/math.mjs';

test('configuration rejects silent misspellings, invalid nested inputs and incompatible population rates',()=>{
 for(const value of [{aligmnent:.5},{human:{exposureTime:0}},{ai:{difficulty:0}},
  {assets:{hardware:{life:0}}},{policy:{coverage:1.01}},{dt:NaN},{events:[{type:'unknown',time:1,magnitude:2}]}])
  assert.throws(()=>makeConfig(value));
 const c=makeConfig({aiEnabled:false,horizon:4,human:{technologyRate:0}});
 assert.equal(c.aiEnabled,false);assert.equal(c.human.technologyRate,0);
 assert.ok(Object.isFrozen(c)&&Object.isFrozen(c.human));
});
test('difficulty reduces relative growth without inventing a finite capability ceiling',()=>{
 const ai=makeConfig().ai;
 const a=capabilityStep(1,ai.researchReference,10,ai),b=capabilityStep(10,ai.researchReference,10,ai);
 assert.ok(a>1&&b>10);assert.ok(a-1>(b-10)/10);
 assert.ok(capabilityStep(1,ai.researchReference,1e6,ai)>100);
 assert.equal(capabilityStep(3,0,10,ai),3);
});
test('tiny positive research cannot reverse capability through power roundoff',()=>{
 const ai={...makeConfig().ai,difficulty:.01};
 for(const q of [1,3,10,1000])assert.ok(capabilityStep(q,1e-30,.005,ai)>=q);
});
test('finite mortality carries exposure after restoration and accounts for gross deaths with births',()=>{
 const human={...makeConfig().human,growth:.01,exposureTime:2,maximumMortality:.1};
 const damaged=humanStep({H:100,exposure:0},1,2,human);
 const recovery=humanStep({H:damaged.H,exposure:damaged.exposure},0,1,human);
 assert.ok(damaged.extraDeaths>0&&damaged.births>0&&damaged.H>0);
 assert.ok(recovery.extraDeaths>0&&recovery.exposure>0&&recovery.exposure<damaged.exposure);
 assert.ok(Math.abs(damaged.H-(100+damaged.births-damaged.extraDeaths))<1e-8);
 assert.ok(damaged.shortagePersonYears>0);
});
test('efficiency, human support and lagged consumption have their declared bounds',()=>{
 assert.equal(support(8000,8000,4000),1);assert.equal(support(0,8000,4000),0);
 assert.ok(support(16000,8000,4000)>1);
 assert.equal(efficiency(1,3,1),1);assert.ok(efficiency(1e10,3,1)<3);
 assert.equal(energyPerBlock(1,.2),.00876);assert.equal(energyPerBlock(0,.2),.001752);
 const human=makeConfig().human;
 assert.ok(demandStep(1,0,1,human)<1);assert.ok(demandStep(1,1,1,human)>=1);
});
