/** Reporting and external-data interfaces.
 * These reports describe simulated quantities; they do not calibrate future RSI.
 */
import {makeConfig} from './config.mjs';
import {physicalView} from './dynamics.mjs';

const sum=(rows,f)=>rows.reduce((s,r)=>s+f(r),0);
const number=v=>typeof v==='number'&&Number.isFinite(v);
const extent=values=>{const xs=values.filter(number);return {min:xs.length?Math.min(...xs):null,max:xs.length?Math.max(...xs):null};};
const finite=(v,name,min=-1e15,max=1e15)=>{if(!number(v)||v<min||v>max)throw new RangeError(`${name} must be finite in [${min}, ${max}]`);return v;};
const text=(v,name)=>{if(typeof v!=='string'||!v.trim()||v.length>1000)throw new TypeError(`${name} must be nonempty text`);return v;};
const measured=run=>run.state.history.filter(p=>p.t>0&&p.ledger);
const lastMeasured=run=>measured(run).at(-1);
const account=(run,key,fallback=0)=>run.state.accounts[key]??fallback;

function ownedLand(run,owner){
 const a=run.state.assetState;
 const occupied=sum(a.assets.filter(x=>x.owner===owner&&!x.cleared),x=>x.footprint);
 const committed=sum(a.projects.filter(x=>x.owner===owner&&x.status==='pending'),x=>x.footprint);
 return {occupied,committed,total:occupied+committed,unit:'km2'};
}
/** TH-V1: exactly nine ordered groups; a group may contain a unit-labelled structure. */
export function outputVector(run){
 const s=run.state,c=run.config,v=physicalView(s,c),a=s.assetState,rows=measured(run);
 const observedH=extent(s.history.map(p=>p.H)),qol=extent(rows.map(p=>p.qualityOfLife));
 const humanPopulation={min:Math.min(account(run,'minPopulation',s.H),observedH.min??s.H),
  max:Math.max(account(run,'maxPopulation',s.H),observedH.max??s.H)};
 const aiLand=ownedLand(run,'ai'),humanLand={...ownedLand(run,'human'),
  serviceLandRequired:s.H*c.human.landPerMillion,
  serviceLandAvailable:Math.min(s.H*c.human.landPerMillion,v.landAvailable),
  serviceLandDefinition:'Human service requirement on remaining land; separate from asset ownership and not an additional committed footprint.'};
 const worldResources={materials:{free:a.materials,embodied:sum(a.assets.filter(x=>!x.cleared),x=>x.materials),
  committed:sum(a.projects.filter(x=>x.status==='pending'),x=>x.materials),
  recycledRecoveredCumulative:a.accounts.recycledRecovered,disposedCumulative:a.accounts.materialsDisposed,
  primaryExtractedCumulative:a.accounts.primarySupplied??a.accounts.primaryExtracted??a.accounts.materialsExtracted??0,
  unit:'hypothetical block-equivalent material units',
  accounting:'Recovered cumulative flow is informational; do not add it to free + embodied + committed + disposed stocks.'},
  freeLand:{value:v.landAvailable,unit:'km2'},currentPower:{value:v.sourcePower,unit:'TWh/year'},
  oreRemaining:{enabled:c.infrastructure?.extraction.enabled??false,value:s.infrastructure?.oreRemaining??0,unit:'hypothetical block-equivalent material units'},
  storedElectricity:{enabled:c.infrastructure?.storage.enabled??false,value:s.infrastructure?.storage??0,unit:'TWh'},
  coolingWaterConsumedCumulative:{enabled:c.infrastructure?.cooling.enabled??false,value:s.infrastructure?.waterConsumed??0,unit:'m3'},
  physicalBoundary:'Ore and stored electricity are stocks; cumulative cooling-water consumption is a flow diagnostic. Food, service water and cooling-water budgets are separately declared.'};
 const groups=[
  {index:1,name:'humanPopulation',value:humanPopulation,unit:'million people'},
  {index:2,name:'starvationEventCount',value:account(run,'shortageEpisodes'),unit:'critical-shortage episodes',
   definition:'Proxy: a new critical-service deficit episode exceeding 0.001; the model does not measure literal food starvation.'},
  {index:3,name:'endPopulation',value:s.H,unit:'million people'},
  {index:4,name:'qualityOfLife',value:qol,unit:'index [0,1]'},
  {index:5,name:'endQualityOfLife',value:lastMeasured(run)?.qualityOfLife??null,unit:'index [0,1]'},
  {index:6,name:'effectiveCompute',value:extent(rows.map(p=>p.effectiveCompute)),unit:'benchmark-equivalent utilised MW blocks',
   definition:'Actual interval effective compute; unmeasured t=0 is excluded.'},
  {index:7,name:'endAiLand',value:aiLand,unit:'km2'},
  {index:8,name:'endHumanLand',value:humanLand,unit:'km2'},
  {index:9,name:'endWorldResources',value:worldResources,unit:'structured; see each quantity'}];
 return {schema:'mcm.output-vector.v1',version:run.version,sourceDigest:run.sourceDigest,configId:run.configId,
  seed:c.seed,time:s.t,groups,endPopulation:s.H,endCompute:lastMeasured(run)?.effectiveCompute??null,
  endQualityOfLife:lastMeasured(run)?.qualityOfLife??null,qolPersonYears:account(run,'qolPersonYears'),
  qolPersonYearsUnit:'million quality-adjusted person-years'};
}

/** TH-R1: baseline net growth is not gross births; compute stock changes are not a causal decomposition. */
export function growthContributions(run){
 const s=run.state,first=s.history[0],a=s.assetState;
 const delivered=a.assets.filter(x=>x.kind==='hardware'&&x.birth>0&&x.birth<=s.t);
 const retired=a.assets.filter(x=>x.kind==='hardware'&&x.retiredAt!==null&&x.retiredAt!==undefined&&x.retiredAt<=s.t);
 const rows=measured(run),previousRows=new Map(s.history.map((r,i)=>[r,s.history[i-1]]));
 const intervals=rows.map((r,i)=>{
  const previous=previousRows.get(r)??first;
  const change=r.H-previous.H,deaths=(r.extraDeaths??0)-(previous.extraDeaths??0);
  return {start:r.ledger.start,end:r.ledger.end,populationChange:change,additionalDeaths:deaths,
   baselineNetGrowth:change+deaths,capabilityChange:r.q-previous.q,
   effectiveComputeChange:i>0?r.effectiveCompute-rows[i-1].effectiveCompute:null};
 });
 const baseline=account(run,'births'),deaths=account(run,'extraDeaths');
 return {population:{initial:first.H,final:s.H,change:s.H-first.H,baselineNetGrowth:baseline,additionalDeaths:deaths,
  residual:(s.H-first.H)-(baseline-deaths),unit:'million people',
  definition:'The inherited births account is integrated baseline NET growth; deprivation adds extraDeaths.'},
  hardware:{commissioned:sum(delivered,x=>x.rated),retired:sum(retired,x=>x.rated),unit:'rated MW blocks',
   commissioning:delivered.map(x=>({id:x.id,time:x.birth,rated:x.rated})),
   retirements:retired.map(x=>({id:x.id,time:x.retiredAt,rated:x.rated}))},
  capability:{initial:first.q,final:s.q,change:s.q-first.q,unit:'reference capability index'},
  effectiveCompute:{initialMeasured:rows[0]?.effectiveCompute??null,final:rows.at(-1)?.effectiveCompute??null,
   change:rows.length?rows.at(-1).effectiveCompute-rows[0].effectiveCompute:null,
   definition:'Change between measured allocation intervals. Hardware, utilisation, power and policy jointly determine it.'},intervals};
}

export const COEXISTENCE_THRESHOLDS=Object.freeze({minimumQol:.6990322618396219,
 minimumPopulationFraction:.01,minimumCompute:0,minimumCriticalAdequacy:.999});
/** TH-R2: piecewise interval service/compute measures; population criterion uses interval endpoint minima. */
export function adequateCoexistence(run,options={}){
 const th={...COEXISTENCE_THRESHOLDS,...options};
 for(const [key,value] of Object.entries(th))finite(value,key,0,key==='minimumCompute'?1e15:1);
 for(const k of Object.keys(th))if(!Object.hasOwn(COEXISTENCE_THRESHOLDS,k))throw new TypeError(`Unknown threshold ${k}`);
 const rows=measured(run),initial=run.config.initial.H,previousRows=new Map(run.state.history.map((r,i)=>[r,run.state.history[i-1]]));
 const intervals=rows.map(r=>{
  const previous=previousRows.get(r)??r;
  const minimumPopulation=r.ledger.minimumPopulation??Math.min(previous.H,r.H);
  const adequate=number(r.qualityOfLife)&&r.qualityOfLife>=th.minimumQol&&minimumPopulation>=initial*th.minimumPopulationFraction&&
   r.effectiveCompute>th.minimumCompute&&r.criticalAdequacy>=th.minimumCriticalAdequacy;
  return {start:r.ledger.start,end:r.ledger.end,adequate,minimumPopulation,qualityOfLife:r.qualityOfLife??null,
   criticalAdequacy:r.criticalAdequacy,effectiveCompute:r.effectiveCompute};
 });
 const episodes=intervals.reduce((out,r)=>{
  if(!r.adequate)return out;
  const previous=out.at(-1);
  return previous&&Math.abs(previous.end-r.start)<1e-9?
   [...out.slice(0,-1),{...previous,end:r.end,duration:r.end-previous.start}]:
   [...out,{start:r.start,end:r.end,duration:r.end-r.start,leftCensored:r.start===0,rightCensored:false}];
 },[]).map(e=>({...e,rightCensored:Math.abs(e.end-run.state.t)<1e-9}));
 return {thresholds:th,duration:sum(episodes,e=>e.duration),unit:'years',episodes,intervals,
  observationEnd:run.state.t,horizon:run.config.horizon,
  definition:'QoL, critical-service adequacy and compute are actual interval allocations; presence requires compute strictly above minimumCompute. Episode ends at observation end are right-censored.'};
}

const evidence=(binding,detail)=>({status:'assessed',binding:!!binding,detail});
const unavailable=detail=>({status:'unassessed',binding:null,detail});
/** TH-R3: report ledger evidence; missing demand logging never becomes a fabricated constraint diagnosis. */
export function bindingTimeline(run){
 return measured(run).map(r=>{
  const l=r.ledger,tolerance=1e-8*Math.max(1,l.available??0),workUsed=(l.maintenanceWork??0)+(l.constructionWork??0)+(l.policyWork??0)+(l.extractionWork??0);
  const numeric={energy:l.energyLimited,industrialWork:l.workLimited,policyAccess:l.policyAccess,regionalPower:l.regionalPowerLimited,
   storage:l.storageLimited,coolingWater:l.coolingWaterLimited,heatRejection:l.heatLimited,refining:l.refiningLimited};
  const flags=Object.fromEntries(Object.entries(numeric).filter(([,v])=>number(v)).map(([key,v])=>[key,v!==0]));
  const c={...flags,...(l.constraints??{})};
  const constraints={
   energy:typeof c.energy==='boolean'?evidence(c.energy,'Executor demand feasibility'):
    evidence((l.available??0)>0&&(l.unused??Infinity)<=tolerance,'Power budget saturated; saturation alone does not identify unmet demand.'),
   land:number(l.landAdequacy)?evidence(l.landAdequacy<1-1e-9,'Human service land adequacy'):
    typeof c.land==='boolean'?evidence(c.land,'Executor land feasibility'):unavailable('No interval land demand was logged.'),
   industrialWork:typeof c.industrialWork==='boolean'?evidence(c.industrialWork,'Industrial work budget saturated; saturation is not proof of unmet demand.'):
    evidence((l.workAvailable??0)>0&&workUsed>=(l.workAvailable??0)-1e-8*Math.max(1,l.workAvailable),'Industrial work budget saturated; saturation is not proof of unmet demand.'),
   materials:typeof c.materials==='boolean'?evidence(c.materials,'Executor material feasibility'):
    number(l.materialFree)?evidence(l.materialFree<=1e-9,'No free material stock; unmet project demand must also be inspected.'):
    unavailable('No interval rejected-order material demand was logged.'),
   policyAccess:typeof c.policyAccess==='boolean'?evidence(c.policyAccess,'Executor policy access constraint'):
    l.policyAccess?evidence(l.policyAccess.binding,'Declared policy access observation'):unavailable('No interval policy-access feasibility was logged.')};
  for(const key of ['regionalPower','storage','coolingWater','heatRejection','refining'])if(c[key]!==undefined)
   constraints[key]=evidence(c[key],`Executor ${key} feasibility`);
  return {start:l.start,end:l.end,constraints};
 });
}

function validateObservation(row){
 if(!row||typeof row!=='object')throw new TypeError('Observation must be an object');
 finite(row.t,'observation time');finite(row.value,'observation value');text(row.metric,'metric');text(row.unit,'unit');
 text(row.source,'observation source');if(!['calibration','heldout'].includes(row.split))throw new TypeError('Observation split must be calibration or heldout');
 if(row.timeUncertainty!==undefined)finite(row.timeUncertainty,'time uncertainty',0);
 if(row.valueUncertainty!==undefined)finite(row.valueUncertainty,'value uncertainty',0);
 return {...row};
}
const matchKey=row=>JSON.stringify([row.t,row.metric,row.unit]);
/** TH-R4 exact matching by time, metric, unit and data split; there is no implicit interpolation or unit conversion. */
export function compareObservations(predictions,dataset){
 text(dataset?.id,'dataset id');if(!Array.isArray(predictions)||!Array.isArray(dataset.observations))throw new TypeError('Expected prediction and observation arrays');
 const rows=dataset.observations.map(validateObservation),seen=new Map();
 for(const r of rows){const key=JSON.stringify([r.t,r.metric]);if(seen.has(key))throw new RangeError('Calibration/heldout overlap or duplicate observation');seen.set(key,r.split);}
 const lookup=new Map();
 for(const p of predictions){finite(p.t,'prediction time');finite(p.value,'prediction value');text(p.metric,'prediction metric');text(p.unit,'prediction unit');
  const key=matchKey(p);if(lookup.has(key))throw new RangeError('Duplicate prediction');lookup.set(key,p);}
 const matches=rows.filter(r=>r.split==='heldout').map(o=>{
  const p=lookup.get(matchKey(o));
  if(!p&&predictions.some(x=>x.t===o.t&&x.metric===o.metric))throw new RangeError(`Unit mismatch for ${o.metric} at ${o.t}`);
  return p?{...o,prediction:p.value,error:p.value-o.value,status:'matched'}:{...o,status:'unmatched'};
 });
 const groups=Map.groupBy(matches.filter(r=>r.status==='matched'),r=>JSON.stringify([r.metric,r.unit]));
 const metrics=[...groups.values()].map(rs=>({metric:rs[0].metric,unit:rs[0].unit,n:rs.length,
  mae:sum(rs,r=>Math.abs(r.error))/rs.length,rmse:Math.sqrt(sum(rs,r=>r.error*r.error)/rs.length),bias:sum(rs,r=>r.error)/rs.length}));
 return {schema:'mcm.heldout-error.v1',datasetId:dataset.id,calibrationCount:rows.filter(r=>r.split==='calibration').length,
  heldoutCount:matches.length,matchedCount:matches.filter(r=>r.status==='matched').length,metrics,matches,
  evaluation:'Only externally supplied heldout observations are scored. Provenance is declared by the data supplier, not independently certified by this interface.'};
}

export const OBSERVATION_METRICS=Object.freeze({H:'million people',q:'reference capability index',qualityOfLife:'index [0,1]',
 effectiveCompute:'benchmark-equivalent utilised MW blocks',power:'TWh/year',hardware:'rated MW blocks',
 factoryWork:'hypothetical block-equivalent work/year',criticalAdequacy:'fraction',landUsed:'km2',materialStock:'hypothetical block-equivalent material units',
 perCapitaElectricity:'kWh/person/year'});
export function predictionsFromRun(run){
 return run.state.history.flatMap(row=>Object.entries(OBSERVATION_METRICS)
  .filter(([key])=>number(row[key])&&(!(key==='effectiveCompute'||key==='qualityOfLife'||key==='perCapitaElectricity'||key==='criticalAdequacy')||row.ledger))
  .map(([metric,unit])=>({t:row.t,metric,unit,value:row[metric]})));
}


const positiveAlarm=(deficit,exposure,p)=>(deficit>0&&deficit>=p.deficitThreshold)||(exposure>0&&exposure>=p.exposureThreshold);
/** TH-N8: threshold diagnostic against prior measured intervals, including withheld/missing samples.
 * Anticipatory plan forecasts and actual action deployment are separate from this sample-quality audit.
 */
export function sensorReliability(run){
 const p=run.config.policy,policies=[...(run.state.policyArchive??[]),run.state.policyState];
 const observed=new Map(policies.flatMap(policy=>[...(policy.controller?.history??[]),...(policy.controller?.pending??[])])
  .map(sample=>[sample.t,sample]));
 const expected=run.state.t>0?run.state.history:[],expectedTimes=new Set(expected.map(row=>row.t));
 const samples=expected.map(truth=>{
  const sample=observed.get(truth.t),measuredTruth=!!truth.ledger;
  const trueDeficit=measuredTruth?Math.max(0,Math.min(1,1-truth.criticalAdequacy)):null;
  const trueExposure=measuredTruth?truth.exposure??0:null;
  const observedDeficit=sample?Math.max(0,Math.min(1,(sample.deficit??
   ((sample.need??0)>0?1-(sample.supply??0)/sample.need:0))+p.falseSignal)):null;
  const observedExposure=sample?.exposure??0;
  return {t:truth.t,observed:!!sample,observedAt:sample?.observedAt??null,
   released:sample?sample.observedAt<=run.state.t:false,measuredTruth,trueDeficit,trueExposure,
   observedDeficit,observedExposure:sample?observedExposure:null,
   trueAlarm:measuredTruth?positiveAlarm(trueDeficit,trueExposure,p):null,
   observedAlarm:sample?positiveAlarm(observedDeficit,observedExposure,p):false};
 });
 const eligible=samples.filter(s=>s.measuredTruth),positives=eligible.filter(s=>s.trueAlarm),negatives=eligible.filter(s=>!s.trueAlarm);
 const falseAlarmCount=negatives.filter(s=>s.observedAlarm).length,missedTriggerCount=positives.filter(s=>!s.observedAlarm).length;
 const missingSamples=samples.filter(s=>!s.observed).length;
 return {expectedSamples:samples.length,observedSamples:samples.filter(s=>s.observed).length,missingSamples,
  missingRate:samples.length?missingSamples/samples.length:null,eligibleSamples:eligible.length,
  positiveTruthSamples:positives.length,negativeTruthSamples:negatives.length,falseAlarmCount,missedTriggerCount,
  falseAlarmRate:negatives.length?falseAlarmCount/negatives.length:null,
  missedTriggerRate:positives.length?missedTriggerCount/positives.length:null,
  missingPositiveSamples:positives.filter(s=>!s.observed).length,
  pendingSamples:samples.filter(s=>s.observed&&!s.released).length,
  releasedSamples:samples.filter(s=>s.observed&&s.released).length,
  unmeasuredTruthSamples:samples.filter(s=>!s.measuredTruth).length,
  unmatchedObservationTimes:[...observed.keys()].filter(t=>!expectedTimes.has(t)),
  thresholds:{deficit:p.deficitThreshold,exposure:p.exposureThreshold,fixedDeficitBias:p.falseSignal},samples,
  definition:'Current configured thresholds are applied retrospectively to deduplicated acquired samples (released or pending). Truth is the actual previous allocation interval at the same timestamp and current exposure. Initial truth is unmeasured. Missing positive-truth samples count as missed threshold signals; false-alarm denominator is all eligible truth negatives, missed-signal denominator all eligible truth positives. This is a sensor threshold audit, not an anticipatory forecast or deployment-success metric.'};
}

const CALIBRATION_PATHS=Object.freeze({N1:['human.landPerMillion','human.criticalEnergy','human.criticalFloor','human.flexEnergy','human.serviceBaseline','infrastructure.services.'],
 N2:['assets.','initial.ageBands','initial.powerAgeBands','initial.factoryAgeBands','initial.hardwareAgeBands','initial.humanPower','initial.aiPower','initial.hardware','initial.humanFactories','initial.aiFactories'],
 N3:['human.growth','human.growthSchedule','human.maximumMortality','human.exposureTime','human.demandTime','initial.H'],
 N7:['ai.','initial.hardware','initial.hardwareEfficiency','initial.manufacturingEfficiency','assets.hardware.'],
 N8:['policy.observationDelay','policy.falseSignal','infrastructure.observations.','infrastructure.outages','events','eventMode','annualProbability','eventMagnitude','eventObservationDelay']});

/** Canonical input units. Values arrive already converted; unsupported units are rejected. */
export function calibrationUnits(path){
 const exact={
  'human.landPerMillion':['km2/million people'],
  'human.criticalEnergy':['TWh/million person-years','TWh/(million people*year)'],
  'human.criticalFloor':['TWh/million person-years','TWh/(million people*year)'],
  'human.flexEnergy':['TWh/million person-years','TWh/(million people*year)'],
  'human.serviceBaseline':['work units/year'], 'human.growth':['1/year'],
  'human.growthSchedule':['year,1/year'], 'human.maximumMortality':['1/year'],
  'human.exposureTime':['year'],'human.demandTime':['year'],'initial.H':['million people'],
  'initial.humanPower':['TWh/year'],'initial.aiPower':['TWh/year'],'initial.hardware':['rated MW blocks'],
  'initial.humanFactories':['plants'],'initial.aiFactories':['plants'],
  'initial.hardwareEfficiency':['dimensionless'],'initial.manufacturingEfficiency':['dimensionless'],
  'policy.observationDelay':['year'],'policy.falseSignal':['fraction'],
  'events':['model event schema'],'eventMode':['enum'],'annualProbability':['probability/year'],
  'eventMagnitude':['multiplier'],'eventObservationDelay':['year'],
  'ai.researchReference':['benchmark-equivalent utilised MW blocks'],
  'ai.growth':['1/year'],'ai.expansion':['1/year'],'ai.planningWindow':['year'],'ai.adjustmentTime':['year'],
  'ai.workloadMode':['enum'], 'ai.demandSchedule':['year,rated MW blocks,fraction'],
  'ai.investmentEnergyLimit':['TWh/year'],'ai.investmentWorkLimit':['work units/year'],
  'assets.demolitionDelay':['year'],'assets.adoptionDelay':['year'],'assets.maintenanceTime':['year'],
  'assets.adoptionEnergy':['TWh'],'assets.adoptionWork':['work units'],
  'assets.factoryProductivity':['work units/plant/year'],
  'infrastructure.services.foodPerPerson':['kcal/person/year'],'infrastructure.services.foodSupply':['kcal/year'],
  'infrastructure.services.waterPerPerson':['m3/person/year'],'infrastructure.services.waterSupply':['m3/year'],
  'infrastructure.observations.noise':['fraction'],'infrastructure.observations.missingProbability':['probability'],
  'infrastructure.outages':['model outage schema']
 };
 if(Object.hasOwn(exact,path))return exact[path];
 if(/^initial\.(ageBands|powerAgeBands|factoryAgeBands|hardwareAgeBands)$/.test(path))return ['age fraction and share'];
 if(/^infrastructure\.(services|observations)\.enabled$/.test(path))return ['boolean'];
 const asset=path.match(/^assets\.(power|factory|hardware)\.(life|endPerformance|delay|energy|work|materials|land|maintenance)$/);
 if(asset)return ({life:['year'],endPerformance:['fraction'],delay:['year'],energy:['TWh/rated unit'],
  work:['work units/rated unit'],materials:['material units/rated unit'],land:['km2/rated unit'],maintenance:['work units/rated unit/year']})[asset[2]];
 if(/^assets\.(demolitionEnergyFraction|demolitionWorkFraction)$/.test(path))return ['fraction'];
 if(/^ai\.(utilisation|idleFraction|researchFraction|autonomy|factoryUtilisation)$/.test(path))return ['fraction'];
 if(/^ai\.(difficulty|researchElasticity|algorithmMaximum|hardwareMaximum|manufacturingMaximum|efficiencyExponent|competitionWeight)$/.test(path))return ['dimensionless'];
 throw new TypeError(`No canonical calibration unit for path ${path}`);
}

function setPath(object,path,value){
 const parts=path.split('.');if(parts.some(p=>!/^[a-zA-Z][a-zA-Z0-9]*$/.test(p)||['prototype','constructor','__proto__'].includes(p)))throw new TypeError('Unsafe calibration path');
 const apply=(node,i)=>{
  if(!node||typeof node!=='object'||Array.isArray(node)||!Object.hasOwn(node,parts[i]))throw new TypeError(`Unknown calibration path ${path}`);
  return {...node,[parts[i]]:i===parts.length-1?structuredClone(value):apply(node[parts[i]],i+1)};
 };
 return apply(object,0);
}
/** TH-N1 TH-N2 TH-N3 TH-N7 TH-N8: measured inputs replace existing scenario parameters; no fitting or invented observations. */
export function applyCalibrationInputs(options,dataset){
 text(dataset?.id,'dataset id');if(!Array.isArray(dataset.inputs))throw new TypeError('Expected calibration inputs array');
 let config=makeConfig(options);const paths=new Set();
 const provenance=dataset.inputs.map(input=>{
  text(input.id,'input id');text(input.path,'input path');text(input.source,'input source');text(input.unit,'input unit');
  if(input.split!=='calibration')throw new TypeError('Only calibration inputs may change a scenario');
  const allowed=Object.hasOwn(CALIBRATION_PATHS,input.branch)?CALIBRATION_PATHS[input.branch]:null;if(!allowed)throw new RangeError('Unknown calibration branch');
  if(!allowed.some(p=>p.endsWith('.')?input.path.startsWith(p):input.path===p))throw new RangeError(`Path ${input.path} is outside branch ${input.branch}`);
  if(paths.has(input.path))throw new RangeError('Duplicate calibration path');paths.add(input.path);
  if(!calibrationUnits(input.path).includes(input.unit))throw new RangeError(`Calibration unit mismatch for ${input.path}; expected ${calibrationUnits(input.path).join(' or ')}`);
  config=setPath(config,input.path,input.value);
  return {datasetId:dataset.id,id:input.id,branch:input.branch,path:input.path,value:structuredClone(input.value),unit:input.unit,
   source:input.source,split:input.split,classification:'externally supplied calibration input; provenance not independently verified'};
 });
 return {config:makeConfig(config),provenance};
}

function mergeOptions(a,b){
 return Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,
  b[k]===undefined?a[k]:b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])&&a[k]&&typeof a[k]==='object'?mergeOptions(a[k],b[k]):structuredClone(b[k])]));
}
function caseConfig(base,values){
 // Grid paths must already exist in validated config; unknown parameters fail explicitly.
 let config=makeConfig(base);
 for(const [path,value] of Object.entries(values))config=setPath(config,path,value);
 return config;
}
/** Grid keys are exact config paths, e.g. alignment, human.memEnergy, priority.mode, horizon. */
export function buildSweepCases(spec){
 if(Array.isArray(spec)){
  if(!spec.length||spec.length>4096)throw new RangeError('Expected 1–4096 sweep cases');
  const ids=new Set();return spec.map((x,i)=>{
   const id=x.id??`case-${i+1}`;text(id,'case id');if(ids.has(id))throw new RangeError('Duplicate case id');ids.add(id);
   return {id,baselineId:x.baselineId??null,config:structuredClone(x.config??x.options??{}),provenance:structuredClone(x.provenance??[])};
  });
 }
 if(!spec||typeof spec!=='object'||!spec.grid||typeof spec.grid!=='object'||Array.isArray(spec.grid))throw new TypeError('Expected case list or {base, grid}');
 const entries=Object.entries(spec.grid);let cells=[{}];
 for(const [key,values] of entries){
  if(!Array.isArray(values)||!values.length||cells.length*values.length>4096)throw new RangeError('Invalid or oversized sweep grid');
  cells=cells.flatMap(cell=>values.map(value=>({...cell,[key]:value})));
 }
 return cells.map((cell,i)=>({id:`grid-${i+1}`,baselineId:spec.baselineId??null,
  config:caseConfig(spec.base??{},cell),gridValues:cell,provenance:[]}));
}

/** High-interest selections are diagnostic hypotheses; Pareto maximises total human welfare and final compute. */
export function selectInterestingRuns(records){
 const ok=records.filter(r=>r.status==='ok'&&r.vector),metrics=['endPopulation','endQualityOfLife','endCompute','qolPersonYears'];
 const extrema=Object.fromEntries(metrics.map(key=>{
  const rs=ok.filter(r=>number(r.vector[key]));if(!rs.length)return [key,{minimumIds:[],maximumIds:[]}];
  const {min,max}=extent(rs.map(r=>r.vector[key]));return [key,{minimum:min,maximum:max,
   minimumIds:rs.filter(r=>r.vector[key]===min).map(r=>r.id),maximumIds:rs.filter(r=>r.vector[key]===max).map(r=>r.id)}];
 }));
 const eligible=ok.filter(r=>number(r.vector.qolPersonYears)&&number(r.vector.endCompute));
 const paretoIds=eligible.filter(a=>!eligible.some(b=>b.vector.qolPersonYears>=a.vector.qolPersonYears&&b.vector.endCompute>=a.vector.endCompute&&
  (b.vector.qolPersonYears>a.vector.qolPersonYears||b.vector.endCompute>a.vector.endCompute))).map(r=>r.id);
 return {extrema,paretoIds,objectives:['maximise million quality-adjusted person-years','maximise final effective compute'],
  failedIds:records.filter(r=>r.status!=='ok').map(r=>r.id)};
}
export function pairedComparisons(records){
 const lookup=new Map(records.map(r=>[r.id,r]));
 return records.filter(r=>r.baselineId).map(r=>{
  const base=lookup.get(r.baselineId);
  if(r.status!=='ok'||base?.status!=='ok')return {id:r.id,baselineId:r.baselineId,status:'unavailable',reason:'Missing or failed pair member'};
  const keys=['endPopulation','endQualityOfLife','endCompute','qolPersonYears'];
  const forcing=c=>JSON.stringify({seed:c.seed,eventMode:c.eventMode,annualProbability:c.annualProbability,
   eventMagnitude:c.eventMagnitude,eventObservationDelay:c.eventObservationDelay,events:c.events,outages:c.infrastructure?.outages});
  const pairedForcing=r.config&&base.config?forcing(r.config)===forcing(base.config):null;
  return {id:r.id,baselineId:r.baselineId,status:'ok',pairedSeed:r.seed===base.seed,pairedForcing,
   sameHorizon:r.config&&base.config?r.config.horizon===base.config.horizon:null,
   delta:Object.fromEntries(keys.map(k=>[k,number(r.vector[k])&&number(base.vector[k])?r.vector[k]-base.vector[k]:null]))};
 });
}
const csvCell=v=>{const s=v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
export function vectorCSV(records){
 const fields=['id','status','configId','sourceDigest','seed','time','humanPopulationMin','humanPopulationMax','starvationEventCount',
  'endPopulation','qualityOfLifeMin','qualityOfLifeMax','endQualityOfLife','effectiveComputeMin','effectiveComputeMax','endAiLand','endHumanLand','endWorldResources','qolPersonYears','error'];
 const rows=records.map(r=>{
  const v=r.vector,g=v?.groups??[],x={...r,configId:v?.configId??r.configId,sourceDigest:v?.sourceDigest??r.sourceDigest,seed:v?.seed??r.seed,time:v?.time??r.time,
   humanPopulationMin:g[0]?.value.min,humanPopulationMax:g[0]?.value.max,starvationEventCount:g[1]?.value,
   endPopulation:v?.endPopulation,qualityOfLifeMin:g[3]?.value.min,qualityOfLifeMax:g[3]?.value.max,endQualityOfLife:v?.endQualityOfLife,
   effectiveComputeMin:g[5]?.value.min,effectiveComputeMax:g[5]?.value.max,endAiLand:g[6]?.value,endHumanLand:g[7]?.value,
   endWorldResources:g[8]?.value,qolPersonYears:v?.qolPersonYears};
  return fields.map(k=>csvCell(x[k])).join(',');
 });
 return [fields.join(','),...rows].join('\n')+'\n';
}
export {mergeOptions};
