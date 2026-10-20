import {makeConfig} from '../sim/config.mjs';
import {validatePolicies} from '../sim/policies.mjs';
import {deploymentFunded} from '../sim/policy-funding.mjs';
import {canonical,seedStreams,uniform} from '../sim/rng.mjs';
import {ledgerCheck} from '../sim/resources.mjs';
import {landUsed} from '../sim/infrastructure.mjs';
import {LIMITS,KINDS,plain,bounded,keysOnly,normalizeOptions,normalizeLinks,normalizeRegionMetadata} from './config.mjs';
import {historyPoint} from './observe.mjs';
import {validateEventState} from './events.mjs';

const near=(a,b)=>Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
function requireThat(condition,message) {if(!condition)throw new Error(`Invalid world checkpoint: ${message}`);}
function array(value,name,limit=LIMITS.items) {
 requireThat(Array.isArray(value)&&value.length<=limit,name);return value;
}
function checkPolicyState(s,c) {
 array(s.policyFunding,'policy funding',64);array(s.policyLog,'policy log',64);
 requireThat(s.policyFunding.length===c.policies.length,'policy funding length');
 s.policyFunding.forEach((v,i)=>bounded(v,'funding',0,c.policies[i].cost+1e-8));
 let random=seedStreams(c.seed).policy,shutdown=false,residual=1;const seen=new Set();
 for(const p of s.policyLog){
  const policy=c.policies[p.index];
  requireThat(Number.isInteger(p.index)&&policy&&!seen.has(p.index),'policy identity');seen.add(p.index);
  bounded(p.t,'policy time',policy.start+policy.delay-1e-9,s.t+1e-9);
  requireThat(deploymentFunded(s.policyFunding[p.index],policy.cost),'unfunded attempt');
  if(policy.type==='shutdown'){
   const draw=uniform(random);random=draw.state;
   requireThat(p.draw===draw.value&&p.outcome===(draw.value<policy.success?'success':'failure'),'policy RNG history');
   if(p.outcome==='success'){shutdown=true;residual=Math.min(residual,policy.residual);}
  }else requireThat(p.outcome==='success'&&p.t<policy.start+policy.delay+policy.duration+1e-9,'cap attempt');
 }
 requireThat(s.rng.policy===random&&s.shutdown===shutdown&&s.residual===residual,'policy state');
}
function checkShockState(s,c) {
 requireThat(Number.isInteger(s.shockYear)&&s.shockYear>=-1&&s.shockYear<=Math.floor(s.t+1e-9),'shock year');
 requireThat(s.t===0?s.shockYear===-1:s.shockYear>=Math.floor(s.t+1e-9)-1,'shock continuity');
 let random=seedStreams(c.seed).environment,draw;
 for(let year=0;year<=s.shockYear;year++){draw=uniform(random);random=draw.state;}
 const factor=draw&&draw.value<c.shockProbability?1-c.shockMagnitude:1;
 requireThat(s.rng.environment===random&&s.shockFactor===factor,'shock stream');
}
function checkProjects(s,c) {
 const seen=new Set();
 const delays={hardware:c.hardwareDelay,power:c.powerDelay,factory:c.fabDelay,powerAutomation:c.automationDelay,fabAutomation:c.automationDelay};
 for(const p of array(s.queue,'queue')){
  requireThat(KINDS.includes(p.kind)&&Number.isSafeInteger(p.id)&&p.id>=0&&p.id<s.nextProjectId&&!seen.has(p.id),'project identity');seen.add(p.id);
  for(const k of ['amount','energy','land','requestedDue','due'])bounded(p[k],`project ${k}`);
  const orderedAt=p.requestedDue-delays[p.kind],timeTolerance=8*Number.EPSILON*Math.max(1,s.t,p.requestedDue);
  requireThat(orderedAt>=-timeTolerance&&orderedAt<=s.t+timeTolerance,'project order time');
  const due=Math.ceil(p.requestedDue/c.dt-1e-8)*c.dt;
  requireThat(p.amount>0&&p.due>s.t+1e-10&&Math.abs(p.due-due)<=8*Number.EPSILON*Math.max(1,due),'project commissioning');
  const energy={hardware:c.embodiedBlock,power:c.embodiedPower,factory:c.embodiedFab,powerAutomation:c.automationEnergy,fabAutomation:c.automationEnergy};
  const land={hardware:c.landBlock,power:c.landPower,factory:c.landFab,powerAutomation:0,fabAutomation:0};
  requireThat(near(p.energy,p.amount*energy[p.kind])&&near(p.land,p.amount*land[p.kind]),'project prepaid accounts');
 }
 const used=landUsed(s,c);requireThat(used<=c.land+1e-6&&near(used,s.landUsed),'land ledger');
 const pending=kind=>s.queue.filter(p=>p.kind===kind).reduce((a,p)=>a+p.amount,0);
 requireThat(s.aE+pending('powerAutomation')<=1+1e-8&&s.aF+pending('fabAutomation')<=1+1e-8,'automation bounds');
}
function checkConstruction(r,config) {
 const s=r.state,c=r.config,weights=config.workWeights,last=s.lastConstruction;
 for(const k of ['commissionedBuildEnergy','commissionedBuildWork','cumulativeBuildWork'])bounded(s[k],k);
 const queuedEnergy=s.queue.reduce((a,p)=>a+p.energy,0),queuedWork=s.queue.reduce((a,p)=>a+p.amount*weights[p.kind],0);
 requireThat(near(s.cumulativeBuildEnergy,s.commissionedBuildEnergy+queuedEnergy),'cumulative prepaid energy');
 requireThat(near(s.cumulativeBuildWork,s.commissionedBuildWork+queuedWork),'cumulative prepaid work');
 plain(last,'construction receipt');plain(last.amounts,'construction receipt amounts');
 for(const k of ['start','dt','energy','work'])bounded(last[k],`receipt ${k}`);
 requireThat(near(last.start+last.dt,s.t)&&last.dt===s.stepDuration,'construction receipt interval');
 const energy={hardware:c.embodiedBlock,power:c.embodiedPower,factory:c.embodiedFab,powerAutomation:c.automationEnergy,fabAutomation:c.automationEnergy};
 const amounts=s.commissionedAmounts;plain(amounts,'commissioned amounts');
 for(const kind of KINDS)bounded(amounts[kind],`commissioned ${kind}`);
 requireThat(near(s.commissionedBuildEnergy,KINDS.reduce((a,k)=>a+amounts[k]*energy[k],0))&&
  near(s.commissionedBuildWork,KINDS.reduce((a,k)=>a+amounts[k]*weights[k],0)),'commissioned paid quantities');
 requireThat(near(s.B+s.retired,c.B0+amounts.hardware)&&near(s.G,c.G0+amounts.power)&&near(s.F,c.F0+amounts.factory)&&
  near(s.aE,Math.min(1,c.aE0+amounts.powerAutomation))&&near(s.aF,Math.min(1,c.aF0+amounts.fabAutomation)),'installed commissioned stocks');
 for(const kind of KINDS)bounded(last.amounts[kind],`receipt ${kind}`);
 requireThat(near(last.energy,KINDS.reduce((a,k)=>a+last.amounts[k]*energy[k],0))&&
  near(last.work,KINDS.reduce((a,k)=>a+last.amounts[k]*weights[k],0)),'construction receipt quantities');
 requireThat(near(last.energy,s.ledger.construction*last.dt)&&near(last.work,r.work.used*last.dt),'construction paid interval accounts');
 requireThat(last.energy<=s.cumulativeBuildEnergy+1e-8&&last.work<=s.cumulativeBuildWork+1e-8,'construction cumulative bounds');
}
function checkState(r,t,worldConfig) {
 const s=r.state,c=r.config;plain(s,'state');requireThat(s.t===t,'synchronized regional time');
 for(const k of ['t','H','B','G','F','active','belowYears','retired','nextProjectId','cumulativeBuildEnergy','shortageYears','minPopulation','landUsed','stepDuration'])bounded(s[k],k);
 bounded(s.Q,'Q',Number.MIN_VALUE);bounded(s.stepDuration,'stepDuration',0,c.dt+1e-8);
 for(const k of ['aE','aF','support','sH','residual','shockFactor','minAdequacy'])bounded(s[k],k,0,1);
 requireThat(Number.isSafeInteger(s.nextProjectId)&&s.nextProjectId<=Number.MAX_SAFE_INTEGER-KINDS.length,'project counter headroom');
 requireThat(typeof s.extinct==='boolean'&&typeof s.shutdown==='boolean'&&s.traceProjects===false&&typeof s.infeasible==='boolean','state flags');
 requireThat(!s.extinct||s.H===0,'absorbing extinction');
 requireThat(s.belowYears<=t+1e-9&&!(s.belowYears+1e-9>=c.extinctionWindow&&!s.extinct),'extinction duration');
 requireThat(s.H<c.extinctionPopulation||s.belowYears===0,'extinction counter/population');
 for(const k of ['environment','policy','parameters'])requireThat(Number.isInteger(s.rng?.[k])&&s.rng[k]>=0&&s.rng[k]<=0xffffffff,'RNG state');
 requireThat(s.rng.parameters===seedStreams(c.seed).parameters,'parameter RNG');
 checkProjects(s,c);checkPolicyState(s,c);checkShockState(s,c);array(s.events,'events');
 const window=array(s.window,'outcome window');requireThat(t===0||window.length>0,'missing outcome history');
 window.forEach((p,i)=>{
  plain(p,'outcome window');keysOnly(p,['t','dt','H','s'],'outcome window');
  bounded(p.t,'window t',0,t+1e-8);bounded(p.dt,'window dt',Number.MIN_VALUE,c.dt+1e-8);
  bounded(p.H,'window H');bounded(p.s,'window adequacy',0,1);
  if(i)requireThat(near(p.t-window[i-1].t,p.dt),'outcome continuity');
 });
 if(window.length){
  const last=window.at(-1);requireThat(last.t===t&&last.H===s.H&&last.s===s.sH,'outcome endpoint');
  requireThat(window[0].t-window[0].dt<=Math.max(0,t-c.outcomeWindow)+1e-8,'outcome coverage');
 }
 // The shared ledger check supplies the integration tolerance at this supply.
 const energyResidual=ledgerCheck(s.ledger);
 requireThat(Number.isFinite(s.energyResidual)&&s.energyResidual===energyResidual,'energy residual');
 for(const k of ['rawPower','deliveredPower','imports','exports','reserve'])bounded(r.power?.[k],`power ${k}`);
 requireThat(r.power.deliveredPower===Math.max(0,r.power.rawPower+(r.power.imports-r.power.exports)),'power balance');
 if(t>0)requireThat(near(s.ledger.supply,r.power.deliveredPower),'delivered ledger');
 for(const k of ['capacity','used','requested'])bounded(r.work?.[k],`work ${k}`);
 requireThat(r.work.used<=r.work.requested+1e-8,'requested work');
 checkConstruction(r,worldConfig);validateEventState(s,worldConfig,c.seed);
}
function checkLinks(w) {
 normalizeLinks(w.links.map(({flow,...l})=>l),w.regions);
 const balance=new Map(w.regions.map(r=>[r.id,{imports:0,exports:0}]));
 for(const l of w.links){
  bounded(l.flow,'link flow',-l.capacity*w.config.gridScale-1e-8,l.capacity*w.config.gridScale+1e-8);
  const from=balance.get(l.from),to=balance.get(l.to);
  if(l.flow>=0){from.exports+=l.flow;to.imports+=l.flow;}else{from.imports-=l.flow;to.exports-=l.flow;}
 }
 for(const r of w.regions){
  const b=balance.get(r.id);requireThat(near(b.imports,r.power.imports)&&near(b.exports,r.power.exports),'link/node balance');
  requireThat(w.config.unlimitedWork||r.work.used<=r.work.capacity+1e-8,'work capacity');
  const net=r.power.imports-r.power.exports;
  requireThat(net<=Math.max(0,r.power.reserve-r.power.rawPower)+1e-8&&-net<=Math.max(0,r.power.rawPower-r.power.reserve)+1e-8,'reserve-first transfers');
 }
}
export function validateCheckpoint(w,pin) {
 plain(w,'checkpoint');for(const k of ['schema','spatialVersion','sourceDigest','baselineVersion','baselineSourceDigest'])requireThat(w[k]===pin[k],`${k} mismatch`);
 plain(w.config,'world config');const normalized=normalizeOptions(w.config);
 requireThat(canonical(w.config)===canonical(normalized.config),'world config normalization');
 bounded(w.t,'world time',0,w.config.horizon);
 array(w.regions,'regions',LIMITS.regions);requireThat(w.regions.length>0,'empty regions');
 requireThat(new Set(w.regions.map(r=>r.id)).size===w.regions.length,'region IDs');
 for(const [index,r] of w.regions.entries()){
  const metadata=normalizeRegionMetadata(r,index);
  requireThat(Object.entries(metadata).every(([key,value])=>r[key]===value),'normalized regional metadata');
  const c=makeConfig(r.config);validatePolicies(c.policies,c.horizon);
  requireThat(canonical(c)===canonical(r.config),'complete normalized regional config');
  requireThat(c.dt===w.config.dt&&c.horizon===w.config.horizon&&c.alignment===w.config.alignment,'regional config agreement');checkState(r,w.t,w.config);
 }
 requireThat(w.configId===pin.configurationId(w),'configuration ID');array(w.links,'links',LIMITS.links);checkLinks(w);
 const history=array(w.history,'history',LIMITS.history);requireThat(history.length>0&&history[0].t===0,'history origin');
 // Each recorded substep can request at most one project of each kind.
 for(const r of w.regions)requireThat(r.state.nextProjectId<=KINDS.length*(history.length-1),'project counter history');
 history.forEach((p,i)=>{
  for(const k of ['t','H','B','Q'])bounded(p[k],`history ${k}`);
  for(const k of ['sH','minAdequacy'])bounded(p[k],`history ${k}`,0,1);
  requireThat(p.t<=w.t+1e-9&&(!i||p.t>history[i-1].t&&p.t-history[i-1].t<=w.config.dt+1e-8),'history continuity');
 });
 requireThat(canonical(history.at(-1))===canonical(historyPoint(w)),'history endpoint');
 if(w.t>0)requireThat(near(w.t-history.at(-2)?.t,w.regions[0].state.stepDuration)&&
  w.regions.every(r=>r.state.stepDuration===w.regions[0].state.stepDuration),'common history interval');
 const actions=array(w.actions,'actions',64);
 requireThat(actions.length===w.regions.reduce((a,r)=>a+r.config.policies.length,0),'action count');
 for(const action of actions){
  const r=w.regions.find(r=>r.id===action.regionId);requireThat(r,'action region');bounded(action.addedAt,'action branch time',0,w.t);
  const {regionId,addedAt,...policy}=action;validatePolicies([policy],w.config.horizon);
  requireThat(policy.start>=addedAt-1e-9&&r.config.policies.some(p=>canonical(p)===canonical(policy)),'action/config consistency');
 }
 if(w.branchOf!==null){plain(w.branchOf,'branch provenance');bounded(w.branchOf.t,'branch time',0,w.t);requireThat(typeof w.branchOf.configId==='string','branch ID');}
}
