import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,stepWorld,restoreWorld,saveWorld} from '../spatial/world.mjs';

const close=(actual,expected,scale=1)=>assert.ok(Math.abs(actual-expected)<=32*Number.EPSILON*Math.max(scale,Math.abs(actual),Math.abs(expected)),`${actual} != ${expected}`);
const region=(id,H0,G0)=>({id,config:{H0,G0,B0:0,F0:0,aE0:1,shockProbability:0,birth:0,death:0,shortfall:0}});
function conserved(world){
 const raw=world.regions.reduce((sum,r)=>sum+r.power.rawPower,0);
 close(world.regions.reduce((sum,r)=>sum+r.power.deliveredPower,0),raw,raw);
 for(const r of world.regions){
  const signed=world.links.reduce((sum,l)=>sum+(l.to===r.id?l.flow:0)-(l.from===r.id?l.flow:0),0);
  close(r.power.imports-r.power.exports,signed,raw);
  close(r.power.deliveredPower,r.power.rawPower+signed,raw);
  assert.ok(r.power.deliveredPower>=0);
 }
 for(const l of world.links)assert.ok(Math.abs(l.flow)<=l.capacity*world.config.gridScale+32*Number.EPSILON*Math.max(1,l.capacity*world.config.gridScale));
 assert.deepEqual(restoreWorld(saveWorld(world)),world);
}

for(const reverse of [false,true])test(`R01 large residual capacities preserve fractional transit flow (${reverse?'reverse':'forward'})`,()=>{
 const links=[{id:'dh',from:'d',to:'hub',capacity:1e8},{id:'hs',from:'hub',to:'s',capacity:1e9}]
  .map(l=>reverse?{...l,from:l.to,to:l.from}:l);
 const world=stepWorld(createWorld({alignment:1,gridScale:100,
  regions:[region('d',0,1),region('hub',0,0),region('s',.15,0)],links}));
 for(const l of world.links)assert.equal(l.flow,reverse?-.3:.3);
 assert.equal(world.regions[1].power.deliveredPower,0);
 conserved(world);
});

test('R01 heterogeneous parallel links conserve fractional transfers and retain input tie order',()=>{
 const world=stepWorld(createWorld({alignment:1,gridScale:100,regions:[region('d',0,1),region('s',.15,0)],
  links:[{id:'small',from:'d',to:'s',capacity:.001},{id:'large',from:'s',to:'d',capacity:1e9}]}));
 assert.equal(world.links[0].flow,.1);close(world.links[1].flow,-.2);
 close(world.regions[1].state.sH,1);conserved(world);
});

test('R01 reverse residual augmentation cancels an earlier route instead of double-counting it',()=>{
 const world=stepWorld(createWorld({alignment:1,regions:[region('u',0,1),region('v',0,1),region('x',.5,0),region('y',.5,0)],
  links:[{id:'ux',from:'u',to:'x',capacity:1},{id:'uy',from:'u',to:'y',capacity:1},{id:'vx',from:'v',to:'x',capacity:1}]}));
 assert.deepEqual(world.links.map(l=>l.flow),[0,1,1]);conserved(world);
});

for(const H0 of [1e-14,1e-100,1e-310])test(`R05 positive tiny sink reserve is routed at H0=${H0}`,()=>{
 const world=stepWorld(createWorld({alignment:1,regions:[region('d',0,100*H0),region('s',H0,0)],
  links:[{id:'wire',from:'d',to:'s',capacity:1}]}));
 assert.equal(world.links[0].flow,2*H0);
 assert.equal(world.regions[1].state.sH,1);
 conserved(world);
});

test('independent exhaustive min-cut oracle covers deterministic integral networks and parallel links',()=>{
 let random=719;
 const draw=max=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random%max;};
 for(let trial=0;trial<32;trial++){
  const supply=Array.from({length:4},()=>draw(12)),need=Array.from({length:4},()=>draw(12)),links=[];
  for(let a=0;a<4;a++)for(let b=a+1;b<4;b++)links.push({id:`e${a}${b}`,from:`r${a}`,to:`r${b}`,capacity:draw(10)});
  links.push({id:'parallel',from:'r1',to:'r0',capacity:draw(5)});
  let oracle=Infinity;
  for(let mask=0;mask<16;mask++){
   let capacity=0;
   for(let i=0;i<4;i++)capacity+=(mask&(1<<i))?Math.max(0,need[i]-supply[i]):Math.max(0,supply[i]-need[i]);
   for(const l of links)if(Boolean(mask&(1<<Number(l.from[1])))!==Boolean(mask&(1<<Number(l.to[1]))))capacity+=l.capacity;
   oracle=Math.min(oracle,capacity);
  }
  const world=stepWorld(createWorld({alignment:1,regions:supply.map((G0,i)=>region(`r${i}`,need[i]/2,G0)),links}));
  assert.equal(world.regions.reduce((sum,r)=>sum+Math.max(0,r.power.imports-r.power.exports),0),oracle,`trial ${trial}`);
  conserved(world);
 }
});
