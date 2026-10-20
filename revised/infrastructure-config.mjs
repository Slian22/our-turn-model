// TH-N1, TH-N4, TH-N5, TH-N6, TH-N8: optional mechanisms; zero defaults are not calibrations.
const freeze=value=>{
 if(value&&typeof value==='object')for(const child of Object.values(value))freeze(child);
 return value&&typeof value==='object'?Object.freeze(value):value;
};

export const INFRA_DEFAULTS=freeze({
 services:{enabled:false,foodPerPerson:0,foodSupply:0,waterPerPerson:0,waterSupply:0},
 extraction:{enabled:false,oreStock:0,extractionRate:0,capacity:0,energyPerMaterial:0,workPerMaterial:0,leadTime:0},
 grid:{enabled:false,humanReliability:1,aiReliability:1,humanToAi:0,aiToHuman:0,loss:0},
 storage:{enabled:false,capacity:0,initial:0,chargePower:0,dischargePower:0,chargeEfficiency:1,dischargeEfficiency:1},
 cooling:{enabled:false,waterAvailable:0,wue:0,ewif:0,pue:1,maxHeatPower:0,temperature:20,referenceTemperature:20,deratingPerDegree:0},
 observations:{enabled:false,noise:0,missingProbability:0},
 outages:[]
});

function record(value,path){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)
  throw new TypeError(`${path} must be a plain object`);
 return value;
}

function number(value,path,min=0,max=1e24){
 if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)
  throw new RangeError(`${path} must be finite in [${min}, ${max}]`);
}

function mergedGroup(name,overrides){
 const defaults=INFRA_DEFAULTS[name],input=overrides===undefined?{}:record(overrides,`infrastructure.${name}`);
 for(const key of Object.keys(input))if(!Object.hasOwn(defaults,key))throw new TypeError(`Unknown infrastructure.${name}.${key}`);
 const result={...defaults,...input};
 for(const [key,value] of Object.entries(result)){
  if(key==='enabled'){
   if(typeof value!=='boolean')throw new TypeError(`infrastructure.${name}.enabled must be boolean`);
  }else number(value,`infrastructure.${name}.${key}`,
   ['temperature','referenceTemperature'].includes(key)?-273.15:0);
 }
 return result;
}

function outages(input){
 if(!Array.isArray(input)||input.length>1000)throw new TypeError('infrastructure.outages must be an array of at most 1000 outages');
 return input.map((raw,i)=>{
  const item=record(raw,`infrastructure.outages[${i}]`),keys=['start','duration','zone','availability'];
  if(Object.keys(item).length!==keys.length||Object.keys(item).some(key=>!keys.includes(key)))throw new TypeError('Invalid outage fields');
  number(item.start,'outage start');number(item.duration,'outage duration',Number.MIN_VALUE);
  number(item.start+item.duration,'outage end');number(item.availability,'outage availability',0,1);
  if(item.start+item.duration===item.start)throw new RangeError('Outage duration is below numeric resolution');
  if(!['human','ai','both'].includes(item.zone))throw new TypeError('Invalid outage zone');
  return {...item};
 });
}

export function mergeInfrastructure(input={}){
 record(input,'infrastructure');
 for(const key of Object.keys(input))if(!Object.hasOwn(INFRA_DEFAULTS,key))throw new TypeError(`Unknown infrastructure.${key}`);
 const result=Object.fromEntries(Object.keys(INFRA_DEFAULTS).filter(key=>key!=='outages').map(key=>[key,mergedGroup(key,input[key])]));
 result.outages=outages(input.outages??[]);
 for(const key of ['humanReliability','aiReliability'])number(result.grid[key],`grid.${key}`,0,1);
 number(result.grid.loss,'grid.loss',0,1-Number.EPSILON);
 for(const key of ['chargeEfficiency','dischargeEfficiency']){
  number(result.storage[key],`storage.${key}`,Number.MIN_VALUE,1);
  if(!Number.isFinite(1/result.storage[key]))throw new RangeError(`storage.${key} is below numeric resolution`);
 }
 if(result.storage.initial>result.storage.capacity)throw new RangeError('Initial stored energy exceeds storage capacity');
 number(result.cooling.pue,'cooling.pue',1);number(result.cooling.deratingPerDegree,'cooling.deratingPerDegree',0,1);
 number(result.observations.noise,'observations.noise',0,1);number(result.observations.missingProbability,'observations.missingProbability',0,1);
 return freeze(result);
}
