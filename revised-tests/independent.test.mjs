// Independent contract tests, written before revised/math.mjs and engine.mjs existed.
// Oracles are analytic solutions and invariants, not implementation replicas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityStep, humanStep, efficiency, support, energyPerBlock } from '../revised/math.mjs';
import { createRun, stepRun, advanceRun, finishRun, branchRun, saveCheckpoint, restoreCheckpoint } from '../revised/engine.mjs';
import { makeConfig } from '../revised/config.mjs';
import { demandPlan } from '../revised/planning.mjs';
import { initialAssetState, inspectAssets, requestProjects, advanceAssets } from '../revised/assets.mjs';

const ai = { growth: 0.13, researchReference: 100, researchElasticity: 0.7, difficulty: 0.8 };
const human = { growth: 0.017, maximumMortality: 0.31, exposureTime: 0.7 };
const near = (actual, expected, atol = 1e-9, rtol = 1e-9) => {
  assert.ok(Number.isFinite(actual), `nonfinite result: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= atol + rtol * Math.abs(expected),
    `actual=${actual}, expected=${expected}, delta=${actual - expected}`);
};

// Composite Simpson is used only for independent quadrature of the closed H(t).
function integral(f, end, n = 8192) {
  if (end === 0) return 0;
  const dx = end / n;
  let sum = f(0) + f(end);
  for (let i = 1; i < n; i += 1) sum += (i % 2 ? 4 : 2) * f(i * dx);
  return sum * dx / 3;
}

function humanOracle(initial, deficit, h, p) {
  const x = t => deficit + (initial.exposure - deficit) * Math.exp(-t / p.exposureTime);
  const H = t => initial.H * Math.exp((p.growth - p.maximumMortality * deficit) * t
    - p.maximumMortality * (initial.exposure - deficit) * p.exposureTime
    * (-Math.expm1(-t / p.exposureTime)));
  const personYears = integral(H, h);
  const candidates = [initial.H, H(h)];
  if (p.maximumMortality > 0 && initial.exposure !== deficit) {
    const ratio = (p.growth / p.maximumMortality - deficit) / (initial.exposure - deficit);
    const stationary = ratio > 0 ? -p.exposureTime * Math.log(ratio) : -1;
    if (stationary > 0 && stationary < h) candidates.push(H(stationary));
  }
  return {
    H: H(h), exposure: x(h), personYears, minPopulation: Math.min(...candidates),
    births: p.growth * personYears,
    extraDeaths: integral(t => p.maximumMortality * x(t) * H(t), h),
    shortagePersonYears: deficit * personYears,
  };
}

test('difficulty integrates a finite research dose without a capability ceiling', () => {
  for (const difficulty of [0, 0.15, 1, 2.3]) {
    for (const research of [0, 1, 430]) {
      const q0 = 2.4;
      const h = 3.7;
      const p = { ...ai, difficulty };
      const dose = p.growth * (research / p.researchReference) ** p.researchElasticity * h;
      const q1 = capabilityStep(q0, research, h, p);
      if (difficulty === 0) near(Math.log(q1 / q0), dose);
      else near((q1 ** difficulty - q0 ** difficulty) / difficulty, dose);
      near(capabilityStep(capabilityStep(q0, research, h / 3, p), research, 2 * h / 3, p), q1);
    }
  }
  const p = { ...ai, difficulty: 1 };
  const small = capabilityStep(1, 100, 10, p);
  const large = capabilityStep(1, 100, 100000, p);
  assert.ok(large > 100 * small, 'positive difficulty is not a finite upper bound');
});

test('frozen deficits match analytic exposure, population and gross death integrals', () => {
  for (const initial of [{ H: 8000, exposure: 0 }, { H: 6200, exposure: 0.83 }]) {
    for (const deficit of [0, 0.37, 1]) {
      for (const h of [0, 0.03, 0.8, 4]) {
        const expected = humanOracle(initial, deficit, h, human);
        const actual = humanStep(initial, deficit, h, human);
        for (const key of Object.keys(expected)) near(actual[key], expected[key], 2e-7, 2e-8);
        near(actual.H, initial.H + actual.births - actual.extraDeaths, 2e-7, 2e-8);
        assert.ok(actual.extraDeaths >= 0 && actual.personYears >= 0);
        assert.deepEqual(initial, initial.H === 8000 ? { H: 8000, exposure: 0 } : { H: 6200, exposure: 0.83 });
      }
    }
  }
});

test('recovery retains past exposure and counts simultaneous births and gross additional deaths', () => {
  const initial = { H: 8000, exposure: 0.8 };
  const h = 2;
  const actual = humanStep(initial, 0, h, human);
  assert.ok(actual.exposure > 0 && actual.exposure < initial.exposure);
  assert.ok(actual.extraDeaths > initial.H - actual.H, 'net population loss understates gross deaths');
  assert.ok(actual.births > 0 && actual.shortagePersonYears === 0);
  const first = humanStep(initial, 0, 0.7, human);
  const second = humanStep(first, 0, 1.3, human);
  near(second.H, actual.H, 1e-7);
  near(second.exposure, actual.exposure);
  for (const key of ['births', 'extraDeaths', 'personYears', 'shortagePersonYears']) {
    near(first[key] + second[key], actual[key], 3e-7, 3e-8);
  }
  near(Math.min(first.minPopulation, second.minPopulation), actual.minPopulation, 1e-7);
});

test('humanStep reports the exact within-interval minimum during recovery', () => {
  const p = { growth: 0.1, maximumMortality: 1, exposureTime: 0.01 };
  const value = humanStep({ H: 100, exposure: 1 }, 0, 1, p);
  near(value.minPopulation, 99.3324962790767);
  assert.ok(value.H > 100 && value.minPopulation < 100);
});

test('no instantaneous clipping at the onset of a critical shortage', () => {
  const initial = { H: 8000, exposure: 0 };
  const p = { ...human, growth: 0 };
  const a = humanStep(initial, 1, 1e-4, p);
  const b = humanStep(initial, 1, 5e-5, p);
  assert.ok(a.H > 7999.9999);
  near((initial.H - a.H) / (initial.H - b.H), 4, 0.002);
});

test('human support is normalized, increasing, bounded and unit-invariant', () => {
  const H0 = 8000;
  const K = 2000;
  near(support(H0, H0, K), 1);
  near(support(0, H0, K), 0);
  let previous = -1;
  for (const H of [0, 1, 1000, 8000, 16000, 1e12]) {
    const s = support(H, H0, K);
    assert.ok(s > previous && s <= (K + H0) / H0);
    near(support(H / 1000, H0 / 1000, K / 1000), s);
    previous = s;
  }
});

test('efficiency saturates while capability can continue to grow', () => {
  for (const maximum of [1, 2.8, 20]) {
    near(efficiency(1, maximum, 0.7), 1);
    let previous = 1;
    for (const q of [2, 20, 1e9]) {
      const value = efficiency(q, maximum, 0.7);
      assert.ok(value >= previous && value <= maximum);
      previous = value;
    }
  }
});

test('fixed work saves less than half the energy after a doubling when idle load is positive', () => {
  for (const idle of [0, 0.2, 0.7, 1]) {
    near(energyPerBlock(0, idle), 0.00876 * idle);
    near(energyPerBlock(1, idle), 0.00876);
    const before = energyPerBlock(0.8, idle);
    const fixedWork = energyPerBlock(0.4, idle);
    const fixedUtilisation = energyPerBlock(0.8, idle);
    near(fixedUtilisation, before);
    near(fixedWork / before, (idle + (1 - idle) * 0.4) / (idle + (1 - idle) * 0.8));
    if (idle > 0) assert.ok(fixedWork > before / 2);
    assert.ok(fixedWork <= before);
  }
});

test('fixed-work operation compensates attainable hardware performance loss while fixed utilisation does not', () => {
  const execute = (age, workloadMode) => stepRun(createRun({ horizon: 1, dt: 0.1,
    initial: { hardware: 1000, humanPower: 1000, aiPower: 0, ageBands: [age] },
    human: { criticalEnergy: 1e-9, criticalFloor: 1e-9, flexEnergy: 0, growth: 0, technologyRate: 0 },
    ai: { workloadMode, growth: 0, expansion: 0 },
    resources: { constructionEnergyShare: 0 },
    assets: { hardware: { life: 100, endPerformance: 0.8, maintenance: 0 },
      power: { life: 100, endPerformance: 1, maintenance: 0 },
      factory: { life: 100, endPerformance: 1, maintenance: 0 } },
    events: [], eventMode: 'off', policy: { mode: 'none' } }));
  const fresh = execute(0, 'fixed-work');
  const older = execute(0.5, 'fixed-work');
  near(fresh.state.last.poweredBlocks, older.state.last.poweredBlocks);
  near(fresh.state.last.effectiveCompute, older.state.last.effectiveCompute, 1e-8);
  assert.ok(older.state.last.utilisation > fresh.state.last.utilisation);
  const fixedUtilisation = execute(0.5, 'fixed-utilisation');
  assert.ok(fixedUtilisation.state.last.effectiveCompute < older.state.last.effectiveCompute);
});

test('the public engine retains no-AI human dynamics and completes the requested interval', () => {
  const run = createRun({ horizon: 3, dt: 0.1, aiEnabled: false, events: [], eventMode: 'off' });
  const initialH = run.state.H;
  const before = saveCheckpoint(run);
  const finished = finishRun(run);
  assert.equal(saveCheckpoint(run), before, 'finishRun must preserve its input');
  near(finished.state.t, 3);
  near(finished.state.q, run.config.initial.q);
  assert.ok(finished.state.H > 0 && finished.state.H <= initialH * Math.exp(run.config.human.growth * 3) * (1 + 1e-8));
  assert.ok(Array.isArray(finished.state.history) && finished.state.history.length > 1);
});

test('source-derived energy, installed compute, project work and materials independently constrain the ledger', () => {
  const initial = createRun({ horizon: 2, dt: 0.1, events: [], eventMode: 'off', policy: { mode: 'none' } });
  const run = stepRun(initial);
  const ledger = run.state.last.ledger;
  const c = initial.config;
  const effective = (a, at) => {
    const spec = c.assets[a.kind];
    const age = at - a.birth;
    return age < 0 || age >= spec.life ? 0 : a.rated * (1 - (1 - spec.endPerformance) * age / spec.life);
  };
  const initialAssets = initial.state.assetState.assets;
  const sourcePower = initialAssets.filter(a => a.kind === 'power')
    .reduce((s, a) => s + effective(a, 0), 0);
  near(ledger.available, sourcePower * initial.state.maintenanceFactor * ledger.h);
  near(ledger.operation, ledger.poweredBlocks * energyPerBlock(ledger.utilisation, c.ai.idleFraction) * ledger.h);
  const hardware = initialAssets.filter(a => a.kind === 'hardware');
  const blocks = hardware.reduce((s, a) => s + a.rated, 0);
  assert.ok(ledger.poweredBlocks <= blocks + 1e-9 && ledger.poweredBlocks >= 0);
  const compute = hardware.reduce((s, a) => s + effective(a, 0) * a.hardwareEfficiency, 0)
    * ledger.poweredBlocks / blocks * ledger.utilisation;
  near(run.state.last.effectiveCompute, compute, 1e-8);
  const dose = c.ai.growth * (compute * c.ai.researchFraction / c.ai.researchReference) ** c.ai.researchElasticity * ledger.h;
  near((run.state.q ** c.ai.difficulty - initial.state.q ** c.ai.difficulty) / c.ai.difficulty, dose);
  near(ledger.construction, run.state.assetState.accounts.energySpent - initial.state.assetState.accounts.energySpent);
  near(ledger.constructionWork, run.state.assetState.accounts.workDone - initial.state.assetState.accounts.workDone);
  assert.ok(ledger.constructionWork + ledger.maintenanceWork + ledger.policyWork <= ledger.workAvailable + 1e-7);
  const expenditure = ['humanCritical', 'humanFlexible', 'operation', 'maintenance', 'construction', 'policy', 'unused']
    .reduce((s, key) => s + ledger[key], 0);
  near(expenditure, ledger.available, 1e-7);
  const physical = run.state.assetState;
  const embodied = physical.assets.filter(a => !a.cleared).reduce((s, a) => s + a.materials, 0);
  const pending = physical.projects.filter(p => p.status === 'pending' && ['power', 'factory', 'hardware'].includes(p.kind))
    .reduce((s, p) => s + p.materials, 0);
  const endowment = c.resources.materials + initialAssets.reduce((s, a) => s + a.materials, 0);
  near(physical.materials + embodied + pending + physical.accounts.materialsDisposed, endowment, 1e-7);
});

test('branch and checkpoint preserve exposure and deterministic continuation without resetting physical state', () => {
  const initial = createRun({ horizon: 6, dt: 0.1, alignment: 0, policy: { mode: 'none' }, eventMode: 'off', events: [] });
  const initialEncoded = saveCheckpoint(initial);
  const run = advanceRun(initial, 2.3);
  assert.equal(saveCheckpoint(initial), initialEncoded, 'advanceRun must preserve its input');
  const encoded = saveCheckpoint(run);
  const checkpoint = restoreCheckpoint(encoded);
  const branch = branchRun(run, { mode: 'none' });
  for (const key of ['t', 'H', 'q', 'exposure']) {
    near(checkpoint.state[key], run.state[key]);
    near(branch.state[key], run.state[key]);
  }
  assert.deepEqual(branch.state.assetState, run.state.assetState);
  assert.notEqual(branch.state, run.state);
  const finished = finishRun(run);
  const replay = finishRun(checkpoint);
  const branched = finishRun(branch);
  for (const key of ['t', 'H', 'q', 'exposure']) {
    near(replay.state[key], finished.state[key], 1e-8, 1e-11);
    near(branched.state[key], finished.state[key], 1e-8, 1e-11);
  }
});

test('minimum population includes an interior recovery minimum, not only interval endpoints', () => {
  const initial = createRun({ horizon: 2, dt: 1, alignment: 0,
    // This recovery witness deliberately uses the earlier operating claim rule:
    // AI growth is zero, so the marginal-growth rule would prioritise humans.
    priority: { operatingMode: 'legacy' },
    initial: { H: 100, humanPower: 500, aiPower: 0, hardware: 100000, ageBands: [0] },
    human: { growth: 0.1, maximumMortality: 1, exposureTime: 0.01, technologyRate: 0 },
    ai: { growth: 0, expansion: 0, competitionWeight: 100 },
    resources: { constructionEnergyShare: 0 },
    assets: { hardware: { life: 100, endPerformance: 1, maintenance: 0 },
      power: { life: 100, endPerformance: 1, maintenance: 0 },
      factory: { life: 100, endPerformance: 1, maintenance: 0 } },
    events: [], eventMode: 'off', policy: { mode: 'none' } });
  const harmed = advanceRun(initial, 1);
  const recovered = finishRun(branchRun(harmed, { mode: 'fixed', type: 'shutdown', start: 1,
    delay: 0, cost: 0, work: 0, success: 1, coverage: 1, residual: 0 }));
  near(recovered.state.last.deficit, 0);
  const p = harmed.config.human;
  const turningTime = p.exposureTime * Math.log(p.maximumMortality * harmed.state.exposure / p.growth);
  assert.ok(turningTime > 0 && turningTime < 1);
  const expected = harmed.state.H * Math.exp(p.growth * turningTime
    - p.maximumMortality * harmed.state.exposure * p.exposureTime * (-Math.expm1(-turningTime / p.exposureTime)));
  assert.ok(expected < harmed.state.H && recovered.state.H > harmed.state.H);
  near(recovered.state.accounts.minPopulation, expected, 1e-7, 1e-8);
});

test('malformed checkpoint states are rejected', () => {
  assert.throws(() => restoreCheckpoint('{}'));
  assert.throws(() => restoreCheckpoint('{'));
  assert.throws(() => restoreCheckpoint(JSON.stringify({ version: '2.0.0', state: { H: -1, t: 0 } })));
  const valid = JSON.parse(saveCheckpoint(stepRun(createRun({ horizon: 2 }))));
  for (const corrupt of [
    r => { r.state.H = -1; },
    r => { r.state.H *= 2; },
    r => { r.state.exposure = 1.01; },
    r => { r.state.assetState.materials += 1; },
    r => { r.sourceDigest = 'different-numerical-source'; },
    r => { r.unrecognizedState = true; },
  ]) {
    const changed = structuredClone(valid);
    corrupt(changed);
    assert.throws(() => restoreCheckpoint(JSON.stringify(changed)), 'a valid-schema but inconsistent state must reject');
  }
});

test('old manufacturing backlog still demands factories when there are no net-new hardware orders', () => {
  const config = makeConfig({ ai: { adjustmentTime: 1, planningWindow: 10, expansion: 0 },
    assets: { factoryProductivity: 2, factory: { delay: 0, endPerformance: 1, life: 100, work: 1 } } });
  const obs = {
    t: 0, H: config.initial.H, q: 1,
    technology: { hardware: 1, manufacturing: 1, land: 1, power: 1 },
    assets: [], resources: { land: 1e8, materials: 1e8 },
    human: { powerNeed: 0, factoryWorkNeed: 0 }, ai: { desiredHardware: 0 }, policy: {},
    projects: [{ id: 'old-order', kind: 'hardware', owner: 'ai', amount: 50,
      remainingWork: 40, commissionAt: 2 }],
  };
  const plan = demandPlan(obs, config, 1);
  const total = (p, kind) => p.requests.filter(r => r.owner === 'ai' && r.kind === kind)
    .reduce((s, r) => s + r.amount, 0);
  near(total(plan, 'hardware'), 0);
  assert.ok(total(plan, 'factory') > 0, 'committed work cannot disappear with net-new orders');
  const heavier = demandPlan({ ...obs, projects: [{ ...obs.projects[0], remainingWork: 80 }] }, config, 1);
  assert.ok(total(heavier, 'factory') > total(plan, 'factory'));
});

function emptyAssetConfig() {
  return makeConfig({
    initial: { hardware: 0, humanPower: 0, aiPower: 0, humanFactories: 0, aiFactories: 0 },
    resources: { land: 1e6, materials: 1e6 },
    assets: { power: { life: 50, endPerformance: 1, delay: 2, energy: 4, work: 6, materials: 1, land: 10, maintenance: 0 } },
  });
}

test('paid progress cannot commission power before its lead time or retroactively alter prior output', () => {
  const config = emptyAssetConfig();
  const initial = initialAssetState(config);
  const requested = requestProjects(initial, [{ id: 'delayed-power', kind: 'power', owner: 'human', amount: 1 }], 0, config);
  const paid = advanceAssets(requested, 0, 1, { energy: 100, work: 100 }, config);
  assert.ok(paid.energyUsed > 0 && paid.workUsed > 0);
  near(inspectAssets(paid.state, 1, config).humanPower, 0);
  const commissioned = advanceAssets(paid.state, 1, 1, { energy: 0, work: 0 }, config);
  near(inspectAssets(commissioned.state, 2, config).humanPower, 1);
  near(inspectAssets(paid.state, 1, config).humanPower, 0, 1e-12);
  near(commissioned.energyUsed, 0);
  near(commissioned.workUsed, 0);
});

test('land savings on a new order leave an older cohort footprint unchanged', () => {
  const config = emptyAssetConfig();
  const old = requestProjects(initialAssetState(config), [{ id: 'old-land', kind: 'power', owner: 'human', amount: 1 }], 0, config);
  const built = advanceAssets(old, 0, 2, { energy: 100, work: 100 }, config).state;
  const baseline = inspectAssets(built, 2, config);
  near(baseline.landOccupied, 10);
  const improved = requestProjects(built, [{ id: 'new-land', kind: 'power', owner: 'human', amount: 1,
    landMultiplier: 0.5 }], 2, config);
  near(inspectAssets(improved, 2, config).landOccupied, 10);
  const result = advanceAssets(improved, 2, 2, { energy: 100, work: 100 }, config).state;
  near(inspectAssets(result, 4, config).landOccupied, 15);
  near(inspectAssets(built, 2, config).landOccupied, baseline.landOccupied);
});

test('the integrated engine cannot bridge a retirement gap using uncommissioned power', () => {
  const initial = createRun({ horizon: 3, dt: 0.25,
    initial: { H: 1, humanPower: 100, aiPower: 0, hardware: 10000, ageBands: [0.85] },
    assets: { power: { life: 10, delay: 2 } },
    policy: { mode: 'none' }, events: [], eventMode: 'off' });
  const beforeRetirement = advanceRun(initial, 1);
  assert.ok(beforeRetirement.state.assetState.projects.some(p => p.kind === 'power' && p.progress > 0),
    'fixture must actually pay toward a replacement');
  const gap = advanceRun(beforeRetirement, 0.75);
  near(gap.state.t, 1.75);
  near(inspectAssets(gap.state.assetState, gap.state.t, gap.config).power, 0, 1e-10);
  assert.ok(!gap.state.assetState.assets.some(a => a.kind === 'power' && a.birth > 0),
    'no order placed at or after zero can commission before year two');
});

test('constant-rate construction finance commissions at its exact paid boundary across time steps', () => {
  const expectedAmount = (100 * (1.5 + 1) - 100) * (-Math.expm1(-1 / 2));
  const expectedTime = expectedAmount / (100 * 0.15);
  for (const dt of [0.2, 0.1, 0.05, 0.025]) {
    const run = finishRun(createRun({ horizon: 5, dt, aiEnabled: false, alignment: 0,
      initial: { H: 100, hardware: 0, humanPower: 100, aiPower: 0, humanFactories: 10, aiFactories: 0, ageBands: [0] },
      human: { growth: 0, maximumMortality: 0, technologyRate: 0, criticalEnergy: 1.5, criticalFloor: 1.5, flexEnergy:1 },
      resources: { constructionEnergyShare: 0.15 },
      assets: { power: { life: 100, endPerformance: 1, delay: 0, energy: 1, work: 40, maintenance: 0 },
        factory: { life: 100, endPerformance: 1, maintenance: 0 }, hardware: { maintenance: 0 } },
      policy: { mode: 'none' }, events: [], eventMode: 'off' }));
    const first = run.state.assetState.projects.find(p => p.requestId === 'plan:0:human:power');
    near(first.amount, expectedAmount);
    assert.equal(first.status, 'completed');
    near(first.completedAt, expectedTime, 5e-8, 1e-9);
  }
});

test('no-AI retains commissioned human replacements after the original power lifetime', () => {
  const run = finishRun(createRun({ horizon: 55, dt: 0.2, aiEnabled: false, policy: { mode: 'none' }, events: [], eventMode: 'off' }));
  assert.ok(run.state.assetState.assets.some(a => a.owner === 'human' && a.kind === 'power' && a.birth > 0),
    'no-AI comparator needs a real human replacement channel');
  assert.ok(run.state.H > 0 && run.state.q === run.config.initial.q);
});

test('the no-AI counterfactual preserves initial power and factory output by transferring ownership', () => {
  const withAI = createRun({ horizon: 2, aiEnabled: true });
  const withoutAI = createRun({ horizon: 2, aiEnabled: false });
  const a = inspectAssets(withAI.state.assetState, 0, withAI.config);
  const b = inspectAssets(withoutAI.state.assetState, 0, withoutAI.config);
  near(a.power, b.power);
  near(a.factoryWork, b.factoryWork);
  near(b.aiPower, 0);
  near(b.aiFactoryWork, 0);
  near(b.hardware, 0);
  near(b.humanPower, a.power);
  near(b.humanFactoryWork, a.factoryWork);
});

test('changing an unobserved future event cannot alter the present controller or physical state', () => {
  for (const planner of ['demand', 'optimizer']) {
    const options = { horizon: 10, dt: 0.25, planner, eventMode: 'off',
      policy: { mode: 'anticipatory' }, seed: 413 };
    const a = advanceRun(createRun({ ...options, events: [] }), 2);
    const b = advanceRun(createRun({ ...options, events: [{ id: 'future-secret', type: 'algorithm', time: 8,
      magnitude: 4, observationDelay: 1, adoptionDelay: 1, adoptionEnergy: 2, adoptionWork: 1 }] }), 2);
    for (const key of ['t', 'H', 'q', 'exposure']) near(a.state[key], b.state[key]);
    assert.deepEqual(a.state.assetState, b.state.assetState);
    assert.deepEqual(a.state.policyState, b.state.policyState);
    assert.deepEqual(a.state.accounts, b.state.accounts);
  }
});

test('annual exogenous event draws remain paired across policy branches and checkpoint replay', () => {
  const initial = advanceRun(createRun({ horizon: 5, dt: 0.25, seed: 83,
    policy: { mode: 'none' }, events: [], eventMode: 'annual', annualProbability: 1 }), 1.5);
  const branch = branchRun(initial, { mode: 'fixed', type: 'shutdown', start: 2,
    delay: 0, cost: 0, work: 0, success: 0.5 });
  const run = finishRun(initial);
  const alternate = finishRun(branch);
  const replay = finishRun(restoreCheckpoint(saveCheckpoint(branch)));
  assert.deepEqual(alternate.state.eventState.schedule, run.state.eventState.schedule);
  assert.deepEqual(replay.state.eventState, alternate.state.eventState);
  assert.equal(alternate.state.eventState.rngState, run.state.eventState.rngState);
  for (const key of ['t', 'H', 'q', 'exposure']) near(replay.state[key], alternate.state[key]);
});
