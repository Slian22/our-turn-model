/** Browser/headless regional kernel. See README.md for scenario overrides. */
import {createRun} from '../sim/engine.mjs';
import {nextDuration} from '../sim/dynamics.mjs';
import {fundingDuration} from '../sim/policy-funding.mjs';
import {validatePolicies} from '../sim/policies.mjs';
import {canonical,hashText} from '../sim/rng.mjs';
import {ENGINE_VERSION,SOURCE_DIGEST as BASELINE_DIGEST} from '../sim/version.mjs';
import {normalizeOptions,deepFreeze,bounded,plain,keysOnly,LIMITS} from './config.mjs';
import {prepareRegion,integrateRegion} from './local.mjs';
import {routePower} from './grid.mjs';
import {historyPoint} from './observe.mjs';
import {validateCheckpoint} from './checkpoint.mjs';
import {SPATIAL_VERSION,SOURCE_DIGEST} from './version.mjs';
import {initialEvents,prepareEvents,effectiveConfig,eventDuration} from './events.mjs';
export {SPATIAL_VERSION,SOURCE_DIGEST};
export {summarizeWorld,worldView,trajectoryCSV} from './observe.mjs';
export const SCHEMA='our-turn.spatial.v1';
export function configurationId(world) {
 return hashText(canonical({config:world.config,regions:world.regions.map(({id,name,q,r,terrain,config})=>({id,name,q,r,terrain,config})),
  links:world.links.map(({flow,...link})=>link)}));
}
export function createWorld(options={}) {
 const normalized=normalizeOptions(options);
 const regions=normalized.regions.map(r=>{
  const state={...createRun(r.config).state,traceProjects:false,scenarioEvents:initialEvents(r.config.seed),
   commissionedBuildEnergy:0,commissionedBuildWork:0,cumulativeBuildWork:0,
   commissionedAmounts:Object.fromEntries(Object.keys(normalized.config.workWeights).map(k=>[k,0])),
   lastConstruction:{start:0,dt:0,energy:0,work:0,amounts:Object.fromEntries(Object.keys(normalized.config.workWeights).map(k=>[k,0]))}};
  return {...r,state,work:{capacity:state.F*(state.aF+(1-state.aF)*state.support)*normalized.config.workScale,used:0,requested:0}};
 });
 const routed=routePower(regions,normalized.links,normalized.config.gridScale);
 const initial={schema:SCHEMA,spatialVersion:SPATIAL_VERSION,sourceDigest:SOURCE_DIGEST,
  baselineVersion:ENGINE_VERSION,baselineSourceDigest:BASELINE_DIGEST,t:0,config:normalized.config,
  regions:regions.map((r,i)=>({...r,power:routed.power[i]})),links:routed.links,
  history:[],actions:[],branchOf:null};
 return deepFreeze({...initial,configId:configurationId(initial),history:[historyPoint(initial)]});
}
function stepBounded(world,target) {
 if(world.t>=target-1e-9)return world;
 const prepared=world.regions.map(r=>{
  const p=prepareRegion(r,world.config),state=prepareEvents(p.state,world.config,r.config.seed);
  return {...p,state,effectiveConfig:effectiveConfig(p.config,state)};
 }),routed=routePower(prepared,world.links,world.config.gridScale);
 const h=Math.min(target-world.t,...prepared.map((r,i)=>Math.min(nextDuration(r.state,r.config),eventDuration(r.state),
  fundingDuration(r.state,r.config,Math.max(0,routed.power[i].deliveredPower-routed.power[i].reserve)))));
 if(!Number.isFinite(h)||h<=0||world.t+h===world.t)throw new Error('Regional scheduler cannot make progress');
 const regions=prepared.map((r,i)=>({...integrateRegion(r,{deliveredPower:routed.power[i].deliveredPower,h},world.config),power:routed.power[i]}));
 const next={...world,t:world.t+h,regions,links:routed.links};
 if(world.history.length>=LIMITS.history)throw new Error('World history limit exceeded');
 return deepFreeze({...next,history:[...world.history,historyPoint(next)]});
}
export function stepWorld(world) {return stepBounded(world,world.config.horizon);}
export function advanceWorld(world,years=1) {
 bounded(years,'advance years',0,1e6);if(years===0)return world;
 const target=Math.min(world.config.horizon,world.t+years);let next=world,count=0;
 while(next.t<target-1e-9){
  if(++count>LIMITS.steps)throw new Error('Regional step limit exceeded');
  next=stepBounded(next,target);
 }
 return next;
}
export function branchWorld(world,action) {
 plain(action,'branch action');keysOnly(action,['regionId','type','start','delay','cost','duration','cap','success','residual'],'action');
 const index=world.regions.findIndex(r=>r.id===action.regionId);
 if(index<0)throw new RangeError('Unknown branch region');
 if(action.start<world.t-1e-9)throw new RangeError('Branch action must start at or after checkpoint time');
 if(world.actions.length>=64)throw new RangeError('World action limit exceeded');
 const {regionId,cap,...fields}=action;
 const policy=action.type==='cap'?{...fields,capBlocks:cap}:fields;
 if(action.type!=='cap'&&cap!==undefined)throw new RangeError('cap is only valid for cap policies');
 const region=world.regions[index],policies=validatePolicies([...region.config.policies,policy],world.config.horizon);
 const regions=world.regions.map((r,i)=>i!==index?r:{...r,config:{...r.config,policies},
  state:{...r.state,policyFunding:[...r.state.policyFunding,0]}});
 const branch={...world,regions,actions:[...world.actions,{regionId,...policies.at(-1),addedAt:world.t}],
  branchOf:{configId:world.configId,t:world.t}};
 return deepFreeze({...branch,configId:configurationId(branch)});
}
export function saveWorld(world) {return JSON.stringify(world);}
export function restoreWorld(text) {
 if(typeof text!=='string'||text.length>LIMITS.text)throw new RangeError('World checkpoint must be JSON text under 20MB');
 const world=JSON.parse(text);
 validateCheckpoint(world,{schema:SCHEMA,spatialVersion:SPATIAL_VERSION,sourceDigest:SOURCE_DIGEST,
  baselineVersion:ENGINE_VERSION,baselineSourceDigest:BASELINE_DIGEST,configurationId});
 return deepFreeze(world);
}
