import test from 'node:test';
import assert from 'node:assert/strict';
import {operatingPriority,cappedContestedAllocation} from '../revised/marginal-priority.mjs';

const config=(patch={})=>({aiEnabled:true,
 human:{qolMaximum:.9,qolScale:667,...patch.human},
 ai:{growth:.06,researchReference:16000,researchElasticity:1,difficulty:1.5,...patch.ai},
 priority:{lambda:1,sharpness:1,hysteresis:.05,tieBreak:'human',...patch.priority},
 ...(patch.aiEnabled===undefined?{}:{aiEnabled:patch.aiEnabled})});
const input=(patch={})=>({q:4,researchAtCapacity:8000,operationPower:100,
 perCapitaElectricity:1000,previousLeader:null,...patch});
const close=(actual,expected,tolerance=1e-12)=>assert.ok(Math.abs(actual-expected)<=tolerance*Math.max(1,Math.abs(expected)),`${actual} != ${expected}`);

test('marginal values follow the analytic QoL slope and capability-growth energy derivative',()=>{
 const c=config(),x=input(),r=operatingPriority(x,c);
 const human=.9/667*Math.exp(-1000/667),ai=.06*(8000/16000)*4**(-.5)/100;
 close(r.humanValue,human);close(r.aiValue,ai);close(r.logRatio,Math.log(human/ai));
 close(r.humanShare,human/(human+ai));assert.equal(r.leader,'human');
 const qdot=p=>c.ai.growth*((x.researchAtCapacity/x.operationPower*p)/c.ai.researchReference)**c.ai.researchElasticity*x.q**(1-c.ai.difficulty);
 const delta=1e-3,finiteDifference=(qdot(x.operationPower+delta)-qdot(x.operationPower-delta))/(2*delta);
 close(r.aiValue,finiteDifference,1e-10);
});

test('AI marginal uses elasticity, adopted research capacity and capability, not raw hardware',()=>{
 const c=config({ai:{researchElasticity:1.7,difficulty:.6},priority:{lambda:3.2}}),x=input({q:7});
 const r=operatingPriority(x,c),qdot=.06*(8000/16000)**1.7*7**.4;
 close(r.aiValue,3.2*1.7*qdot/100);
 const growth=p=>.06*((8000/100*p)/16000)**1.7*7**.4,epsilon=.001;
 close(r.aiValue,3.2*(growth(100+epsilon)-growth(100-epsilon))/(2*epsilon),1e-10);
 const larger=operatingPriority({...x,researchAtCapacity:16000},c);
 close(larger.aiValue/r.aiValue,2**1.7);
});

test('declining electricity raises the exponential human marginal value',()=>{
 const c=config(),low=operatingPriority(input({perCapitaElectricity:100}),c),high=operatingPriority(input({perCapitaElectricity:2000}),c);
 assert.ok(low.humanValue>high.humanValue);assert.ok(low.humanShare>high.humanShare);
});

test('sharpness gives equal positive-value shares at zero and approaches the leading side',()=>{
 const x=input(),zero=operatingPriority(x,config({priority:{sharpness:0}}));
 assert.equal(zero.humanShare,.5);
 const smooth=operatingPriority(x,config()),sharp=operatingPriority(x,config({priority:{sharpness:100}}));
 assert.ok(sharp.humanShare>smooth.humanShare);assert.ok(sharp.humanShare>1-1e-12);
 assert.equal(operatingPriority(x,config({priority:{sharpness:1e300}})).humanShare,1);
 assert.equal(operatingPriority(x,config({priority:{lambda:1e6,sharpness:1e300}})).humanShare,0);
});

test('hysteresis holds a leader without modifying the smooth allocation share',()=>{
 const base=config({human:{qolMaximum:.5,qolScale:1},ai:{growth:1,researchReference:1,researchElasticity:1,difficulty:1},priority:{hysteresis:.1}});
 const x=input({q:1,researchAtCapacity:1,operationPower:1,perCapitaElectricity:0,previousLeader:'ai'});
 const near=operatingPriority(x,{...base,priority:{...base.priority,lambda:.5*Math.exp(-.05)}});
 assert.equal(near.leader,'ai');assert.ok(near.humanShare>.5);
 const beyond=operatingPriority(x,{...base,priority:{...base.priority,lambda:.5*Math.exp(-.2)}});
 assert.equal(beyond.leader,'human');
 const opposite=operatingPriority({...x,previousLeader:'human'},{...base,priority:{...base.priority,lambda:.5*Math.exp(.2)}});
 assert.equal(opposite.leader,'ai');
 const exact=operatingPriority(x,{...base,priority:{...base.priority,lambda:.5,hysteresis:0}});
 assert.equal(exact.logRatio,0);assert.equal(exact.leader,'ai');assert.equal(exact.humanShare,.5);
 const fresh=operatingPriority({...x,previousLeader:null},{...base,priority:{...base.priority,lambda:.5,tieBreak:'human'}});
 assert.equal(fresh.leader,'human');
 const boundary=operatingPriority({...x,previousLeader:'human'},{...base,priority:{...base.priority,lambda:1,hysteresis:Math.LN2}});
 assert.equal(boundary.logRatio,-Math.LN2);assert.equal(boundary.leader,'human');
 const otherBoundary=operatingPriority(x,{...base,priority:{...base.priority,lambda:.25,hysteresis:Math.LN2}});
 assert.equal(otherBoundary.logRatio,Math.LN2);assert.equal(otherBoundary.leader,'ai');
});

test('zero values have explicit one-sided and both-zero rules',()=>{
 const x=input();
 for(const c of [config({priority:{lambda:0}}),config({ai:{growth:0}}),config({aiEnabled:false})]){
  const r=operatingPriority(x,c);assert.equal(r.aiValue,0);assert.equal(r.humanShare,1);assert.equal(r.logRatio,Infinity);
 }
 for(const patch of [{operationPower:0},{researchAtCapacity:0}])assert.equal(operatingPriority(input(patch),config()).humanShare,1);
 const ai=operatingPriority(x,config({human:{qolMaximum:0}}));assert.equal(ai.humanShare,0);assert.equal(ai.logRatio,-Infinity);
 const c=config({human:{qolMaximum:0},priority:{lambda:0,tieBreak:'ai'}});
 const both=operatingPriority(x,c);assert.deepEqual(both,{humanValue:0,aiValue:0,logRatio:0,humanShare:.5,leader:'ai'});
 assert.equal(operatingPriority(input({previousLeader:'human'}),c).leader,'human');
});

test('log-domain evaluation preserves shares through representable-value underflow',()=>{
 const r=operatingPriority(input({q:1e100,perCapitaElectricity:1e6}),config({ai:{difficulty:10}}));
 assert.equal(r.humanValue,0);assert.equal(r.aiValue,0);assert.ok(Number.isFinite(r.logRatio));
 assert.ok(r.logRatio>500);assert.equal(r.humanShare,1);
 const humanOnly=operatingPriority(input({perCapitaElectricity:1e6}),config({priority:{lambda:0}}));
 assert.equal(humanOnly.humanValue,0);assert.equal(humanOnly.humanShare,1);
});

test('log evaluation avoids intermediate overflow but rejects nonfinite returned marginal values',()=>{
 const c=config({ai:{growth:1,researchReference:1e-100,researchElasticity:2,difficulty:1},priority:{lambda:1e-300}});
 const r=operatingPriority(input({q:1,researchAtCapacity:1e100,operationPower:1e100}),c);close(r.aiValue,2,1e-11);
 assert.throws(()=>operatingPriority(input({researchAtCapacity:1e100,operationPower:1}),config({ai:{researchReference:1e-100,researchElasticity:10}})),/finite|domain|overflow/i);
 assert.throws(()=>operatingPriority(input({perCapitaElectricity:0}),config({human:{qolScale:Number.MIN_VALUE}})),/finite|domain|overflow/i);
 const saturated=operatingPriority(input({perCapitaElectricity:1}),config({human:{qolScale:Number.MIN_VALUE}}));
 assert.equal(saturated.humanValue,0);assert.equal(saturated.humanShare,0);
});

test('priority validates inputs and parameters without mutating caller-owned state',()=>{
 const x=Object.freeze(input()),c=config();Object.freeze(c.human);Object.freeze(c.ai);Object.freeze(c.priority);Object.freeze(c);
 assert.ok(operatingPriority(x,c).humanShare>0);
 for(const patch of [{q:0},{q:Infinity},{researchAtCapacity:-1},{operationPower:NaN},{perCapitaElectricity:-1},{previousLeader:'other'}])assert.throws(()=>operatingPriority(input(patch),config()));
 for(const patch of [{human:{qolMaximum:2}},{human:{qolScale:0}},{ai:{growth:-1}},{ai:{researchReference:0}},{ai:{researchElasticity:0}},{ai:{difficulty:-1}},
  {priority:{lambda:-1}},{priority:{sharpness:-1}},{priority:{hysteresis:-1}},{priority:{tieBreak:'other'}}])assert.throws(()=>operatingPriority(input(),config(patch)));
});

test('capped allocation applies desired fractions then passes surplus to unmet needs',()=>{
 assert.deepEqual(cappedContestedAllocation(100,80,80,.7),{human:70,ai:30,unused:0});
 assert.deepEqual(cappedContestedAllocation(100,10,100,.7),{human:10,ai:90,unused:0});
 assert.deepEqual(cappedContestedAllocation(100,100,10,.1),{human:90,ai:10,unused:0});
 assert.deepEqual(cappedContestedAllocation(100,10,20,.7),{human:10,ai:20,unused:70});
 assert.deepEqual(cappedContestedAllocation(0,10,20,.7),{human:0,ai:0,unused:0});
 assert.deepEqual(cappedContestedAllocation(100,0,0,.5),{human:0,ai:0,unused:100});
 assert.deepEqual(cappedContestedAllocation(100,100,100,0),{human:0,ai:100,unused:0});
 assert.deepEqual(cappedContestedAllocation(100,100,100,1),{human:100,ai:0,unused:0});
});

test('capped allocation closes the ledger and respects needs across deterministic scales',()=>{
 for(const pool of [1e-200,.125,1,1e100,Number.MAX_VALUE])for(const fraction of [0,.01,.5,.999,1]){
  const humanNeed=pool*.2,aiNeed=pool*.65,r=cappedContestedAllocation(pool,humanNeed,aiNeed,fraction);
  assert.ok(r.human>=0&&r.human<=humanNeed);assert.ok(r.ai>=0&&r.ai<=aiNeed);assert.ok(r.unused>=0);
  close((r.human/pool)+(r.ai/pool)+(r.unused/pool),1,1e-14);
 }
 for(const args of [[-1,1,1,.5],[1,-1,1,.5],[1,1,Infinity,.5],[1,1,1,NaN],[1,1,1,1.1]])assert.throws(()=>cappedContestedAllocation(...args));
});
