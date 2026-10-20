/** Regional adaptation of sim/dynamics.mjs. Supply and h are explicit inputs;
 * canonical config.dt is used only for event/grid and commissioning dates.
 */
import {adequacy,populationStep,clamp01,ledgerCheck} from '../sim/resources.mjs';
import {safeAllocatePool as allocatePool} from './allocation.mjs';
import {supportFactor,landUsed,settleProjects} from '../sim/infrastructure.mjs';
import {uniform} from '../sim/rng.mjs';
import {reserveFraction} from '../sim/dynamics.mjs';
import {applyFundedPolicies,fundDeployment} from '../sim/policy-funding.mjs';
import {capabilityStep} from '../sim/capability.mjs';
import {expireEvents} from './events.mjs';
import {DEFAULT_WEIGHTS} from './config.mjs';

function settleRegional(s,weights) {
 const due=s.queue.filter(p=>p.due<=s.t+1e-10);
 return {...settleProjects(s),commissionedBuildEnergy:(s.commissionedBuildEnergy??0)+due.reduce((a,p)=>a+p.energy,0),
  commissionedBuildWork:(s.commissionedBuildWork??0)+due.reduce((a,p)=>a+p.amount*weights[p.kind],0),
  commissionedAmounts:Object.fromEntries(Object.keys(weights).map(k=>[k,(s.commissionedAmounts?.[k]??0)+due.filter(p=>p.kind===k).reduce((a,p)=>a+p.amount,0)]))};
}

export function prepareRegion(region,worldConfig={workWeights:DEFAULT_WEIGHTS}) {
 let s=settleRegional(region.state,worldConfig.workWeights);const c=region.config,year=Math.floor(s.t+1e-9);
 if(year!==s.shockYear){
  const draw=uniform(s.rng.environment),shock=draw.value<c.shockProbability;
  s={...s,shockYear:year,shockFactor:shock?1-c.shockMagnitude:1,rng:{...s.rng,environment:draw.state},
   events:shock?[...s.events,{t:s.t,type:'supply-shock',factor:1-c.shockMagnitude}]:s.events};
 }
 const activated=applyFundedPolicies(s,c);
 return {...region,state:activated.state,capBlocks:activated.capBlocks};
}
function desiredProjects(s,c,h,cap) {
 if(s.shutdown||s.B===0)return [];
 const pending=kind=>s.queue.filter(p=>p.kind===kind).reduce((a,p)=>a+p.amount,0);
 const desiredHardware=Math.min(s.B*c.hardwareGrowth*Math.pow(s.Q,.2)*h,c.materials*h,Math.max(0,cap-s.B-pending('hardware')));
 const fabrication=s.F*supportFactor(s.aF,s.support),hardware=Math.min(desiredHardware,fabrication*h);
 const factoryPressure=c.factoryRule==='persistent'?1:clamp01(desiredHardware/Math.max(1e-12,fabrication*h)-1);
 const items=[['hardware',hardware,c.embodiedBlock,c.landBlock,c.hardwareDelay],
  ['power',s.G*c.powerGrowth*h,c.embodiedPower,c.landPower,c.powerDelay],
  ['factory',s.F*c.fabGrowth*h*factoryPressure,c.embodiedFab,c.landFab,c.fabDelay],
  ['powerAutomation',Math.min(c.automationRate*s.Q/(s.Q+1)*h,Math.max(0,1-s.aE-pending('powerAutomation'))),c.automationEnergy,0,c.automationDelay],
  ['fabAutomation',Math.min(c.automationRate*s.Q/(s.Q+1)*h,Math.max(0,1-s.aF-pending('fabAutomation'))),c.automationEnergy,0,c.automationDelay]];
 return items.filter(([,amount])=>amount>1e-12).map(([kind,amount,energyPer,landPer,delay])=>({kind,amount,
  energy:amount*energyPer,land:amount*landPer,requestedDue:s.t+delay,due:Math.ceil((s.t+delay)/c.dt-1e-8)*c.dt}));
}
function finishPopulation(s,c,h,sH) {
 const candidate=populationStep(s.H,sH,c,h),belowYears=candidate<c.extinctionPopulation?s.belowYears+h:0;
 const extinct=s.extinct||belowYears+1e-9>=c.extinctionWindow,H=extinct?0:candidate;
 const targetSupport=clamp01((c.H0>0?H/c.H0:0)*Math.pow(sH,c.supportExponent));
 const support=c.supportTime===0?targetSupport:targetSupport+(s.support-targetSupport)*Math.exp(-h/c.supportTime);
 const window=[...s.window,{t:s.t+h,dt:h,H,s:sH}].filter(p=>p.t>s.t+h-c.outcomeWindow-1e-10);
 return {H,belowYears,extinct,window,minPopulation:Math.min(s.minPopulation,H),minAdequacy:Math.min(s.minAdequacy,sH),
  shortageYears:s.shortageYears+(sH<.999?h:0),support:clamp01(support)};
}
export function integrateRegion(region,{deliveredPower:supply,h},worldConfig) {
 const c=region.effectiveConfig??region.config;let s=region.state;
 const reserveE=reserveFraction(c)*c.humanEnergy*Math.max(c.H0,s.H),reserveL=reserveFraction(c)*c.humanLand*Math.max(c.H0,s.H);
 const landBefore=landUsed(s,c),infeasible=reserveE>supply+1e-9||reserveL>c.land-landBefore+1e-9;
 const funding=fundDeployment(s,c,Math.max(0,supply-reserveE)*h);s=funding.state;
 const ethicalOrSupport=Math.max(reserveE,c.dependencyReserve*(1-Math.max(s.aE,s.aF))*c.humanEnergy*s.H);
 const requests=infeasible?[]:desiredProjects(s,c,h,region.capBlocks);
 const capacity=s.F*supportFactor(s.aF,s.support)*worldConfig.workScale;
 const requestedWork=requests.reduce((a,p)=>a+p.amount*worldConfig.workWeights[p.kind],0);
 const zeta=worldConfig.unlimitedWork||requestedWork===0?1:Math.min(1,h*capacity/requestedWork);
 const plans=requests.map(p=>({...p,amount:p.amount*zeta,energy:p.energy*zeta,land:p.land*zeta}));
 const plannedEnergy=plans.reduce((a,p)=>a+p.energy,0),plannedLand=plans.reduce((a,p)=>a+p.land,0);
 const perBlock=c.energyBlock*(c.idleFraction+(1-c.idleFraction)*c.utilization);
 const targetBlocks=infeasible?0:Math.min(s.B,region.capBlocks)*s.residual,operating=targetBlocks*perBlock;
 const industry=infeasible||s.shutdown||s.B===0?0:c.industryEnergy*supply;
 const demandA=operating+industry+plannedEnergy/h,needH=c.humanEnergy*s.H;
 const energy=allocatePool({supply:Math.max(0,supply-funding.cost/h),needH,needA:demandA,claimH:needH,
  claimA:demandA*Math.pow(s.Q,c.competition),reserve:Math.min(Math.max(0,supply-funding.cost/h),ethicalOrSupport)});
 const fraction=demandA>0?energy.other/demandA:0,space=Math.max(0,c.land-landBefore-reserveL);
 const constructionFraction=Math.min(fraction,plannedLand>0?space/plannedLand:1);
 if(!Number.isSafeInteger(s.nextProjectId)||s.nextProjectId<0||s.nextProjectId>Number.MAX_SAFE_INTEGER-plans.length)
  throw new Error('Regional project identifier headroom exceeded');
 const nextProjectId=s.nextProjectId+plans.length;
 const booked=plans.map((p,i)=>({...p,id:s.nextProjectId+i,amount:p.amount*constructionFraction,
  energy:p.energy*constructionFraction,land:p.land*constructionFraction})).filter(p=>p.amount>1e-12);
 const buildEnergy=booked.reduce((a,p)=>a+p.energy,0),usedWork=booked.reduce((a,p)=>a+p.amount*worldConfig.workWeights[p.kind],0);
 const actualOperating=operating*fraction,actualIndustry=industry*fraction;
 const unusedAI=Math.max(0,energy.other-actualOperating-actualIndustry-buildEnergy/h);
 const returnedHuman=Math.min(Math.max(0,needH-energy.human),unusedAI),human=energy.human+returnedHuman;
 const unused=energy.unused+unusedAI-returnedHuman,afterLand=landBefore+booked.reduce((a,p)=>a+p.land,0);
 const humanLand=Math.min(c.humanLand*s.H,Math.max(0,c.land-afterLand));
 const sH=adequacy([human,humanLand],[needH,c.humanLand*s.H]),active=actualOperating/perBlock;
 const Q=capabilityStep(s.Q,active*c.utilization*c.rdShare,c,h),retired=s.B*(1-Math.exp(-h/c.lifetime));
 const ledger={supply,human,operation:actualOperating*(1-c.rdShare),research:actualOperating*c.rdShare,
  construction:buildEnergy/h,industry:actualIndustry,policy:funding.cost/h,unused};
 const energyResidual=ledgerCheck(ledger);
 const next={...s,...finishPopulation(s,c,h,sH),t:s.t+h,B:s.B-retired,Q,active,retired:s.retired+retired,
  queue:[...s.queue,...booked],nextProjectId,
  events:s.traceProjects===false?s.events:[...s.events,...booked.map(p=>({t:s.t,type:'ordered',project:p.id,kind:p.kind,amount:p.amount,due:p.due}))],
  sH,ledger,energyResidual,infeasible,landUsed:afterLand-retired*c.landBlock,
  cumulativeBuildEnergy:s.cumulativeBuildEnergy+buildEnergy,cumulativeBuildWork:(s.cumulativeBuildWork??0)+usedWork,
  lastConstruction:{start:s.t,dt:h,energy:buildEnergy,work:usedWork,amounts:Object.fromEntries(Object.keys(worldConfig.workWeights).map(kind=>[kind,booked.filter(p=>p.kind===kind).reduce((a,p)=>a+p.amount,0)]))},stepDuration:h};
 const state=expireEvents(applyFundedPolicies(settleRegional(next,worldConfig.workWeights),c).state);
 if(landUsed(state,c)>c.land+1e-6)throw new Error('Committed regional land exceeds supply');
 for(const k of ['H','B','Q','G','F'])if(!Number.isFinite(state[k])||state[k]<0)throw new Error(`Invalid regional stock ${k}`);
 if(!worldConfig.unlimitedWork&&usedWork>h*capacity+1e-9*Math.max(1,h*capacity))throw new Error('Construction work exceeds capacity');
 const {capBlocks:ignored,effectiveConfig:ignored2,...rest}=region;
 return {...rest,state,work:{capacity,used:usedWork/h,requested:requestedWork/h}};
}
