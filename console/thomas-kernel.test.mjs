import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DEFAULT_THOMAS_PARAMS as defaults, allocateResourcesThomas, rsiRhsThomas, simulateThomasTrajectory} from './thomas-kernel.mjs';

const initial = p => [p.initial_humans,p.initial_hardware,p.initial_capability,p.initial_power,p.initial_fabrication];
const witness = {...defaults,hardware_depreciation:0,max_replication_per_year:0,power_expansion_per_year:0,
  fabrication_expansion_per_year:0,research_fraction:1,research_rate:1,capability_law:'exponential'};
const close = (actual, expected, tolerance=1e-8) => assert.ok(Math.abs(actual-expected)<=tolerance*Math.max(1,Math.abs(expected)), `${actual} != ${expected}`);

test('BROWSER-08: freeze each policy segment; off-grid and aligned shutdown/cap give exp(.025)', () => {
  for(const dt of [.05,.025,.0125,.00625])for(const policy of [
    {alignment:.5,shutdown_year:.025,shutdown_succeeds:true},
    {alignment:.5,compute_cap:0,cap_start_year:.025},
  ]) {
    const rows=simulateThomasTrajectory(witness,policy,.1,dt);
    assert.equal(rows.at(-1).t,.1);
    close(rows.at(-1).C,Math.exp(.025),1e-9);
    assert.ok(rows.some(row=>row.t===.025),'policy switch must be exported exactly');
  }
});

test('BROWSER-08: exact horizon includes short remainder, final switch and tiny positive horizon', () => {
  for(const [horizon,dt] of [[.1,.03],[.125,.05],[1e-10,.05]]) {
    const rows=simulateThomasTrajectory(witness,{shutdown_year:horizon},horizon,dt);
    assert.equal(rows.at(-1).t,horizon);
    close(rows.at(-1).C,Math.exp(horizon),2e-8);
    assert.ok(rows.every((row,i)=>i===0||row.t>rows[i-1].t));
  }
});

test('BROWSER-09: omitted policy defaults match original alignment=0 and shutdown_succeeds=true', () => {
  const highHardware=[1,20,1,1,.3];
  assert.deepEqual(allocateResourcesThomas(0,highHardware),allocateResourcesThomas(0,highHardware,defaults,{alignment:0}));
  assert.equal(allocateResourcesThomas(0,initial(defaults),defaults,{alignment:.5,shutdown_year:0}).operatingHardware,0);
  assert.ok(allocateResourcesThomas(0,initial(defaults),defaults,{shutdown_year:0,shutdown_succeeds:false}).operatingHardware>0);
});

test('BROWSER-10: reject invalid caps, policy fields and allocation state at public boundary', () => {
  for(const compute_cap of [-1,NaN,Infinity,true,'1'])
    assert.throws(()=>allocateResourcesThomas(0,initial(defaults),defaults,{compute_cap}), /cap|policy|finite/i);
  for(const policy of [{alignment:2},{shutdown_year:-1},{cap_start_year:NaN},{shutdown_succeeds:1}])
    assert.throws(()=>allocateResourcesThomas(0,initial(defaults),defaults,policy));
  for(const state of [[1,1,NaN,1,.3],[1,1,1],[-1,1,1,1,.3]])
    assert.throws(()=>allocateResourcesThomas(0,state,defaults,{}));
});

test('BROWSER-10: reject nonfinite or nonpositive horizon/dt and invalid physical parameters', () => {
  for(const dt of [-.05,NaN,Infinity,0])assert.throws(()=>simulateThomasTrajectory(defaults,{},1,dt));
  for(const horizon of [-1,0,NaN,Infinity])assert.throws(()=>simulateThomasTrajectory(defaults,{},horizon,.05));
  for(const change of [{capability_law:'typo'},{human_power_per_person:0},{research_fraction:2},
    {initial_power:Infinity},{initial_capability:.5},{total_land:.01},{capability_law:'bounded',initial_capability:101}])
    assert.throws(()=>simulateThomasTrajectory({...defaults,...change},{},1,.05));
});

test('T04: independently reconstructed energy/chip budgets and genuinely unmaintained decay', () => {
  const p={...defaults,initial_fabrication:0,max_replication_per_year:0,power_expansion_per_year:0,fabrication_expansion_per_year:0};
  const derivative=rsiRhsThomas(0,initial(p),p,{});
  close(derivative[3],-p.power_depreciation*p.initial_power,1e-14);
  const rows=simulateThomasTrajectory(p,{},2,.01);
  close(rows.at(-1).P,Math.exp(-p.power_depreciation*2),1e-8);
  const unpowered={...p,initial_power:0,initial_fabrication:.3};
  close(rsiRhsThomas(0,initial(unpowered),unpowered,{})[4],-.024,1e-14);
  close(simulateThomasTrajectory(unpowered,{},2,.01).at(-1).F,.3*Math.exp(-.16),1e-8);
  for(const alignment of [0,.5,1]) {
    const a=allocateResourcesThomas(0,initial(defaults),defaults,{alignment});
    const operating=defaults.hardware_power*a.operatingHardware;
    const construction=defaults.hardware_build_energy*a.buildHardware+defaults.power_build_energy*a.buildPower+defaults.fabrication_build_energy*a.buildFab;
    close(a.humanPower+operating+construction,1,1e-13);
    const chips=a.buildHardware+defaults.power_build_chips*a.buildPower+defaults.fabrication_build_chips*a.buildFab;
    assert.ok(chips<=defaults.initial_fabrication+1e-13);
  }
});

test('T04: original unchanged Python model supplies independent allocation and trajectory references', () => {
  const original=fileURLToPath(new URL('../python/model.py',import.meta.url));
  const script=`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('original_thomas_reference',sys.argv[1]);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
p=m.RSIParameters(); cases=[{},dict(alignment=.5,compute_cap=.5,cap_start_year=.125),dict(shutdown_year=.125)]
print(json.dumps([dict(policy=policy,allocation=m.allocate_resources(0,p.initial_state(),p,m.Policy(**policy)),final=m.simulate_rsi(p,m.Policy(**policy),horizon=2,points=9,rtol=1e-10,atol=1e-12,max_step=.01).state[-1].tolist()) for policy in cases]))`;
  const reference=spawnSync(process.env.PYTHON??'python3',['-c',script,original],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(reference.status,0,reference.stderr);
  for(const row of JSON.parse(reference.stdout)) {
    const a=allocateResourcesThomas(0,initial(defaults),defaults,row.policy);
    for(const [js,py] of [['humanPower','human_power'],['operatingHardware','operating_hardware'],['buildPower','build_power'],['buildFab','build_fabrication']])close(a[js],row.allocation[py],1e-13);
    const end=simulateThomasTrajectory(defaults,row.policy,2,.005).at(-1);
    ['H','A','C','P','F'].forEach((key,i)=>close(end[key],row.final[i],3e-7));
  }
});

test('CONT-REVIEW-02: bounded growth matches the exact logistic endpoint at the default step', () => {
  const p={...defaults,initial_hardware:1000,initial_capability:99,initial_power:100,total_land:10,
    capability_law:'bounded',capability_ceiling:100,hardware_depreciation:0,max_replication_per_year:0,
    power_expansion_per_year:0,fabrication_expansion_per_year:0};
  // Constant fully powered hardware gives dC/dt=60*C*(1-C/100).
  const exact=t=>100/(1+(100/99-1)*Math.exp(-60*t));
  close(rsiRhsThomas(0,initial(p),p,{alignment:.5})[2],59.4,1e-13);
  for(const dt of [.05,.025,.0125]) {
    const rows=simulateThomasTrajectory(p,{alignment:.5},.05,dt);
    for(const row of rows) {
      assert.ok(row.C<=100&&row.C>=99,'every sample must obey the bounded law');
      close(row.C,exact(row.t),2e-13);
    }
    assert.ok(rows.at(-1).C<100,'finite growth must not be replaced by a final ceiling clamp');
  }
  for(const policy of [{alignment:.5,compute_cap:500,cap_start_year:.025},
    {alignment:.5,shutdown_year:.025}]) {
    const end=simulateThomasTrajectory(p,policy,.05).at(-1);
    const dose=policy.compute_cap===500?2.25:1.5;
    close(end.C,100/(1+(100/99-1)*Math.exp(-dose)),2e-13);
  }
  assert.equal(simulateThomasTrajectory({...p,initial_capability:100},{},.05).at(-1).C,100);
  assert.equal(simulateThomasTrajectory({...p,research_rate:0},{},.05).at(-1).C,99);
  assert.throws(()=>simulateThomasTrajectory({...p,research_rate:Number.MAX_VALUE},{},.05),/research dose/);
  assert.throws(()=>simulateThomasTrajectory({...p,initial_capability:1e-310,capability_ceiling:1},{},.05),/capability/);
});

test('CONT-REVIEW-03: positive subnormal endpoints and switch segments never silently disappear', () => {
  const tiny=Number.MIN_VALUE;
  for(const [horizon,dt,policy] of [[tiny,2,{}],[tiny,Number.MAX_VALUE,{}],
    [2*tiny,2,{compute_cap:0,cap_start_year:tiny}],[2*tiny,2,{shutdown_year:tiny}]]) {
    const rows=simulateThomasTrajectory({},policy,horizon,dt);
    assert.equal(rows.at(-1).t,horizon);
    assert.ok(rows.length>=2);
    assert.ok(rows.every((row,i)=>i===0||row.t>rows[i-1].t));
    if(horizon>tiny)assert.ok(rows.some(row=>row.t===tiny));
  }
});
