/** M04--M07/M10: headless and browser orchestration around one physical engine. */
import {makeConfig} from './config.mjs';
import {seedStreams,canonical,hashText,uniform} from './rng.mjs';
import {ledgerCheck} from './resources.mjs';
import {landUsed} from './infrastructure.mjs';
import {advanceState} from './dynamics.mjs';
import {validatePolicies} from './policies.mjs';
import {deploymentFunded} from './policy-funding.mjs';
import {ENGINE_VERSION,SOURCE_DIGEST} from './version.mjs';
import {validateCheckpointConsistency,validateCheckpointTrajectory} from './checkpoint-validation.mjs';
export {ENGINE_VERSION,SOURCE_DIGEST};
const normalized=overrides=>{const c=makeConfig(overrides);return {...c,policies:validatePolicies(c.policies,c.horizon)};};
// Shared import/export budgets: bound parsed collections as well as JSON text.
const checkpointCharacters=20e6,checkpointRecords=250000;
function checkCheckpointSize(run) {
 const collections=[run.state?.queue,run.state?.window,run.state?.events,run.state?.policyLog,run.trajectory];
 if(collections.reduce((count,items)=>count+(Array.isArray(items)?items.length:0),0)>checkpointRecords)
  throw new Error('Checkpoint structure exceeds the 250000-record limit');
}
function checkCheckpointText(serialized) {
 if(typeof serialized!=='string'||serialized.length>checkpointCharacters)
  throw new Error('Checkpoint must be JSON text within the 20-million-character limit');
}
function point(s) {
 return {t:s.t,H:s.H,B:s.B,Q:s.Q,active:s.active,G:s.G,F:s.F,aE:s.aE,aF:s.aF,sH:s.sH,
  support:s.support,landUsed:s.landUsed,energyResidual:s.energyResidual,infeasible:s.infeasible,
  queued:s.queue.length,...s.ledger};
}
export function createRun(overrides={}) {
 const c=normalized(overrides);
 const state={t:0,H:c.H0,B:c.B0,G:c.G0,F:c.F0,Q:c.Q0,aE:c.aE0,aF:c.aF0,
  active:0,support:c.H0>0?1:0,sH:1,queue:[],events:[],policyLog:[],rng:seedStreams(c.seed),traceProjects:true,
  shutdown:false,residual:1,policyFunding:c.policies.map(()=>0),shockYear:-1,shockFactor:1,belowYears:0,extinct:false,
  window:[],minPopulation:c.H0,minAdequacy:1,shortageYears:0,retired:0,nextProjectId:0,
  cumulativeBuildEnergy:0,landUsed:0,energyResidual:0,infeasible:false,stepDuration:0,
  ledger:{supply:0,human:0,operation:0,research:0,construction:0,industry:0,policy:0,unused:0}};
 const initial={...state,landUsed:landUsed(state,c)};
 return {engineVersion:ENGINE_VERSION,sourceDigest:SOURCE_DIGEST,configId:hashText(canonical(c)),config:c,state:initial,trajectory:[point(initial)],branchOf:null};
}
export function stepRun(run) {
 if(run.state.t>=run.config.horizon-1e-9)return run;
 const state=advanceState(run.state,run.config);
 return {...run,state,trajectory:[...run.trajectory,point(state)]};
}
export function simulate(input={},options={}) {
 let run=input.state&&input.config?input:createRun(input);let count=0;
 if(options.traceProjects===false)run={...run,state:{...run.state,traceProjects:false}};
 while(run.state.t<run.config.horizon-1e-9){
  run=options.recordTrajectory===false?{...run,state:advanceState(run.state,run.config)}:stepRun(run);
  if(++count>1e6)throw new Error('Step limit exceeded');
 }
 if(options.recordTrajectory===false)run={...run,trajectory:[run.trajectory[0],point(run.state)]};
 return run;
}
export function summarize(run) {
 const {state:s,config:c}=run;
 const start=Math.max(0,s.t-c.outcomeWindow);
 const weighted=s.window.map(p=>({...p,weight:Math.max(0,Math.min(p.dt,p.t-start))}));
 const total=weighted.reduce((a,p)=>a+p.weight,0);
 const mean=k=>total>0?weighted.reduce((a,p)=>a+p[k]*p.weight,0)/total:s[k==='s'?'sH':k];
 const meanPopulation=mean('H'),meanAdequacy=mean('s');
 const outcome=s.extinct?'extinction':meanPopulation<c.marginalPopulation*c.H0||meanAdequacy<c.marginalAdequacy?'marginal':'non-marginal';
 return {outcome,time:s.t,finalH:s.H,finalB:s.B,finalQ:s.Q,minPopulation:s.minPopulation,minAdequacy:s.minAdequacy,
  shortageYears:s.shortageYears,meanPopulation,meanAdequacy,finalAutonomyPower:s.aE,finalAutonomyFab:s.aF,
  configId:run.configId,seed:c.seed,engineVersion:run.engineVersion,sourceDigest:run.sourceDigest,
  definition:'Functional extinction is an absorbing model threshold; marginality uses trailing time-weighted means. Neither is a literal biological forecast.'};
}
export function saveCheckpoint(run) {
 checkCheckpointSize(run);
 const serialized=JSON.stringify({schema:'our-turn.checkpoint.v1',...run});
 checkCheckpointText(serialized);return serialized;
}
function checkState(s,c) {
 if(!s||!Array.isArray(s.queue)||!Array.isArray(s.window)||!Array.isArray(s.events)||!Array.isArray(s.policyLog))throw new Error('Incomplete checkpoint state');
 for(const k of ['t','H','B','G','F','Q','active','belowYears','retired','nextProjectId','cumulativeBuildEnergy','shortageYears','minPopulation'])
  if(!Number.isFinite(s[k])||s[k]<0)throw new Error(`Invalid checkpoint ${k}`);
 if(s.Q===0)throw new Error('Checkpoint capability Q must be positive');
 for(const k of ['aE','aF','sH','support','residual','shockFactor','minAdequacy'])if(!Number.isFinite(s[k])||s[k]<0||s[k]>1)throw new Error(`Invalid checkpoint ${k}`);
 if(s.t>c.horizon||typeof s.extinct!=='boolean'||typeof s.shutdown!=='boolean')throw new Error('Invalid checkpoint time/outcome');
 for(const k of ['environment','policy','parameters'])if(!Number.isInteger(s.rng?.[k])||s.rng[k]<0||s.rng[k]>0xffffffff)throw new Error('Invalid random-stream state');
 for(const p of s.queue)if(!['hardware','power','factory','powerAutomation','fabAutomation'].includes(p.kind)||!['id','amount','energy','land','due'].every(k=>Number.isFinite(p[k])&&p[k]>=0))throw new Error('Invalid project state');
 if(landUsed(s,c)>c.land+1e-6)throw new Error('Checkpoint overcommits land');
 for(const p of s.window)if(!['t','dt','H','s'].every(k=>Number.isFinite(p[k])&&p[k]>=0))throw new Error('Invalid outcome window');
 if(typeof s.traceProjects!=='boolean'||!Number.isFinite(s.energyResidual)||!Number.isFinite(s.stepDuration))throw new Error('Incomplete checkpoint trace/ledger');
 ledgerCheck(s.ledger);
 if(Math.abs(landUsed(s,c)-s.landUsed)>1e-6)throw new Error('Checkpoint land ledger mismatch');
 checkShockState(s,c);checkPolicyState(s,c);checkWindowState(s,c);
 validateCheckpointConsistency(s,c);
}
function checkShockState(s,c) {
 if(!Number.isInteger(s.shockYear)||s.shockYear< -1||s.shockYear>Math.floor(s.t+1e-9)||
  (s.t>0&&s.shockYear<Math.floor(s.t+1e-9)-1))throw new Error('Missing/invalid calendar shock state');
 let random=seedStreams(c.seed).environment,draw=null;
 for(let i=0;i<=s.shockYear;i++){draw=uniform(random);random=draw.state;}
 const factor=draw&&draw.value<c.shockProbability?1-c.shockMagnitude:1;
 if(s.rng.environment!==random||Math.abs(s.shockFactor-factor)>1e-12)throw new Error('Shock stream history mismatch');
}
function checkPolicyState(s,c) {
 if(!Array.isArray(s.policyFunding)||s.policyFunding.length!==c.policies.length||s.policyFunding.some((v,i)=>!Number.isFinite(v)||v<0||v>c.policies[i].cost+1e-9))throw new Error('Invalid deployment-work accounts');
 const seen=new Set();let random=seedStreams(c.seed).policy,shutdown=false,residual=1;
 for(const record of s.policyLog){
  const p=c.policies[record.index];
  if(!Number.isInteger(record.index)||!p||seen.has(record.index)||!Number.isFinite(record.t)||record.t< p.start+p.delay-1e-9||record.t>s.t+1e-9||!['success','failure'].includes(record.outcome)||!deploymentFunded(s.policyFunding[record.index],p.cost))throw new Error('Malformed policy attempt');
  seen.add(record.index);
  if(p.type==='shutdown'){
   const draw=uniform(random);random=draw.state;
   if(record.draw!==draw.value||record.outcome!==(draw.value<p.success?'success':'failure'))throw new Error('Policy draw history mismatch');
   if(record.outcome==='success'){shutdown=true;residual=Math.min(residual,p.residual);}
  }else if(record.outcome!=='success'||record.t>=p.start+p.delay+p.duration+1e-9)throw new Error('Malformed cap attempt');
 }
 if(s.rng.policy!==random||s.shutdown!==shutdown||s.residual!==residual)throw new Error('Policy state/history mismatch');
}
function checkWindowState(s,c) {
 if(s.t>0&&!s.window.length)throw new Error('Missing outcome window');
 const first=s.window[0],start=Math.max(0,s.t-c.outcomeWindow);
 if(first&&first.t-first.dt>start+1e-9)throw new Error('Incomplete trailing outcome history');
 for(let i=0;i<s.window.length;i++){
  const p=s.window[i],previous=s.window[i-1];
  if(Object.keys(p).some(k=>!['t','dt','H','s'].includes(k))||p.t>s.t+1e-9||p.dt<=0||p.dt>c.dt+1e-9||p.s>1||
   (previous&&Math.abs(p.t-previous.t-p.dt)>1e-8))throw new Error('Malformed outcome window');
 }
 const last=s.window.at(-1);
 if(last&&(Math.abs(last.t-s.t)>1e-9||last.H!==s.H||last.s!==s.sH))throw new Error('Outcome window does not end at saved state');
 const ids=s.queue.map(p=>p.id);
 if(new Set(ids).size!==ids.length||s.queue.some(p=>!Number.isInteger(p.id)||p.id>=s.nextProjectId||p.due<=s.t+1e-10))throw new Error('Duplicate or past-due project');
}
export function restoreCheckpoint(serialized) {
 checkCheckpointText(serialized);
 const run=JSON.parse(serialized);
 if(!run||typeof run!=='object')throw new Error('Checkpoint must contain an object');
 checkCheckpointSize(run);
 if(run.schema!=='our-turn.checkpoint.v1'||run.engineVersion!==ENGINE_VERSION||run.sourceDigest!==SOURCE_DIGEST)throw new Error('Checkpoint version/source mismatch');
 const c=normalized(run.config);
 if(hashText(canonical(c))!==run.configId)throw new Error('Checkpoint configuration ID mismatch');
 checkState(run.state,c);
 validateCheckpointTrajectory(run.trajectory,run.state,c);
 const {schema,...rest}=run;return {...rest,config:c};
}
export function branchRun(run,policy) {
 if(policy.start<run.state.t-1e-9)throw new Error('Branch action must start at or after checkpoint time');
 const config=normalized({...run.config,policies:[...run.config.policies,policy]});
 const clone=structuredClone(run);
 return {...clone,state:{...clone.state,policyFunding:[...clone.state.policyFunding,0]},config,configId:hashText(canonical(config)),branchOf:{configId:run.configId,t:run.state.t}};
}
export function trajectoryCSV(run) {
 const keys=Object.keys(run.trajectory[0]);
 return keys.join(',')+'\n'+run.trajectory.map(row=>keys.map(k=>row[k]).join(',')).join('\n')+'\n';
}
