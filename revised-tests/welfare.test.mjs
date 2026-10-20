import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityOfLife, perCapitaElectricity, memTarget, intervalWelfare,
 actionPriority, reorderRequests} from '../revised/welfare.mjs';
import {humanStep} from '../revised/math.mjs';

test('[DOM-QOL] proposal anchors follow the declared exponential curve',()=>{
 assert.equal(qualityOfLife(0),0);
 for(const e of [250,500,750,1000,2000,4000])
  assert.ok(Math.abs(qualityOfLife(e)-.9*(1-Math.exp(-e/667)))<1e-14);
 assert.ok(Math.abs(qualityOfLife(1000)-.7)<.001);
 assert.ok(qualityOfLife(4000)>.897&&qualityOfLife(4000)<.9);
 assert.equal(qualityOfLife(Number.MAX_VALUE),.9);
 assert.ok(qualityOfLife(1e-15)>0);
 assert.equal(qualityOfLife(667,{maximum:.8,scale:667}),.8*(-Math.expm1(-1)));
 assert.equal(qualityOfLife(1000,{maximum:0}),0);
});

test('[DOM-MEM] electricity units and historical-population reserve are explicit',()=>{
 assert.equal(perCapitaElectricity(8000,1,8000),1000);
 assert.equal(perCapitaElectricity(4000,.5,8000),1000);
 assert.equal(perCapitaElectricity(0,1,8000),0);
 assert.equal(perCapitaElectricity(100,1,0),0);
 assert.equal(memTarget(8000,8000,1,1),8000);
 assert.equal(memTarget(4000,8000,1,.5),4000);
 assert.equal(memTarget(10000,8000,1,.5),5000);
 assert.equal(memTarget(0,8000,1,1),8000);
 assert.equal(memTarget(8000,8000,2,0),0);
});

test('[DOM-QOL] interval utility uses start population and exact demographic person-years',()=>{
 const demographic=humanStep({H:100,exposure:.6},.4,2,
  {growth:.01,maximumMortality:.2,exposureTime:1});
 const result=intervalWelfare({energyTWh:200,hYears:2,startPopulation:100,
  personYears:demographic.personYears});
 assert.equal(result.perCapitaElectricity,1000);
 assert.equal(result.qualityOfLife,qualityOfLife(1000));
 assert.equal(result.personYears,demographic.personYears);
 assert.equal(result.weightedQolPersonYears,qualityOfLife(1000)*demographic.personYears);
 assert.notEqual(result.personYears,2*demographic.H);
 assert.deepEqual(intervalWelfare({energyTWh:0,hYears:1,startPopulation:0,personYears:0}),
  {perCapitaElectricity:0,qualityOfLife:0,personYears:0,weightedQolPersonYears:0});
});

test('[DOM-QOL] interval utility is additive for a frozen service and demographic rate',()=>{
 const human={growth:.03,maximumMortality:0,exposureTime:1};
 const whole=humanStep({H:100,exposure:0},0,2,human);
 const first=humanStep({H:100,exposure:0},0,1,human);
 const second=humanStep({H:first.H,exposure:0},0,1,human);
 const utility=(H,h,personYears)=>intervalWelfare({energyTWh:H*h,hYears:h,
  startPopulation:H,personYears}).weightedQolPersonYears;
 assert.ok(Math.abs(utility(100,2,whole.personYears)-utility(100,1,first.personYears)
  -utility(first.H,1,second.personYears))<1e-11);
});

test('[TH-PRIORITY] relative powered processing and actual human use determine priority',()=>{
 assert.deepEqual(actionPriority({processing:80000,humanUsage:10000}),
  {aiScore:1,humanScore:.5,winner:'ai'});
 assert.deepEqual(actionPriority({processing:40000,humanUsage:20000}),
  {aiScore:.5,humanScore:1,winner:'human'});
 assert.deepEqual(actionPriority({processing:80000,humanUsage:20000},{aiWeight:2}),
  {aiScore:2,humanScore:1,winner:'ai'});
 assert.deepEqual(actionPriority({processing:80000,humanUsage:20000},{humanWeight:2}),
  {aiScore:1,humanScore:2,winner:'human'});
 assert.equal(actionPriority({processing:100,humanUsage:1},
  {processingReference:100,humanUsageReference:2}).winner,'ai');
});

test('[TH-PRIORITY] ties, zero scores and static mode have declared deterministic behavior',()=>{
 assert.equal(actionPriority({processing:0,humanUsage:0}).winner,'human');
 assert.equal(actionPriority({processing:0,humanUsage:0},{tieBreak:'ai'}).winner,'ai');
 assert.equal(actionPriority({processing:80000,humanUsage:20000}).winner,'human');
 assert.equal(actionPriority({processing:80000,humanUsage:0},
  {mode:'static',tieBreak:'human'}).winner,'human');
 assert.equal(actionPriority({processing:0,humanUsage:20000},
  {mode:'static',tieBreak:'ai'}).winner,'ai');
});

test('[TH-PRIORITY] request reordering is stable, immutable, and owner precedence wins first',()=>{
 const rows=Object.freeze([
  Object.freeze({id:'human-high',owner:'human',priority:0}),
  Object.freeze({id:'ai-low',owner:'ai',priority:5}),
  Object.freeze({id:'human-low',owner:'human',priority:8}),
  Object.freeze({id:'ai-first',owner:'ai',priority:1}),
  Object.freeze({id:'ai-equal',owner:'ai',priority:1}),
 ]);
 assert.deepEqual(reorderRequests(rows,'ai').map(x=>x.id),
  ['ai-first','ai-equal','ai-low','human-high','human-low']);
 assert.deepEqual(reorderRequests(rows,'human').map(x=>x.id),
  ['human-high','human-low','ai-first','ai-equal','ai-low']);
 assert.deepEqual(reorderRequests(rows,'ai','static'),rows);
 assert.notEqual(reorderRequests(rows,'ai','static'),rows);
 assert.equal(rows[0].id,'human-high');
});

test('welfare functions reject nonfinite, negative and invalid scale inputs',()=>{
 for(const value of [NaN,Infinity,-Infinity,-1]){
  assert.throws(()=>qualityOfLife(value));
  assert.throws(()=>perCapitaElectricity(value,1,100));
  assert.throws(()=>memTarget(value,100,1,.5));
 }
 for(const config of [{maximum:NaN},{maximum:1.1},{scale:0},{scale:-1}])
  assert.throws(()=>qualityOfLife(1000,config));
 for(const args of [[1,0,1],[1,-1,1],[1,1,-1],[1,Infinity,1],[1,1,NaN]])
  assert.throws(()=>perCapitaElectricity(...args));
 assert.throws(()=>perCapitaElectricity(Number.MAX_VALUE,1,1));
 for(const args of [[1,-1,1,.5],[1,1,-1,.5],[1,1,1,1.1],[1,1,1,-1]])
  assert.throws(()=>memTarget(...args));
 assert.throws(()=>memTarget(Number.MAX_VALUE,1,2,1));
 for(const personYears of [-1,Infinity])
  assert.throws(()=>intervalWelfare({energyTWh:1,hYears:1,startPopulation:1,personYears}));
 assert.throws(()=>intervalWelfare({energyTWh:1,hYears:1,startPopulation:1,
  personYears:NaN}));
});

test('priority functions reject invalid measurements, configuration and request rows',()=>{
 for(const key of ['processing','humanUsage'])for(const value of [NaN,Infinity,-1])
  assert.throws(()=>actionPriority({processing:1,humanUsage:1,[key]:value}));
 for(const config of [{mode:'random'},{processingReference:0},{humanUsageReference:-1},
  {aiWeight:-1},{humanWeight:Infinity},{tieBreak:'random'}])
  assert.throws(()=>actionPriority({processing:1,humanUsage:1},config));
 assert.throws(()=>actionPriority({processing:Number.MAX_VALUE,humanUsage:1},
  {processingReference:Number.MIN_VALUE}));
 assert.throws(()=>reorderRequests([], 'random'));
 assert.throws(()=>reorderRequests([], 'ai','random'));
 assert.throws(()=>reorderRequests(null,'ai'));
 assert.throws(()=>reorderRequests([{owner:'ai',priority:NaN}],'ai'));
});
