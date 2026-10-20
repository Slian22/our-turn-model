import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun, stepRun, advanceRun} from '../revised/engine.mjs';
import {prepareState, planningProjection, physicalView} from '../revised/dynamics.mjs';
import {selectPortfolio} from '../revised/planning.mjs';

test('C4 forecasts cannot inspect the live future shutdown draw', () => {
  const options = {horizon: 10, planner: 'optimizer', policy: {mode: 'fixed',
    type: 'shutdown', start: 0, delay: 1, cost: 0, work: 0,
    success: 0.5, residual: 0, coverage: 1}};
  const a = structuredClone(createRun(options));
  const b = structuredClone(a);
  a.state.policyRng = 0;
  b.state.policyRng = 1;
  assert.deepEqual(planningProjection(prepareState(a.state, a.config), a.config),
    planningProjection(prepareState(b.state, b.config), b.config));
  const resultA = stepRun(a);
  const resultB = stepRun(b);
  assert.deepEqual(resultA.state.planning.optimization, resultB.state.planning.optimization);
  assert.equal(resultA.state.policyState.actions[0].attempted, false);
  assert.equal(resultB.state.policyState.actions[0].attempted, false);
  assert.equal(resultA.state.policyRng, 0);
  assert.equal(resultB.state.policyRng, 1);
});

test('C4 same observation has the same forecast despite a hidden future work commitment', () => {
  const event = {id: 'hidden-work', type: 'algorithm', time: 0, magnitude: 2,
    observationDelay: 100, adoptionEnergy: 1e6, adoptionWork: 1e6, adoptionDelay: 1};
  const a = createRun({horizon: 10, planner: 'optimizer', events: [event]});
  const b = createRun({horizon: 10, planner: 'optimizer'});
  const observedA = planningProjection(prepareState(a.state, a.config), a.config);
  const observedB = planningProjection(prepareState(b.state, b.config), b.config);
  assert.deepEqual(observedA, observedB);
  assert.equal(observedA.projects.length, 0);
  assert.deepEqual(stepRun(a).state.planning.optimization, stepRun(b).state.planning.optimization);
});

test('C4 evaluates newly commissioned endpoint power instead of the preceding interval', () => {
  const run = createRun({horizon: 10, planner: 'optimizer',
    initial: {H: 1, hardware: 100, humanPower: 0, aiPower: 0,
      humanFactories: 1, aiFactories: 0, ageBands: [0]},
    human: {criticalEnergy: 1e-6, criticalFloor: 1e-6, flexEnergy: 0, landPerMillion: 0},
    resources: {maintenanceEnergyPerWork: 0}, ai: {planningWindow: 2},
    assets: {power: {delay: 2, energy: 0, work: 1, materials: 0, land: 0, maintenance: 0},
      factory: {delay: 0}, hardware: {delay: 0}}});
  const next = stepRun(run);
  assert.equal(next.state.planning.optimization.horizon, 2);
  assert.ok(next.state.planning.optimization.objective > 0);
  assert.notEqual(next.state.planning.optimization.selectedCandidate, 'hold');
  assert.ok(next.state.assetState.projects.some(p => p.kind === 'power' && p.owner === 'ai'));
});

test('fixed work compensates ageing performance when utilisation headroom exists', () => {
  const run = createRun({initial: {hardware: 1000, ageBands: [0.5]},
    ai: {workloadMode: 'fixed-work', utilisation: 0.8}});
  const view = physicalView(run.state, run.config);
  assert.ok(Math.abs(view.assets.hardwareEffective - 900) < 1e-10);
  assert.ok(Math.abs(view.utilisation - 8 / 9) < 1e-14);
  assert.ok(Math.abs(view.assets.hardwareEffective * view.utilisation - 800) < 1e-10);
});

test('only reported deployments enter policy observations; pending attempts remain private', () => {
  const options = {horizon: 10, policy: {mode: 'fixed', type: 'cap', start: 0,
    delay: 0, cost: 0, work: 0, observationDelay: 2, duration: 9, cap: 1}};
  const waitingForReport = advanceRun(createRun(options), 0.5);
  const before = planningProjection(waitingForReport.state, waitingForReport.config);
  assert.deepEqual(before.policy.reportedControls, []);
  const reported = advanceRun(waitingForReport, 1.5);
  const after = planningProjection(reported.state, reported.config);
  assert.equal(after.policy.reportedControls.length, 1);
  assert.equal(after.policy.reportedControls[0].type, 'cap');
  assert.equal(after.policy.reportedControls[0].cap, 1);
  assert.equal('rngState' in after.policy, false);
  assert.equal('draw' in after.policy.reportedControls[0], false);
});

test('public belief telemetry includes free land and demographic/maintenance observations', () => {
  const run = createRun();
  const observation = planningProjection(run.state, run.config);
  assert.equal(observation.human.exposure, run.state.exposure);
  assert.equal(observation.human.flexibleDemand, run.state.flexibleDemand);
  assert.equal(observation.human.maintenanceFactor, run.state.maintenanceFactor);
  assert.ok(observation.resources.landAvailable >= observation.resources.land);
});

test('C4 probe and candidate simulations preserve live state and paid accounts', () => {
  const run = createRun({horizon: 4, planner: 'optimizer'});
  const before = JSON.stringify(run);
  const first = stepRun(run);
  const second = stepRun(run);
  assert.equal(JSON.stringify(run), before);
  assert.deepEqual(first, second);
  assert.ok(first.state.assetState.accounts.energySpent < 1000);
  assert.equal(first.state.t, run.config.dt);
});

test('C4 forwards observed temporary technology and its expiry to every belief callback', () => {
  const run = advanceRun(createRun({horizon: 4, events: [{id: 'known-temporary',
    type: 'hardware', time: 0, magnitude: 2, duration: 2, observationDelay: 0,
    adoptionEnergy: 0, adoptionWork: 0, adoptionDelay: 0}]}), 0.125);
  const observation = planningProjection(run.state, run.config);
  assert.equal(observation.technologyEffects[0].expiresAt, 2);
  const snapshots = [];
  selectPortfolio(observation, run.config, 1, query => {
    snapshots.push(query.observation.technologyEffects);
    return {effectiveCompute: 1};
  });
  assert.equal(snapshots.length, 6);
  for (const known of snapshots) assert.deepEqual(known, observation.technologyEffects);
});

test('R2 known temporary coverage reverts in C4 while a longer shift remains active', () => {
  const base = {horizon: 2, planner: 'optimizer', initial: {hardware: 1000, ageBands: [0]},
    policy: {mode: 'fixed', type: 'cap', start: 0, delay: 0, cost: 0, work: 0,
      coverage: 1, cap: 0, observationDelay: 0, duration: 4}};
  const runs = [0.5, 3].map(duration => advanceRun(createRun({...base,
    events: [{id: 'known-coverage', type: 'coverage', time: 0,
      magnitude: 0.1, duration, observationDelay: 0}]}), 0.125));
  const observations = runs.map(r => planningProjection(r.state, r.config));
  assert.equal(observations[0].executionEffects[0].expiresAt, 0.5);
  assert.equal(observations[1].executionEffects[0].expiresAt, 3);
  assert.equal(runs[0].state.planning.optimization.objective, 0);
  assert.ok(runs[1].state.planning.optimization.objective > 0);
});

test('R2 public baseline survives a clamped coverage gain without double application', () => {
  const base = {horizon: 2, planner: 'optimizer', initial: {hardware: 1000, ageBands: [0]},
    policy: {mode: 'fixed', type: 'cap', start: 0, delay: 0, cost: 0, work: 0,
      coverage: 0.8, cap: 0, observationDelay: 0, duration: 4}};
  const run = advanceRun(createRun({...base, events: [{id: 'clamped-coverage',
    type: 'coverage', time: 0, magnitude: 2, duration: 0.5, observationDelay: 0}]}), 0.125);
  const observation = planningProjection(run.state, run.config);
  assert.equal(observation.policy.coverage, 1);
  assert.deepEqual(observation.baseConditions, {coverage: 0.8, authorized: true, fundingShare: 0.02});
  assert.ok(run.state.planning.optimization.objective > 0,
    'expiry must return to baseline coverage 0.8, not the clamped current value 1');
});

test('R2 execution effects and declared baseline pass to every candidate; hidden events stay absent', () => {
  const events = [
    {id: 'observed-funding', type: 'funding', time: 0, magnitude: 20, duration: 0.5, observationDelay: 0},
    {id: 'hidden-authority', type: 'authority', time: 0, magnitude: 0, duration: 0.5, observationDelay: 10},
  ];
  const run = advanceRun(createRun({horizon: 2, events,
    resources: {policyEnergyShare: 0.2}}), 0.125);
  const observation = planningProjection(run.state, run.config);
  assert.equal(observation.policy.fundingShare, 1);
  assert.deepEqual(observation.baseConditions, {coverage: 0.9, authorized: true, fundingShare: 0.2});
  assert.deepEqual(observation.executionEffects.map(e => e.id), ['observed-funding']);
  selectPortfolio(observation, run.config, 1, query => {
    assert.deepEqual(query.observation.executionEffects, observation.executionEffects);
    assert.deepEqual(query.observation.baseConditions, observation.baseConditions);
    return {effectiveCompute: 1};
  });
});

test('R2 a known authority suspension expires against its declared baseline in C4', () => {
  const base = {horizon: 2, planner: 'optimizer', initial: {hardware: 1000, ageBands: [0]},
    policy: {mode: 'fixed', type: 'cap', start: 0, delay: 0, cost: 0, work: 0,
      coverage: 1, authorized: true, cap: 0, observationDelay: 0, duration: 4}};
  const runs = [0.5, 3].map(duration => advanceRun(createRun({...base,
    events: [{id: 'known-authority', type: 'authority', time: 0.125,
      magnitude: 0, duration, observationDelay: 0}]}), 0.125));
  for (const run of runs) {
    const observation = planningProjection(run.state, run.config);
    assert.equal(observation.policy.authorized, false);
    assert.equal(observation.baseConditions.authorized, true);
    assert.equal(observation.policy.reportedControls.length, 1);
  }
  const objectives = runs.map(run => stepRun({...run,
    state: {...run.state, nextDecision: run.state.t}}).state.planning.optimization.objective);
  assert.equal(objectives[0], 0);
  assert.ok(objectives[1] > 0);
});
