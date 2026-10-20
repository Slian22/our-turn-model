// TH-N1, TH-N4, TH-N5, TH-N6, TH-N8: conserved optional physical and observation extensions.
import {INFRA_DEFAULTS} from './infrastructure-config.mjs';

const cfg=c=>c.infrastructure??INFRA_DEFAULTS;
// 1 TWh = 10^9 kWh and 1 m3 = 10^3 L, so TWh * L/kWh -> 10^6 m3.
const CUBIC_METRES_PER_TWH_LITRE_PER_KWH=1e6;
const limited=(available,perUnit)=>perUnit===0?Number.MAX_VALUE:available/perUnit;
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
const positive=(value,name)=>{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new RangeError(`${name} must be finite and nonnegative`);
 return value;
};
const interval=h=>{
 positive(h,'interval');if(h===0)throw new RangeError('Interval must be positive');return h;
};

export function minimumRepresentableInterval(t){
 positive(t,'time');if(t===0)return Number.MIN_VALUE;
 const bits=new DataView(new ArrayBuffer(8));
 bits.setFloat64(0,t);bits.setBigUint64(0,bits.getBigUint64(0)+1n);
 const next=bits.getFloat64(0);
 if(!Number.isFinite(next))throw new RangeError('No finite future time is representable');
 return next-t;
}

export function initialInfrastructure(c){
 const n=cfg(c);
 return {storage:n.storage.enabled?n.storage.initial:0,oreRemaining:n.extraction.enabled?n.extraction.oreStock:0,
  primarySupplied:0,extractionEnergy:0,extractionWork:0,storageCharged:0,storageDischarged:0,
  storageLoss:0,waterConsumed:0,coolingEnergy:0};
}

export function validateInfrastructureState(state,c){
 const initial=initialInfrastructure(c),keys=Object.keys(initial),n=cfg(c),s=n.storage,x=n.extraction;
 if(!state||typeof state!=='object'||Array.isArray(state)||Object.keys(state).length!==keys.length||Object.keys(state).some(k=>!keys.includes(k)))
  throw new TypeError('Invalid infrastructure state fields');
 for(const key of keys)positive(state[key],`infrastructure.${key}`);
 const expectedStorage=initial.storage+state.storageCharged*s.chargeEfficiency-state.storageDischarged/s.dischargeEfficiency;
 const expectedLoss=state.storageCharged*(1-s.chargeEfficiency)+state.storageDischarged*(1/s.dischargeEfficiency-1);
 const intensity=n.cooling.enabled?n.cooling.wue/n.cooling.pue+n.cooling.ewif:0;
 const checks=[near(state.oreRemaining+state.primarySupplied,initial.oreRemaining),
  near(state.extractionEnergy,state.primarySupplied*x.energyPerMaterial),near(state.extractionWork,state.primarySupplied*x.workPerMaterial),
  near(state.storage,expectedStorage),near(state.storageLoss,expectedLoss),near(state.waterConsumed,state.coolingEnergy*intensity*CUBIC_METRES_PER_TWH_LITRE_PER_KWH),
  state.storage<=s.capacity+1e-8, x.enabled||state.primarySupplied===0,
  s.enabled||(state.storageCharged===0&&state.storageDischarged===0),n.cooling.enabled||state.coolingEnergy===0];
 if(checks.some(ok=>!ok))throw new RangeError('Infrastructure conservation mismatch');
 return state;
}

function reliability(t,n){
 let human=n.grid.enabled?n.grid.humanReliability:1,ai=n.grid.enabled?n.grid.aiReliability:1;
 for(const outage of n.outages)if(t>=outage.start&&t<outage.start+outage.duration){
  if(outage.zone==='human'||outage.zone==='both')human*=outage.availability;
  if(outage.zone==='ai'||outage.zone==='both')ai*=outage.availability;
 }
 return {human,ai};
}

function delivery(human,ai,humanNeed,aiNeed,n){
 if(!n.grid.enabled)return {human:human+ai,ai:human+ai,loss:0};
 const eta=1-n.grid.loss;
 const toHuman=Math.min(n.grid.aiToHuman,Math.max(0,ai-aiNeed),Math.max(0,humanNeed-human)/eta);
 const toAi=Math.min(n.grid.humanToAi,Math.max(0,human-humanNeed),Math.max(0,aiNeed-ai)/eta);
 return {human:human+toHuman*eta-toAi,ai:ai+toAi*eta-toHuman,loss:(toHuman+toAi)*n.grid.loss};
}

function coolingLimits(n){
 if(!n.cooling.enabled)return {intensity:0,water:Number.MAX_VALUE,heat:Number.MAX_VALUE,operation:Number.MAX_VALUE};
 const x=n.cooling,intensity=x.wue/x.pue+x.ewif;
 const water=limited(x.waterAvailable,intensity*CUBIC_METRES_PER_TWH_LITRE_PER_KWH);
 const heat=x.maxHeatPower*Math.max(0,1-x.deratingPerDegree*Math.max(0,x.temperature-x.referenceTemperature));
 return {intensity,water,heat,operation:Math.min(water,heat)};
}

export function infrastructureView(state,t,c,{humanPower=0,aiPower=0,H=0,operationNeed=0,humanNeed=0,interval:h=c.dt??1}={}){
 positive(t,'time');interval(h);
 for(const [name,value] of Object.entries({humanPower,aiPower,H,operationNeed,humanNeed}))positive(value,name);
 const n=cfg(c),r=reliability(t,n),human=humanPower*r.human,ai=aiPower*r.ai,cooling=coolingLimits(n);
 // TH-N5/N6: unavailable cooling cannot reserve generation against human imports.
 const d=delivery(human,ai,humanNeed,Math.min(operationNeed,cooling.operation),n),rawGeneratedPower=human+ai,generatedPower=rawGeneratedPower-d.loss;
 // TH-N5: a positive residual is dispatched over a representable time step;
 // reducing the offered rate preserves its energy and its eventual debit.
 const storageInterval=n.storage.enabled?Math.max(h,minimumRepresentableInterval(t)):h;
 const storageDischargePower=n.storage.enabled?Math.min(n.storage.dischargePower,state.storage*n.storage.dischargeEfficiency/storageInterval):0;
 const foodNeed=H*1e6*n.services.foodPerPerson,waterNeed=H*1e6*n.services.waterPerPerson;
 const foodAdequacy=n.services.enabled&&foodNeed>0?Math.min(1,n.services.foodSupply/foodNeed):1;
 const waterAdequacy=n.services.enabled&&waterNeed>0?Math.min(1,n.services.waterSupply/waterNeed):1;
 return {rawGeneratedPower,generatedPower,sourcePower:generatedPower+storageDischargePower,
  accessibleHumanPower:d.human+storageDischargePower,accessibleAiPower:d.ai+storageDischargePower,
  storageDischargePower,transmissionLossPower:d.loss,humanReliability:r.human,aiReliability:r.ai,
  coolingOperationLimit:cooling.operation,coolingWaterIntensity:cooling.intensity,heatOperationLimit:cooling.heat,
  coolingWaterOperationLimit:cooling.water,foodAdequacy,waterAdequacy,serviceAdequacy:Math.min(foodAdequacy,waterAdequacy)};
}

function extractionLimit(state,t,h,energyBudget,workBudget,c){
 const x=cfg(c).extraction;
 if(!x.enabled||t<x.leadTime)return 0;
 return Math.min(state.oreRemaining,x.extractionRate*h,x.capacity*h,
  limited(energyBudget,x.energyPerMaterial),limited(workBudget,x.workPerMaterial));
}

export function extractionRates(state,t,{energyBudget,workBudget,interval:requestedInterval},c){
 positive(t,'time');if(requestedInterval!==undefined)interval(requestedInterval);
 positive(energyBudget,'extraction energy rate');positive(workBudget,'extraction work rate');
 const x=cfg(c).extraction;
 // Rates remain physical until the scheduler's ore / material-rate boundary.
 // Capping by ore / dt would make extraction depend on UI advance chunking.
 const materials=x.enabled&&t>=x.leadTime&&state.oreRemaining>0?
  Math.min(x.extractionRate,x.capacity,limited(energyBudget,x.energyPerMaterial),limited(workBudget,x.workPerMaterial)):0;
 return {materials,energyUsed:materials*x.energyPerMaterial,workUsed:materials*x.workPerMaterial};
}

export function extractMaterials(state,t,h,{energyBudget,workBudget},c){
 positive(t,'time');interval(h);positive(energyBudget,'extraction energy');positive(workBudget,'extraction work');
 const materials=extractionLimit(state,t,h,energyBudget,workBudget,c),x=cfg(c).extraction;
 const energyUsed=materials*x.energyPerMaterial,workUsed=materials*x.workPerMaterial;
 const updated=materials===0?state:{...state,oreRemaining:state.oreRemaining-materials,primarySupplied:state.primarySupplied+materials,
  extractionEnergy:state.extractionEnergy+energyUsed,extractionWork:state.extractionWork+workUsed};
 return {state:updated,materials,energyUsed,workUsed};
}

export function settleInfrastructure(state,{h,dischargeEnergy=0,chargeEnergy=0,operationEnergy=0},c){
 interval(h);positive(dischargeEnergy,'storage discharge');positive(chargeEnergy,'storage charge');positive(operationEnergy,'operation energy');
 const n=cfg(c),s=n.storage,limits=coolingLimits(n);
 if(dischargeEnergy>0&&chargeEnergy>0)throw new RangeError('Storage cannot charge and discharge in the same interval');
 if(!s.enabled&&(dischargeEnergy>0||chargeEnergy>0))throw new RangeError('Storage is disabled');
 if(dischargeEnergy>s.dischargePower*h+1e-9||chargeEnergy>s.chargePower*h+1e-9)throw new RangeError('Storage power exceeded');
 const stored=state.storage+chargeEnergy*s.chargeEfficiency-dischargeEnergy/s.dischargeEfficiency;
 if(stored < -1e-8||stored>s.capacity+1e-8)throw new RangeError('Stored energy outside capacity');
 if(n.cooling.enabled&&operationEnergy>limits.operation*h+1e-8)throw new RangeError('Cooling capacity exceeded');
 return {...state,storage:Math.max(0,Math.min(s.capacity,stored)),storageCharged:state.storageCharged+chargeEnergy,
  storageDischarged:state.storageDischarged+dischargeEnergy,
  storageLoss:state.storageLoss+chargeEnergy*(1-s.chargeEfficiency)+dischargeEnergy*(1/s.dischargeEfficiency-1),
  waterConsumed:state.waterConsumed+(n.cooling.enabled?operationEnergy*limits.intensity*CUBIC_METRES_PER_TWH_LITRE_PER_KWH:0),
  coolingEnergy:state.coolingEnergy+(n.cooling.enabled?operationEnergy:0)};
}

export function nextInfrastructureTime(t,c){
 positive(t,'time');const n=cfg(c),times=n.outages.flatMap(x=>[x.start,x.start+x.duration]);
 if(n.extraction.enabled)times.push(n.extraction.leadTime);
 return Math.min(Infinity,...times.filter(value=>value>t));
}

function hash(text){
 let value=2166136261;
 for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);
 value^=value>>>16;value=Math.imul(value,0x7feb352d);value^=value>>>15;
 return ((value^value>>>16)>>>0)/4294967296;
}

export function observeInfrastructure(values,{seed,index},c){
 positive(seed,'observation seed');positive(index,'observation index');const n=cfg(c).observations;
 return Object.fromEntries(Object.entries(values).map(([key,value])=>{
  if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Observations must be finite numbers');
  if(!n.enabled)return [key,value];
  const prefix=`${seed}:${index}:${key}`;
  if(hash(`${prefix}:missing`)<n.missingProbability)return [key,null];
  return [key,value+(2*hash(`${prefix}:noise`)-1)*n.noise*Math.max(Math.abs(value),1)];
 }));
}
