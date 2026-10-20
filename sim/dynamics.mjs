import {allocatePool,adequacy,populationStep,clamp01,ledgerCheck} from './resources.mjs';
import {supportFactor,landUsed,settleProjects} from './infrastructure.mjs';
import {uniform} from './rng.mjs';
import {applyFundedPolicies,fundingDuration,fundDeployment} from './policy-funding.mjs';
import {capabilityStep} from './capability.mjs';

export function reserveFraction(c) {return c.reserveRule==='convex'?c.alignment**2:c.alignment;}
function updateEnvironment(s,c) {
 const year=Math.floor(s.t+1e-9);
 if(year===s.shockYear)return s;
 const draw=uniform(s.rng.environment);const shock=draw.value<c.shockProbability;
 return {...s,shockYear:year,shockFactor:shock?1-c.shockMagnitude:1,rng:{...s.rng,environment:draw.state},
  events:shock?[...s.events,{t:s.t,type:'supply-shock',factor:1-c.shockMagnitude}]:s.events};
}
export function nextDuration(s,c) {
 const grid=(Math.floor(s.t/c.dt+1e-8)+1)*c.dt;
 const future=[c.horizon,grid,Math.floor(s.t+1e-9)+1,...s.queue.map(p=>p.due),
  ...c.policies.flatMap(p=>[p.start+p.delay,p.start+p.delay+(p.duration??c.horizon+1)])].filter(t=>t>s.t+1e-9);
 return Math.min(c.dt,...future.map(t=>t-s.t));
}
function desiredProjects(s,c,h,cap) {
 if(s.shutdown||s.B===0)return [];
 const pending=kind=>s.queue.filter(p=>p.kind===kind).reduce((a,p)=>a+p.amount,0);
 const desiredHardware=Math.min(s.B*c.hardwareGrowth*Math.pow(s.Q,.2)*h,c.materials*h,Math.max(0,cap-s.B-pending('hardware')));
 const fabrication=s.F*supportFactor(s.aF,s.support);
 const hardware=Math.min(desiredHardware,fabrication*h);
 const factoryPressure=c.factoryRule==='persistent'?1:clamp01(desiredHardware/Math.max(1e-12,fabrication*h)-1);
 const items=[
  ['hardware',hardware,c.embodiedBlock,c.landBlock,c.hardwareDelay],
  ['power',s.G*c.powerGrowth*h,c.embodiedPower,c.landPower,c.powerDelay],
  ['factory',s.F*c.fabGrowth*h*factoryPressure,c.embodiedFab,c.landFab,c.fabDelay],
  ['powerAutomation',Math.min(c.automationRate*s.Q/(s.Q+1)*h,Math.max(0,1-s.aE-pending('powerAutomation'))),c.automationEnergy,0,c.automationDelay],
  ['fabAutomation',Math.min(c.automationRate*s.Q/(s.Q+1)*h,Math.max(0,1-s.aF-pending('fabAutomation'))),c.automationEnergy,0,c.automationDelay],
 ];
 return items.filter(([,amount])=>amount>1e-12).map(([kind,amount,energyPer,landPer,delay])=>({kind,amount,energy:amount*energyPer,land:amount*landPer,
  requestedDue:s.t+delay,due:Math.ceil((s.t+delay)/c.dt-1e-8)*c.dt}));
}
function finishPopulation(s,c,h,sH) {
 const candidate=populationStep(s.H,sH,c,h);
 const belowYears=candidate<c.extinctionPopulation?s.belowYears+h:0;
 const extinct=s.extinct||belowYears+1e-9>=c.extinctionWindow;
 const H=extinct?0:candidate;
 const targetSupport=clamp01((c.H0>0?H/c.H0:0)*Math.pow(sH,c.supportExponent));
 const support=c.supportTime===0?targetSupport:targetSupport+(s.support-targetSupport)*Math.exp(-h/c.supportTime);
 const window=[...s.window,{t:s.t+h,dt:h,H,s:sH}].filter(p=>p.t>s.t+h-c.outcomeWindow-1e-10);
 return {H,belowYears,extinct,window,minPopulation:Math.min(s.minPopulation,H),minAdequacy:Math.min(s.minAdequacy,sH),
  shortageYears:s.shortageYears+(sH<.999?h:0),support:clamp01(support)};
}
export function advanceState(previous,c) {
 let s=updateEnvironment(settleProjects(previous),c);
 const activated=applyFundedPolicies(s,c);s=activated.state;
 const safeH=Math.max(c.H0,s.H);
 const reserveE=reserveFraction(c)*c.humanEnergy*safeH;
 const reserveL=reserveFraction(c)*c.humanLand*safeH;
 const supply=s.G*supportFactor(s.aE,s.support)*s.shockFactor;
 const landBefore=landUsed(s,c);
 const infeasible=reserveE>supply+1e-9||reserveL>c.land-landBefore+1e-9;
 const policyFlow=Math.max(0,supply-reserveE);
 const h=Math.min(nextDuration(s,c),fundingDuration(s,c,policyFlow));
 const funding=fundDeployment(s,c,policyFlow*h);s=funding.state;
 const policy={cost:funding.cost,capBlocks:activated.capBlocks};
 const ethicalOrSupport=Math.max(reserveE,c.dependencyReserve*(1-Math.max(s.aE,s.aF))*c.humanEnergy*s.H);
 const plans=infeasible?[]:desiredProjects(s,c,h,policy.capBlocks);
 const plannedEnergy=plans.reduce((a,p)=>a+p.energy,0);
 const plannedLand=plans.reduce((a,p)=>a+p.land,0);
 const perBlock=c.energyBlock*(c.idleFraction+(1-c.idleFraction)*c.utilization);
 const targetBlocks=infeasible?0:Math.min(s.B,policy.capBlocks)*s.residual;
 const operating=targetBlocks*perBlock;
 const industry=infeasible||s.shutdown||s.B===0?0:c.industryEnergy*supply;
 const demandA=operating+industry+plannedEnergy/h;
 const needH=c.humanEnergy*s.H;
 const energy=allocatePool({supply:Math.max(0,supply-policy.cost/h),needH,needA:demandA,
  claimH:needH,claimA:demandA*Math.pow(s.Q,c.competition),reserve:Math.min(Math.max(0,supply-policy.cost/h),ethicalOrSupport)});
 const fraction=demandA>0?energy.other/demandA:0;
 const space=Math.max(0,c.land-landBefore-reserveL);
 const constructionFraction=Math.min(fraction,plannedLand>0?space/plannedLand:1);
 const booked=plans.map((p,i)=>({...p,id:s.nextProjectId+i,amount:p.amount*constructionFraction,energy:p.energy*constructionFraction,land:p.land*constructionFraction})).filter(p=>p.amount>1e-12);
 const buildEnergy=booked.reduce((a,p)=>a+p.energy,0);
 const actualOperating=operating*fraction,actualIndustry=industry*fraction;
 const unusedAI=Math.max(0,energy.other-actualOperating-actualIndustry-buildEnergy/h);
 const returnedHuman=Math.min(Math.max(0,needH-energy.human),unusedAI);
 const human=energy.human+returnedHuman;
 const unused=energy.unused+unusedAI-returnedHuman;
 const afterLand=landBefore+booked.reduce((a,p)=>a+p.land,0);
 const humanLand=Math.min(c.humanLand*s.H,Math.max(0,c.land-afterLand));
 const sH=adequacy([human,humanLand],[needH,c.humanLand*s.H]);
 const active=perBlock>0?actualOperating/perBlock:0;
 const Q=capabilityStep(s.Q,active*c.utilization*c.rdShare,c,h);
 const retired=s.B*(1-Math.exp(-h/c.lifetime));
 const ledger={supply,human,operation:actualOperating*(1-c.rdShare),research:actualOperating*c.rdShare,
  construction:buildEnergy/h,industry:actualIndustry,policy:policy.cost/h,unused};
 const energyResidual=ledgerCheck(ledger);
 const next={...s,...finishPopulation(s,c,h,sH),t:s.t+h,B:s.B-retired,Q,active,
  retired:s.retired+retired,queue:[...s.queue,...booked],nextProjectId:s.nextProjectId+plans.length,
  events:s.traceProjects===false?s.events:[...s.events,...booked.map(p=>({t:s.t,type:'ordered',project:p.id,kind:p.kind,amount:p.amount,due:p.due}))],
  sH,ledger,energyResidual,infeasible,landUsed:afterLand-retired*c.landBlock,
  cumulativeBuildEnergy:s.cumulativeBuildEnergy+buildEnergy,stepDuration:h};
 const result=applyFundedPolicies(settleProjects(next),c).state;
 if(landUsed(result,c)>c.land+1e-6)throw new Error('Committed land exceeds supply');
 for(const k of ['H','B','Q','G','F'])if(!Number.isFinite(result[k])||result[k]<0)throw new Error(`Invalid stock ${k}`);
 return result;
}
