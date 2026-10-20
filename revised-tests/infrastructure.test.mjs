import test from 'node:test';
import assert from 'node:assert/strict';
import {INFRA_DEFAULTS, mergeInfrastructure} from '../revised/infrastructure-config.mjs';
import {initialInfrastructure, infrastructureView, extractionRates, extractMaterials,
 settleInfrastructure, nextInfrastructureTime, observeInfrastructure,
 validateInfrastructureState,minimumRepresentableInterval} from '../revised/infrastructure.mjs';

const config=options=>({dt:.25,infrastructure:mergeInfrastructure(options)});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8*Math.max(1,Math.abs(b)),`${a} != ${b}`);

test('infrastructure: disabled modules preserve pooled power and have no new flows',()=>{
 const c=config({}),state=initialInfrastructure(c);
 const view=infrastructureView(state,0,c,{humanPower:10,aiPower:20,H:8,operationNeed:25,humanNeed:5});
 assert.equal(view.sourcePower,30);assert.equal(view.generatedPower,30);
 assert.equal(view.accessibleHumanPower,30);assert.equal(view.accessibleAiPower,30);
 assert.equal(view.serviceAdequacy,1);assert.equal(view.coolingOperationLimit,Number.MAX_VALUE);
 assert.deepEqual(extractMaterials(state,0,.25,{energyBudget:20,workBudget:30},c),
  {state,materials:0,energyUsed:0,workUsed:0});
 assert.deepEqual(settleInfrastructure(state,{h:.25,operationEnergy:4},c),state);
 assert.ok(Object.isFrozen(INFRA_DEFAULTS.grid));
});

test('infrastructure rejects unknown keys, nonfinite numbers, invalid outages and impossible storage',()=>{
 for(const x of [{grid:{loss:1}},{grid:{loss:NaN}},{services:{surprise:1}},
  {storage:{initial:1}},{storage:{dischargeEfficiency:0}},{outages:[{start:1,duration:0,zone:'both',availability:0}]},
  {outages:[{start:1,duration:1,zone:'invalid',availability:0}]},{outages:[{start:1,duration:1,zone:'ai',availability:0,extra:1}]},
  {observations:{enabled:1}},{extraction:{leadTime:-1}}, {grid:[]},null,
  {storage:{dischargeEfficiency:Number.MIN_VALUE}},
  {outages:[{start:10,duration:Number.MIN_VALUE,zone:'ai',availability:0}]}])assert.throws(()=>mergeInfrastructure(x));
});

test('N1 essential food and water adequacy uses population and named annual units',()=>{
 const c=config({services:{enabled:true,foodPerPerson:100,foodSupply:400e6,waterPerPerson:2,waterSupply:12e6}});
 const v=infrastructureView(initialInfrastructure(c),0,c,{H:8,humanPower:10,aiPower:0});
 close(v.foodAdequacy,.5);close(v.waterAdequacy,.75);close(v.serviceAdequacy,.5);
 const zero=infrastructureView(initialInfrastructure(c),0,c,{H:0,humanPower:0,aiPower:0});
 assert.equal(zero.serviceAdequacy,1);
});

test('N4 extraction obeys ore, extraction, refining, energy, work and lead-time limits',()=>{
 const c=config({extraction:{enabled:true,oreStock:7,extractionRate:12,capacity:20,energyPerMaterial:2,workPerMaterial:3,leadTime:2}});
 const state=initialInfrastructure(c);
 assert.equal(extractionRates(state,1,{energyBudget:100,workBudget:100},c).materials,0);
 const rates=extractionRates(state,2,{energyBudget:10,workBudget:12},c);
 assert.deepEqual(rates,{materials:4,energyUsed:8,workUsed:12});
 const first=extractMaterials(state,2,.5,{energyBudget:10,workBudget:12},c);
 assert.equal(first.materials,4);assert.equal(first.state.oreRemaining,3);
 const last=extractMaterials(first.state,2.5,1,{energyBudget:100,workBudget:100},c);
 assert.equal(last.materials,3);assert.equal(last.state.primarySupplied,7);
 close(last.state.extractionEnergy,14);close(last.state.extractionWork,21);
 assert.equal(state.oreRemaining,7);validateInfrastructureState(last.state,c);
 assert.equal(nextInfrastructureTime(0,c),2);assert.equal(nextInfrastructureTime(2,c),Infinity);
 const refined=config({extraction:{enabled:true,oreStock:100,extractionRate:20,capacity:3}});
 assert.equal(extractMaterials(initialInfrastructure(refined),0,1,{energyBudget:0,workBudget:0},refined).materials,3);
});

test('N4 annual extraction rate retains physical capacity until an exact ore-depletion boundary',()=>{
 const c=config({extraction:{enabled:true,oreStock:1,extractionRate:100,capacity:100,energyPerMaterial:1}});
 const state=initialInfrastructure(c);
 const annual=extractionRates(state,0,{energyBudget:100,workBudget:0},c);
 assert.deepEqual(annual,{materials:100,energyUsed:100,workUsed:0});
 const depletionTime=state.oreRemaining/annual.materials;
 assert.equal(depletionTime,.01);
 const done=extractMaterials(state,0,depletionTime,{energyBudget:1,workBudget:0},c);
 assert.equal(done.materials,1);assert.equal(done.state.oreRemaining,0);
 assert.deepEqual(extractionRates(done.state,depletionTime,{energyBudget:100,workBudget:0},c),
  {materials:0,energyUsed:0,workUsed:0});
});

test('N5 two-zone transfer obeys sending capacity and conserves transmission loss',()=>{
 const c=config({grid:{enabled:true,aiToHuman:4,humanToAi:8,loss:.25,humanReliability:.5}});
 const v=infrastructureView(initialInfrastructure(c),0,c,{humanPower:4,aiPower:20,humanNeed:10,operationNeed:10,H:1});
 close(v.rawGeneratedPower,22);close(v.transmissionLossPower,1);close(v.generatedPower,21);
 close(v.accessibleHumanPower,5);close(v.accessibleAiPower,16);
 close(v.accessibleHumanPower+v.accessibleAiPower,v.sourcePower);
 const noLink=config({grid:{enabled:true}});
 const n=infrastructureView(initialInfrastructure(noLink),0,noLink,{humanPower:0,aiPower:10,humanNeed:10,H:1});
 assert.equal(n.accessibleHumanPower,0);assert.equal(n.sourcePower,10);
});

test('N5 storage charges and discharges once, honors power, capacity and energy conservation',()=>{
 const c=config({storage:{enabled:true,capacity:10,initial:2,chargePower:4,dischargePower:6,chargeEfficiency:.8,dischargeEfficiency:.5}});
 let state=initialInfrastructure(c);
 let view=infrastructureView(state,0,c,{humanPower:0,aiPower:0,H:1,interval:.25});
 assert.equal(view.storageDischargePower,4);
 state=settleInfrastructure(state,{h:.25,chargeEnergy:1},c);close(state.storage,2.8);
 state=settleInfrastructure(state,{h:.25,dischargeEnergy:1},c);close(state.storage,.8);
 close(state.storageLoss,1.2);validateInfrastructureState(state,c);
 assert.throws(()=>settleInfrastructure(state,{h:.25,chargeEnergy:2},c));
 assert.throws(()=>settleInfrastructure(state,{h:.25,dischargeEnergy:1},c));
 assert.throws(()=>settleInfrastructure(state,{h:.25,chargeEnergy:.1,dischargeEnergy:.1},c));
 const split=settleInfrastructure(settleInfrastructure(initialInfrastructure(c),{h:.125,dischargeEnergy:.5},c),{h:.125,dischargeEnergy:.5},c);
 assert.equal(split.storage,0);close(split.storageDischarged,1);
});

test('N5 a tiny positive stock is offered over an actually representable future time interval',()=>{
 // IEEE-754 doubles immediately above 0.5 have independently known spacing 2^-53.
 assert.equal(minimumRepresentableInterval(.5),2**-53);
 assert.equal(minimumRepresentableInterval(0),Number.MIN_VALUE);
 const c=config({storage:{enabled:true,capacity:1,initial:1e-20,dischargePower:1,dischargeEfficiency:.5}});
 const state=initialInfrastructure(c),view=infrastructureView(state,.5,c,{interval:Number.MIN_VALUE});
 const delivered=view.storageDischargePower*(2**-53);
 assert.ok(delivered>0);assert.ok(delivered<=5e-21);
 close(view.storageDischargePower,5e-21/(2**-53));
 const settled=settleInfrastructure(state,{h:2**-53,dischargeEnergy:delivered},c);
 assert.equal(settled.storage,0);assert.equal(settled.storageDischarged,delivered);
 validateInfrastructureState(settled,c);
});

test('N6 cooling uses facility energy, WUE/PUE plus EWIF and temperature heat derating',()=>{
 const c=config({cooling:{enabled:true,waterAvailable:3e6,wue:2,ewif:.5,pue:2,maxHeatPower:10,
  temperature:30,referenceTemperature:20,deratingPerDegree:.05}});
 const state=initialInfrastructure(c);
 const v=infrastructureView(state,0,c,{humanPower:10,aiPower:10,H:1});
 close(v.coolingWaterIntensity,1.5);close(v.coolingOperationLimit,2);close(v.heatOperationLimit,5);
 const end=settleInfrastructure(state,{h:.5,operationEnergy:1},c);
 close(end.waterConsumed,1.5e6);close(end.coolingEnergy,1);validateInfrastructureState(end,c);
 assert.throws(()=>settleInfrastructure(state,{h:.5,operationEnergy:1.01},c));
});

test('N6 independent SI unit identity: one TWh at one litre/kWh consumes one million cubic metres',()=>{
 // 1 TWh = 1,000,000,000 kWh; at 1 litre/kWh this is 1,000,000 m3.
 const c=config({cooling:{enabled:true,waterAvailable:2_000_000,wue:1,pue:1,maxHeatPower:10}});
 const state=initialInfrastructure(c),view=infrastructureView(state,0,c,{humanPower:10});
 assert.equal(view.coolingWaterOperationLimit,2);
 const settled=settleInfrastructure(state,{h:1,operationEnergy:1},c);
 assert.equal(settled.waterConsumed,1_000_000);
 validateInfrastructureState(settled,c);
});

test('N8 outages apply only to their half-open periods and expose exact next boundaries',()=>{
 const c=config({outages:[{start:1,duration:2,zone:'human',availability:.5},{start:2,duration:1,zone:'both',availability:0}]});
 const state=initialInfrastructure(c),load={humanPower:10,aiPower:20,H:1};
 assert.equal(infrastructureView(state,.999,c,load).sourcePower,30);
 assert.equal(infrastructureView(state,1,c,load).sourcePower,25);
 assert.equal(infrastructureView(state,2,c,load).sourcePower,0);
 assert.equal(infrastructureView(state,3,c,load).sourcePower,30);
 assert.equal(nextInfrastructureTime(1,c),2);assert.equal(nextInfrastructureTime(2,c),3);
 assert.equal(nextInfrastructureTime(1-Number.EPSILON,c),1);
 assert.equal(nextInfrastructureTime(3,c),Infinity);
});

test('N8 observation noise is reproducible, order-independent and missingness explicit',()=>{
 const c=config({observations:{enabled:true,noise:.1,missingProbability:0}}),values={H:100,adequacy:.5};
 const first=observeInfrastructure(values,{seed:4,index:2},c);
 assert.deepEqual(first,observeInfrastructure(values,{seed:4,index:2},c));
 assert.deepEqual(first,observeInfrastructure({adequacy:.5,H:100},{seed:4,index:2},c));
 assert.notDeepEqual(first,observeInfrastructure(values,{seed:4,index:3},c));
 assert.ok(first.H>=90&&first.H<=110);assert.ok(first.adequacy>=.4&&first.adequacy<=.6);
 assert.deepEqual(observeInfrastructure(values,{seed:4,index:2},config({observations:{enabled:true,missingProbability:1}})),{H:null,adequacy:null});
 assert.deepEqual(values,{H:100,adequacy:.5});assert.deepEqual(observeInfrastructure(values,{seed:4,index:2},config({})),values);
});

test('checkpoint infrastructure validation rejects forged state and preserves caller objects',()=>{
 const c=config({extraction:{enabled:true,oreStock:4},storage:{enabled:true,capacity:2,initial:1}}),state=initialInfrastructure(c);
 validateInfrastructureState(state,c);
 for(const patch of [{oreRemaining:3},{storage:2},{waterConsumed:1},{storageLoss:1},{extra:1},{storage:NaN}])
  assert.throws(()=>validateInfrastructureState({...state,...patch},c));
 assert.throws(()=>infrastructureView(state,0,c,{humanPower:NaN,aiPower:0,H:1}));
 assert.throws(()=>extractMaterials(state,0,-1,{energyBudget:0,workBudget:0},c));
});
