import {makeConfig} from '../sim/config.mjs';
import {validatePolicies} from '../sim/policies.mjs';
import {hashText} from '../sim/rng.mjs';
import {normalizeEvents} from './events.mjs';

export const LIMITS=Object.freeze({regions:32,links:128,steps:100000,history:100001,items:100000,text:20000000});
export const KINDS=Object.freeze(['hardware','power','factory','powerAutomation','fabAutomation']);
export const DEFAULT_WEIGHTS=Object.freeze({hardware:1,power:1,factory:1,powerAutomation:1000,fabAutomation:1000});
const ids=['hearth','upland','sunbelt','delta','plateau','coast','frontier'];
const positions=[[0,0],[0,-1],[1,-1],[1,0],[0,1],[-1,1],[-1,0]];
const shares=[.22,.13,.16,.18,.1,.14,.07],powerShares=[.3,.14,.2,.06,.11,.16,.03];

export function plain(value,name) {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
  throw new TypeError(`${name} must be a plain object`);
}
export function bounded(value,name,min=0,max=Number.MAX_VALUE) {
 if(!Number.isFinite(value)||value<min||value>max)throw new RangeError(`Invalid ${name}`);
 return value;
}
export function keysOnly(object,allowed,name) {
 if(Reflect.ownKeys(object).some(key=>!allowed.includes(key)))throw new RangeError(`Unknown ${name} key`);
}
export function identifier(value,name) {
 if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value))throw new RangeError(`Invalid ${name}`);
 return value;
}
export function deepFreeze(value) {
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.values(value).forEach(deepFreeze);Object.freeze(value);
 }
 return value;
}
function defaultRegions() {
 return ids.map((id,i)=>({id,name:['Hearth','Upland','Sunbelt','Delta','Plateau','Coast','Frontier'][i],
  q:positions[i][0],r:positions[i][1],terrain:['plain','mountain','desert','wetland','plateau','coast','forest'][i],
  config:{H0:8000*shares[i],B0:1000*shares[i],G0:28000*powerShares[i],F0:1000*shares[i],
   land:1e8*shares[i],materials:200000*shares[i],rdReference:140*shares[i]}}));
}
export function normalizeRegionMetadata(spec,i) {
 plain(spec,'region');
 const id=identifier(spec.id,'region ID'),name=spec.name??id,terrain=spec.terrain??'plain';
 if(typeof name!=='string'||name.length>100||typeof terrain!=='string'||terrain.length>64)throw new RangeError('Invalid region labels');
 const q=spec.q??i,r=spec.r??0;
 if(!Number.isInteger(q)||!Number.isInteger(r)||Math.abs(q)>100||Math.abs(r)>100)throw new RangeError('Invalid axial position');
 return {id,name,q,r,terrain};
}
function normalizeRegion(spec,i,config,custom) {
 plain(spec,'region');keysOnly(spec,['id','name','q','r','terrain','config'],'region');
 const metadata=normalizeRegionMetadata(spec,i),{id}=metadata;
 const local=spec.config??{};plain(local,'regional config');
 const c=makeConfig({...config.baseline,...local,horizon:config.horizon,dt:config.dt,alignment:config.alignment,
  seed:local.seed??(custom?config.seed:(config.seed^parseInt(hashText(id),16))>>>0)});
 if(c.policies.length>0)throw new RangeError('Use branchWorld for regional policies');
 return {...metadata,config:{...c,policies:validatePolicies(c.policies,c.horizon)}};
}
export function normalizeLinks(specs,regions) {
 if(!Array.isArray(specs)||specs.length>LIMITS.links)throw new RangeError('Too many/invalid links');
 const seen=new Set(),ids=new Set(regions.map(r=>r.id));
 return specs.map(link=>{
  plain(link,'link');keysOnly(link,['id','from','to','capacity'],'link');
  const id=identifier(link.id,'link ID');
  if(seen.has(id)||!ids.has(link.from)||!ids.has(link.to)||link.from===link.to)throw new RangeError('Invalid/duplicate link endpoints or ID');
  seen.add(id);return {id,from:link.from,to:link.to,capacity:bounded(link.capacity,'link capacity',0,1e9)};
 });
}
export function normalizeOptions(options={}) {
 plain(options,'world options');keysOnly(options,['horizon','dt','alignment','seed','gridScale','workScale','unlimitedWork','workWeights','baseline','regions','links','eventMode','eventConfig'],'world');
 const config={horizon:options.horizon??30,dt:options.dt??1/32,alignment:options.alignment??.5,
  seed:options.seed??20261016,gridScale:options.gridScale??1,workScale:options.workScale??1,
  unlimitedWork:options.unlimitedWork??false,workWeights:{...DEFAULT_WEIGHTS,...options.workWeights},baseline:options.baseline??{},
  ...normalizeEvents(options.eventMode,options.eventConfig)};
 bounded(config.horizon,'horizon',1,200);bounded(config.dt,'dt',.005,1);bounded(config.alignment,'alignment',0,1);
 bounded(config.seed,'seed',0,0xffffffff);if(!Number.isInteger(config.seed))throw new RangeError('Seed must be an integer');
 bounded(config.gridScale,'gridScale',0,100);bounded(config.workScale,'workScale',0,100);
 if(typeof config.unlimitedWork!=='boolean')throw new TypeError('unlimitedWork must be boolean');
 plain(config.baseline,'baseline');makeConfig({...config.baseline,horizon:config.horizon,dt:config.dt,alignment:config.alignment,seed:config.seed});
 if(options.workWeights!==undefined)plain(options.workWeights,'workWeights');
 keysOnly(config.workWeights,KINDS,'work weights');for(const kind of KINDS)bounded(config.workWeights[kind],`${kind} work weight`,1e-9,1e9);
 const specs=options.regions??defaultRegions();
 if(!Array.isArray(specs)||specs.length<1||specs.length>LIMITS.regions)throw new RangeError('Expected 1..32 regions');
 const regions=specs.map((spec,i)=>normalizeRegion(spec,i,config,options.regions!==undefined));
 if(new Set(regions.map(r=>r.id)).size!==regions.length)throw new RangeError('Duplicate region ID');
 const defaultLinks=regions.slice(1).map((r,i)=>({
  // A separate fallback prefix cannot collide with an ordinary hearth-* ID.
  id:r.id.length<=57?`hearth-${r.id}`:`regional-link-${i+1}`,from:regions[0].id,to:r.id,capacity:1000}));
 const links=normalizeLinks(options.links??defaultLinks,regions).map(l=>({...l,flow:0}));
 return {config:structuredClone(config),regions,links};
}
