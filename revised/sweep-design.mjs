/** [DOM-SWEEP] Explicit named factorial contrasts and reproducible Latin hypercubes.
 * A switch is a declared configuration bundle. Historical C1–C9 repairs are not
 * reversible switches; this API does not reconstruct older numerical kernels.
 */
import {makeConfig,deepFreeze,plain} from './config.mjs';
import {canonical,configurationId} from './identity.mjs';

export const DESIGN_LIMITS=Object.freeze({hardMaxRuns:50000,defaultMaxRuns:10000,
 maxSwitches:11,maxSeeds:100,maxSamples:4096,maxParameters:64});
const UNSAFE=new Set(['__proto__','prototype','constructor']);

function keys(value,allowed,name){
 plain(value,name);
 for(const key of Object.keys(value))if(!allowed.includes(key))throw new TypeError(`Unknown ${name}.${key}`);
 return value;
}
function integer(value,name,min,max){
 if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError(`${name} must be an integer in [${min},${max}]`);
 return value;
}
function jsonValue(value,depth=0,ancestors=new Set()){
 if(depth>20)throw new RangeError('Sweep specification nesting exceeds 20');
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(!value||typeof value!=='object')throw new TypeError('Sweep values must be finite JSON values');
 if(ancestors.has(value))throw new TypeError('Cyclic sweep specification');
 if(!Array.isArray(value))plain(value,'sweep value');
 for(const key of Array.isArray(value)?Array.from({length:value.length},(_,i)=>String(i)):Object.keys(value)){
  if(UNSAFE.has(key))throw new TypeError(`Unsafe sweep path ${key}`);
  jsonValue(value[key],depth+1,new Set([...ancestors,value]));
 }
}
function name(value,label,allowDash=true){
 if(typeof value!=='string'||!(allowDash?/^[A-Za-z][A-Za-z0-9_-]{0,47}$/:/^[A-Za-z][A-Za-z0-9_]{0,47}$/).test(value))throw new TypeError(`Invalid ${label}`);
 return value;
}
function pathValue(config,path){
 if(typeof path!=='string'||path.length>160||!path.split('.').every(k=>/^[A-Za-z][A-Za-z0-9]*$/.test(k)&&!UNSAFE.has(k)))
  throw new TypeError(`Invalid config path ${path}`);
 if(path==='seed')throw new TypeError('Config path seed is reserved for shared seeds');
 const value=path.split('.').reduce((current,key)=>{
  if(!current||typeof current!=='object'||Array.isArray(current)||!Object.hasOwn(current,key))throw new TypeError(`Unknown config path ${path}`);
  return current[key];
 },config);
 if(value&&typeof value==='object'&&!Array.isArray(value))throw new TypeError(`Config path must name a leaf: ${path}`);
 return value;
}
function setPath(object,path,value){
 const [key,...rest]=path.split('.');
 return {...object,[key]:rest.length?setPath(object[key],rest.join('.'),value):structuredClone(value)};
}
function applyPaths(config,values){
 return Object.entries(values).reduce((next,[path,value])=>setPath(next,path,value),config);
}
function switchDefinitions(values,base){
 if(!Array.isArray(values)||values.length>DESIGN_LIMITS.maxSwitches)throw new RangeError('Expected at most 11 named switches');
 const names=new Set(),paths=new Set();
 return Array.from(values,value=>{
  keys(value,['name','off','on'],'switch');name(value.name,'switch name',false);
  if(names.has(value.name))throw new TypeError(`Duplicate switch ${value.name}`);names.add(value.name);
  plain(value.off,'switch.off');plain(value.on,'switch.on');
  const off=Object.keys(value.off).sort(),on=Object.keys(value.on).sort();
  if(!off.length||canonical(off)!==canonical(on))throw new TypeError('Switch off/on maps must declare the same paths');
  if(canonical(value.off)===canonical(value.on))throw new TypeError('Switch off/on maps must differ');
  for(const path of off){
   pathValue(base,path);
   if(paths.has(path))throw new TypeError(`Overlapping switch path ${path}`);paths.add(path);
  }
  return {name:value.name,off:structuredClone(value.off),on:structuredClone(value.on)};
 });
}
function samplingDefinition(value,base,usedPaths){
 if(value===undefined)return {method:'factorial-only',samples:1,parameters:[]};
 keys(value,['method','samples','parameters'],'sampling');
 if(value.method!=='latin-hypercube')throw new RangeError('Sampling method must be latin-hypercube');
 integer(value.samples,'samples',1,DESIGN_LIMITS.maxSamples);
 if(!Array.isArray(value.parameters)||!value.parameters.length||value.parameters.length>DESIGN_LIMITS.maxParameters)
  throw new RangeError('Expected 1–64 continuous parameters');
 const seen=new Set(usedPaths);
 const parameters=Array.from(value.parameters,p=>{
  keys(p,['path','min','max','scale'],'parameter');
  if(typeof pathValue(base,p.path)!=='number')throw new TypeError(`Continuous parameter must name a numeric path: ${p.path}`);
  if(seen.has(p.path))throw new TypeError(`Overlapping parameter path ${p.path}`);seen.add(p.path);
  if(typeof p.min!=='number'||typeof p.max!=='number'||!Number.isFinite(p.min)||!Number.isFinite(p.max)||p.min>=p.max)
   throw new RangeError(`Invalid parameter range ${p.path}`);
  const scale=p.scale??'linear';
  if(!['linear','log'].includes(scale))throw new RangeError(`Invalid parameter scale ${scale}`);
  if(scale==='log'&&p.min<=0)throw new RangeError('Log range requires positive bounds');
  // Boundary validation avoids silently accepting inadmissible parts of a range.
  makeConfig(setPath(base,p.path,p.min));makeConfig(setPath(base,p.path,p.max));
  return {path:p.path,min:p.min,max:p.max,scale};
 });
 return {method:value.method,samples:value.samples,parameters};
}
function random(seed){
 let state=seed;
 return ()=>{
  state=(state+0x6d2b79f5)>>>0;
  let t=Math.imul(state^(state>>>15),state|1);
  t^=t+Math.imul(t^(t>>>7),t|61);
  return ((t^(t>>>14))>>>0);
 };
}
function shuffledStrata(count,next){
 let permutation=Array.from({length:count},(_,i)=>i);
 for(let i=count-1;i>0;i--){
  const j=Math.floor(next()/4294967296*(i+1)),a=permutation[i],b=permutation[j];
  permutation=permutation.map((v,k)=>k===i?b:k===j?a:v);
 }
 return permutation;
}
function continuousPoints(sampling,seed){
 const next=random(seed),n=sampling.samples;
 const coordinates=sampling.parameters.map(p=>({path:p.path,
  values:shuffledStrata(n,next).map(stratum=>(stratum+(next()+.5)/4294967296)/n)}));
 return Array.from({length:n},(_,i)=>{
  const unitCoordinates=Object.fromEntries(coordinates.map(c=>[c.path,c.values[i]]));
  const parameters=Object.fromEntries(sampling.parameters.map(p=>{
   const u=unitCoordinates[p.path],value=p.scale==='log'?Math.exp(Math.log(p.min)+u*(Math.log(p.max)-Math.log(p.min))):p.min+u*(p.max-p.min);
   return [p.path,value];
  }));
  return {id:`p${String(i+1).padStart(4,'0')}`,parameters,unitCoordinates};
 });
}
function caseId(prefix,pointId,mask,seed){return `${prefix}-${pointId}-s${String(mask).padStart(4,'0')}-r${seed}`;}
function pointCases(point,definitions,seeds,base,prefix){
 const sampled=applyPaths(base,point.parameters);
 return Array.from({length:2**definitions.length},(_,mask)=>{
  const switches=Object.fromEntries(definitions.map((d,i)=>[d.name,Boolean(mask&(2**i))]));
  const configured=definitions.reduce((c,d)=>applyPaths(c,switches[d.name]?d.on:d.off),sampled);
  return seeds.map(seed=>{
   const baselineIds=Object.fromEntries(definitions.flatMap((d,i)=>switches[d.name]?[[d.name,caseId(prefix,point.id,mask-2**i,seed)]]:[]));
   const config=makeConfig({...configured,seed});
   return {id:caseId(prefix,point.id,mask,seed),pointId:point.id,seed,switches,
    switchPaths:Object.fromEntries(definitions.map(d=>[d.name,Object.keys(d.off)])),parameters:point.parameters,
    baselineId:Object.values(baselineIds)[0]??null,baselineIds,config,configId:configurationId(config)};
  });
 }).flat();
}

/** Build and validate the entire design before executing any numerical run. */
export function buildSweepDesign(spec){
 jsonValue(spec);
 keys(spec,['name','base','designSeed','seeds','switches','sampling','maxRuns'],'design');
 const prefix=name(spec.name??'design','design name');
 const designSeed=integer(spec.designSeed??20261018,'design seed',0,0xffffffff);
 plain(spec.base??{},'base');
 if(Object.hasOwn(spec.base??{},'seed'))throw new TypeError('base.seed is reserved; declare the shared seeds list');
 const base=makeConfig(spec.base??{}),definitions=switchDefinitions(spec.switches??[],base);
 if(!Array.isArray(spec.seeds)||!spec.seeds.length||spec.seeds.length>DESIGN_LIMITS.maxSeeds)throw new RangeError('Expected 1–100 shared seeds');
 const seeds=Array.from(spec.seeds,seed=>integer(seed,'shared seed',0,0xffffffff));
 if(new Set(seeds).size!==seeds.length)throw new TypeError('Duplicate shared seed');
 const sampling=samplingDefinition(spec.sampling,base,definitions.flatMap(d=>Object.keys(d.off)));
 const maxRuns=integer(spec.maxRuns??DESIGN_LIMITS.defaultMaxRuns,'maxRuns',1,DESIGN_LIMITS.hardMaxRuns);
 const count=sampling.samples*2**definitions.length*seeds.length;
 if(count>maxRuns)throw new RangeError(`Design requires ${count} runs, exceeding cap ${maxRuns}`);
 const points=continuousPoints(sampling,designSeed);
 const cases=points.flatMap(point=>pointCases(point,definitions,seeds,base,prefix));
 return deepFreeze({schema:'mcm.designed-sweep.v1',name:prefix,specification:structuredClone(spec),points,cases,
  metadata:{designSeed,sharedSeeds:seeds,runCount:count,maxRuns,factorialCombinations:2**definitions.length,
   switchDefinitions:definitions,historicalKernelSwitchesSupported:false,
   sampling:{...sampling,generator:'mulberry32-v1',endpointRule:'open stratum jitter',
    factorOrder:sampling.parameters.map(p=>p.path),crossedWithAllSwitches:true},
   pairingRule:'Same continuous point and seed; exactly one declared named switch is changed from off to on.'}});
}
