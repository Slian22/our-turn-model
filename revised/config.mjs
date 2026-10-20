/** Explicit scenario defaults; no future RSI or mortality parameter is calibrated. */
import {INFRA_DEFAULTS,mergeInfrastructure} from './infrastructure-config.mjs';
export const VERSION='2.2.2';
export const SCHEMA='our-turn.revised.v4';
export const PARAMETER_METADATA=Object.freeze({
 time:'year',population:'million people',energy:'TWh',power:'TWh/year',land:'km2',
 hardware:'fixed 1 MW facility-load blocks',factory:'plants',work:'hypothetical block-equivalent work',
 materials:'hypothetical block-equivalent material stock',classification:'scenario unless a unit conversion',
 conversion:{MWYearsToTWh:.00876,classification:'unit identity, 8760 hours/year'},
 assumptions:['Finite construction and replacement','Linear surviving-cohort performance',
  'Independent finite industrial work and material stocks','Energy deficits proxy critical-service deficits',
  'Conditional mortality, efficiency and behavior parameters; not empirical probabilities'],
});
const defaults={
 horizon:100,dt:.125,seed:20261017,alignment:.5,aiEnabled:true,planner:'demand',
 initial:{H:8000,q:1,hardware:100000,humanPower:26000,aiPower:2000,humanFactories:40,aiFactories:20,
  ageBands:[.05,.25,.45,.65,.85],powerAgeBands:[],factoryAgeBands:[],hardwareAgeBands:[],hardwareEfficiency:1,manufacturingEfficiency:1},
 // [DOM-MEM] The reserve is independent of the 2,000-kWh initial demand.
 // [TH-N1] Land is an effective service footprint, not total subsistence land.
 human:{memEnergy:1,qolMaximum:.9,qolScale:667,criticalEnergy:1.5,criticalFloor:.9,flexEnergy:.5,landPerMillion:2,growth:.001,growthSchedule:[],
  technologyRate:.003,exposureTime:2,maximumMortality:.05,demandTime:2,
  minimumFlexible:.9,maximumFlexible:1.1,supportHalfPopulation:4000,serviceBaseline:50000},
 ai:{utilisation:.8,idleFraction:.2,researchFraction:.2,researchReference:16000,growth:.06,
  difficulty:1.5,researchElasticity:1,algorithmMaximum:3,hardwareMaximum:3,manufacturingMaximum:2,
  efficiencyExponent:.7,autonomy:.1,expansion:.05,factoryUtilisation:.8,planningWindow:8,
  adjustmentTime:2,competitionWeight:1,workloadMode:'fixed-utilisation',demandSchedule:[],
  investmentEnergyLimit:1e15,investmentWorkLimit:1e15},
 resources:{land:1000000,materials:10000000,recycling:.6,humanConstructionShare:.5,
  constructionEnergyShare:.15,policyEnergyShare:.02,maintenanceEnergyPerWork:.01},
 // [TH-PRIORITY] References give both inputs dimensionless comparison scores.
 // [DOM-PRIORITY] Suggested edits: operating marginal values are a separate
 // scenario rule from project admission; legacy keeps the prior electricity split.
 priority:{mode:'weighted',operatingMode:'marginal',lambda:1,sharpness:1,hysteresis:.05,
  processingReference:80000,humanUsageReference:16000,
  aiWeight:1,humanWeight:1,tieBreak:'human'},
 infrastructure:INFRA_DEFAULTS,
 assets:{
  power:{life:50,endPerformance:.7,delay:4,energy:1,work:40,materials:40,land:10,maintenance:.1},
  factory:{life:30,endPerformance:.7,delay:4,energy:5,work:1000,materials:1000,land:1,maintenance:5},
  hardware:{life:8,endPerformance:.8,delay:1,energy:.02,work:1,materials:1,land:.002,maintenance:.01},
  demolitionDelay:.5,demolitionEnergyFraction:.05,demolitionWorkFraction:.05,
  adoptionDelay:1,adoptionEnergy:5,adoptionWork:100,factoryProductivity:500,maintenanceTime:2},
 policy:{mode:'none',type:'shutdown',start:5,delay:2,cost:5,work:5,duration:100,
  cap:50000,success:.8,residual:.05,priority:0,coverage:.9,authorized:true,
  observationDelay:1,deficitThreshold:.1,exposureThreshold:.1,lookahead:5,falseSignal:0},
 events:[],eventMode:'off',annualProbability:.05,eventMagnitude:1.5,eventObservationDelay:1,
};
export function deepFreeze(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const v of Object.values(value))deepFreeze(v);Object.freeze(value);
 }return value;
}
export function plain(value,name='object'){
 if(!value||typeof value!=='object'||Array.isArray(value)||
  ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(`${name} must be a plain object`);
 return value;
}
export function finite(value,name,min=0,max=1e15){
 if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)
  throw new RangeError(`${name} must be finite in [${min},${max}]`);
 return value;
}
function merge(base,value,path='config'){
 plain(value,path);const next={...base};
 for(const [key,v] of Object.entries(value)){
  if(!Object.hasOwn(base,key))throw new TypeError(`Unknown ${path}.${key}`);
  next[key]=base[key]&&typeof base[key]==='object'&&!Array.isArray(base[key])?merge(base[key],v,`${path}.${key}`):structuredClone(v);
 }return next;
}
function between(object,keys,min,max,name){for(const key of keys)finite(object[key],`${name}.${key}`,min,max);}
function choice(value,values,name){if(!values.includes(value))throw new RangeError(`Invalid ${name}`);}
function validateEvents(events,horizon){
 if(!Array.isArray(events)||events.length>1000)throw new RangeError('Expected at most 1000 events');
 const keys=['id','type','time','magnitude','duration','observationDelay','adoptionEnergy','adoptionWork','adoptionDelay','target'];
 const types=['algorithm','hardware','manufacturing','land','power','coverage','authority','funding'],ids=new Set();
 return events.map((event,i)=>{
  plain(event,'event');for(const k of Object.keys(event))if(!keys.includes(k))throw new TypeError(`Unknown event.${k}`);
  choice(event.type,types,'event type');finite(event.time,'event time',0,horizon);
  finite(event.magnitude,'event magnitude',types.indexOf(event.type)<5?Number.MIN_VALUE:0,100);
  if(event.target!==undefined&&event.target!==event.type)throw new RangeError('Event target must equal its declared type');
  const id=event.id??`scenario-${i}`;
  if(typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,80}$/.test(id)||ids.has(id))throw new RangeError('Invalid or repeated event ID');ids.add(id);
  for(const k of ['duration','observationDelay','adoptionEnergy','adoptionWork','adoptionDelay'])
   if(event[k]!==undefined&&event[k]!==null)finite(event[k],`event ${k}`,k==='duration'?Number.MIN_VALUE:0,1e6);
  if(event.duration!=null){
   const expiry=finite(event.time+event.duration,'event expiry');
   if(expiry<=event.time)throw new RangeError('Event duration is below numeric resolution');
  }
  return {...event,id};
 });
}
export function makeConfig(options={}){
 const c=merge(defaults,options);
 finite(c.horizon,'horizon',1,300);finite(c.dt,'dt',.005,1);
 if(c.horizon/c.dt>100000)throw new RangeError('Too many integration intervals');
 finite(c.seed,'seed',0,0xffffffff);if(!Number.isSafeInteger(c.seed))throw new RangeError('Seed must be uint32');
 finite(c.alignment,'alignment',0,1);if(typeof c.aiEnabled!=='boolean')throw new TypeError('aiEnabled must be boolean');
 choice(c.planner,['demand','optimizer'],'planner');choice(c.eventMode,['off','annual'],'event mode');
 finite(c.annualProbability,'annual probability',0,1);finite(c.eventMagnitude,'event magnitude',1,10);
 finite(c.eventObservationDelay,'event observation delay',0,1000);
 between(c.initial,['H'],1e-6,1e9,'initial');between(c.initial,['q'],1,1e6,'initial');
 between(c.initial,['hardware','humanPower','aiPower','humanFactories','aiFactories'],0,1e9,'initial');
 between(c.initial,['hardwareEfficiency','manufacturingEfficiency'],.01,100,'initial');
 if(!Array.isArray(c.initial.ageBands)||!c.initial.ageBands.length||c.initial.ageBands.length>50)throw new RangeError('Invalid initial age bands');
 let share=0;
 for(const band of c.initial.ageBands){
  const age=typeof band==='number'?band:plain(band,'age band').ageFraction;
  finite(age,'age fraction',0,1-Number.EPSILON);
  if(typeof band!=='number'){
   if(Object.keys(band).some(k=>!['ageFraction','share'].includes(k)))throw new TypeError('Unknown age band field');
   finite(band.share,'age share',0,1);share+=band.share;
  }else share+=1/c.initial.ageBands.length;
 }
 if(Math.abs(share-1)>1e-10)throw new RangeError('Age-band shares must sum to one');
 // [TH-N2] Observed technology-specific cohorts can replace the shared proxy.
 for(const key of ['powerAgeBands','factoryAgeBands','hardwareAgeBands']){
  const rows=c.initial[key];
  if(!Array.isArray(rows)||rows.length>50)throw new RangeError(`Invalid ${key}`);
  if(rows.length){
   let weight=0;
   for(const band of rows){
    const age=typeof band==='number'?band:plain(band,key).ageFraction;
    finite(age,'age fraction',0,1-Number.EPSILON);
    if(typeof band==='number')weight+=1/rows.length;
    else{
     if(Object.keys(band).some(k=>!['ageFraction','share'].includes(k)))throw new TypeError(`Unknown ${key} field`);
     finite(band.share,'age share',0,1);weight+=band.share;
    }
   }
   if(Math.abs(weight-1)>1e-10)throw new RangeError(`${key} shares must sum to one`);
  }
 }
 const h=c.human,a=c.ai,r=c.resources,p=c.policy;
 between(h,['memEnergy'],.1,2,'human');between(h,['qolMaximum'],0,1,'human');
 between(h,['qolScale'],Number.MIN_VALUE,1e6,'human');
 choice(c.priority.mode,['weighted','static'],'priority mode');choice(c.priority.tieBreak,['human','ai'],'priority tie');
 choice(c.priority.operatingMode,['marginal','legacy'],'operating priority mode');
 between(c.priority,['lambda'],0,1e12,'priority');
 between(c.priority,['sharpness','hysteresis'],0,1e6,'priority');
 between(c.priority,['processingReference','humanUsageReference'],1e-9,1e15,'priority');
 between(c.priority,['aiWeight','humanWeight'],0,1e6,'priority');
 c.infrastructure=mergeInfrastructure(c.infrastructure);
 between(h,['criticalEnergy','criticalFloor'],Number.MIN_VALUE,100,'human');
 between(h,['flexEnergy','landPerMillion'],0,100,'human');
 if(h.criticalFloor>h.criticalEnergy)throw new RangeError('Critical floor exceeds initial intensity');
 between(h,['growth'],-.1,.1,'human');between(h,['technologyRate','maximumMortality'],0,1,'human');
 // [TH-N3] Piecewise observed baseline rates; shortage mortality remains separate.
 if(!Array.isArray(h.growthSchedule)||h.growthSchedule.length>1000)throw new RangeError('Invalid growth schedule');
 let lastGrowthTime=-1;
 for(const row of h.growthSchedule){
  plain(row,'growth schedule');
  if(Object.keys(row).some(k=>!['time','growth'].includes(k)))throw new TypeError('Unknown demographic schedule field');
  finite(row.time,'growth schedule time',0,c.horizon);finite(row.growth,'scheduled net growth',-.1,.1);
  if(row.time<=lastGrowthTime)throw new RangeError('Growth schedule must be strictly ordered');lastGrowthTime=row.time;
 }
 between(h,['exposureTime','demandTime'],.01,1000,'human');between(h,['supportHalfPopulation'],1e-6,1e12,'human');
 between(h,['serviceBaseline'],0,1e12,'human');between(h,['minimumFlexible'],0,1,'human');
 between(h,['maximumFlexible'],1,10,'human');
 between(a,['utilisation','idleFraction','researchFraction','autonomy'],0,1,'ai');
 between(a,['factoryUtilisation'],.01,1,'ai');between(a,['researchReference'],1e-9,1e12,'ai');
 between(a,['growth','expansion'],0,10,'ai');between(a,['difficulty','researchElasticity'],.01,10,'ai');
 between(a,['algorithmMaximum','hardwareMaximum','manufacturingMaximum'],1,100,'ai');
 between(a,['efficiencyExponent','competitionWeight'],.01,100,'ai');
  between(a,['planningWindow'],.01,100,'ai');between(a,['adjustmentTime'],0,100,'ai');
 choice(a.workloadMode,['fixed-utilisation','fixed-work'],'workload mode');
 // [TH-N7] Benchmark-equivalent initial vintages, observed orders/workloads and
 // actual financing limits are scenario inputs until paired measurements exist.
 between(a,['investmentEnergyLimit','investmentWorkLimit'],0,1e15,'ai');
 if(!Array.isArray(a.demandSchedule)||a.demandSchedule.length>1000)throw new RangeError('Invalid task demand schedule');
 let lastDemandTime=-1;
 for(const row of a.demandSchedule){
  plain(row,'task demand');
  if(Object.keys(row).some(k=>!['time','desiredHardware','utilisation'].includes(k)))throw new TypeError('Unknown task demand field');
  finite(row.time,'task demand time',0,c.horizon);finite(row.desiredHardware,'desired installed hardware',0,1e12);
  if(row.utilisation!==undefined)finite(row.utilisation,'observed workload utilisation',0,1);
  if(row.time<=lastDemandTime)throw new RangeError('Task demand schedule must be ordered');lastDemandTime=row.time;
 }
 between(r,['land','materials'],0,1e15,'resources');
 between(r,['recycling','humanConstructionShare','constructionEnergyShare','policyEnergyShare'],0,1,'resources');
 between(r,['maintenanceEnergyPerWork'],0,1e6,'resources');
 for(const kind of ['power','factory','hardware']){
  between(c.assets[kind],['life'],.1,10000,kind);between(c.assets[kind],['endPerformance'],0,1,kind);
  between(c.assets[kind],['delay','energy','work','materials','land','maintenance'],0,1e9,kind);
  if(c.assets[kind].work===0&&c.assets[kind].energy===0)throw new RangeError(`${kind} construction needs a positive work or energy budget`);
 }
 between(c.assets,['demolitionDelay','adoptionDelay','adoptionEnergy','adoptionWork'],0,1e6,'assets');
 between(c.assets,['demolitionEnergyFraction','demolitionWorkFraction'],0,1,'assets');
 between(c.assets,['factoryProductivity'],1e-9,1e9,'assets');
  between(c.assets,['maintenanceTime'],.01,1000,'assets');
 choice(p.mode,['none','fixed','deficit','anticipatory'],'policy mode');choice(p.type,['cap','shutdown'],'policy type');
 between(p,['start','delay','duration','cost','work','cap','lookahead'],0,1e9,'policy');
 between(p,['coverage','success','residual','deficitThreshold','exposureThreshold'],0,1,'policy');
 between(p,['observationDelay'],0,1000,'policy');between(p,['falseSignal'],-1,1,'policy');
 between(p,['priority'],0,100,'policy');if(typeof p.authorized!=='boolean')throw new TypeError('Policy authorization must be boolean');
 c.events=validateEvents(c.events,c.horizon);
 return deepFreeze(c);
}
export const DEFAULTS=deepFreeze(structuredClone(defaults));
