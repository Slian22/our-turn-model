/** Shared physical executor: controllers request; only this ledger allocates. */
import {inspectAssets,prepareAssets,requestProjects,advanceAssets,nextAssetTime} from './assets.mjs';
import {demandPlan,selectPortfolio} from './planning.mjs';
import {observePolicy,requestPolicy,activatePolicy,policyControls,fundPolicy,nextPolicyTime} from './policy.mjs';
import {processEvents,recordEventAdoptions,eventConditions,eventTechnology,nextEventTime} from './events.mjs';
import {energyPerBlock,criticalIntensity,humanStep,capabilityStep,demandStep,support,efficiency,demographicParameters} from './math.mjs';
import {memTarget,intervalWelfare,actionPriority,reorderRequests} from './welfare.mjs';
import {operatingPriority,cappedContestedAllocation} from './marginal-priority.mjs';
import {infrastructureView,extractionRates,extractMaterials,settleInfrastructure,nextInfrastructureTime,observeInfrastructure} from './infrastructure.mjs';

const positive=v=>Math.max(0,v),sum=(values,f)=>values.reduce((v,x)=>v+f(x),0);
export const allPolicies=s=>[...(s.policyArchive??[]),s.policyState];
export const policyEnergy=s=>sum(allPolicies(s),p=>p.energySpent);
export const policyWork=s=>sum(allPolicies(s),p=>p.workSpent);
export function adoptedTechnology(s,t,visible=false){
 const ev=visible?{...s.eventState,records:s.eventState.records.filter(e=>s.eventState.observedIds.includes(e.id))}:s.eventState;
 const factors=eventTechnology(ev,t);
 return Object.fromEntries(Object.keys(s.technology).map(k=>[k,s.technology[k]*factors[k]]));
}
export function knownConditions(s,c){
 return eventConditions({...s.eventState,records:s.eventState.records.filter(e=>s.eventState.observedIds.includes(e.id))},s.t,c);
}
export function combinedControls(s,c){
 const actual=eventConditions(s.eventState,s.t,c),controls=allPolicies(s).map(p=>policyControls(p,s.t,c,actual));
 return {...actual,active:controls.some(v=>v.active),
  cap:Math.min(Infinity,...controls.filter(v=>v.active&&v.capCoveredBlocks!==null).map(v=>v.capCoveredBlocks)),
  residual:Math.min(1,...controls.filter(v=>v.active).map(v=>v.coveredOperatingFraction))};
}
export function physicalView(s,c,interval=c.dt){
 const assets=inspectAssets(s.assetState,s.t,c),technology=adoptedTechnology(s,s.t),controls=combinedControls(s,c);
 const criticalNeed=s.H*criticalIntensity(s.t,c.human),flexibleNeed=s.H*c.human.flexEnergy*s.flexibleDemand;
 const serviceCapacity=c.human.serviceBaseline*support(s.H,c.initial.H,c.human.supportHalfPopulation);
 const factoryWork=assets.factoryWork*s.maintenanceFactor;
 const autonomousWork=assets.aiFactoryWork*s.maintenanceFactor*c.ai.autonomy;
 const workCapacity=Math.min(factoryWork,serviceCapacity+autonomousWork);
 const hardware=c.aiEnabled?assets.hardware:0;
 const effective=hardware>0?assets.hardwareEffective/hardware:1;
 const task=c.ai.demandSchedule.filter(row=>row.time<=s.t).at(-1),requestedUtilisation=task?.utilisation??c.ai.utilisation;
 const utilisation=c.ai.workloadMode==='fixed-work'?Math.min(1,requestedUtilisation/Math.max(Number.MIN_VALUE,effective)):requestedUtilisation;
 const allowed=positive((1-controls.coverage)*hardware+Math.min(controls.coverage*hardware,controls.cap)*controls.residual);
 const infrastructure=infrastructureView(s.infrastructure,s.t,c,{H:s.H,
  humanPower:assets.humanPower*s.maintenanceFactor,aiPower:assets.aiPower*s.maintenanceFactor,
  humanNeed:criticalNeed+flexibleNeed,operationNeed:allowed*energyPerBlock(utilisation,c.ai.idleFraction),interval});
 const sourcePower=infrastructure.sourcePower;
 const operationNeed=Math.min(allowed*energyPerBlock(utilisation,c.ai.idleFraction),
  infrastructure.coolingOperationLimit,infrastructure.accessibleAiPower);
 const landAvailable=positive(c.resources.land-assets.landOccupied-assets.landCommitted);
 const humanLandNeed=s.H*c.human.landPerMillion;
 const landAdequacy=humanLandNeed>0?Math.min(1,landAvailable/humanLandNeed):1;
 return {assets,technology,controls,criticalNeed,flexibleNeed,sourcePower,serviceCapacity,workCapacity,infrastructure,
  factoryWork,autonomousWork,hardware,utilisation,allowed,operationNeed,landAvailable,landAdequacy};
}
// [TH-PRIORITY] Current permitted capacity is known before allocation. Actual
// previous human usage avoids making the winner depend on its own new outcome.
export function currentPriority(s,c,v=physicalView(s,c)){
 const hardwareNeed=v.allowed*energyPerBlock(v.utilisation,c.ai.idleFraction);
 const processing=v.hardware>0?v.assets.hardwareEffective*(v.allowed/v.hardware)*v.utilisation*
  (hardwareNeed>0?Math.min(1,v.operationNeed/hardwareNeed):0):0;
 const humanUsage=s.last?(s.last.ledger.humanCritical+s.last.ledger.humanFlexible)/s.last.ledger.h:
  v.criticalNeed+v.flexibleNeed;
 return {...actionPriority({processing,humanUsage},c.priority),processing,humanUsage};
}
function publishedPlans(s,c){
 const retirements=s.assetState.assets.filter(a=>!a.retired&&!a.cleared&&a.kind==='power')
  .map(a=>({id:`retirement:${a.id}`,time:a.birth+c.assets.power.life,powerDelta:-a.rated*c.assets.power.endPerformance,needDelta:0}));
 const funded=s.assetState.projects.filter(p=>p.kind==='power'&&p.status==='pending'&&p.progress>=1)
  .map(p=>({id:p.id,time:p.readyAt,powerDelta:p.amount,needDelta:0}));
 return [...retirements,...funded].filter(p=>p.time>s.t);
}
export function dependencyView(v){
 return {rsiOnHumans:[{service:'industrial maintenance and construction work',fraction:v.factoryWork>0?
  Math.min(1,positive(v.factoryWork-v.autonomousWork)/v.factoryWork):0,covered:true}],
 humansOnRsi:[{service:'pooled electricity from AI-owned capacity',fraction:v.assets.power>0?v.assets.aiPower/v.assets.power:0,covered:true}],
 uncovered:['food production chains','water distribution','clinical care','communications','military coercion']};
}
export function policyProjection(s,c){
 const v=physicalView(s,c),known=knownConditions(s,c);
 return {t:s.t,H:s.H,q:s.q,exposure:s.exposure,deficit:s.last?.deficit??positive(1-v.sourcePower/Math.max(Number.MIN_VALUE,v.criticalNeed)),
  supply:v.sourcePower,need:v.criticalNeed,powerAvailability:s.maintenanceFactor,
  technology:adoptedTechnology(s,s.t,true),...known,
  plans:publishedPlans(s,c),dependencies:dependencyView(v)};
}
export function planningProjection(s,c){
 const v=physicalView(s,c),known=knownConditions(s,c);
 const reportedControls=allPolicies(s).flatMap(p=>p.actions).filter(a=>a.effective_from!==null&&
  a.effective_from+c.policy.observationDelay<=s.t&&(a.expiresAt===null||a.expiresAt>s.t))
  .map(a=>({id:a.id,type:a.type,cap:a.cap,residual:a.residual,effective_from:a.effective_from,expiresAt:a.expiresAt}));
 const technologyEffects=s.eventState.records.filter(e=>s.eventState.observedIds.includes(e.id)&&
  ['algorithm','hardware','manufacturing','land','power'].includes(e.type))
  .map(e=>({id:e.id,type:e.type,target:e.target,time:e.time,magnitude:e.magnitude,expiresAt:e.expiresAt,
   adoptionStatus:e.adoptionStatus,adoptedAt:e.adoptedAt,adoptionRequestId:e.adoptionRequestId,observedAt:e.observedAt}));
 const executionEffects=s.eventState.records.filter(e=>s.eventState.observedIds.includes(e.id)&&
  ['coverage','authority','funding'].includes(e.type))
  .map(e=>({id:e.id,type:e.type,target:e.target,time:e.time,magnitude:e.magnitude,
   expiresAt:e.expiresAt,observedAt:e.observedAt}));
 const baseConditions={coverage:c.policy.coverage,authorized:c.policy.authorized,
  fundingShare:c.resources.policyEnergyShare};
 return {t:s.t,H:s.H,q:s.q,competitionLead:s.competitionLead,technology:adoptedTechnology(s,s.t,true),
  technologyEffects,executionEffects,baseConditions,infrastructure:structuredClone(s.infrastructure),
  assets:v.assets.cohorts.map(a=>({...a,active:a.performance>0})),
  projects:s.assetState.projects.filter(p=>p.status==='pending'&&(!p.eventId||s.eventState.observedIds.includes(p.eventId)))
   .map(p=>({...p,commissionAt:Math.max(s.t,p.readyAt)})),
  resources:{land:positive(v.assets.landAvailable-c.alignment*s.H*c.human.landPerMillion),landAvailable:v.assets.landAvailable,materials:s.assetState.materials,
   energy:v.sourcePower,work:v.workCapacity},
  human:{powerNeed:v.criticalNeed+v.flexibleNeed+v.assets.maintenanceWork*c.resources.maintenanceEnergyPerWork,
   // [TH-PRIORITY] C4 must retain the observed lagged delivery rate, including zero.
   previousUsage:s.last?(s.last.ledger.humanCritical+s.last.ledger.humanFlexible)/s.last.ledger.h:null,
   previousPerCapitaElectricity:s.last?.perCapitaElectricity??null,
   factoryWorkNeed:v.assets.maintenanceWork,exposure:s.exposure,flexibleDemand:s.flexibleDemand,maintenanceFactor:s.maintenanceFactor},
  // A demand assumption, separate from power feasibility: gradual desired
  // rated hardware growth from the original installed stock, independent of Q.
  ai:{desiredHardware:c.aiEnabled?(c.ai.demandSchedule.filter(row=>row.time<=s.t).at(-1)?.desiredHardware??
   c.initial.hardware*(1+c.ai.expansion*s.t)):0,
   utilisation:c.ai.demandSchedule.filter(row=>row.time<=s.t).at(-1)?.utilisation??c.ai.utilisation},
  policy:{...c.policy,...known,mode:'none',reportedControls}};
}
function activateAll(s,c){
 let rng=s.policyRng;
 const policies=allPolicies(s).map(p=>{
  const result=activatePolicy({...p,rngState:rng},s.t,c,eventConditions(s.eventState,s.t,c));
  rng=result.state.rngState;return result.state;
 });
 return {...s,policyArchive:policies.slice(0,-1),policyState:policies.at(-1),policyRng:rng};
}
export function prepareState(state,c){
 let s={...state,assetState:prepareAssets(state.assetState,state.t,c)};
 const events=processEvents(s.eventState,s.t,c);s.eventState=events.state;
 if(c.aiEnabled&&events.adoptionRequests.length)s.assetState=requestProjects(s.assetState,events.adoptionRequests,s.t,c);
 const projection=policyProjection(s,c);
 // [TH-N8] Missing sensors withhold a sample; paired deterministic noise never
 // consumes either policy execution or exogenous-event random streams.
 const sensed=observeInfrastructure({deficit:projection.deficit,supply:projection.supply,need:projection.need},
  {seed:c.seed,index:s.t},c);
 // A missing new sample must not hold back an earlier sample whose delay ended.
 const observation=Object.values(sensed).every(x=>x!==null)?
  {...projection,...sensed,deficit:Math.max(0,Math.min(1,sensed.deficit)),
   supply:positive(sensed.supply),need:positive(sensed.need)}:null;
 s.policyState=observePolicy(s.policyState,observation,s.t,c);
 const policy=requestPolicy(s.policyState,s.t,c);s.policyState=policy.state;
 return activateAll(s,c);
}
function capabilityRequests(s,c){
 if(!c.aiEnabled)return [];
 const pairs=[['algorithm',c.ai.algorithmMaximum],['hardware',c.ai.hardwareMaximum],['manufacturing',c.ai.manufacturingMaximum]];
 return pairs.flatMap(([target,maximum])=>{
  const value=efficiency(s.q,maximum,c.ai.efficiencyExponent);
  const pending=s.assetState.projects.some(p=>p.status==='pending'&&p.kind==='adoption'&&p.target===target&&p.requestId.startsWith('capability:'));
  return !pending&&value>s.technology[target]+1e-9?[{id:`capability:${target}:${s.nextDecision}`,kind:'adoption',owner:'ai',
   amount:1,priority:5,target,multiplier:value}]:[];
 });
}
export function planState(s,c,forecast){
 if(s.t<s.nextDecision)return s;
 const observation=planningProjection(s,c),h=1;
 const priority=currentPriority(s,c),mandatory=capabilityRequests(s,c);
 // Compulsory adoption competes inside C4's forecast and actual queue alike.
 const pairedForecast=query=>forecast({...query,requests:reorderRequests([...mandatory,...query.requests],priority.winner,c.priority.mode)});
 const plan=c.planner==='optimizer'?selectPortfolio(observation,c,h,pairedForecast):demandPlan(observation,c,h);
 const requests=reorderRequests([...mandatory,...plan.requests],priority.winner,c.priority.mode);
 // Existing human land protection is a commitment constraint for new orders;
 // installed footprints are unchanged when population/needs later change.
 const assetConfig={...c,resources:{...c.resources,land:positive(c.resources.land-c.alignment*s.H*c.human.landPerMillion)}};
 return {...s,assetState:requestProjects(s.assetState,requests,s.t,assetConfig),nextDecision:Math.floor(s.t)+1,
  planning:{time:s.t,priority,diagnostics:plan.diagnostics,optimization:plan.optimization??null}};
}
export function resourceRates(s,c,interval=c.dt){
 const v=physicalView(s,c,interval),priority=currentPriority(s,c,v);
 // [DOM-MEM] Reservation cannot create supply or force consumption above demand.
 const reserve=Math.min(v.sourcePower,v.infrastructure.accessibleHumanPower,v.criticalNeed+v.flexibleNeed,
  memTarget(s.H,c.initial.H,c.human.memEnergy,c.alignment));
 const afterReserve=positive(v.sourcePower-reserve);
 const maintenanceWork=Math.min(v.assets.maintenanceWork,v.workCapacity,
  c.resources.maintenanceEnergyPerWork>0?afterReserve/c.resources.maintenanceEnergyPerWork:Infinity);
 const maintenanceEnergy=maintenanceWork*c.resources.maintenanceEnergyPerWork;
 const freeEnergy=positive(afterReserve-maintenanceEnergy),freeWork=positive(v.workCapacity-maintenanceWork);
 // [TH-N4] Extraction uses the same finite energy/work before downstream work.
 const extraction=extractionRates(s.infrastructure,s.t,{energyBudget:freeEnergy,workBudget:freeWork},c);
 const available=positive(freeEnergy-extraction.energyUsed),work=positive(freeWork-extraction.workUsed);
 const energyPolicy=available*v.controls.fundingShare,workPolicy=work*v.controls.fundingShare;
 const policies=allPolicies(s),pending=policies.map((p,index)=>({index,p,request:requestPolicy(p,s.t,c).requests[0]}))
  .filter(x=>x.request).sort((a,b)=>a.request.priority-b.request.priority||a.index-b.index);
 const remainingEnergy=sum(pending,x=>x.request.energy),remainingWork=sum(pending,x=>x.request.work);
 const rates=policies.map(()=>({energy:0,work:0}));
 for(const x of pending)rates[x.index]={energy:remainingEnergy>0?energyPolicy*x.request.energy/remainingEnergy:0,
  work:remainingWork>0?workPolicy*x.request.work/remainingWork:0};
 return {...v,reserve,priority,maintenanceWork,maintenanceEnergy,available,availableWork:work,
  extractionEnergy:extraction.energyUsed,extractionWork:extraction.workUsed,extractionMaterials:extraction.materials,rates};
}
export function nextBoundary(s,c,rates){
 const oreWait=rates.extractionMaterials>0?s.infrastructure.oreRemaining/rates.extractionMaterials:Infinity;
 const oreAt=Number.isFinite(oreWait)?(s.t+oreWait>s.t?s.t+oreWait:s.t+Math.max(Number.MIN_VALUE,s.t*Number.EPSILON*2)):Infinity;
 return Math.min(c.horizon,s.nextDecision,nextAssetTime(s.assetState,s.t,c),nextEventTime(s.eventState,s.t,c),
  nextConstructionTime(s,c,rates),nextInfrastructureTime(s.t,c),
  ...c.human.growthSchedule.filter(row=>row.time>s.t).map(row=>row.time),
  ...c.ai.demandSchedule.filter(row=>row.time>s.t).map(row=>row.time),
  oreAt,
  ...allPolicies(s).map((p,i)=>nextPolicyTime(p,s.t,c,rates.rates[i])));
}
function nextConstructionTime(s,c,r){
 // Before the first funding completion, the two-pass executor is linear in
 // the interval length. Compute those same priority/FIFO progress rates,
 // without capping them at an arbitrary proposed integration endpoint.
 const pending=s.assetState.projects.filter(p=>p.status==='pending'&&p.progress<1&&p.start<=s.t&&
  (p.expiresAt===null||p.expiresAt>s.t)).sort((a,b)=>a.priority-b.priority||a.sequence-b.sequence);
 const queue=reorderRequests(pending,r.priority.winner,c.priority.mode);
 const energy=positive(r.available-sum(r.rates,x=>x.energy))*c.resources.constructionEnergyShare;
 const work=positive(r.availableWork-sum(r.rates,x=>x.work));
 const progress=new Map(queue.map(p=>[p.id,0]));
 function allocate(rows,e,w){
  let usedEnergy=0,usedWork=0,aiEnergy=0,aiWork=0;
  for(const p of rows){
   const rate=Math.min(p.energyRequired>0?positive(e-usedEnergy)/p.energyRequired:Infinity,
    p.workRequired>0?positive(w-usedWork)/p.workRequired:Infinity,
    p.owner==='ai'&&p.energyRequired>0?positive(c.ai.investmentEnergyLimit-aiEnergy)/p.energyRequired:Infinity,
    p.owner==='ai'&&p.workRequired>0?positive(c.ai.investmentWorkLimit-aiWork)/p.workRequired:Infinity);
   if(!Number.isFinite(rate))continue; // Free projects settle at their known lead boundary.
   progress.set(p.id,progress.get(p.id)+rate);
   usedEnergy+=rate*p.energyRequired;usedWork+=rate*p.workRequired;
   if(p.owner==='ai'){aiEnergy+=rate*p.energyRequired;aiWork+=rate*p.workRequired;}
  }
  return {energy:usedEnergy,work:usedWork};
 }
 const share=c.resources.humanConstructionShare;
 const reserved=allocate(queue.filter(p=>p.owner==='human'),energy*share,work*share);
 allocate(queue,positive(energy-reserved.energy),positive(work-reserved.work));
 const wait=Math.min(Infinity,...queue.map(p=>progress.get(p.id)>0?(1-p.progress)/progress.get(p.id):Infinity));
 if(!Number.isFinite(wait))return Infinity;
 // A sub-ULP remainder must still be paid over an actual positive interval.
 return s.t+wait>s.t?s.t+wait:s.t+Math.max(Number.MIN_VALUE,Math.abs(s.t)*Number.EPSILON*2);
}
function shareContested(available,humanNeed,aiNeed,weight){
 const total=humanNeed+weight*aiNeed;
 if(total===0)return {human:0,ai:0};
 let human=Math.min(humanNeed,available*humanNeed/total),ai=Math.min(aiNeed,positive(available-human));
 human+=Math.min(positive(humanNeed-human),positive(available-human-ai));
 return {human,ai};
}
export function integrateState(s,c,h,r){
 const t=s.t,end=t+h,beforeAssetEnergy=s.assetState.accounts.energySpent,beforePolicyEnergy=policyEnergy(s);
 const extracted=extractMaterials(s.infrastructure,t,h,{energyBudget:r.extractionEnergy*h,workBudget:r.extractionWork*h},c);
 const fundedAssets={...s.assetState,materials:s.assetState.materials+extracted.materials,
  accounts:{...s.assetState.accounts,primarySupplied:s.assetState.accounts.primarySupplied+extracted.materials}};
 let energyPolicy=0,workPolicy=0;
 const policies=allPolicies(s).map((p,i)=>{
  const funded=fundPolicy(p,t,h,{energy:r.rates[i].energy*h,work:r.rates[i].work*h,
   receiptId:`fund:${p.actions[0]?.id??i}:${t}:${end}`},c);
  energyPolicy+=funded.energyUsed;workPolicy+=funded.workUsed;return funded.state;
 });
 const buildBudget=positive((r.available*h-energyPolicy))*c.resources.constructionEnergyShare;
 const built=advanceAssets(fundedAssets,t,h,{energy:buildBudget,
  work:positive(r.availableWork*h-workPolicy),humanShare:c.resources.humanConstructionShare,
  aiEnergyLimit:c.ai.investmentEnergyLimit*h,aiWorkLimit:c.ai.investmentWorkLimit*h,
  ...(c.priority.mode==='weighted'?{preferredOwner:r.priority.winner}:{})},c);
 const available=r.sourcePower*h,reserve=r.reserve*h;
 const contested=positive(available-reserve-r.maintenanceEnergy*h-energyPolicy-built.energyUsed-extracted.energyUsed);
 const protectedCritical=Math.min(reserve,r.criticalNeed*h),protectedFlexible=reserve-protectedCritical;
 const humanResidual=Math.min(positive(r.infrastructure.accessibleHumanPower*h-reserve),
  positive(r.criticalNeed*h+r.flexibleNeed*h-reserve));
 // [DOM-PRIORITY] A local derivative of research-supported capability growth
 // values attainable operating electricity. It does not grant unpaid hardware
 // growth or adoption. Only committed intervals update hysteresis memory.
 const marginal=operatingPriority({q:s.q,operationPower:r.operationNeed,
  researchAtCapacity:r.priority.processing*r.technology.algorithm*c.ai.researchFraction,
  perCapitaElectricity:s.last?.perCapitaElectricity??(s.H>0?1000*(r.criticalNeed+r.flexibleNeed)/s.H:0),
  previousLeader:s.competitionLead},c);
 const legacy=shareContested(contested,humanResidual,r.operationNeed*h,c.ai.competitionWeight);
 const isMarginal=c.priority.operatingMode==='marginal';
 const shared=isMarginal?cappedContestedAllocation(contested,humanResidual,r.operationNeed*h,marginal.humanShare):legacy;
 const legacyTotal=humanResidual+c.ai.competitionWeight*r.operationNeed*h;
 const targetAiShare=isMarginal?1-marginal.humanShare:legacyTotal>0?c.ai.competitionWeight*r.operationNeed*h/legacyTotal:.5;
 const observed=contested>0;
 const proposedLead=isMarginal?marginal.leader:targetAiShare>.5?'ai':targetAiShare<.5?'human':s.competitionLead??c.priority.tieBreak;
 const competitionLead=observed?proposedLead:s.competitionLead;
 const humanCritical=protectedCritical+Math.min(positive(r.criticalNeed*h-protectedCritical),shared.human);
 const humanFlexible=protectedFlexible+positive(shared.human-positive(r.criticalNeed*h-protectedCritical));
 const energyAdequacy=r.criticalNeed>0?Math.min(1,humanCritical/(r.criticalNeed*h)):1;
 const adequacy=Math.min(energyAdequacy,r.landAdequacy,r.infrastructure.serviceAdequacy),deficit=positive(1-adequacy);
 const operation=shared.ai,hardwareNeed=r.allowed*energyPerBlock(r.utilisation,c.ai.idleFraction);
 const powered=hardwareNeed>0?r.allowed*Math.min(1,operation/(hardwareNeed*h)):0;
 const cohortFactor=r.hardware>0?powered/r.hardware:0;
 const effectiveCompute=sum(r.assets.cohorts.filter(a=>a.kind==='hardware'),a=>a.effective*a.hardwareEfficiency*cohortFactor*r.utilisation);
 const research=effectiveCompute*r.technology.algorithm*c.ai.researchFraction;
 const human=humanStep(s,deficit,h,demographicParameters(t,c.human)),q=c.aiEnabled?capabilityStep(s.q,research,h,c.ai):s.q;
 const welfare=intervalWelfare({energyTWh:humanCritical+humanFlexible,hYears:h,startPopulation:s.H,personYears:human.personYears},
  {maximum:c.human.qolMaximum,scale:c.human.qolScale});
 const technology={...s.technology};
 for(const receipt of built.receipts)if(receipt.kind==='adoption'&&receipt.status==='completed'&&receipt.requestId.startsWith('capability:'))
  technology[receipt.target]=Math.max(technology[receipt.target],receipt.multiplier);
 const adopted=recordEventAdoptions(s.eventState,built.receipts.map(x=>({...x,time:x.completedAt})),end);
 const spent=humanCritical+humanFlexible+operation+r.maintenanceEnergy*h+energyPolicy+built.energyUsed+extracted.energyUsed;
 // [TH-N5] Only actual net demand draws storage; only unused generation charges
 // it. Both conversion losses are retained in the independent state account.
 const generation=r.infrastructure.generatedPower*h;
 const storageDischarge=c.infrastructure.storage.enabled?Math.max(positive(spent-generation),
  positive(humanCritical+humanFlexible-(r.infrastructure.accessibleHumanPower-r.infrastructure.storageDischargePower)*h),
  positive(operation-(r.infrastructure.accessibleAiPower-r.infrastructure.storageDischargePower)*h)):0;
 const supplied=generation+storageDischarge;
 const surplus=positive(generation-spent),st=c.infrastructure.storage;
 const storageCharge=st.enabled?Math.min(surplus,st.chargePower*h,
  positive(st.capacity-extracted.state.storage)/st.chargeEfficiency)*(storageDischarge>0?0:1):0;
 const unused=positive(supplied-spent-storageCharge);
 const infrastructure=settleInfrastructure(extracted.state,{h,dischargeEnergy:storageDischarge,
  chargeEnergy:storageCharge,operationEnergy:operation},c);
 const ledger={start:t,end,h,available:supplied,humanCritical,humanFlexible,operation,
  maintenance:r.maintenanceEnergy*h,construction:built.energyUsed,policy:energyPolicy,unused,
  extraction:extracted.energyUsed,extractionWork:extracted.workUsed,primaryMaterials:extracted.materials,
  generatedEnergy:generation,storageDischarge,storageCharge,
  aiPriorityScore:r.priority.aiScore,humanPriorityScore:r.priority.humanScore,priorityWinner:r.priority.winner==='ai'?1:0,
  competitionMode:isMarginal?1:0,competitionHumanValue:marginal.humanValue,competitionAiValue:marginal.aiValue,
  competitionLogRatio:Math.max(-700,Math.min(700,marginal.logRatio)),
  competitionTargetAiShare:targetAiShare,competitionActualAiShare:observed?shared.ai/contested:0,
  competitionObserved:observed?1:0,competitionLeader:competitionLead==='ai'?1:0,
  competitionFlip:observed&&s.competitionLead!==null&&s.competitionLead!==competitionLead?1:0,
  competitionPool:contested,protectedReserve:reserve,
  // The admitted queue can shrink before the endpoint observation is saved.
  queuePendingCount:s.assetState.projects.filter(p=>p.status==='pending').length,
  competitionHumanAtFloor:s.H>0&&Math.abs(humanCritical+humanFlexible-reserve)<=1e-9*Math.max(1,humanCritical+humanFlexible,reserve)?1:0,
  priorityProcessing:r.priority.processing,serviceAdequacy:r.infrastructure.serviceAdequacy,
  minimumPopulation:human.minPopulation,maximumPopulation:human.maxPopulation,
  landAdequacy:r.landAdequacy,materialFree:s.assetState.materials,
  policyAccess:allPolicies(s).some(p=>p.actions.some(a=>a.status==='unauthorized'))?1:0,
  regionalPowerLimited:c.infrastructure.grid.enabled&&
   (r.infrastructure.accessibleHumanPower<r.criticalNeed+r.flexibleNeed||r.infrastructure.accessibleAiPower<hardwareNeed)?1:0,
  storageLimited:c.infrastructure.storage.enabled&&s.infrastructure.storage<=1e-9?1:0,
  coolingWaterLimited:r.infrastructure.coolingWaterOperationLimit<hardwareNeed?1:0,
  heatLimited:r.infrastructure.heatOperationLimit<hardwareNeed?1:0,
  refiningLimited:c.infrastructure.extraction.enabled&&c.infrastructure.extraction.capacity<c.infrastructure.extraction.extractionRate?1:0,
  workLimited:r.workCapacity>0?(r.maintenanceWork*h+built.workUsed+workPolicy+extracted.workUsed>0&&
   r.workCapacity*h-(r.maintenanceWork*h+built.workUsed+workPolicy+extracted.workUsed)<=1e-9?1:0):
   (r.assets.maintenanceWork>0?1:0),
  energyLimited:humanCritical<r.criticalNeed*h-1e-9||operation<hardwareNeed*h-1e-9?1:0,
  workAvailable:r.workCapacity*h,maintenanceWork:r.maintenanceWork*h,constructionWork:built.workUsed,policyWork:workPolicy,
  sourcePower:supplied/h,maintenanceAvailability:s.maintenanceFactor,poweredBlocks:powered,utilisation:r.utilisation,
  assetEnergyBefore:beforeAssetEnergy,assetEnergyAfter:built.state.accounts.energySpent,
  policyEnergyBefore:beforePolicyEnergy,policyEnergyAfter:sum(policies,p=>p.energySpent)};
 const maintenanceTarget=r.assets.maintenanceWork>0?Math.min(1,r.maintenanceWork/r.assets.maintenanceWork):1;
 const accounts={...s.accounts,births:s.accounts.births+human.births,extraDeaths:s.accounts.extraDeaths+human.extraDeaths,
  personYears:s.accounts.personYears+human.personYears,shortagePersonYears:s.accounts.shortagePersonYears+human.shortagePersonYears,
  humanEnergy:s.accounts.humanEnergy+humanCritical+humanFlexible,operationEnergy:s.accounts.operationEnergy+operation,
  maintenanceEnergy:s.accounts.maintenanceEnergy+ledger.maintenance,availableEnergy:s.accounts.availableEnergy+supplied,
  unusedEnergy:s.accounts.unusedEnergy+unused,minPopulation:Math.min(s.accounts.minPopulation,human.minPopulation),
  maxPopulation:Math.max(s.accounts.maxPopulation,human.maxPopulation),qolPersonYears:s.accounts.qolPersonYears+welfare.weightedQolPersonYears,
  minAdequacy:Math.min(s.accounts.minAdequacy,adequacy),shortageYears:s.accounts.shortageYears+(deficit>1e-3?h:0),
  shortageEpisodes:s.accounts.shortageEpisodes+(deficit>1e-3&&(s.last?.deficit??0)<=1e-3?1:0),
  energyShortfall:s.accounts.energyShortfall+positive(r.criticalNeed*h-humanCritical),
  landShortfallPersonYears:s.accounts.landShortfallPersonYears+(1-r.landAdequacy)*human.personYears};
 return {...s,t:end,H:human.H,exposure:human.exposure,q,competitionLead,technology,eventState:adopted.state,infrastructure,
  assetState:built.state,policyArchive:policies.slice(0,-1),policyState:policies.at(-1),accounts,
  flexibleDemand:demandStep(s.flexibleDemand,adequacy,h,c.human,unused),
  maintenanceFactor:maintenanceTarget+(s.maintenanceFactor-maintenanceTarget)*Math.exp(-h/c.assets.maintenanceTime),
  last:{deficit,criticalAdequacy:adequacy,energyAdequacy,landAdequacy:r.landAdequacy,researchCapacity:research,
   effectiveCompute,poweredBlocks:powered,utilisation:r.utilisation,ledger,dependencies:dependencyView(r),
   qualityOfLife:welfare.qualityOfLife,perCapitaElectricity:welfare.perCapitaElectricity,
   priority:{aiScore:r.priority.aiScore,humanScore:r.priority.humanScore,winner:r.priority.winner}}};
}
