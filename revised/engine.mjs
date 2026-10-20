/** Integrated C1–C9 model; all public transitions are immutable. */
import {makeConfig,deepFreeze,VERSION,SCHEMA,finite} from './config.mjs';
import {SOURCE_DIGEST} from './version.mjs';
import {initialAssetState,inspectAssets,requestProjects} from './assets.mjs';
import {initialPolicyState} from './policy.mjs';
import {initialEventState} from './events.mjs';
import {configurationId,canonical} from './identity.mjs';
import {prepareState,planState,resourceRates,nextBoundary,integrateState,physicalView,policyEnergy,allPolicies,dependencyView,adoptedTechnology} from './dynamics.mjs';
import {initialInfrastructure,minimumRepresentableInterval} from './infrastructure.mjs';
import {outputVector,growthContributions,adequateCoexistence,bindingTimeline,sensorReliability} from './analysis.mjs';
import {validateRun,MAX_TEXT} from './checkpoint.mjs';
import {encodeCheckpoint,decodeCheckpoint,assertExpandedCheckpointTree} from './checkpoint-codec.mjs';
export {CONSOLE_BYTES} from './checkpoint-limits.mjs';
export {VERSION,SOURCE_DIGEST};

function point(s,c){
 const v=physicalView(s,c);
 return {t:s.t,H:s.H,q:s.q,exposure:s.exposure,power:v.sourcePower,hardware:v.hardware,factoryWork:v.factoryWork,
  criticalAdequacy:s.last?.criticalAdequacy??1,extraDeaths:s.accounts.extraDeaths,shortagePersonYears:s.accounts.shortagePersonYears,
  policyCost:policyEnergy(s),landUsed:v.assets.landOccupied+v.assets.landCommitted,materialStock:s.assetState.materials,
  effectiveCompute:s.last?.effectiveCompute??0,ledger:s.last?.ledger??null,flexibleDemand:s.flexibleDemand,
  qualityOfLife:s.last?.qualityOfLife??0,perCapitaElectricity:s.last?.perCapitaElectricity??0,
  qolPersonYears:s.accounts.qolPersonYears,competitionLead:s.competitionLead,
  // [DOM-WIDE] These are endpoint observations, not reconstructed queue maxima.
  queuePendingCount:s.assetState.projects.filter(p=>p.status==='pending').length,
  autonomousWork:v.autonomousWork,humanOwnedPower:v.assets.humanPower*s.maintenanceFactor};
}
export function createRun(options={}){
 const config=makeConfig(options),initial=config.initial;
 // No-AI is an explicit ownership-transfer counterfactual: the same initial
 // power/factories belong to humans, while AI hardware/research are absent.
 const physical=config.aiEnabled?config:{...config,initial:{...initial,hardware:0,aiPower:0,aiFactories:0,
  humanPower:initial.humanPower+initial.aiPower,humanFactories:initial.humanFactories+initial.aiFactories}};
 const policyState=initialPolicyState(config);
 const state={t:0,H:initial.H,q:initial.q,exposure:0,flexibleDemand:1,maintenanceFactor:1,competitionLead:null,
  assetState:initialAssetState(physical),infrastructure:initialInfrastructure(config),technology:{algorithm:1,hardware:1,manufacturing:1,land:1,power:1},
  policyState,policyArchive:[],policyRng:policyState.rngState,eventState:initialEventState(config),nextDecision:0,
  accounts:{births:0,extraDeaths:0,personYears:0,shortagePersonYears:0,humanEnergy:0,operationEnergy:0,
   maintenanceEnergy:0,availableEnergy:0,unusedEnergy:0,minPopulation:initial.H,maxPopulation:initial.H,qolPersonYears:0,minAdequacy:1,
   shortageYears:0,shortageEpisodes:0,energyShortfall:0,landShortfallPersonYears:0},
  last:null,planning:null,history:[]};
 state.history=[point(state,config)];
 return deepFreeze({schema:SCHEMA,version:VERSION,sourceDigest:SOURCE_DIGEST,configId:configurationId(config),config,branchOf:null,state});
}
// A separate forecast-only stream: no future deployment is assumed for pending
// stochastic actions. Already reported controls and known expiry remain in force.
const FORECAST_SEED=0x46524353;
function beliefAssets(observation,c){
 const assets=structuredClone(observation.assets).map(a=>({...a,
  footprint:a.footprint??a.rated*c.assets[a.kind].land,materials:a.materials??a.rated*c.assets[a.kind].materials,
  embodiedEnergy:a.embodiedEnergy??a.rated*c.assets[a.kind].energy,
  embodiedWork:a.embodiedWork??a.rated*c.assets[a.kind].work,
  hardwareEfficiency:a.hardwareEfficiency??1,manufacturingEfficiency:a.manufacturingEfficiency??1,
  retired:a.retired??a.active===false,cleared:a.cleared??false,demolitionProjectId:null}));
 const projects=structuredClone(observation.projects).map((p,i)=>({...p,sequence:p.sequence??i+1,
  requestId:p.requestId??p.id,start:p.start??observation.t,readyAt:p.readyAt??p.commissionAt,
  status:'pending',targetIds:p.targetIds??[],eventId:p.eventId??null,expiresAt:p.expiresAt??null}));
 for(const a of assets)a.demolitionProjectId=projects.find(p=>p.kind==='demolition'&&p.targetIds.includes(a.id))?.id??null;
 const total=(rows,key)=>rows.reduce((value,row)=>value+(row[key]??0),0);
 // Rebase the synthetic material epoch at the observation: already cleared
 // historical cohorts have no embodied stock or future recovery to credit.
 const committed=total(projects,'materials'),embodied=total(assets.filter(a=>!a.cleared),'materials');
 const stock=observation.resources.materials;
 const occupied=total(assets.filter(a=>!a.cleared),'footprint'),landCommitted=total(projects,'footprint');
 const nextId=1+Math.max(0,...[...assets,...projects].map(a=>Math.max(a.sequence??0,Number(a.id?.match(/-(\d+)$/)?.[1]??0))));
 const requestIds=Object.fromEntries(projects.map(p=>[p.requestId,{signature:'observed-existing-commitment',
  receipt:{id:p.requestId,requestId:p.requestId,projectId:p.id,kind:p.kind,status:'accepted',amount:p.amount}}]));
 return {state:{assets,projects,materials:stock,nextId,requestIds,receipts:[],accounts:{
  initialStock:stock+committed,initialEmbodied:embodied,initialMaterials:stock+committed+embodied,
  virginCommitted:committed,recycledCommitted:0,recycledRecovered:0,primarySupplied:0,materialsCommitted:committed,
  materialsDisposed:0,energySpent:total(projects,'energySpent'),
  workDone:total(projects,'workDone')}},occupied,landCommitted};
}
function beliefEvents(observation,c,projects){
 let records=structuredClone([...(observation.technologyEffects??[]),...(observation.executionEffects??[])])
  .map(e=>({...e,discoveredAt:e.time}));
 for(const p of projects.filter(p=>p.kind==='adoption'&&p.eventId))if(!records.some(e=>e.id===p.eventId)){
  records=[...records,{id:p.eventId,type:p.target,target:p.target,time:p.start,magnitude:p.multiplier,
   expiresAt:p.expiresAt,adoptionStatus:'pending',adoptedAt:null,adoptionRequestId:p.requestId,observedAt:observation.t,discoveredAt:p.start}];
 }
 const eventState={...initialEventState(c),records,schedule:[],processedIds:records.map(e=>e.id),
  observedIds:records.map(e=>e.id),adoptedIds:records.filter(e=>e.adoptionStatus==='adopted').map(e=>e.id)};
 // The observation already includes current adopted event gains. Factor them
 // out of the intrinsic frontier so the shared executor applies them only once.
 const technology=Object.fromEntries(['algorithm','hardware','manufacturing','land','power'].map(type=>{
  const factor=records.filter(e=>e.type===type&&e.adoptionStatus==='adopted'&&e.adoptedAt<=observation.t&&
   e.time<=observation.t&&(e.expiresAt===null||e.expiresAt>observation.t)).reduce((v,e)=>v*e.magnitude,1);
  return [type,(observation.technology[type]??1)/factor];
 }));
 return {eventState,technology};
}
function beliefPolicy(observation,c){
 return (observation.policy?.reportedControls??[]).map(a=>({...initialPolicyState(c),nextId:1+Number(a.id.slice(7)),actions:[{
  id:a.id,type:a.type,cap:a.cap,residual:a.residual,success:1,start:a.effective_from,createdAt:a.effective_from,
  eligibleAt:a.effective_from,expiresAt:a.expiresAt,energyRequired:0,workRequired:0,energyPaid:0,workPaid:0,
  paidAt:a.effective_from,priority:0,status:'active',attempted:false,draw:null,effective_from:a.effective_from}]}));
}
function beliefState(observation,c){
 const inventory=beliefAssets(observation,c),known=beliefEvents(observation,c,inventory.state.projects);
 const policyState=initialPolicyState(c),human=observation.human;
 const state={t:observation.t,H:observation.H,q:observation.q,exposure:human.exposure??0,
  competitionLead:observation.competitionLead??null,
  flexibleDemand:human.flexibleDemand??1,maintenanceFactor:human.maintenanceFactor??1,
  assetState:inventory.state,infrastructure:structuredClone(observation.infrastructure??initialInfrastructure(c)),...known,policyState,policyArchive:beliefPolicy(observation,c),policyRng:policyState.rngState,
  nextDecision:Math.floor(observation.t+1e-9)+1,history:[],
  // [TH-PRIORITY] Only the preceding delivered annual rate is required to
  // initialize priority memory; subsequent forecast steps record full ledgers.
  last:human.previousUsage===null||human.previousUsage===undefined?null:
   {perCapitaElectricity:human.previousPerCapitaElectricity??(observation.H>0?1000*human.previousUsage/observation.H:0),
    ledger:{h:1,humanCritical:human.previousUsage,humanFlexible:0}},planning:null,
  accounts:{births:0,extraDeaths:0,personYears:0,shortagePersonYears:0,humanEnergy:0,operationEnergy:0,
   maintenanceEnergy:0,availableEnergy:0,unusedEnergy:0,minPopulation:observation.H,maxPopulation:observation.H,qolPersonYears:0,minAdequacy:1,
   shortageYears:0,shortageEpisodes:0,energyShortfall:0,landShortfallPersonYears:0}};
 return {state,inventory};
}
function boundedInterval(t,boundary,maximum){
 let h=Math.min(maximum,boundary-t);
 if(h>0&&t+h>boundary){
  // Subtraction and re-addition need not round-trip an absolute boundary.
  // Step down the duration itself; any final remainder is paid next interval.
  const bits=new DataView(new ArrayBuffer(8));
  do{
   bits.setFloat64(0,h);bits.setBigUint64(0,bits.getBigUint64(0)-1n);h=bits.getFloat64(0);
  }while(h>0&&t+h>boundary);
 }
 return h;
}
// [TH-N5] Offer physical storage power until depletion, rather than spreading
// the remaining stock over an arbitrary UI interval. A discarded safe probe
// measures actual dispatch before the first known funding/event boundary.
function scheduledInterval(state,c,target,maximum){
 const rates=resourceRates(state,c,Number.MIN_VALUE);
 let boundary=Math.min(target,nextBoundary(state,c,rates));
 const storage=c.infrastructure.storage,offered=rates.infrastructure.storageDischargePower;
 if(storage.enabled&&offered>0&&state.infrastructure.storage>0){
  const safe=state.infrastructure.storage*storage.dischargeEfficiency/offered;
  const probe=boundedInterval(state.t,boundary,Math.min(maximum,Math.max(safe,minimumRepresentableInterval(state.t))));
  if(!(probe>0)||state.t+probe===state.t)throw new Error('Storage depletion is below representable time resolution');
  const dispatched=integrateState(state,c,probe,rates).last.ledger.storageDischarge;
  if(dispatched>0){
   const wait=state.infrastructure.storage*storage.dischargeEfficiency/(dispatched/probe);
   boundary=Math.min(boundary,state.t+wait);
  }
 }
 return {h:boundedInterval(state.t,boundary,maximum),rates};
}
function endpointCompute(state,c){
 const ready=prepareState(state,c);
 const at={...ready,nextDecision:Math.floor(ready.t+1e-9)+1};
 const probeConfig={...c,horizon:Math.max(c.horizon,at.t+1)};
 // This discarded probe uses exactly the shared allocation equations at the
 // endpoint. It commits no live spending, draw, cohort or demographic change.
 const {h,rates}=scheduledInterval(at,probeConfig,at.t+1e-6,1e-6);
 if(!(h>0)||at.t+h===at.t)throw new Error('Optimizer endpoint probe cannot advance');
 return integrateState(at,probeConfig,h,rates).last.effectiveCompute;
}
function forecastFrom({observation,config,horizon,requests}){
 // Public base parameters cannot be recovered from clamped current aggregates.
 // Replay observed execution effects against the declared base exactly once.
 const base=observation.baseConditions??{coverage:config.policy.coverage,authorized:config.policy.authorized,
  fundingShare:config.resources.policyEnergyShare};
 const policy={...config.policy,...observation.policy,mode:'none',coverage:base.coverage,authorized:base.authorized};
 delete policy.fundingShare;delete policy.reportedControls;
 const fc={...config,seed:FORECAST_SEED,events:[],eventMode:'off',annualProbability:0,planner:'demand',policy,
  infrastructure:{...config.infrastructure,outages:config.infrastructure.outages.filter(o=>o.start<=observation.t)},
  resources:{...config.resources,policyEnergyShare:base.fundingShare},
  dt:Math.max(config.dt,.5)};
 const belief=beliefState(observation,fc),{occupied,landCommitted}=belief.inventory;
 // Hidden commitments never reappear as future capacity or released resources.
 // Only observed free land plus visible inventory/commitments exists in belief.
 fc.resources={...fc.resources,materials:observation.resources.materials,
  land:occupied+landCommitted+(observation.resources.landAvailable??observation.resources.land)};
 const orderConfig={...fc,resources:{...fc.resources,land:occupied+landCommitted+observation.resources.land}};
 let state={...belief.state,assetState:requestProjects(belief.state.assetState,requests,observation.t,orderConfig)};
 const target=Math.min(fc.horizon,observation.t+horizon);
 let count=0;
 while(state.t<target){
  if(++count>10000)throw new Error('Optimizer forecast step budget exceeded');
  state=prepareState(state,fc);
  if(state.nextDecision<=state.t+1e-10)state={...state,nextDecision:Math.floor(state.t+1e-9)+1};
  const {rates,h}=scheduledInterval(state,fc,target,fc.dt);
  if(!(h>0)||state.t+h===state.t)throw new Error('Optimizer forecast cannot advance');
  state=integrateState(state,fc,h,rates);
 }
 return {effectiveCompute:endpointCompute(state,fc),feasible:true};
}
function transition(run,maxYears,stopAt=run.state.t+maxYears){
 const c=run.config;if(run.state.t>=c.horizon)return run;
 let s=prepareState(run.state,c);
 s=planState(s,c,query=>forecastFrom(query));
 const {rates,h}=scheduledInterval(s,c,Math.min(c.horizon,stopAt),Math.min(c.dt,maxYears));
 if(!(h>0)||s.t+h===s.t)throw new Error(`Revised scheduler cannot advance at year ${s.t}`);
 s=integrateState(s,c,h,rates);
 s=prepareState(s,c); // Endpoint events/deployment affect subsequent intervals.
 s.history=[...run.state.history,point(s,c)];
 if(s.history.length>100001)throw new RangeError('Revised history limit exceeded');
 return {...run,state:s};
}
export function stepRun(run,maxYears=run.config.dt){
 finite(maxYears,'advance interval',Number.MIN_VALUE,1000);
 const next=transition(run,maxYears);return next===run?run:deepFreeze(next);
}
export function advanceRun(run,years=1){
 finite(years,'advance years',0,1000);if(years===0)return run;
 const target=Math.min(run.config.horizon,run.state.t+years);let next=run,count=0;
 while(next.state.t<target){
  if(++count>200000)throw new RangeError('Revised integration step limit exceeded');
  next=transition(next,target-next.state.t,target);
 }
 return next===run?run:deepFreeze(next);
}
export const finishRun=run=>advanceRun(run,run.config.horizon-run.state.t);
export function branchRun(run,policyOverrides){
 const config=makeConfig({...run.config,policy:{...run.config.policy,...policyOverrides}});
 const same=canonical(config.policy)===canonical(run.config.policy);
 if(!same&&config.policy.mode!=='none'&&config.policy.start<run.state.t)throw new RangeError('Branch policy cannot start before the checkpoint');
 const state=structuredClone(run.state);
 if(!same){
  const old=state.policyState;
  if(old.actions.length)state.policyArchive=[...state.policyArchive,old];
  state.policyState={...initialPolicyState(config),controller:old.controller,rngState:state.policyRng,
   nextId:Math.max(old.nextId,...state.policyArchive.map(p=>p.nextId))};
 }
 return deepFreeze({...run,config,configId:configurationId(config),
  branchOf:{configId:run.configId,t:run.state.t},state});
}
export function summarize(run){
 const s=run.state,c=run.config,v=physicalView(s,c),a=s.accounts,dependencies=dependencyView(v);
 return {version:VERSION,time:s.t,H:s.H,q:s.q,exposure:s.exposure,...a,
  criticalAdequacy:s.last?.criticalAdequacy??1,flexibleDemand:s.flexibleDemand,
  power:v.sourcePower,hardware:v.hardware,factoryWork:v.factoryWork,landUsed:v.assets.landOccupied+v.assets.landCommitted,
  materialStock:s.assetState.materials,policyCost:policyEnergy(s),
  policyStatus:allPolicies(s).flatMap(p=>p.actions).map(p=>`${p.id}: ${p.status}`).join('; ')||'no action',
  aiHumanDependence:dependencies.rsiOnHumans[0].fraction,humanAIDependence:dependencies.humansOnRsi[0].fraction,
  dependencies,ledger:s.last?.ledger??{},effectiveCompute:s.last?.effectiveCompute??0,
  researchCapacity:s.last?.researchCapacity??0,adoptedTechnology:adoptedTechnology(s,s.t),
  qualityOfLife:s.last?.qualityOfLife??null,perCapitaElectricity:s.last?.perCapitaElectricity??null,
  priority:s.last?.priority??null,outputVectorV1:outputVector(run),
  outcome:s.H<c.initial.H*.01?'functional-collapse':a.minAdequacy<.8?'critical-service-shortfall':'critical-services-maintained',
  welfareOutcome:s.last===null?'unmeasured':s.H<c.initial.H*.01?'functional-collapse':
   s.last.qualityOfLife<c.human.qolMaximum*(-Math.expm1(-1000*c.human.memEnergy/c.human.qolScale))?'below-mem-qol':'at-or-above-mem-qol',
  outcomeDefinition:'Functional collapse: H below 1% of initial population; service shortfall: minimum critical adequacy below 0.8. QoL and cumulative welfare are separate continuous human outcomes; labels are conditional scenario descriptions.'};
}
export function explainRun(run){
 return {vector:outputVector(run),growth:growthContributions(run),coexistence:adequateCoexistence(run),constraints:bindingTimeline(run),sensors:sensorReliability(run)};
}
export function saveCheckpoint(run){
 assertExpandedCheckpointTree(run);validateRun(run);const raw=JSON.stringify(run);
 const text=raw.length<=MAX_TEXT&&new TextEncoder().encode(raw).byteLength<=MAX_TEXT?raw:JSON.stringify(encodeCheckpoint(run));
 if(text.length>MAX_TEXT||new TextEncoder().encode(text).byteLength>MAX_TEXT)
  throw new RangeError('Revised encoded checkpoint exceeds the supported 25 MB UTF-8 budget');
 return text;
}
export function restoreCheckpoint(text){
 if(typeof text!=='string'||text.length>MAX_TEXT||new TextEncoder().encode(text).byteLength>MAX_TEXT)
  throw new RangeError('Revised checkpoint must be JSON text under 25 MB UTF-8');
 const parsed=JSON.parse(text),run=parsed&&Object.hasOwn(parsed,'encoding')?decodeCheckpoint(parsed):parsed;
 validateRun(run);return deepFreeze(run);
}
export function trajectoryCSV(run){
 const keys=['t','H','q','exposure','power','hardware','factoryWork','criticalAdequacy','extraDeaths','shortagePersonYears','policyCost','landUsed','materialStock','effectiveCompute',
  'qualityOfLife','perCapitaElectricity','qolPersonYears','flexibleDemand'];
 return [keys.join(','),...run.state.history.map(p=>keys.map(k=>p[k]).join(','))].join('\n')+'\n';
}
