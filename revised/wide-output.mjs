/** [DOM-VECTOR-2] Explicit reconstructed output dictionary for Suggested edits.pdf.
 * The referenced 91-entry CSV and format PDF were not supplied. This fixed schema
 * covers the named groups without claiming to reproduce those absent files.
 */
import {outputVector} from './analysis.mjs';
import {configurationId} from './identity.mjs';

export const WIDE_OUTPUT_SCHEMA='mcm.wide-output.v1';
export const WIDE_DICTIONARY_PROVENANCE=Object.freeze({schema:WIDE_OUTPUT_SCHEMA,
 classification:'Explicit reconstruction from Suggested edits.pdf; not the absent 91-entry companion dictionary.',
 qSnapshotYears:Object.freeze([10,20,30,40,50,60,70,80,90,100]),
 energySnapshotYears:Object.freeze([10,25,50,75,100]),
 snapshots:'Q uses piecewise-linear interpolation within recorded endpoint observations. Energy shares use the actual interval containing the snapshot; neither extrapolates beyond observed time.'});
export const DEFAULT_FLAG_THRESHOLDS=Object.freeze({landInertFraction:.01,unusedLargeShare:.3,
 factoryGrowthRatio:1000,frozenSupplyRelativeTolerance:1e-8,qGrowthRatio:1.1,
 physicalRelativeTolerance:1e-8,floorRelativeTolerance:1e-9,priorityChatterFlipsPerYear:4});

const accounts=Object.freeze({human_critical:'humanCritical',human_flexible:'humanFlexible',operation:'operation',
 maintenance:'maintenance',construction:'construction',policy:'policy',extraction:'extraction',storage_charge:'storageCharge',unused:'unused'});
const flags=Object.freeze({
 land_inert:'Observed peak asset footprint below the declared land-fraction threshold and no logged service-land deficit; not a causal land-intervention claim.',
 unused_large:'Cumulative unused electricity divided by cumulative available electricity exceeds the declared share.',
 factory_runaway:'Peak effective factory-work capacity divided by positive initial factory-work capacity exceeds the declared growth ratio; not a count of plants.',
 extinction_unreachable:'Unassessed: a finite trajectory cannot establish general extinction or operational-collapse unreachability.',
 frozen_human_supply:'Observed delivered human annual electricity rate is constant within the declared tolerance over at least two intervals; not a structural causal claim.',
 q_without_physical_effect:'Observed Q growth exceeds its threshold while measured power, hardware, factory work and effective compute do not increase; not a causal zero-effect claim.',
 floor_is_reserve:'At least one measured interval has human delivery equal to the explicitly logged protected energy reserve; this is not a population clamp.',
 label_disagrees:'A supplied outcome label differs from an independently supplied or recomputed outcome using the existing final-population/minimum-adequacy rule.',
 priority_chatter:'Observed priority-lead flips per observed priority year exceed the declared threshold.'});
const entry=(name,unit,definition)=>Object.freeze({name,unit,definition});
const baseDictionary=[
 ['run_id','identifier','Unique run identity; joins the separate input and optional trajectory tables.'],
 ['config_id','identifier','Normalized engine configuration identity.'],
 ['engine_version','version','Engine version that executed this row.'],
 ['source_digest','sha256','Executed model source digest; different digests cannot be pooled.'],
 ['seed','integer','Declared deterministic random seed.'],['status','enum','ok or failed; failures retain their row.'],
 ['fail_reason','text','Failure reason; null for a successful run.'],['run_time','year','Last observed model time.'],
 ['human_population_final','million people','Final human population.'],['human_population_min','million people','Exact integrated and observed population minimum.'],
 ['human_population_max','million people','Exact integrated and observed population maximum.'],
 ['human_qol_final','index','Final measured interval quality of life; initial synthetic values excluded.'],
 ['human_qol_min','index','Minimum measured interval quality of life.'],['human_qol_max','index','Maximum measured interval quality of life.'],
 ['human_qol_person_years','million quality-adjusted person-years','Integrated QoL-weighted person-years.'],
 ['human_kwh_person_final','kWh/person/year','Final measured annual per-person electricity delivery.'],
 ['human_kwh_person_mean','kWh/person/year','Cumulative delivered human TWh divided by million person-years, multiplied by 1000.'],
 ['human_owned_power_final','TWh/year','Final recorded human-owned source-power capacity, separate from delivered human electricity.'],
 ['human_starvation_episodes','episodes','Critical-service-deficit episode proxy; not an empirical famine count.'],
 ['human_additional_deaths','million people','Modeled deprivation-related additional deaths; separate from baseline net growth.'],
 ['human_outcome','enum','Existing functional-collapse / critical-service-shortfall / critical-services-maintained label.'],
 ['human_welfare_outcome','enum','Separate final QoL/MEM label; a different welfare label is not a label disagreement.'],
 ['rsi_q_final','reference capability index','Final Q, distinct from actual effective compute.'],
 ['rsi_q_over_100_t','year','First recorded endpoint with Q strictly above 100; null if never observed.'],
 ['rsi_blocks_final','rated MW blocks','Final surviving rated hardware stock from the recorded physical snapshot; not efficiency-weighted compute.'],
 ['rsi_blocks_peak','rated MW blocks','Peak recorded surviving rated hardware stock.'],
 ['rsi_compute_final','benchmark-equivalent utilised MW blocks','Final actual interval effective compute.'],
 ['rsi_compute_peak','benchmark-equivalent utilised MW blocks','Peak actual interval effective compute.'],
 ['rsi_factory_work_final','work units/year','Final recorded effective factory-work capacity.'],
 ['rsi_factory_work_peak','work units/year','Peak recorded effective factory-work capacity.'],
 ['rsi_material_hardware_cap','rated MW blocks','Free final material divided by hardware material cost; an upper bound ignoring all other constraints.'],
 ['rsi_autonomy_half_t','year','First recorded endpoint with autonomous work at least half of positive factory-work capacity; null without evidence.'],
 ['rsi_autonomy_full_t','year','First recorded endpoint with autonomous work at least all positive factory-work capacity; null without evidence.'],
 ['energy_available_cumulative','TWh','Sum of actual interval available energy.'],
 ['energy_unused_share','fraction','Total unused / total available electricity, not an unweighted mean of interval shares.'],
 ['energy_construction_share_peak','fraction','Peak actual interval construction/available-energy share.'],
 ['energy_ledger_residual_max','TWh','Maximum absolute available-minus-all-debits residual across fully logged intervals.'],
 ['land_fraction_peak','fraction','Peak recorded occupied plus committed asset footprint / declared land.'],
 ['land_binding_years','year','Duration with logged service-land adequacy below 1, or explicit land constraint.'],
 ['land_queue_peak','projects','Peak explicitly recorded pending-project count; null when not logged.'],
 ['land_ai_final','km2','Final occupied plus committed AI-owned asset footprint.'],
 ['land_human_final','km2','Final occupied plus committed human-owned asset footprint.'],
 ['policy_shutdown_attempts','attempts','Count of attempted shutdown actions across archived/current policies.'],
 ['policy_shutdown_successes','actions','Count of attempted shutdown actions that activated.'],
 ['policy_cap_years','year','Union duration of activated cap actions, clipped to the observation horizon.'],
 ['numerics_step_count','intervals','Count of actual measured executor ledger intervals.'],
 ['numerics_dt_max','year','Configured maximum interval; event boundaries can produce finer actual intervals.'],
 ['numerics_refinement_run_id','identifier','Actual successful finer-run identity; null without a verified refinement comparison.'],
 ['numerics_refinement_population_difference','million people','Finer minus coarse final population, verified same config except smaller dt.'],
 ['numerics_refinement_q_difference','reference capability index','Finer minus coarse final Q.'],
 ['numerics_refinement_qol_difference','index','Finer minus coarse final QoL.'],
 ['numerics_refinement_compute_difference','benchmark-equivalent utilised MW blocks','Finer minus coarse final effective compute.'],
 ['numerics_refinement_welfare_difference','million quality-adjusted person-years','Finer minus coarse integrated welfare.'],
 ['pair_baseline_id','identifier','One explicitly requested baseline; multiple baseline mappings remain separate comparison rows.'],
 ['pair_status','enum','ok or unavailable for the explicitly requested contrast.'],
 ['pair_kind','enum','switch for one verified declared switch; parameter for a numeric/config contrast without a switch flip.'],
 ['pair_reason','text','Reason a requested comparison is unavailable.'],
 ['delta_qol_person_years','million quality-adjusted person-years','Run minus baseline integrated welfare.'],
 ['delta_population_final','million people','Run minus baseline final population.'],
 ['delta_q_final','reference capability index','Run minus baseline final Q.'],
 ['delta_construction_energy','TWh','Run minus baseline cumulative construction energy.'],
 ['pri_takeover_t','year','First observed interval start with AI share of contested allocation above 0.5; null if never.'],
 ['pri_flip_count','flips','Committed hysteretic lead-side changes recorded by the executor across observed positive-pool intervals.'],
 ['pri_ai_share_mean','fraction','Duration-weighted realized AI contested allocation share across explicitly observed positive-pool intervals.'],
 ['pri_ai_share_nominal_mean','fraction','Duration-weighted nominal AI contested target share, separately from realized need-capped allocations.'],
 ['pri_observed_years','year','Total duration of positive contested-pool intervals with explicit priority observations.'],
 ['pri_ai_years','year','Duration with committed hysteretic AI leader on explicitly observed positive-pool intervals.'],
 ['pri_floor_years','year','Duration human delivery equalled explicitly logged reserve under the declared tolerance; executor floor booleans are used only at their documented default tolerance when numeric evidence is absent.']
];
export const WIDE_OUTPUT_DICTIONARY=Object.freeze([
 ...baseDictionary.map(x=>entry(...x)),
 ...WIDE_DICTIONARY_PROVENANCE.qSnapshotYears.map(t=>entry(`rsi_q_t${t}`,'reference capability index',`Q at year ${t}; piecewise-linear interpolation within recorded observations only.`)),
 ...Object.keys(accounts).map(k=>entry(`energy_${k}_cumulative`,'TWh',`Cumulative actual ${k.replaceAll('_',' ')} energy debit; null if incompletely logged.`)),
 ...WIDE_DICTIONARY_PROVENANCE.energySnapshotYears.flatMap(t=>Object.keys(accounts).map(k=>entry(`energy_${k}_share_t${t}`,'fraction',`Actual ${k.replaceAll('_',' ')} / available energy in the interval containing year ${t}.`))),
 ...Object.entries(flags).flatMap(([name,definition])=>[entry(`flag_${name}`,'boolean or null',definition),entry(`flag_${name}_assessed`,'boolean','True only when all evidence required by this declared diagnostic test was available.')]),
 ...Object.keys(DEFAULT_FLAG_THRESHOLDS).map(k=>entry(`threshold_${k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())}`,
  k==='priorityChatterFlipsPerYear'?'flips/year':k.endsWith('Ratio')?'dimensionless ratio':'fraction',
  `Exact ${k} setting used for this row; illustrative diagnostic screen, not an empirically fitted constant.`))
]);
export const WIDE_OUTPUT_COLUMNS=Object.freeze(WIDE_OUTPUT_DICTIONARY.map(x=>x.name));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const sum=xs=>xs.reduce((s,x)=>s+x,0);
const extrema=(rows,key,kind)=>rows.reduce((value,r)=>!finite(r[key])?value:value===null?r[key]:kind==='min'?Math.min(value,r[key]):Math.max(value,r[key]),null);
const text=(x,name)=>{if(typeof x!=='string'||!x.trim()||x.length>1000)throw new TypeError(`${name} must be nonempty text`);return x;};
const initialRow=()=>Object.fromEntries(WIDE_OUTPUT_COLUMNS.map(k=>[k,k.startsWith('flag_')&&k.endsWith('_assessed')?false:null]));
const measured=run=>run.state.history.filter(r=>r.ledger&&finite(r.ledger.start)&&finite(r.ledger.end)&&r.ledger.end>r.ledger.start);
const duration=r=>r.ledger.end-r.ledger.start;
const quantity=(rows,key)=>rows.length&&rows.every(r=>finite(r.ledger[key]))?sum(rows.map(r=>r.ledger[key])):null;
const ratio=(a,b)=>finite(a)&&finite(b)&&b>0?a/b:null;
const snake=k=>k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());

function thresholds(options={}){
 for(const [k,v] of Object.entries(options))if(!Object.hasOwn(DEFAULT_FLAG_THRESHOLDS,k)||!finite(v)||v<0)throw new RangeError(`Invalid diagnostic threshold ${k}`);
 return {...DEFAULT_FLAG_THRESHOLDS,...options};
}
function identity({runId,configId=null,engineVersion,sourceDigest,seed}){
 text(runId,'run ID');text(engineVersion,'engine version');text(sourceDigest,'source digest');
 if(!Number.isSafeInteger(seed)||seed<0)throw new TypeError('seed must be a nonnegative integer');
 return {run_id:runId,config_id:configId,engine_version:engineVersion,source_digest:sourceDigest,seed};
}
/** Failed computations remain in the same fixed schema; missing outcomes never become zeros. */
export function wideFailureRow(options){
 text(options.failReason,'failure reason');
 return {...initialRow(),...identity(options),status:'failed',fail_reason:options.failReason};
}
function atTime(history,t,end,key){
 if(t>end)return null;const exact=history.find(r=>r.t===t);
 if(exact)return finite(exact[key])?exact[key]:null;
 const after=history.findIndex(r=>r.t>t);if(after<=0)return null;
 const a=history[after-1],b=history[after];
 return finite(a[key])&&finite(b[key])?a[key]+(b[key]-a[key])*(t-a.t)/(b.t-a.t):null;
}
function capDuration(actions,end){
 const ranges=actions.filter(a=>a.type==='cap'&&finite(a.effective_from)).map(a=>[Math.max(0,a.effective_from),Math.min(end,a.expiresAt??end)])
  .filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
 const merged=ranges.reduce((out,r)=>out.length&&out.at(-1)[1]>=r[0]?
  [...out.slice(0,-1),[out.at(-1)[0],Math.max(out.at(-1)[1],r[1])]]:[...out,r],[]);
 return sum(merged.map(([a,b])=>b-a));
}
function priorityData(rows,th){
 const instrumented=rows.length>0&&rows.every(r=>finite(r.ledger.competitionPool)&&r.ledger.competitionPool>=0&&
  ((r.ledger.competitionObserved===0&&r.ledger.competitionPool===0)||(r.ledger.competitionObserved===1&&r.ledger.competitionPool>0)));
 const eligible=rows.filter(r=>r.ledger.competitionObserved===1&&r.ledger.competitionPool>0);
 const complete=instrumented&&eligible.every(r=>finite(r.ledger.competitionActualAiShare)&&r.ledger.competitionActualAiShare>=0&&r.ledger.competitionActualAiShare<=1&&[0,1].includes(r.ledger.competitionLeader)&&[0,1].includes(r.ledger.competitionFlip));
 const shares=eligible.map(r=>({...r,share:r.ledger.competitionActualAiShare}));
 const flips=sum(eligible.map(r=>r.ledger.competitionFlip));
 const floor=rows.map(r=>{
  const l=r.ledger,delivery=l.humanCritical+l.humanFlexible;
  if(finite(l.protectedReserve)&&l.protectedReserve>=0&&finite(delivery)&&finite(r.H))
   return r.H>0&&Math.abs(delivery-l.protectedReserve)<=th.floorRelativeTolerance*Math.max(1,delivery,l.protectedReserve);
  return th.floorRelativeTolerance===DEFAULT_FLAG_THRESHOLDS.floorRelativeTolerance&&[0,1,true,false].includes(l.competitionHumanAtFloor)?!!l.competitionHumanAtFloor:null;
 });
 return {complete,years:sum(eligible.map(duration)),takeover:complete?(shares.find(r=>r.share>.5)?.ledger.start??null):null,
  flips:complete?flips:null,mean:complete?ratio(sum(shares.map(r=>r.share*duration(r))),sum(shares.map(duration))):null,
  nominalMean:complete&&eligible.every(r=>finite(r.ledger.competitionTargetAiShare))?ratio(sum(eligible.map(r=>r.ledger.competitionTargetAiShare*duration(r))),sum(eligible.map(duration))):null,
  aiYears:complete?sum(eligible.filter(r=>r.ledger.competitionLeader===1).map(duration)):null,
  floorYears:rows.length&&floor.every(x=>x!==null)?sum(rows.filter((_,i)=>floor[i]).map(duration)):null};
}
function assessFlags(run,rows,row,th,pri,options){
 const set=(name,value)=>({[`flag_${name}`]:value,[`flag_${name}_assessed`]:typeof value==='boolean'});
 const landKnown=rows.length&&rows.every(r=>finite(r.ledger.landAdequacy)||typeof r.ledger.constraints?.land==='boolean');
 const first=run.state.history[0],factoryRatio=ratio(row.rsi_factory_work_peak,first.factoryWork);
 const rates=rows.map(r=>ratio(r.ledger.humanCritical+r.ledger.humanFlexible,duration(r)));
 const low=rates.reduce((a,b)=>Math.min(a,b),Infinity),high=rates.reduce((a,b)=>Math.max(a,b),-Infinity);
 const frozen=rates.length>=2&&rates.every(finite)?high-low<=th.frozenSupplyRelativeTolerance*Math.max(1,high):null;
 const qGrowth=ratio(row.rsi_q_final,first.q),physical=['power','hardware','factoryWork'];
 const physicalKnown=rows.length>=2&&physical.every(k=>finite(first[k])&&rows.every(r=>finite(r[k])))&&rows.every(r=>finite(r.effectiveCompute));
 const flat=physicalKnown?physical.every(k=>extrema(rows,k,'max')<=first[k]*(1+th.physicalRelativeTolerance))&&
  extrema(rows,'effectiveCompute','max')<=rows[0].effectiveCompute*(1+th.physicalRelativeTolerance):null;
 const expected=options.expectedOutcome??row.human_outcome;
 return {...set('land_inert',landKnown&&finite(row.land_fraction_peak)?row.land_fraction_peak<th.landInertFraction&&row.land_binding_years===0:null),
  ...set('unused_large',finite(row.energy_unused_share)?row.energy_unused_share>th.unusedLargeShare:null),
  ...set('factory_runaway',finite(factoryRatio)?factoryRatio>th.factoryGrowthRatio:null),
  ...set('extinction_unreachable',null),...set('frozen_human_supply',frozen),
  ...set('q_without_physical_effect',physicalKnown&&finite(qGrowth)?qGrowth>th.qGrowthRatio&&flat:null),
  ...set('floor_is_reserve',finite(pri.floorYears)?pri.floorYears>0:null),
  ...set('label_disagrees',typeof options.reportedOutcome==='string'&&typeof expected==='string'?options.reportedOutcome!==expected:null),
  ...set('priority_chatter',pri.complete&&pri.years>0?pri.flips/pri.years>th.priorityChatterFlipsPerYear:null)};
}
/** [DOM-VECTOR-2] A fixed scalar row; no synthetic initial delivery/compute measurement. */
export function wideOutputRow(run,options={}){
 const {runId}=options,s=run.state,c=run.config,rows=measured(run),history=s.history,last=rows.at(-1),v=outputVector(run),g=v.groups,th=thresholds(options.thresholds);
 const ledgerTotal=quantity(rows,'available'),unused=quantity(rows,'unused'),pri=priorityData(rows,th);
 const outcome=s.H<c.initial.H*.01?'functional-collapse':s.accounts.minAdequacy<.8?'critical-service-shortfall':'critical-services-maintained';
 const mem=c.human.qolMaximum*(-Math.expm1(-1000*c.human.memEnergy/c.human.qolScale));
 const landKnown=rows.length&&rows.every(r=>finite(r.ledger.landAdequacy)||typeof r.ledger.constraints?.land==='boolean');
 const autonomous=fraction=>history.find(r=>finite(r.autonomousWork)&&r.factoryWork>0&&r.autonomousWork/r.factoryWork>=fraction)?.t??null;
 const policies=[...(s.policyArchive??[]),s.policyState].filter(Boolean).flatMap(p=>p.actions??[]);
 const completeLedger=rows.length&&rows.every(r=>finite(r.ledger.available)&&Object.values(accounts).every(k=>finite(r.ledger[k])));
 const row={...initialRow(),...identity({runId,configId:run.configId,engineVersion:run.version,sourceDigest:run.sourceDigest,seed:c.seed}),
  status:'ok',fail_reason:null,run_time:s.t,human_population_final:s.H,human_population_min:g[0].value.min,human_population_max:g[0].value.max,
  human_qol_final:v.endQualityOfLife,human_qol_min:g[3].value.min,human_qol_max:g[3].value.max,human_qol_person_years:v.qolPersonYears,
  human_kwh_person_final:last?.perCapitaElectricity??null,human_kwh_person_mean:ratio(s.accounts.humanEnergy*1000,s.accounts.personYears),
  human_owned_power_final:history.at(-1)?.humanOwnedPower??null,
  human_starvation_episodes:s.accounts.shortageEpisodes??null,human_additional_deaths:s.accounts.extraDeaths??null,human_outcome:outcome,
  human_welfare_outcome:!last?'unmeasured':s.H<c.initial.H*.01?'functional-collapse':last.qualityOfLife<mem?'below-mem-qol':'at-or-above-mem-qol',
  rsi_q_final:s.q,rsi_q_over_100_t:history.find(r=>r.q>100)?.t??null,rsi_blocks_final:history.at(-1)?.hardware??null,
  rsi_blocks_peak:extrema(history,'hardware','max'),rsi_compute_final:v.endCompute,rsi_compute_peak:g[5].value.max,
  rsi_factory_work_final:history.at(-1)?.factoryWork??null,rsi_factory_work_peak:extrema(history,'factoryWork','max'),
  rsi_material_hardware_cap:ratio(s.assetState.materials,c.assets.hardware.materials),rsi_autonomy_half_t:autonomous(.5),rsi_autonomy_full_t:autonomous(1),
  energy_available_cumulative:ledgerTotal,energy_unused_share:ratio(unused,ledgerTotal),
  energy_construction_share_peak:extrema(rows.map(r=>({share:ratio(r.ledger.construction,r.ledger.available)})),'share','max'),
  energy_ledger_residual_max:completeLedger?rows.reduce((peak,r)=>Math.max(peak,Math.abs(r.ledger.available-sum(Object.values(accounts).map(k=>r.ledger[k])))),0):null,
  land_fraction_peak:ratio(extrema(history,'landUsed','max'),c.resources.land),
  land_binding_years:landKnown?sum(rows.filter(r=>r.ledger.landAdequacy<1-1e-9||r.ledger.constraints?.land===true).map(duration)):null,
  land_queue_peak:rows.length&&rows.every(r=>finite(r.queuePendingCount)||finite(r.ledger.queuePendingCount))?
   rows.reduce((peak,r)=>Math.max(peak,r.queuePendingCount??0,r.ledger.queuePendingCount??0),0):null,
  land_ai_final:g[6].value.total,land_human_final:g[7].value.total,
  policy_shutdown_attempts:policies.filter(a=>a.type==='shutdown'&&a.attempted).length,
  policy_shutdown_successes:policies.filter(a=>a.type==='shutdown'&&a.attempted&&finite(a.effective_from)).length,
  policy_cap_years:capDuration(policies,s.t),numerics_step_count:rows.length,numerics_dt_max:c.dt,
  pri_takeover_t:pri.takeover,pri_flip_count:pri.flips,pri_ai_share_mean:pri.mean,pri_ai_share_nominal_mean:pri.nominalMean,
  pri_observed_years:pri.complete?pri.years:null,pri_ai_years:pri.aiYears,pri_floor_years:pri.floorYears};
 const snapshots=Object.fromEntries(WIDE_DICTIONARY_PROVENANCE.qSnapshotYears.map(t=>[`rsi_q_t${t}`,atTime(history,t,s.t,'q')]));
 const energySnapshots=Object.fromEntries(WIDE_DICTIONARY_PROVENANCE.energySnapshotYears.flatMap(t=>{
  const interval=t<=s.t?rows.find(r=>r.ledger.start<t&&r.ledger.end>=t):null;
  return Object.entries(accounts).map(([name,key])=>[`energy_${name}_share_t${t}`,interval?ratio(interval.ledger[key],interval.ledger.available):null]);
 }));
 return {...row,...snapshots,...Object.fromEntries(Object.entries(accounts).map(([name,key])=>[`energy_${name}_cumulative`,quantity(rows,key)])),
  ...energySnapshots,...assessFlags(run,rows,row,th,pri,options),...Object.fromEntries(Object.entries(th).map(([k,val])=>[`threshold_${snake(k)}`,val]))};
}

function flatten(object,prefix=''){
 return Object.entries(object).flatMap(([key,value])=>{
  if(!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)||['constructor','prototype','__proto__'].includes(key))throw new TypeError('Unsafe input field name');
  const name=prefix?`${prefix}_${key}`:key;
  return value&&typeof value==='object'&&!Array.isArray(value)?flatten(value,name):[[`in_${name}`,Array.isArray(value)?JSON.stringify(value):value]];
 });
}
/** Inputs and switch indicators are a distinct joinable table. Arrays retain exact JSON. */
export function wideInputRow(config,options){
 const {switches={},...id}=options,base=identity({...id,configId:id.configId??configurationId(config)}),fields=flatten(config);
 if(new Set(fields.map(([k])=>k)).size!==fields.length)throw new TypeError('Flattened input field collision');
 const indicators=Object.entries(switches).map(([key,value])=>{
  if(!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(key)||typeof value!=='boolean')throw new TypeError('Switch names must be safe (1–48 characters) and values boolean');
  return [`in_switch_${key}`,value];
 });
 const names=[...fields,...indicators].map(([k])=>k);if(new Set(names).size!==names.length)throw new TypeError('Input/switch field collision');
 return {...base,...Object.fromEntries(fields),...Object.fromEntries(indicators)};
}
export function wideTrajectoryRows(run,{runId}){
 const id=identity({runId,configId:run.configId,engineVersion:run.version,sourceDigest:run.sourceDigest,seed:run.config.seed});
 return run.state.history.map(r=>({...id,time:r.t,human_population:r.H,rsi_q:r.q,human_qol:r.ledger?r.qualityOfLife??null:null,
  rsi_compute:r.ledger?r.effectiveCompute??null:null,power:r.power??null,hardware:r.hardware??null,
  factory_work:r.factoryWork??null,land_used:r.landUsed??null,energy_human:r.ledger?r.ledger.humanCritical+r.ledger.humanFlexible:null,
  energy_construction:r.ledger?.construction??null}));
}
const canonical=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):
 Array.isArray(value)?value.map(canonical):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function configDifferences(a,b,prefix=''){
 return [...new Set([...Object.keys(a??{}),...Object.keys(b??{})])].flatMap(key=>{
  const path=prefix?`${prefix}.${key}`:key,x=a?.[key],y=b?.[key];
  return equal(x,y)?[]:x&&y&&typeof x==='object'&&typeof y==='object'&&!Array.isArray(x)&&!Array.isArray(y)?configDifferences(x,y,path):[path];
 });
}
const differences=Object.freeze({delta_qol_person_years:'human_qol_person_years',delta_population_final:'human_population_final',
 delta_q_final:'rsi_q_final',delta_construction_energy:'energy_construction_cumulative'});
function comparePair(record,base,baselineId){
 const row=record.wideRow,b=base?.wideRow,empty=Object.fromEntries(Object.keys(differences).map(k=>[k,null]));
 const result={run_id:record.id,baseline_id:baselineId,source_digest:row.source_digest,engine_version:row.engine_version,seed:row.seed,
  status:'unavailable',kind:null,reason:null,...empty};
 if(!base||row.status!=='ok'||b.status!=='ok')return {...result,reason:'Missing or failed pair member.'};
 if(row.seed!==b.seed)return {...result,reason:'Pair seeds differ.'};
 const changed=Object.keys({...record.switches,...base.switches}).filter(k=>record.switches?.[k]!==base.switches?.[k]);
 const paths=configDifferences(record.config,base.config);
 let kind='parameter';
 if(changed.length){
  if(changed.length!==1||!equal(record.parameters??{},base.parameters??{}))return {...result,reason:'An exact switch pair must change one switch and no sampled parameters.'};
  const allowed=record.switchPaths?.[changed[0]]??base.switchPaths?.[changed[0]];
  if(!Array.isArray(allowed)||!allowed.length||!paths.length||paths.some(p=>!allowed.includes(p)))return {...result,reason:'Configuration changes are not confined to the declared single-switch paths.'};
  kind='switch';
 }else if(!paths.length)return {...result,reason:'No configuration contrast was declared.'};
 return {...result,status:'ok',kind,reason:null,...Object.fromEntries(Object.entries(differences).map(([key,metric])=>[key,
  finite(row[metric])&&finite(b[metric])?row[metric]-b[metric]:null]))};
}
function refinements(records,pairs){
 const lookup=new Map(records.map(r=>[r.id,r]));
 return pairs.map(({id,baselineId})=>{
  const fine=lookup.get(id),coarse=lookup.get(baselineId),a=fine?.wideRow,b=coarse?.wideRow;
  const valid=a?.status==='ok'&&b?.status==='ok'&&a.seed===b.seed&&a.run_time===fine.config.horizon&&b.run_time===coarse.config.horizon&&fine.config.dt<coarse.config.dt&&
   equal(configDifferences(fine.config,coarse.config),['dt']);
  const metrics={population:'human_population_final',q:'rsi_q_final',qol:'human_qol_final',compute:'rsi_compute_final',welfare:'human_qol_person_years'};
  return {id,baselineId,run_id:id,baseline_id:baselineId,source_digest:a?.source_digest??b?.source_digest??null,
   engine_version:a?.engine_version??b?.engine_version??null,seed:a?.seed??b?.seed??null,
   status:valid?'ok':'unavailable',reason:valid?null:'Requires actual successful finer run, same seed and every config leaf except dt unchanged.',
   ...(valid?Object.fromEntries(Object.entries(metrics).map(([name,key])=>[`numerics_refinement_${name}_difference`,finite(a[key])&&finite(b[key])?a[key]-b[key]:null])):{})};
 });
}
/** No cross-digest pooling; exact switch effects remain separate from numeric contrasts. */
export function finalizeWideRows(records,{refinementPairs=[]}={}){
 if(!Array.isArray(records)||!records.length)throw new TypeError('Expected nonempty wide records');
 const ids=records.map(r=>r.id);if(new Set(ids).size!==ids.length)throw new TypeError('Duplicate run IDs');
 const digests=new Set(records.map(r=>r.wideRow?.source_digest));
 if(digests.size!==1||![...digests][0])throw new TypeError('Cannot pool mixed or missing source digests');
 if(new Set(records.map(r=>r.wideRow.engine_version)).size!==1)throw new TypeError('Cannot pool mixed engine versions');
 for(const r of records)for(const key of ['source_digest','engine_version','seed','run_id','config_id'])
  if(r.wideRow[key]!==r.inputRow?.[key]||(key==='run_id'&&r.wideRow[key]!==r.id))throw new TypeError('Input/output identity mismatch');
 for(const r of records)if(r.config&&r.wideRow.config_id!==configurationId(r.config))throw new TypeError('Configuration identity does not match actual normalized config');
 const lookup=new Map(records.map(r=>[r.id,r]));
 const comparisons=records.flatMap(r=>[...new Set([r.baselineId,...Object.values(r.baselineIds??{})].filter(Boolean))].map(id=>comparePair(r,lookup.get(id),id)));
 const refined=refinements(records,refinementPairs);
 const rows=records.map(r=>{
  const pairs=comparisons.filter(p=>p.run_id===r.id),pair=r.baselineId?pairs.find(p=>p.baseline_id===r.baselineId):pairs.length===1?pairs[0]:null;
  const refinement=refined.find(p=>p.baselineId===r.id&&p.status==='ok');
  return {...r.wideRow,...(pair?{pair_baseline_id:pair.baseline_id,pair_status:pair.status,pair_kind:pair.kind,pair_reason:pair.reason,
   ...Object.fromEntries(Object.keys(differences).map(k=>[k,pair[k]]))}:{}),
   ...(refinement?{numerics_refinement_run_id:refinement.id,...Object.fromEntries(Object.entries(refinement).filter(([k])=>k.startsWith('numerics_refinement_')))}:{})};
 });
 return {schema:WIDE_OUTPUT_SCHEMA,rows,comparisons,refinements:refined};
}
const csvCell=value=>{if(value===null||value===undefined)return '';const s=typeof value==='object'?JSON.stringify(value):String(value);return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
export function wideCSV(rows,{columns}={}){
 const identified=rows.filter(r=>Object.hasOwn(r,'source_digest'));
 if(identified.length&&(identified.length!==rows.length||new Set(identified.map(r=>r.source_digest)).size!==1||!identified[0].source_digest))
  throw new TypeError('Cannot pool mixed or missing source digests in CSV');
 const names=columns??[...new Set(rows.flatMap(Object.keys))];
 if(new Set(names).size!==names.length)throw new TypeError('Duplicate CSV columns');
 return [names.join(','),...rows.map(row=>names.map(k=>csvCell(row[k])).join(','))].join('\n')+'\n';
}
export const dictionaryCSV=()=>wideCSV(WIDE_OUTPUT_DICTIONARY,{columns:['name','unit','definition']});
