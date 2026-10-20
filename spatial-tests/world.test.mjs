import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun, stepRun} from '../sim/engine.mjs';
import {landUsed} from '../sim/infrastructure.mjs';
import {createWorld,stepWorld,advanceWorld,branchWorld,summarizeWorld,worldView,
 saveWorld,restoreWorld,trajectoryCSV,SPATIAL_VERSION,SOURCE_DIGEST} from '../spatial/world.mjs';

const close=(a,b,tol=1e-9)=>assert.ok(Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const region=(id,config={})=>({id,name:id,q:0,r:0,terrain:'plain',config});
const isolated=(config={},extra={})=>createWorld({horizon:4,seed:43,regions:[region('only',config)],links:[],...extra});

test('public defaults are seven deterministic immutable synthetic regions',()=>{
 const a=createWorld(),b=createWorld();assert.equal(a.regions.length,7);
 assert.deepEqual(a,b);assert.equal(a.t,0);assert.ok(Object.isFrozen(a));
 assert.ok(Object.isFrozen(a.regions[0].state.queue));
 assert.throws(()=>{a.regions[0].state.H=0;},TypeError);
 assert.equal(typeof SPATIAL_VERSION,'string');assert.match(SOURCE_DIGEST,/^[a-f0-9]{64}$/);
 const view=worldView(a);assert.equal(view.regions.length,7);assert.ok(view.links.length>0);
 assert.ok(['t','horizon','summary','history','branchOf'].every(k=>k in view));
});

test('unlimited work and no links reduce exactly to the unmodified baseline',()=>{
 let w=isolated({shockProbability:0},{unlimitedWork:true});
 let baseline=createRun(w.regions[0].config);
 for(let i=0;i<96;i++){
  w=stepWorld(w);baseline=stepRun(baseline);
  for(const k of ['t','H','B','G','F','Q','aE','aF','support','sH','active','cumulativeBuildEnergy'])
   close(w.regions[0].state[k],baseline.state[k]);
  assert.deepEqual(w.regions[0].state.queue,baseline.state.queue);
 }
});

test('independent regions with zero edges match separate isolated runs',()=>{
 const spec=[region('a',{seed:7,shockProbability:0}),region('b',{seed:9,shockProbability:0,G0:15000})];
 const together=advanceWorld(createWorld({horizon:2,regions:spec,links:[],unlimitedWork:true}),1);
 for(const r of spec){
  const alone=advanceWorld(createWorld({horizon:2,regions:[r],links:[],unlimitedWork:true}),1);
  assert.deepEqual(together.regions.find(x=>x.id===r.id).state,alone.regions[0].state);
 }
});

const pair=(capacity=100,extra={})=>createWorld({horizon:2,alignment:1,
 regions:[region('rich',{H0:10,G0:1000,B0:0}),region('poor',{H0:100,G0:0,B0:0})],
 links:[{id:'wire',from:'rich',to:'poor',capacity}],...extra});

test('reserve-first routing conserves electricity and respects undirected capacity',()=>{
 const w=stepWorld(pair()),v=worldView(w);const [a,b]=v.regions;
 close(a.rawPower+b.rawPower,a.deliveredPower+b.deliveredPower);
 close(a.exports,100);close(b.imports,100);close(v.links[0].flow,100);
 close(b.deliveredPower,100);close(a.deliveredPower,900);
 close(b.sH,.5);assert.ok(b.active===0);
 for(const r of v.regions){close(r.ledger.supply,r.deliveredPower);
  close(r.ledger.supply,Object.entries(r.ledger).filter(([k])=>k!=='supply').reduce((s,[,x])=>s+x,0));}
 const reversed=stepWorld(createWorld({horizon:2,alignment:1,regions:pair().regions.map(r=>({id:r.id,config:r.config})),
  links:[{id:'reverse',from:'poor',to:'rich',capacity:100}]}));
 close(worldView(reversed).links[0].flow,-100);
});

test('aggregate abundance cannot serve disconnected deficits; zero alignment cannot trade',()=>{
 const none=stepWorld(pair(0));close(worldView(none).regions[1].sH,0);
 const noReserve=stepWorld(pair(100,{alignment:0}));
 assert.ok(worldView(noReserve).regions.every(r=>r.imports===0&&r.exports===0));
 close(worldView(stepWorld(pair(400))).regions[1].sH,1);
});

test('transit flow serves deficits beyond a zero-population junction and never exports protected supply',()=>{
 const w=stepWorld(createWorld({horizon:2,alignment:1,regions:[
  region('a',{H0:10,G0:100}),region('hub',{H0:0,G0:0}),region('b',{H0:100,G0:0})],
 links:[{id:'ah',from:'a',to:'hub',capacity:200},{id:'hb',from:'hub',to:'b',capacity:200}]}));
 const v=worldView(w);close(v.regions[0].exports,80);close(v.regions[2].imports,80);
 close(v.regions[1].deliveredPower,0);close(v.links[0].flow,80);close(v.links[1].flow,80);
});

test('all five order kinds consume conserved positive construction work',()=>{
 const w=stepWorld(isolated({H0:0,aE0:1,aF0:1,G0:100000,F0:1,B0:1000,
  shockProbability:0,automationRate:.2},{workWeights:{hardware:1,power:2,factory:3,powerAutomation:4,fabAutomation:5}}));
 const r=w.regions[0],v=worldView(w).regions[0];
 // Autonomous power/factory exclude automation requests at a=1; test mixed autonomy separately below.
 assert.ok(r.state.queue.some(p=>p.kind==='power'));assert.ok(r.state.queue.some(p=>p.kind==='factory'));
 const actual=r.state.queue.reduce((s,p)=>s+p.amount*w.config.workWeights[p.kind],0);
 close(actual,v.work.used*r.state.stepDuration);assert.ok(v.work.used<=v.work.capacity+1e-9);
 assert.ok(v.work.requested>v.work.capacity);
 const mixed=stepWorld(isolated({H0:1,G0:100000,F0:1,B0:1000,shockProbability:0}));
 assert.deepEqual(new Set(mixed.regions[0].state.queue.map(p=>p.kind)),new Set(['hardware','power','factory','powerAutomation','fabAutomation']));
});

test('zero industrial work prevents every form of expansion, including automation',()=>{
 const w=advanceWorld(isolated({shockProbability:0},{workScale:0}),2);
 const r=w.regions[0];assert.deepEqual(r.state.queue,[]);assert.equal(r.state.G,r.config.G0);
 assert.equal(r.state.F,r.config.F0);assert.equal(r.state.aE,r.config.aE0);assert.equal(r.state.aF,r.config.aF0);
 assert.equal(worldView(w).regions[0].work.used,0);assert.ok(r.state.B<r.config.B0);
});

test('construction land stays local and paid work shrinks after land rationing',()=>{
 const w=stepWorld(isolated({H0:0,aE0:1,aF0:1,land:3000.001,shockProbability:0}));
 const r=w.regions[0];assert.ok(landUsed(r.state,r.config)<=r.config.land+1e-6);
 const v=worldView(w).regions[0];assert.ok(v.work.used<=v.work.capacity+1e-9);
 close(r.state.cumulativeBuildEnergy,r.state.queue.reduce((s,p)=>s+p.energy,0));
});

test('common h honors off-grid policy triggers, commissioning uses canonical dt',()=>{
 let w=isolated({shockProbability:0,hardwareDelay:.27},{dt:.1});
 w=branchWorld(w,{regionId:'only',type:'cap',start:.07,delay:0,cost:0,duration:.11,cap:10});
 w=stepWorld(w);close(w.t,.07);assert.equal(w.regions[0].config.dt,.1);
 assert.ok(w.regions[0].state.queue.every(p=>Math.abs(p.due/.1-Math.round(p.due/.1))<1e-9));
 assert.equal(w.regions[0].state.policyLog[0].t,.07);
 w=stepWorld(w);close(w.t,.1);w=stepWorld(w);close(w.t,.18);
});

test('funded policies split at payment completion and do not exceed delivered surplus',()=>{
 let w=isolated({H0:1,G0:1000,shockProbability:0},{dt:.1,alignment:1});
 w=branchWorld(w,{regionId:'only',type:'shutdown',start:0,delay:0,cost:9.98,success:1,residual:0});
 w=stepWorld(w);close(w.t,.01);assert.equal(w.regions[0].state.shutdown,true);
 close(w.regions[0].state.policyFunding[0],9.98);close(w.regions[0].state.ledger.policy,998);
 const stopped=stepWorld(w);assert.equal(stopped.regions[0].state.active,0);
});

test('paired policies retain the same regional annual exogenous shocks',()=>{
 const base=isolated({shockProbability:.6});
 const action={regionId:'only',type:'shutdown',start:.35,delay:.1,cost:0,success:1,residual:0};
 const a=advanceWorld(base,4),b=advanceWorld(branchWorld(base,action),4);
 const shocks=w=>w.regions[0].state.events.filter(e=>e.type==='supply-shock').map(({t,factor})=>({t,factor}));
 assert.deepEqual(shocks(a),shocks(b));assert.equal(a.regions[0].state.rng.environment,b.regions[0].state.rng.environment);
 assert.equal(base.actions.length,0);assert.equal(b.actions.length,1);assert.ok(b.branchOf);
});

test('summary uses powered-block weighting, falls back to installed blocks, and CSV is aggregate',()=>{
 const w=createWorld({horizon:2,regions:[region('a',{B0:10,Q0:2}),region('b',{B0:30,Q0:6})],links:[]});
 close(summarizeWorld(w).Q,5);const n=stepWorld(w),v=worldView(n);
 close(v.summary.Q,v.regions.reduce((s,r)=>s+r.Q*r.active,0)/v.regions.reduce((s,r)=>s+r.active,0));
 assert.ok(['H','B','G','F','Q','sH','minAdequacy','powerAutonomy','fabAutonomy','constructionWork'].every(k=>Number.isFinite(v.summary[k])));
 const rows=trajectoryCSV(n).trim().split('\n');assert.equal(rows.length,n.history.length+1);
 assert.equal(rows[0],'t,H,B,Q,sH,minAdequacy');
});

test('checkpoint round trip and full continuation replay are exact with queues, actions and RNG',()=>{
 let w=isolated({shockProbability:.5});w=branchWorld(w,{regionId:'only',type:'cap',start:.7,delay:.1,cost:5,cap:600,duration:1});
 w=advanceWorld(w,1.25);const restored=restoreWorld(saveWorld(w));assert.deepEqual(restored,w);
 assert.deepEqual(advanceWorld(restored,2.75),advanceWorld(w,2.75));
 assert.ok(Object.isFrozen(restored.regions[0].state.rng));
});

test('checkpoint rejects provenance, numeric, identity, ledger and continuity corruption',()=>{
 const w=advanceWorld(isolated({shockProbability:0}),.5);
 const mutations=[x=>x.sourceDigest='bad',x=>x.regions[0].state.H=-1,
  x=>x.regions[0].id='different',x=>x.regions[0].state.ledger.human+=1,
  x=>x.history.at(-1).t+=.01,x=>x.regions[0].state.t+=.01,
  x=>x.regions[0].state.rng.environment=-1,x=>x.regions[0].state.queue[0].due=0];
 for(const mutate of mutations){const x=JSON.parse(saveWorld(w));mutate(x);assert.throws(()=>restoreWorld(JSON.stringify(x)));}
 assert.throws(()=>restoreWorld('x'));assert.throws(()=>restoreWorld('{}'));assert.throws(()=>restoreWorld(3));
});

test('bounded advance and configuration validation fail explicitly',()=>{
 const w=isolated();assert.equal(advanceWorld(w,0),w);assert.equal(advanceWorld(w,100).t,4);
 assert.equal(stepWorld(advanceWorld(w,4)).t,4);
 for(const options of [{dt:0},{alignment:2},{gridScale:-1},{workScale:-1},{unknown:1},{regions:[]},
  {workWeights:{power:0}},{regions:[region('a'),region('a')]},{links:[{id:'x',from:'missing',to:'bad',capacity:1}]}])
  assert.throws(()=>createWorld(options));
 for(const years of [-1,Infinity,NaN])assert.throws(()=>advanceWorld(w,years));
 for(const action of [{regionId:'absent',type:'cap',start:0,delay:0,cap:0},
  {regionId:'only',type:'cap',start:0,delay:0,cap:0,extra:1},
  {regionId:'only',type:'shutdown',start:0,delay:0,success:2,residual:0}])assert.throws(()=>branchWorld(w,action));
 const later=advanceWorld(w,1);assert.throws(()=>branchWorld(later,{regionId:'only',type:'cap',start:0,delay:0,cap:0}));
});

test('regional outcomes use baseline trailing-window conventions without a global fate claim',()=>{
 const w=advanceWorld(pair(0),1),v=worldView(w);
 assert.equal(v.regions[0].regionalOutcome,'non-marginal');
 assert.equal(v.regions[1].regionalOutcome,'marginal');assert.equal(v.summary.outcome,undefined);
});

test('zero effective fabrication service blocks power, factory, hardware and both automation orders',()=>{
 for(const config of [{F0:0},{H0:0,aF0:0,aE0:.5}]){
  const w=advanceWorld(isolated({...config,shockProbability:0}),1),r=w.regions[0];
  assert.deepEqual(r.state.queue,[]);assert.equal(r.state.G,r.config.G0);
  assert.equal(r.state.F,r.config.F0);assert.equal(r.state.aE,r.config.aE0);assert.equal(r.state.aF,r.config.aF0);
  assert.equal(r.work.capacity,0);assert.equal(r.work.used,0);
 }
});

test('checkpoint replay preserves failed shutdown, partial deployment and year/commissioning boundaries',()=>{
 let w=isolated({G0:20000,shockProbability:1},{dt:.1});
 w=branchWorld(w,{regionId:'only',type:'shutdown',start:0,delay:0,cost:1,success:0,residual:0});
 w=branchWorld(w,{regionId:'only',type:'cap',start:.1,delay:0,cost:1e6,cap:1,duration:3});
 for(const target of [.05,.1,1,2,3]){
  w=advanceWorld(w,target-w.t);const restored=restoreWorld(saveWorld(w));assert.deepEqual(restored,w);
  assert.deepEqual(stepWorld(restored),stepWorld(w));
 }
 assert.equal(w.regions[0].state.policyLog[0].outcome,'failure');
 assert.ok(w.regions[0].state.policyFunding[1]>0&&w.regions[0].state.policyFunding[1]<1e6);
});
