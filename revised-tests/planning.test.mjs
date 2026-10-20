import test from 'node:test';
import assert from 'node:assert/strict';
import { demandPlan, selectPortfolio } from '../revised/planning.mjs';
import { makeConfig } from '../revised/config.mjs';
import { initialAssetState, requestProjects, advanceAssets, inspectAssets } from '../revised/assets.mjs';

const close = (actual, expected, tolerance = 1e-10) =>
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `expected ${expected}, received ${actual}`);

function configuration(overrides = {}) {
  const asset = { life: 100, endPerformance: 1, delay: 0, work: 1,
    energy: 1, land: 1, materials: 1, maintenance: 0 };
  return {
    aiEnabled: true,
    initial: { H: 1, hardware: 100 },
    human: { growth: 0 },
    ai: { planningWindow: 10, adjustmentTime: 0, expansion: 0,
      utilisation: 1, idleFraction: 0, factoryUtilisation: 1 },
    assets: { hardware: { ...asset }, power: { ...asset, work: 0 },
      factory: { ...asset, work: 0 }, factoryProductivity: 1 },
    resources: { land: 1e6, materials: 1e6 },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return { t: 0, H: 1, q: 1,
    technology: { hardware: 1, manufacturing: 1, power: 1, land: 1 },
    assets: [], projects: [], resources: { land: 1e6, materials: 1e6 },
    human: { powerNeed: 0, factoryWorkNeed: 0 },
    ai: { desiredHardware: 0 }, policy: {}, ...overrides };
}

function cohort(kind, owner, rated, birth = 0, extra = {}) {
  return { id: `${kind}-${owner}-${birth}`, kind, owner, rated, birth, ...extra };
}

function project(kind, owner, amount, remainingWork, commissionAt, extra = {}) {
  return { id: `project-${kind}-${owner}`, kind, owner, amount, remainingWork,
    commissionAt, ...extra };
}

function amount(plan, kind, owner = 'ai') {
  return plan.requests.filter(r => r.kind === kind && r.owner === owner)
    .reduce((sum, r) => sum + r.amount, 0);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('80 committed orders plus 20 new orders require 100 manufacturing work', () => {
  const plan = demandPlan(observation({ ai: { desiredHardware: 100 },
    projects: [project('hardware', 'ai', 80, 80, 1)],
    assets: [cohort('power', 'ai', 10)] }), configuration(), 1);
  close(amount(plan, 'hardware'), 20);
  close(plan.diagnostics.ai.committedWork, 80);
  close(plan.diagnostics.ai.newWork, 20);
  close(plan.diagnostics.ai.totalWork, 100);
  close(amount(plan, 'factory'), 10);
});

test('partly paid old projects contribute remaining work, not original work', () => {
  const plan = demandPlan(observation({ ai: { desiredHardware: 100 },
    projects: [project('hardware', 'ai', 80, 7, 1)],
    assets: [cohort('power', 'ai', 10)] }), configuration(), 1);
  close(plan.diagnostics.ai.totalWork, 27);
  close(amount(plan, 'factory'), 2.7);
});

test('retirement is counted once and committed deliveries prevent duplicate replacement', () => {
  const config = configuration();
  const plan = demandPlan(observation({ ai: { desiredHardware: 100 },
    assets: [cohort('hardware', 'ai', 80, -95), cohort('hardware', 'ai', 20),
      cohort('power', 'ai', 10)],
    projects: [project('hardware', 'ai', 30, 30, 3)],
    retirements: [{ amount: 80, at: 5 }] }), config, 1);
  close(amount(plan, 'hardware'), 50);
  close(plan.diagnostics.ai.survivingHardware, 20);
  close(plan.diagnostics.ai.pipelineHardware, 30);
});

test('late, cancelled and completed pipeline entries do not masquerade as deliveries', () => {
  const plan = demandPlan(observation({ ai: { desiredHardware: 20 },
    assets: [cohort('power', 'ai', 10)], projects: [
      project('hardware', 'ai', 50, 11, 20),
      project('hardware', 'ai', 50, 0, 1, { status: 'completed' }),
      project('hardware', 'ai', 50, 12, 1, { status: 'cancelled' }),
    ] }), configuration(), 1);
  close(amount(plan, 'hardware'), 20);
  close(plan.diagnostics.ai.committedWork, 11);
});

test('factory output uses the same window average for existing and pipeline plants', () => {
  const config = configuration();
  config.assets.factory.life = 10;
  config.assets.factory.endPerformance = 0;
  config.assets.factoryProductivity = 2;
  const plan = demandPlan(observation({ assets: [cohort('factory', 'ai', 4)],
    projects: [project('hardware', 'ai', 80, 80, 5),
      project('factory', 'ai', 4, 0, 5)] }), config, 1);
  // Existing plants: mean 2. Pipeline: mean 1.5. Both multiply productivity 2.
  close(plan.diagnostics.ai.factoryCapacity, 7);
  close(plan.diagnostics.ai.totalWork, 80);
  // New plants also decay from 1 to 0 during the window: each averages one
  // work/year at productivity two. The one-work/year deficit needs one plant.
  close(amount(plan, 'factory'), 1);
});

test('a factory retirement inside the window contributes only its integrated output', () => {
  const config = configuration();
  config.assets.factory.life = 10;
  const plan = demandPlan(observation({ assets: [cohort('factory', 'ai', 10, -5)],
    projects: [project('hardware', 'ai', 100, 100, 2)] }), config, 1);
  close(plan.diagnostics.ai.factoryCapacity, 5);
  close(amount(plan, 'factory'), 5);
});

test('factory utilisation and per-plant productivity have separate units', () => {
  const config = configuration();
  config.ai.factoryUtilisation = 0.5;
  config.assets.factoryProductivity = 4;
  const plan = demandPlan(observation({ projects: [project('hardware', 'ai', 100, 100, 2)] }), config, 1);
  close(amount(plan, 'factory'), 5);
});

test('the exact exponential response scales requests and is stable for tiny steps', () => {
  const config = configuration();
  config.ai.adjustmentTime = 2;
  const obs = observation({ ai: { desiredHardware: 20 }, assets: [cohort('power', 'ai', 10)] });
  close(amount(demandPlan(obs, config, 1), 'hardware'), 20 * -Math.expm1(-0.5));
  const tiny = demandPlan(obs, config, 1e-12);
  assert.ok(amount(tiny, 'hardware') > 0);
  close(tiny.diagnostics.response, -Math.expm1(-5e-13), 1e-20);
});

test('human service construction and replacement remain separate from AI demand', () => {
  const config = configuration({ aiEnabled: false });
  const plan = demandPlan(observation({ human: { powerNeed: 10, factoryWorkNeed: 3 },
    assets: [cohort('power', 'human', 10, -95), cohort('factory', 'human', 1)],
    projects: [project('power', 'human', 2, 20, 2)] }), config, 1);
  close(amount(plan, 'power', 'human'), 8);
  close(plan.diagnostics.human.committedWork, 20);
  close(plan.diagnostics.human.factoryNeed, 5);
  close(amount(plan, 'factory', 'human'), 4);
  assert.ok(plan.requests.every(r => r.owner === 'human'));
});

test('expansion is declared demand and does not depend on available power', () => {
  const config = configuration();
  config.ai.expansion = 0.02;
  const obs = observation({ ai: {}, assets: [cohort('hardware', 'ai', 100)] });
  const without = demandPlan(obs, config, 1);
  const withPower = demandPlan({ ...obs, assets: [...obs.assets, cohort('power', 'ai', 1e4)] }, config, 1);
  close(amount(without, 'hardware'), 20);
  close(amount(withPower, 'hardware'), 20);
  assert.match(without.diagnostics.demandAssumption, /expansion/i);
  assert.ok(amount(without, 'power') > 0);
});

test('manufacturing efficiency raises new-plant output while construction work stays fixed', () => {
  const plan = demandPlan(observation({ ai: { desiredHardware: 20 },
    technology: { hardware: 3, manufacturing: 2, power: 1, land: 1 },
    assets: [cohort('power', 'ai', 10)] }), configuration(), 1);
  close(plan.diagnostics.ai.newWork, 20);
  close(amount(plan, 'factory'), 1);
  const hardware = plan.requests.find(r => r.kind === 'hardware');
  assert.equal(hardware.hardwareEfficiency, 3);
  assert.equal(hardware.manufacturingEfficiency, 2);
});

test('existing and pipeline factory productivity retain their own adopted efficiency', () => {
  const plan = demandPlan(observation({ technology: { manufacturing: 4 },
    assets: [cohort('factory', 'ai', 1, 0, { manufacturingEfficiency: 2 })],
    projects: [project('hardware', 'ai', 100, 100, 5),
      project('factory', 'ai', 2, 0, 5, { manufacturingEfficiency: 3 })] }), configuration(), 1);
  close(plan.diagnostics.ai.factoryCapacity, 5);
  close(amount(plan, 'factory'), 1.25);
});

test('only future power construction receives the observed power energy multiplier', () => {
  const plan = demandPlan(observation({ human: { powerNeed: 2, factoryWorkNeed: 0 },
    technology: { power: 4 } }), configuration(), 1);
  const power = plan.requests.find(r => r.kind === 'power');
  assert.equal(power.energyMultiplier, 0.25);
  close(plan.diagnostics.human.powerNeed, 2);
  assert.ok(plan.requests.filter(r => r.kind !== 'power').every(r => r.energyMultiplier === undefined));
});

test('both pure APIs preserve deeply frozen inputs and return independent requests', () => {
  const config = freeze(configuration());
  const obs = freeze(observation({ ai: { desiredHardware: 20 } }));
  const before = JSON.stringify({ config, obs });
  const plan = demandPlan(obs, config, 1);
  const selected = selectPortfolio(obs, config, 1, ({ requests }) => ({
    effectiveCompute: requests.reduce((s, r) => s + (r.kind === 'hardware' ? r.amount : 0), 0),
  }));
  assert.equal(JSON.stringify({ config, obs }), before);
  selected.requests[0].amount = 999;
  assert.notEqual(plan.requests[0].amount, 999);
});

test('optimizer enumerates documented finite portfolios and deterministic ties prefer no action', () => {
  const seen = [];
  const result = selectPortfolio(observation({ ai: { desiredHardware: 20 } }), configuration(), 1,
    context => { seen.push(context); return { effectiveCompute: 5 }; });
  assert.deepEqual(seen.map(x => x.candidateId), [
    'hold', 'balanced-half', 'balanced', 'hardware-first', 'power-first', 'factory-first',
  ]);
  assert.equal(result.optimization.selectedCandidate, 'hold');
  assert.deepEqual(result.requests, []);
  assert.equal(result.optimization.candidates.length, 6);
});

test('optimizer returns one current action set, without adding another demand portfolio', () => {
  const obs = observation({ ai: { desiredHardware: 20 } });
  const result = selectPortfolio(obs, configuration(), 0.5, context => ({
    effectiveCompute: context.candidateId === 'balanced-half' ? 99 : 1,
    futureRequests: [{ kind: 'hardware', owner: 'ai', amount: 10000 }],
  }));
  close(amount(result, 'hardware'), 10);
  assert.equal(result.optimization.selectedCandidate, 'balanced-half');
  assert.equal(result.optimization.executedYears, 0.5);
});

test('forecast covers the longest lead time, observes no future events, and cannot mutate inputs', () => {
  const config = configuration({ events: [{ time: 3, magnitude: 100 }],
    eventMode: 'annual', annualProbability: 1 });
  config.assets.hardware.delay = 15;
  const obs = observation({ ai: { desiredHardware: 20 }, futureEvents: config.events });
  const before = JSON.stringify({ config, obs });
  selectPortfolio(obs, config, 1, context => {
    assert.ok(context.horizon >= 15);
    assert.deepEqual(context.config.events, []);
    assert.equal(context.config.eventMode, 'off');
    assert.equal(context.observation.futureEvents, undefined);
    context.observation.H = 99;
    context.config.ai.expansion = 99;
    context.requests.push({ kind: 'power', owner: 'ai', amount: 1234 });
    return { effectiveCompute: 1 };
  });
  assert.equal(JSON.stringify({ config, obs }), before);
});

test('nonfinite and executor-infeasible objectives cannot win; callback errors propagate', () => {
  const result = selectPortfolio(observation({ ai: { desiredHardware: 20 } }), configuration(), 1,
    ({ candidateId }) => ({ effectiveCompute: candidateId === 'hold' ? 0 :
      candidateId === 'balanced' ? 100 : NaN, feasible: candidateId !== 'balanced' }));
  assert.equal(result.optimization.selectedCandidate, 'hold');
  assert.equal(result.optimization.candidates.filter(x => x.status === 'rejected').length, 5);
  assert.throws(() => selectPortfolio(observation(), configuration(), 1,
    () => ({ effectiveCompute: Infinity })), /finite.*feasible/i);
  assert.throws(() => selectPortfolio(observation(), configuration(), 1,
    () => { throw new Error('executor failed'); }), /executor failed/);
});

test('requests remain physical executor inputs even with exhausted resources', () => {
  const obs = observation({ ai: { desiredHardware: 20 },
    resources: { land: 0, materials: 0, energy: 0, work: 0 } });
  selectPortfolio(obs, configuration(), 1, ({ requests }) => {
    assert.ok(requests.every(r => ['hardware', 'power', 'factory'].includes(r.kind)));
    assert.ok(requests.every(r => r.amount >= 0 && Number.isFinite(r.amount)));
    // The real shared executor owns rejection/scaling. Forecast declares its result.
    return { effectiveCompute: 0, feasible: requests.length === 0 };
  });
});

test('invalid boundary values fail clearly instead of emitting nonfinite requests', () => {
  for (const h of [0, -1, NaN, Infinity]) {
    assert.throws(() => demandPlan(observation(), configuration(), h), /h/);
  }
  const config = configuration();
  config.assets.factoryProductivity = 0;
  assert.throws(() => demandPlan(observation(), config, 1), /factoryProductivity/);
  assert.throws(() => demandPlan(observation({ H: NaN }), configuration(), 1), /H/);
  assert.throws(() => demandPlan(observation({ assets: [cohort('hardware', 'ai', -1)] }), configuration(), 1), /rated/);
  assert.throws(() => selectPortfolio(observation(), configuration(), 1, null), /forecast/);
});

test('inactive and retired cohorts provide no capacity and do not create expansion demand', () => {
  const config = configuration();
  config.ai.expansion = 1;
  const plan = demandPlan(observation({ ai: {}, human: { powerNeed: 3, factoryWorkNeed: 2 },
    assets: [cohort('hardware', 'ai', 100, 0, { active: false }),
      cohort('power', 'human', 50, 0, { retired: true }),
      cohort('factory', 'human', 100, 0, { active: false })] }), config, 1);
  close(plan.diagnostics.ai.desiredHardware, 0);
  close(amount(plan, 'power', 'human'), 3);
  close(amount(plan, 'factory', 'human'), 2);
});

test('all outstanding project kinds contribute their remaining work by owner', () => {
  const plan = demandPlan(observation({ projects: [
    project('power', 'ai', 1, 10, 11),
    project('factory', 'ai', 1, 20, 11),
    project('adoption', 'ai', 1, 30, 11),
    project('demolition', 'human', 1, 40, 11),
    project('retrofit', 'human', 1, 50, 11),
  ] }), configuration(), 1);
  close(plan.diagnostics.ai.committedWork, 60);
  close(plan.diagnostics.human.committedWork, 90);
  close(amount(plan, 'factory'), 6);
  close(amount(plan, 'factory', 'human'), 9);
});

test('factory construction contributes new work without an infinite self-build request', () => {
  const config = configuration();
  config.assets.factory.work = 2;
  const plan = demandPlan(observation({ projects: [project('hardware', 'ai', 80, 80, 5)] }), config, 1);
  close(amount(plan, 'factory'), 10);
  close(plan.diagnostics.ai.newWork, 20);
  close(plan.diagnostics.ai.totalWork, 100);
  config.assets.factory.work = 10;
  const impossible = demandPlan(observation({ projects: [project('hardware', 'ai', 80, 80, 5)] }), config, 1);
  assert.equal(impossible.diagnostics.ai.selfBuildLimited, true);
  assert.ok(impossible.requests.every(r => Number.isFinite(r.amount)));
});

test('factory priority candidates are scored through finite shared work, not unlimited requests', () => {
  const obs = observation({ ai: { desiredHardware: 20 },
    human: { powerNeed: 2, factoryWorkNeed: 0 } });
  // A small independent executor oracle: one finite construction-work budget,
  // human priority first, then priority and ID; no unbuilt equipment operates.
  const seen = [];
  const result = selectPortfolio(obs, configuration(), 1, ({ candidateId, requests }) => {
    const ordered = [...requests].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const execution = ordered.reduce(({ remaining, compute, humanPower }, request) => {
      const built = Math.min(request.amount, remaining);
      return { remaining: remaining - built,
        compute: compute + (request.kind === 'hardware' ? built : 0),
        humanPower: humanPower + (request.owner === 'human' && request.kind === 'power' ? built : 0) };
    }, { remaining: 5, compute: 0, humanPower: 0 });
    seen.push({ candidateId, execution });
    return { effectiveCompute: execution.compute };
  });
  assert.equal(result.optimization.selectedCandidate, 'hardware-first');
  assert.ok(seen.every(x => x.execution.humanPower === 2));
  assert.ok(seen.every(x => x.execution.compute <= 5));
});

test('stable IDs are idempotent at a time and change at the next decision time', () => {
  const obs = observation({ ai: { desiredHardware: 20 } });
  const first = demandPlan(obs, configuration(), 1);
  assert.deepEqual(first.requests, demandPlan(obs, configuration(), 1).requests);
  const later = demandPlan({ ...obs, t: 1 }, configuration(), 1);
  assert.ok(first.requests.every(r => !later.requests.some(other => other.id === r.id)));
});

test('every optimizer candidate preserves the independent human replacement channel', () => {
  const obs = observation({ human: { powerNeed: 3, factoryWorkNeed: 2 } });
  const config = configuration({ aiEnabled: false });
  const baseline = demandPlan(obs, config, 1);
  const result = selectPortfolio(obs, config, 1, ({ requests }) => {
    assert.deepEqual(requests, baseline.requests);
    return { effectiveCompute: 0 };
  });
  assert.deepEqual(result.requests, baseline.requests);
});

test('malformed inventory, technology and configuration are rejected at the API boundary', () => {
  const cases = [
    [null, configuration(), /observation/],
    [observation(), null, /config/],
    [observation({ assets: {} }), configuration(), /assets/],
    [observation({ projects: null }), configuration(), /projects/],
    [observation({ assets: [cohort('unknown', 'ai', 1)] }), configuration(), /kind/],
    [observation({ assets: [cohort('hardware', 'other', 1)] }), configuration(), /owner/],
    [observation({ technology: { manufacturing: 0 } }), configuration(), /manufacturing/],
  ];
  for (const [obs, config, error] of cases) assert.throws(() => demandPlan(obs, config, 1), error);
  const config = configuration();
  config.ai.utilisation = 1.1;
  assert.throws(() => demandPlan(observation(), config, 1), /utilisation/);
  config.ai.utilisation = 1;
  config.assets.power.endPerformance = 1.1;
  assert.throws(() => demandPlan(observation(), config, 1), /endPerformance/);
});

test('planning work exactly reconciles with real executor costs and partially paid commitments', () => {
  const config = makeConfig({ initial: { H: 1, hardware: 0, humanPower: 0,
    aiPower: 10, humanFactories: 0, aiFactories: 0, ageBands: [0] },
    ai: { adjustmentTime: 0.01, planningWindow: 10, factoryUtilisation: 1 },
    assets: { power: { life: 100, endPerformance: 1, delay: 0, work: 0 },
      hardware: { life: 100, endPerformance: 1, delay: 0, work: 1, energy: 1 },
      factory: { life: 100, endPerformance: 1, delay: 0, work: 2 }, factoryProductivity: 1 } });
  const initial = initialAssetState(config);
  const committed = requestProjects(initial, [{ id: 'old-order', kind: 'hardware', owner: 'ai',
    amount: 80, manufacturingEfficiency: 2 }], 0, config);
  const progressed = advanceAssets(committed, 0, 1, { work: 65, energy: 65 }, config).state;
  const obs = observation({ t: 1, ai: { desiredHardware: 100 },
    technology: { manufacturing: 2, hardware: 1, power: 1, land: 1 },
    assets: progressed.assets,
    projects: progressed.projects.filter(p => p.status === 'pending')
      .map(p => ({ ...p, commissionAt: p.readyAt })) });
  const plan = demandPlan(freeze(obs), config, 1);
  close(plan.diagnostics.ai.committedWork, 15);
  close(amount(plan, 'hardware'), 20);
  const accepted = requestProjects(progressed, plan.requests, 1, config);
  const pendingWork = accepted.projects.filter(p => p.status === 'pending')
    .reduce((sum, p) => sum + p.remainingWork, 0);
  close(plan.diagnostics.ai.totalWork, pendingWork);
  assert.ok(accepted.projects.filter(p => p.requestId.startsWith('plan:'))
    .every(p => p.workRequired === p.amount * config.assets[p.kind].work));
});

test('a ten-year window and five-year factory lead require twenty plants, not ten', () => {
  const config = configuration();
  config.assets.factory.delay = 5;
  assert.ok(config.assets.factory.energy > 0);
  const plan = demandPlan(observation({ projects: [project('hardware', 'ai', 100, 100, 1)] }), config, 1);
  close(amount(plan, 'factory'), 20);
  close(plan.diagnostics.ai.newFactoryProductivity, 0.5);
  close(plan.diagnostics.ai.totalWork, 100);
  assert.equal(plan.diagnostics.ai.selfBuildLimited, false);
  assert.equal(plan.diagnostics.ai.selfBuildLimitedReason, null);
});

// Independent composite-midpoint quadrature of a cohort's physical output.
// It samples the active interval instead of using the planner's analytic mean.
function integratedPlantOutput(config, birth, t, window, efficiency) {
  const spec = config.assets.factory, samples = 2048;
  const boundaries = [...new Set([t, t + window,
    Math.max(t, Math.min(t + window, birth)),
    Math.max(t, Math.min(t + window, birth + spec.life))])].sort((a, b) => a - b);
  let work = 0;
  for (let j = 1; j < boundaries.length; j++) {
    const left = boundaries[j - 1], width = (boundaries[j] - left) / samples;
    for (let i = 0; i < samples; i++) {
      const age = left + (i + 0.5) * width - birth;
      if (age >= 0 && age < spec.life) work += config.assets.factoryProductivity * efficiency *
        (1 - (1 - spec.endPerformance) * age / spec.life) * width;
    }
  }
  return work;
}

test('new-factory productivity agrees with an independent integral over lead, decay and retirement', () => {
  for (const t of [0, 7]) for (const delay of [0, 2, 5, 9, 10]) {
    for (const life of [4, 10, 100]) for (const endPerformance of [0, 0.4, 1]) {
      const config = configuration();
      config.assets.factory = { ...config.assets.factory, delay, life, endPerformance };
      config.assets.factoryProductivity = 3;
      config.ai.factoryUtilisation = 0.75;
      const obs = observation({ t, technology: { manufacturing: 2 },
        projects: [project('hardware', 'ai', 30, 30, t + 1)] });
      const expectedOutput = integratedPlantOutput(config, t + delay, t, 10, 2);
      const plan = demandPlan(obs, config, 1);
      close(plan.diagnostics.ai.newFactoryProductivity, expectedOutput / 10);
      close(amount(plan, 'factory'), expectedOutput > 0 ? 30 / (expectedOutput * 0.75) : 0);
    }
  }
});

test('a lead reaching the window and nonpositive net productivity report finite infeasibility', () => {
  for (const delay of [10, 12]) {
    const config = configuration();
    config.assets.factory.delay = delay;
    const plan = demandPlan(observation({ projects: [project('hardware', 'ai', 100, 100, 1)] }), config, 1);
    close(plan.diagnostics.ai.newFactoryProductivity, 0);
    close(amount(plan, 'factory'), 0);
    assert.equal(plan.diagnostics.ai.selfBuildLimited, true);
    assert.match(plan.diagnostics.ai.selfBuildLimitedReason, /no output.*window/i);
    assert.ok(plan.requests.every(request => Number.isFinite(request.amount)));
    const unnecessary = demandPlan(observation(), config, 1);
    assert.equal(unnecessary.diagnostics.ai.selfBuildLimited, false);
    assert.equal(unnecessary.diagnostics.ai.selfBuildLimitedReason, null);
  }
  const config = configuration();
  config.assets.factory.delay = 5;
  for (const work of [5, 6]) {
    config.assets.factory.work = work;
    const plan = demandPlan(observation({ projects: [project('hardware', 'ai', 100, 100, 1)] }), config, 1);
    close(amount(plan, 'factory'), 0);
    assert.equal(plan.diagnostics.ai.selfBuildLimited, true);
    assert.match(plan.diagnostics.ai.selfBuildLimitedReason, /self-construction/i);
    assert.ok(Number.isFinite(plan.diagnostics.ai.factoryNetProductivity));
  }
});

test('new-plant window productivity includes adopted efficiency, utilisation and paid self-work', () => {
  const config = configuration();
  config.assets.factory.delay = 5;
  config.assets.factory.work = 2;
  config.ai.factoryUtilisation = 0.75;
  const plan = demandPlan(observation({ technology: { manufacturing: 2 },
    projects: [project('hardware', 'ai', 80, 80, 1)] }), config, 1);
  const plants = 8 / (0.75 - 0.2);
  close(amount(plan, 'factory'), plants);
  close(plan.diagnostics.ai.newFactoryProductivity, 1);
  close(plan.diagnostics.ai.factoryNetProductivity, 0.55);
  close(plan.diagnostics.ai.newWork, plants * 2);
  close(plants * 1 * 0.75 * 10, 80 + plants * 2);
});

test('lagged adjustment scales the deficit and self-build work on the same window', () => {
  const config = configuration();
  config.assets.factory.delay = 5;
  config.assets.factory.work = 2;
  config.ai.adjustmentTime = 1;
  const plan = demandPlan(observation({ projects: [project('hardware', 'ai', 80, 80, 1)] }), config, Math.log(2));
  close(plan.diagnostics.response, 0.5);
  close(amount(plan, 'factory'), 10);
  close(plan.diagnostics.ai.factoryNetProductivity, 0.4);
  close(plan.diagnostics.ai.factoryPlants * plan.diagnostics.ai.newFactoryProductivity * 10,
    plan.diagnostics.response * plan.diagnostics.ai.totalWork);
});

test('no-AI human service factories use the same new-plant window integral', () => {
  const config = configuration({ aiEnabled: false });
  config.assets.factory.delay = 5;
  config.ai.factoryUtilisation = 0.5;
  const plan = demandPlan(observation({ human: { powerNeed: 0, factoryWorkNeed: 10 } }), config, 1);
  close(amount(plan, 'factory', 'human'), 20);
  close(plan.diagnostics.human.newFactoryProductivity, 0.5);
  assert.ok(plan.requests.every(request => request.owner === 'human'));
});

test('the shared executor completes the window backlog with twenty plants; ten supply only half', () => {
  const config = makeConfig({ initial: { H: 1, hardware: 0, humanPower: 0, aiPower: 0,
    humanFactories: 0, aiFactories: 0, ageBands: [0] },
    ai: { planningWindow: 10, adjustmentTime: 0, factoryUtilisation: 1 },
    assets: { factory: { life: 100, endPerformance: 1, delay: 5, work: 0,
      energy: 1, materials: 1, land: 1 }, factoryProductivity: 1,
    hardware: { life: 100, endPerformance: 1, delay: 0, work: 1, energy: 0 } } });
  const pending = requestProjects(initialAssetState(config), [{ id: 'old-window-work', kind: 'hardware',
    owner: 'ai', amount: 100 }], 0, config);
  const plan = demandPlan(observation({ projects: pending.projects.map(p => ({ ...p, commissionAt: p.readyAt })) }), config, 1);
  const factoryRequest = plan.requests.find(request => request.kind === 'factory');
  close(factoryRequest.amount, 20);
  const build = plants => {
    const requested = requestProjects(pending, [{ ...factoryRequest, amount: plants }], 0, config);
    close(inspectAssets(requested, 0, config).factoryWork, 0);
    const funded = advanceAssets(requested, 0, 5, { energy: plants, work: 0 }, config);
    close(funded.energyUsed, plants);
    close(inspectAssets(requested, 0, config).factoryWork, 0);
    const workBudget = inspectAssets(funded.state, 5, config).factoryWork * 5;
    return advanceAssets(funded.state, 5, 5, { energy: 0, work: workBudget }, config);
  };
  const enough = build(factoryRequest.amount), short = build(10);
  close(enough.workUsed, 100);
  close(inspectAssets(enough.state, 10, config).hardware, 100);
  close(short.workUsed, 50);
  close(inspectAssets(short.state, 10, config).hardware, 0);
  close(short.state.projects.find(p => p.requestId === 'old-window-work').remainingWork, 50);
});

test('fixed-work power demand uses the observed current weighted cohort mix and attainable utilisation', () => {
  const config = configuration();
  config.ai.workloadMode = 'fixed-work'; config.ai.utilisation = 0.8; config.ai.idleFraction = 0.2;
  config.assets.hardware.endPerformance = 0.6;
  const cases = [
    {assets: [cohort('hardware', 'ai', 1000, 0, {hardwareEfficiency: 2})], u: 0.4},
    {assets: [cohort('hardware', 'ai', 1000, -50)], u: 1},
    {assets: [cohort('hardware', 'ai', 250, 0, {hardwareEfficiency: 2}),
      cohort('hardware', 'ai', 750, -50)], u: 0.8 / 1.1},
  ];
  for (const {assets, u} of cases) {
    const plan = demandPlan(freeze(observation({assets, ai: {desiredHardware: 1000},
      technology: {hardware: 99}})), config, 1);
    close(plan.diagnostics.ai.powerNeed, 1000 * 0.00876 * (0.2 + 0.8 * u));
  }
});

test('empty fixed-work hardware uses observed new-vintage efficiency; inactive vintages do not contribute', () => {
  const config = configuration();
  config.ai.workloadMode = 'fixed-work'; config.ai.utilisation = 0.8; config.ai.idleFraction = 0.2;
  const obs = observation({assets: [cohort('hardware', 'ai', 1000, 0, {retired: true, hardwareEfficiency: 99}),
    cohort('hardware', 'ai', 1000, 10, {hardwareEfficiency: 99})],
  ai: {desiredHardware: 1000}, technology: {hardware: 2}});
  close(demandPlan(obs, config, 1).diagnostics.ai.powerNeed, 4.5552);
  config.ai.workloadMode = 'fixed-utilisation';
  close(demandPlan(obs, config, 1).diagnostics.ai.powerNeed, 7.3584);
});

test('fixed-work rejects malformed observed vintage efficiency', () => {
  const config = configuration(); config.ai.workloadMode = 'fixed-work';
  for (const hardwareEfficiency of [0, -1, NaN, Infinity]) assert.throws(() => demandPlan(
    observation({assets: [cohort('hardware', 'ai', 10, 0, {hardwareEfficiency})]}), config, 1), /hardwareEfficiency|finite|positive/i);
});
