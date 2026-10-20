import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,finishRun} from '../revised/engine.mjs';
import {configurationId} from '../revised/identity.mjs';
import {WIDE_OUTPUT_DICTIONARY,WIDE_OUTPUT_COLUMNS,DEFAULT_FLAG_THRESHOLDS,
 wideOutputRow,wideFailureRow,wideInputRow,wideTrajectoryRows,finalizeWideRows,wideCSV} from '../revised/wide-output.mjs';

function fixture(){
 const run=structuredClone(createRun({horizon:100,dt:.25}));
 const ledger=(start,end,share)=>({start,end,h:end-start,available:100*(end-start),
  humanCritical:20*(end-start),humanFlexible:10*(end-start),operation:30*(end-start),
  maintenance:5*(end-start),construction:10*(end-start),policy:0,extraction:0,
  storageCharge:0,unused:25*(end-start),landAdequacy:1,competitionActualAiShare:share,
  competitionObserved:1,competitionPool:10,competitionTargetAiShare:share,
  competitionLeader:share>.5?1:0,competitionFlip:start?1:0,competitionHumanAtFloor:share>.5?1:0,
  minimumPopulation:100,maximumPopulation:100});
 run.state.t=100;run.state.H=100;run.state.q=201;
 run.state.history=[{t:0,H:100,q:1,power:100,hardware:10,factoryWork:10,landUsed:100,extraDeaths:0},
  {t:10,H:100,q:101,power:100,hardware:10,factoryWork:10,landUsed:100,effectiveCompute:10,qualityOfLife:.8,perCapitaElectricity:300,criticalAdequacy:1,queuePendingCount:2,autonomousWork:0,ledger:ledger(0,10,.25)},
  {t:20,H:100,q:151,power:100,hardware:10,factoryWork:20,landUsed:200,effectiveCompute:15,qualityOfLife:.9,perCapitaElectricity:300,criticalAdequacy:1,queuePendingCount:5,autonomousWork:20,ledger:ledger(10,20,.75)},
  {t:100,H:100,q:201,power:100,hardware:10,factoryWork:20,landUsed:200,effectiveCompute:20,qualityOfLife:.9,perCapitaElectricity:300,criticalAdequacy:1,queuePendingCount:0,autonomousWork:20,ledger:ledger(20,100,.4)}];
 run.state.accounts={...run.state.accounts,minPopulation:100,maxPopulation:100,qolPersonYears:8900,
  personYears:10000,humanEnergy:3000,extraDeaths:0,shortageEpisodes:0,minAdequacy:1};
 return run;
}
function compact(id,options={}){
 const run=fixture(),config={...run.config,...options.config};
 const row={...wideOutputRow(run,{runId:id}),config_id:configurationId(config),...options.row};
 const switches=options.switches??{services:false};
 return {id,status:'ok',config,switches,parameters:options.parameters??{},switchPaths:options.switchPaths,
  baselineId:options.baselineId??null,baselineIds:options.baselineIds,
  wideRow:row,inputRow:wideInputRow(config,{runId:id,engineVersion:run.version,sourceDigest:row.source_digest,seed:row.seed,switches})};
}

test('fixed reconstructed dictionary has unique flat names and explicit units across every proposed group',()=>{
 assert.equal(new Set(WIDE_OUTPUT_COLUMNS).size,WIDE_OUTPUT_COLUMNS.length);
 assert.ok(WIDE_OUTPUT_COLUMNS.length>100);
 for(const entry of WIDE_OUTPUT_DICTIONARY){assert.match(entry.name,/^[a-z][a-z0-9_]*$/);assert.equal(typeof entry.unit,'string');assert.ok(entry.definition);}
 for(const name of ['run_id','human_population_final','rsi_q_t100','energy_construction_cumulative',
  'land_fraction_peak','policy_shutdown_attempts','numerics_step_count','flag_land_inert','delta_q_final','pri_takeover_t'])assert.ok(WIDE_OUTPUT_COLUMNS.includes(name));
});

test('wide output preserves measured identity, human outcomes and independent energy-account closure',()=>{
 const run=fixture(),row=wideOutputRow(run,{runId:'case-1'});
 assert.equal(row.run_id,'case-1');assert.equal(row.source_digest,run.sourceDigest);
 assert.equal(row.engine_version,run.version);assert.equal(row.human_population_final,100);
 assert.equal(row.human_qol_person_years,8900);assert.equal(row.human_kwh_person_mean,300);
 assert.equal(row.energy_construction_cumulative,1000);assert.equal(row.energy_ledger_residual_max,0);
 assert.equal(row.energy_unused_share,.25);assert.equal(row.land_queue_peak,5);
 assert.deepEqual(Object.keys(row),WIDE_OUTPUT_COLUMNS);
});

test('Q snapshots interpolate only within observed time and energy snapshots use actual containing intervals',()=>{
 const row=wideOutputRow(fixture(),{runId:'snap'});
 assert.equal(row.rsi_q_t10,101);assert.equal(row.rsi_q_t30,157.25);
 assert.equal(row.energy_operation_share_t25,.3);assert.equal(row.rsi_q_over_100_t,10);
 const short=fixture();short.state.t=20;short.state.history=short.state.history.slice(0,3);
 const partial=wideOutputRow(short,{runId:'partial'});
 assert.equal(partial.rsi_q_t30,null);assert.equal(partial.energy_operation_share_t25,null);
});

test('priority summaries use durations, strict majority, observed flips and actual floor intervals',()=>{
 const row=wideOutputRow(fixture(),{runId:'pri'});
 assert.equal(row.pri_takeover_t,10);assert.equal(row.pri_flip_count,2);
 assert.equal(row.pri_ai_share_mean,.42);assert.equal(row.pri_ai_years,10);
 assert.equal(row.pri_floor_years,10);assert.equal(row.flag_priority_chatter,false);
 assert.equal(row.pri_ai_share_nominal_mean,.42);assert.equal(row.pri_observed_years,100);
 const noPriority=fixture();noPriority.state.history=noPriority.state.history.map(({ledger,...r})=>({...r,...(ledger?{ledger:{start:ledger.start,end:ledger.end,h:ledger.h}}:{})}));
 const unassessed=wideOutputRow(noPriority,{runId:'old'});
 assert.equal(unassessed.pri_takeover_t,null);assert.equal(unassessed.pri_flip_count,null);
 assert.equal(unassessed.flag_priority_chatter,null);assert.equal(unassessed.flag_priority_chatter_assessed,false);
});

test('a never-observed event is empty while a measured zero count remains zero',()=>{
 const run=fixture();run.state.history=run.state.history.map(r=>({...r,q:2}));
 const row=wideOutputRow(run,{runId:'never'});
 assert.equal(row.rsi_q_over_100_t,null);assert.equal(row.policy_shutdown_attempts,0);
 const csv=wideCSV([row]);assert.match(csv,/rsi_q_over_100_t/);assert.ok(!csv.includes('null'));
});

test('failed rows retain source identity and reason with all unavailable outcomes null',()=>{
 const row=wideFailureRow({runId:'failed',configId:'cfg',engineVersion:'2.2.0',sourceDigest:'digest',seed:7,failReason:'not finite, bad input'});
 assert.equal(row.status,'failed');assert.equal(row.fail_reason,'not finite, bad input');
 assert.equal(row.human_population_final,null);assert.equal(row.flag_unused_large_assessed,false);
 assert.match(wideCSV([row]),/"not finite, bad input"/);
 assert.throws(()=>wideFailureRow({runId:'x',sourceDigest:'d',engineVersion:'v',seed:1}),/reason/i);
});

test('input switches are separate, flattened, immutable and bounded to booleans',()=>{
 const config={seed:3,human:{growth:.001},events:[{time:1}]};const original=structuredClone(config);
 const row=wideInputRow(config,{runId:'in',engineVersion:'v',sourceDigest:'d',seed:3,switches:{services:true}});
 assert.equal(row.in_human_growth,.001);assert.equal(row.in_switch_services,true);
 assert.equal(row.in_events,JSON.stringify(config.events));assert.deepEqual(config,original);
 assert.throws(()=>wideInputRow(config,{runId:'x',engineVersion:'v',sourceDigest:'d',seed:3,switches:{services:1}}),/boolean/i);
});

test('trajectory is optional, keyed by run/time and carries version/digest on every row',()=>{
 const run=fixture(),rows=wideTrajectoryRows(run,{runId:'track'});
 assert.equal(rows.length,4);assert.equal(rows[0].time,0);assert.equal(rows.at(-1).time,100);
 assert.ok(rows.every(r=>r.run_id==='track'&&r.source_digest===run.sourceDigest&&r.engine_version===run.version));
 assert.equal(rows[0].human_qol,null);
});

test('diagnostics declare thresholds and leave unsupported structural claims unassessed',()=>{
 const row=wideOutputRow(fixture(),{runId:'flags'});
 assert.equal(DEFAULT_FLAG_THRESHOLDS.landInertFraction,.01);
 assert.equal(row.flag_land_inert,true);assert.equal(row.flag_land_inert_assessed,true);
 assert.equal(row.flag_unused_large,false);assert.equal(row.flag_unused_large_assessed,true);
 assert.equal(row.flag_extinction_unreachable,null);assert.equal(row.flag_extinction_unreachable_assessed,false);
 assert.equal(row.flag_label_disagrees_assessed,false);
 assert.equal(wideOutputRow(fixture(),{runId:'labels',reportedOutcome:'maintained',expectedOutcome:'collapsed'}).flag_label_disagrees,true);
 assert.throws(()=>wideOutputRow(fixture(),{runId:'bad',thresholds:{unknown:1}}),/threshold/i);
});

test('pooling rejects mixed digests, duplicate IDs and mismatched input/output identities',()=>{
 const a=compact('a'),b=compact('b',{row:{source_digest:'different'}});
 assert.throws(()=>finalizeWideRows([a,b]),/digest/i);
 assert.throws(()=>finalizeWideRows([a,a]),/duplicate/i);
 assert.throws(()=>finalizeWideRows([{...a,inputRow:{...a.inputRow,source_digest:'wrong'}}]),/identity|digest/i);
});

test('one explicit mapped switch with the same seed/source yields paired Q and construction-energy deltas',()=>{
 const a=compact('base'),b=compact('on',{baselineId:'base',switches:{services:true},switchPaths:{services:['aiEnabled']},config:{aiEnabled:false},row:{rsi_q_final:251,energy_construction_cumulative:1300}});
 const result=finalizeWideRows([a,b]);const paired=result.comparisons[0];
 assert.equal(paired.status,'ok');assert.equal(paired.kind,'switch');
 assert.equal(paired.delta_q_final,50);assert.equal(paired.delta_construction_energy,300);
 assert.equal(result.rows[1].delta_q_final,50);assert.equal(result.rows[1].pair_baseline_id,'base');
 assert.equal(b.wideRow.delta_q_final,null);
});

test('numeric contrasts are distinct from exact switch comparisons and extra parameter changes are rejected',()=>{
 const a=compact('base'),numeric=compact('numeric',{baselineId:'base',config:{alignment:.75},parameters:{alignment:.75}});
 const n=finalizeWideRows([a,numeric]).comparisons[0];assert.equal(n.kind,'parameter');assert.equal(n.status,'ok');
 const bad=compact('bad',{baselineId:'base',switches:{services:true},switchPaths:{services:['aiEnabled']},config:{aiEnabled:false,alignment:.75}});
 const invalid=finalizeWideRows([a,bad]).comparisons[0];assert.equal(invalid.status,'unavailable');assert.equal(invalid.delta_q_final,null);
 const seed=compact('seed',{baselineId:'base',row:{seed:123}});
 assert.equal(finalizeWideRows([a,seed]).comparisons[0].status,'unavailable');
});

test('multiple named switch baselines yield separate comparison rows without choosing an arbitrary row baseline',()=>{
 const a=compact('base'),b=compact('other'),c=compact('multi',{baselineIds:{first:'base',second:'other'}});
 const out=finalizeWideRows([a,b,c]);assert.equal(out.comparisons.length,2);
 assert.equal(out.rows[2].pair_baseline_id,null);
});

test('refinement values require an actual successful finer run with every other config leaf identical',()=>{
 const a=compact('coarse'),fine=compact('fine',{config:{dt:.125},row:{human_population_final:99,rsi_q_final:200}});
 const out=finalizeWideRows([a,fine],{refinementPairs:[{id:'fine',baselineId:'coarse'}]});
 assert.equal(out.refinements[0].status,'ok');assert.equal(out.rows[0].numerics_refinement_population_difference,-1);
 assert.equal(out.rows[0].numerics_refinement_q_difference,-1);
 assert.equal(finalizeWideRows([a]).rows[0].numerics_refinement_q_difference,null);
 const bad=compact('bad',{config:{dt:.125,alignment:.7}});
 assert.equal(finalizeWideRows([a,bad],{refinementPairs:[{id:'bad',baselineId:'coarse'}]}).refinements[0].status,'unavailable');
});

test('actual engine runs export measured ledger values without mutating the run',()=>{
 const run=finishRun(createRun({horizon:1,dt:.5}));const initial=JSON.stringify(run);
 const row=wideOutputRow(run,{runId:'actual'});
 assert.ok(row.energy_available_cumulative>0);assert.ok(row.human_population_final>0);
 assert.equal(JSON.stringify(run),initial);
});

test('queue peak includes interval-start commitments even if they finish before the endpoint snapshot',()=>{
 const run=fixture();run.state.history[1].ledger.queuePendingCount=17;
 assert.equal(wideOutputRow(run,{runId:'queue'}).land_queue_peak,17);
});

test('separate input rows carry the actual configuration identity and pooling rejects substitutions',()=>{
 const a=compact('a');assert.equal(a.inputRow.config_id,a.wideRow.config_id);
 assert.throws(()=>finalizeWideRows([{...a,inputRow:{...a.inputRow,config_id:'substituted'}}]),/identity/i);
});

test('an explicitly named canonical baseline is honored alongside extra comparison baselines',()=>{
 const a=compact('base'),b=compact('other'),c=compact('multi',{baselineId:'base',baselineIds:{first:'base',second:'other'}});
 assert.equal(finalizeWideRows([a,b,c]).rows[2].pair_baseline_id,'base');
});

test('partial trajectories cannot masquerade as completed numerical-refinement evidence',()=>{
 const a=compact('coarse'),fine=compact('partial',{config:{dt:.125},row:{run_time:50}});
 assert.equal(finalizeWideRows([a,fine],{refinementPairs:[{id:'partial',baselineId:'coarse'}]}).refinements[0].status,'unavailable');
});

test('CSV pooling rejects different or partly missing source identities while dictionary exports remain valid',()=>{
 const a=compact('a').wideRow,b=compact('b',{row:{source_digest:'other'}}).wideRow;
 assert.throws(()=>wideCSV([a,b]),/digest/i);
 assert.throws(()=>wideCSV([a,{run_id:'missing'}]),/digest/i);
 assert.match(wideCSV(WIDE_OUTPUT_DICTIONARY),/^name,unit,definition/);
});

test('configuration IDs bind actual configs rather than merely agreeing with each other',()=>{
 const a=compact('a');const forged={...a,wideRow:{...a.wideRow,config_id:'forged'},inputRow:{...a.inputRow,config_id:'forged'}};
 assert.throws(()=>finalizeWideRows([forged]),/configuration|config/i);
});

test('refinement table rows retain source/version and explicit paired identities',()=>{
 const a=compact('coarse'),fine=compact('fine',{config:{dt:.125}});
 const row=finalizeWideRows([a,fine],{refinementPairs:[{id:'fine',baselineId:'coarse'}]}).refinements[0];
 assert.equal(row.source_digest,a.wideRow.source_digest);assert.equal(row.engine_version,a.wideRow.engine_version);
 assert.equal(row.run_id,'fine');assert.equal(row.baseline_id,'coarse');
});

test('missing positive-pool evidence never becomes fabricated zero priority duration or flips',()=>{
 const run=fixture();delete run.state.history[1].ledger.competitionPool;
 const row=wideOutputRow(run,{runId:'missing-pool'});
 assert.equal(row.pri_observed_years,null);assert.equal(row.pri_flip_count,null);assert.equal(row.pri_ai_years,null);
 assert.equal(row.flag_priority_chatter_assessed,false);
});

test('declared floor tolerance is applied to logged physical reserve and delivery',()=>{
 const run=fixture();run.state.history=run.state.history.map(r=>!r.ledger?r:{...r,ledger:{...r.ledger,
  protectedReserve:(r.ledger.humanCritical+r.ledger.humanFlexible)*.99,competitionHumanAtFloor:0}});
 const strict=wideOutputRow(run,{runId:'strict'}),loose=wideOutputRow(run,{runId:'loose',thresholds:{floorRelativeTolerance:.02}});
 assert.equal(strict.pri_floor_years,0);assert.equal(loose.pri_floor_years,100);assert.equal(loose.flag_floor_is_reserve,true);
});

test('an initially observed physical autonomy threshold has event time zero rather than a missing event',()=>{
 const run=fixture();run.state.history[0].autonomousWork=run.state.history[0].factoryWork;
 const row=wideOutputRow(run,{runId:'initial-autonomy'});
 assert.equal(row.rsi_autonomy_half_t,0);assert.equal(row.rsi_autonomy_full_t,0);
});
