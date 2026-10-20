/**
 * C2 demand planning and C4 finite-candidate rolling optimization.
 *
 * Observation contract (all quantities are observed at t):
 * {t,H,q,technology:{hardware,manufacturing,power,land},
 *  assets:[{id,kind,owner,rated,birth,active?,retired?}],
 *  projects:[{id,kind,owner,amount,remainingWork,commissionAt,status?}],
 *  resources:{land,materials,energy?,work?},
 *  human:{powerNeed,factoryWorkNeed},ai:{desiredHardware?},policy:{...}}.
 * Cohorts may also carry hardwareEfficiency/manufacturingEfficiency. Power need
 * is TWh/year; factory service need is work/year; project remainingWork is work.
 * Projects describe outstanding commitments, including work beyond this window.
 * commissionAt is a known delivery estimate, never a promise of free capacity.
 * Retirement is derived only from birth + life, never added a second time from
 * a retirement summary. Inactive cohorts still own land outside this planner.
 *
 * The parent owns execution and resource feasibility, including material/land
 * reservation, factory work, energy, project completion and realized deliveries.
 * Neither API changes physical state or includes a legacy simulation kernel.
 */

const KINDS = ['hardware', 'power', 'factory'];
const OWNERS = ['human', 'ai'];
const CLOSED = new Set(['completed', 'cancelled', 'canceled', 'rejected']);
const BLOCK_ENERGY = 0.00876; // TWh/year per 1 MW facility-load block.

function number(value, name, minimum = 0, positive = false) {
  if (!Number.isFinite(value) || value < minimum || (positive && value === 0)) {
    throw new RangeError(`${name} must be finite and ${positive ? 'positive' : `at least ${minimum}`}`);
  }
  return value;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function validate(observation, config, h) {
  object(observation, 'observation');
  object(config, 'config');
  number(h, 'h', 0, true);
  for (const name of ['t', 'H', 'q']) number(observation[name], name);
  object(observation.human, 'human');
  for (const name of ['powerNeed', 'factoryWorkNeed']) number(observation.human[name], `human.${name}`);
  if (observation.ai?.desiredHardware !== undefined) number(observation.ai.desiredHardware, 'ai.desiredHardware');
  for (const name of ['assets', 'projects']) {
    if (!Array.isArray(observation[name])) throw new TypeError(`${name} must be an array`);
  }
  for (const kind of KINDS) {
    const spec = object(config.assets?.[kind], `assets.${kind}`);
    number(spec.life, `${kind}.life`, 0, true);
    number(spec.delay, `${kind}.delay`);
    number(spec.work, `${kind}.work`);
    number(spec.endPerformance, `${kind}.endPerformance`);
    if (spec.endPerformance > 1) throw new RangeError(`${kind}.endPerformance must be at most 1`);
  }
  for (const name of ['planningWindow', 'adjustmentTime', 'expansion', 'utilisation', 'idleFraction']) {
    number(config.ai?.[name], `ai.${name}`);
  }
  for (const name of ['utilisation', 'idleFraction', 'factoryUtilisation']) {
    number(config.ai?.[name], `ai.${name}`, 0, name === 'factoryUtilisation');
    if (config.ai[name] > 1) throw new RangeError(`ai.${name} must be at most 1`);
  }
  number(config.assets.factoryProductivity, 'factoryProductivity', 0, true);
  for (const name of ['hardware', 'manufacturing', 'power', 'land']) {
    number(observation.technology?.[name] ?? 1, `technology.${name}`, 0, true);
  }
  for (const asset of observation.assets) {
    validateIdentity(asset);
    if (!KINDS.includes(asset.kind)) throw new TypeError('asset.kind is unsupported');
    number(asset.rated, 'asset.rated');
    number(asset.birth, 'asset.birth', -Number.MAX_VALUE);
    number(asset.manufacturingEfficiency ?? 1, 'asset.manufacturingEfficiency', 0, true);
    number(asset.hardwareEfficiency ?? 1, 'asset.hardwareEfficiency', 0, true);
  }
  for (const project of observation.projects) {
    validateIdentity(project);
    number(project.amount, 'project.amount');
    number(project.remainingWork, 'project.remainingWork');
    number(project.commissionAt, 'project.commissionAt');
    number(project.manufacturingEfficiency ?? 1, 'project.manufacturingEfficiency', 0, true);
  }
}

function validateIdentity(item) {
  object(item, 'inventory entry');
  if (!OWNERS.includes(item.owner)) throw new TypeError('inventory owner must be human or ai');
}

const active = asset => asset.active !== false && !asset.retired;
const outstanding = project => !CLOSED.has(project.status);

function performance(birth, t, spec) {
  const age = t - birth;
  if (age < 0 || age >= spec.life) return 0;
  return 1 - (1 - spec.endPerformance) * age / spec.life;
}

// Exact integral of linear decay, clipped at commissioning and retirement.
function averagePerformance(birth, t, window, spec) {
  const start = Math.max(t, birth);
  const end = Math.min(t + window, birth + spec.life);
  if (end <= start) return 0;
  const meanAge = ((start - birth) + (end - birth)) / 2;
  return (end - start) / window * (1 - (1 - spec.endPerformance) * meanAge / spec.life);
}

function capacity(observation, config, kind, owner, window, average = false) {
  const spec = config.assets[kind];
  const value = birth => average ? averagePerformance(birth, observation.t, window, spec) :
    performance(birth, observation.t + window, spec);
  const vintage = entry => kind === 'factory' ? entry.manufacturingEfficiency ?? 1 : 1;
  const existing = observation.assets.filter(a => a.kind === kind && a.owner === owner && active(a))
    .reduce((sum, a) => sum + a.rated * value(a.birth) * vintage(a), 0);
  const pipeline = observation.projects.filter(p => p.kind === kind && p.owner === owner && outstanding(p))
    .reduce((sum, p) => sum + p.amount * value(Math.max(observation.t, p.commissionAt)) * vintage(p), 0);
  return { existing, pipeline, total: existing + pipeline };
}

function hardwareInventory(observation, config, window) {
  // Demand is in installed rated blocks. Hardware efficiency affects forecast
  // effective compute, not the number of physical blocks awaiting manufacture.
  const aliveAt = birth => birth <= observation.t + window &&
    observation.t + window < birth + config.assets.hardware.life;
  const existing = observation.assets.filter(a => a.kind === 'hardware' && a.owner === 'ai' &&
    active(a) && aliveAt(a.birth)).reduce((sum, a) => sum + a.rated, 0);
  const pipeline = observation.projects.filter(p => p.kind === 'hardware' && p.owner === 'ai' &&
    outstanding(p) && aliveAt(Math.max(observation.t, p.commissionAt)))
    .reduce((sum, p) => sum + p.amount, 0);
  const installed = observation.assets.filter(a => a.kind === 'hardware' && a.owner === 'ai' &&
    active(a) && a.birth <= observation.t && observation.t < a.birth + config.assets.hardware.life)
    .reduce((sum, a) => sum + a.rated, 0);
  return { existing, pipeline, installed };
}

function operatingUtilisation(observation, config) {
  const requested=observation.ai?.utilisation??config.ai.utilisation;
  if (config.ai.workloadMode !== 'fixed-work') return requested;
  const spec = config.assets.hardware;
  const cohorts = observation.assets.filter(a => a.kind === 'hardware' && active(a) &&
    a.birth <= observation.t && observation.t < a.birth + spec.life);
  const rated = cohorts.reduce((sum, a) => sum + a.rated, 0);
  // Hold the observed current cohort mix over this demand forecast. This does
  // not predict future aging, commissioning or event-driven vintage changes.
  const factor = rated > 0 ? cohorts.reduce((sum, a) => sum + a.rated *
    performance(a.birth, observation.t, spec) * (a.hardwareEfficiency ?? 1), 0) / rated :
    observation.technology?.hardware ?? 1;
  return Math.min(1, requested / Math.max(Number.MIN_VALUE, factor));
}

function request(observation, kind, owner, amount) {
  return { id: `plan:${observation.t}:${owner}:${kind}`, kind, owner,
    amount: number(amount, `${owner}.${kind} request`), priority: owner === 'human' ? 1 : 10,
    hardwareEfficiency: observation.technology?.hardware ?? 1,
    manufacturingEfficiency: observation.technology?.manufacturing ?? 1,
    ...(kind === 'power' ? { energyMultiplier: 1 / (observation.technology?.power ?? 1) } : {}),
    landMultiplier: 1 / (observation.technology?.land ?? 1) };
}

function demandTarget(observation, config, window, inventory) {
  if (!config.aiEnabled) return 0;
  if (observation.ai?.desiredHardware !== undefined) return observation.ai.desiredHardware;
  // Explicit scenario assumption: desired rated hardware grows linearly over
  // this window at ai.expansion/year from currently installed hardware. Power
  // scarcity is a separate investment need, not evidence that demand is zero.
  return inventory.installed * (1 + config.ai.expansion * window);
}

function ownerPlan(observation, config, window, response, owner, hardware, powerNeed) {
  const power = capacity(observation, config, 'power', owner, window);
  const powerOrder = Math.max(0, powerNeed - power.total) * response;
  const committedWork = observation.projects.filter(p => p.owner === owner && outstanding(p))
    .reduce((sum, p) => sum + p.remainingWork, 0);
  // Work costs are fixed physical requirements. Manufacturing improvements
  // multiply factory-vintage output; they never divide construction work.
  const newWork = hardware * config.assets.hardware.work + powerOrder * config.assets.power.work;
  const totalWork = committedWork + newWork;
  const serviceWork = owner === 'human' ? observation.human.factoryWorkNeed : 0;
  const utilisation = owner === 'human' ? 1 : config.ai.factoryUtilisation;
  // A new plant contributes only after its earliest lead-time boundary, and
  // its output decays/retires inside the same window as existing and pipeline
  // plants. Funding can delay commissioning further; the executor owns that.
  const factorySpec = config.assets.factory;
  const newFactoryProductivity = config.assets.factoryProductivity * (observation.technology?.manufacturing ?? 1) *
    averagePerformance(observation.t + factorySpec.delay, observation.t, window, factorySpec);
  const factory = capacity(observation, config, 'factory', owner, window, true);
  const factoryCapacity = factory.total * config.assets.factoryProductivity;
  const factoryNeed = serviceWork + totalWork / window;
  // Account for the new factories' own manufacturing work too. The expansion
  // gap includes work already committed plus actual new requests. Self-build
  // work is charged in the same window, without treating new plants as already
  // productive. A nonpositive denominator signals no finite self-build solution;
  // the physical executor must service the deficit rather than accept infinity.
  const selfWork = config.assets.factory.work;
  const denominator = newFactoryProductivity * utilisation - response * selfWork / window;
  const deficit = Math.max(0, factoryNeed - factoryCapacity * utilisation);
  const factoryOrder = denominator > 0 ? response * deficit / denominator : 0;
  const selfBuildLimited = denominator <= 0 && deficit > 0;
  const selfBuildLimitedReason = !selfBuildLimited ? null : newFactoryProductivity === 0 ?
    'New factories contribute no output inside the planning window; no finite in-window order can close the deficit.' :
    'Window-average output after utilisation does not exceed response-weighted self-construction work; no finite in-window order closes the deficit.';
  const requests = [['power', powerOrder], ['factory', factoryOrder], ['hardware', hardware]]
    .filter(([, quantity]) => quantity > 0).map(([kind, quantity]) => request(observation, kind, owner, quantity));
  return { requests, diagnostics: { powerNeed, survivingPower: power.existing, pipelinePower: power.pipeline,
    committedWork, newWork: newWork + factoryOrder * selfWork,
    totalWork: totalWork + factoryOrder * selfWork, factoryNeed: factoryNeed + factoryOrder * selfWork / window,
    factoryCapacity, factoryPlants: factoryOrder, newFactoryProductivity, factoryNetProductivity: denominator,
    selfBuildLimited, selfBuildLimitedReason } };
}

/** Return current-step physical project requests; never reserve resources here. */
export function demandPlan(observation, config, h) {
  validate(observation, config, h);
  const window = Math.max(h, config.ai.planningWindow, ...KINDS.map(kind => config.assets[kind].delay));
  const response = config.ai.adjustmentTime === 0 ? 1 : -Math.expm1(-h / config.ai.adjustmentTime);
  const inventory = hardwareInventory(observation, config, window);
  const target = number(demandTarget(observation, config, window, inventory), 'desiredHardware');
  const hardware = config.aiEnabled ? Math.max(0, target - inventory.existing - inventory.pipeline) * response : 0;
  const energyFraction = config.ai.idleFraction + (1 - config.ai.idleFraction) * operatingUtilisation(observation, config);
  const human = ownerPlan(observation, config, window, response, 'human', 0, observation.human.powerNeed);
  const ai = ownerPlan(observation, config, window, response, 'ai', hardware,
    config.aiEnabled ? target * BLOCK_ENERGY * energyFraction : 0);
  return { requests: [...human.requests, ...(config.aiEnabled ? ai.requests : [])], diagnostics: {
    window, response,
    demandAssumption: observation.ai?.desiredHardware === undefined ?
      'Linear ai.expansion per year of currently installed rated hardware over the planning window.' :
      'Observed desiredHardware target supplied by the parent; expansion is an explicit demand assumption.',
    human: human.diagnostics,
    ai: { ...ai.diagnostics, desiredHardware: target, survivingHardware: inventory.existing,
      pipelineHardware: inventory.pipeline, newHardware: hardware },
  } };
}

// Forecasts receive a fresh projection per candidate, so neither callback
// mutations nor future event schedules can leak between candidates or upstream.
function forecastObservation(observation) {
  return structuredClone(Object.fromEntries(['t', 'H', 'q', 'competitionLead', 'technology', 'technologyEffects', 'executionEffects', 'baseConditions', 'infrastructure', 'assets', 'projects',
    'resources', 'human', 'ai', 'policy'].map(key => [key, observation[key]])));
}

function forecastConfig(config, observation) {
  return structuredClone({ ...config, events: [], eventMode: 'off', annualProbability: 0,
    ...(config.infrastructure?{infrastructure:{...config.infrastructure,
      outages:(config.infrastructure.outages??[]).filter(outage=>outage.start<=observation.t)}}:{}),
    policy: observation.policy ?? { mode: 'none' } });
}

/**
 * Enumerate six portfolios, never claiming a global optimum. `forecast` is a
 * synchronous parent-supplied shared-executor rollout:
 * forecast({observation,config,h,horizon,requests,candidateId})
 *   -> {effectiveCompute,feasible?}.
 * Apply requests at the current step only, then hold new decisions for the
 * remaining horizon. Only currently observed technology/policy is available.
 * Human service/replacement requests are common to every candidate; hold and
 * half affect only AI investment. This preserves the human channel at zero AI.
 * The executor rejects/scales infeasible construction and returns its endpoint
 * effective compute. `feasible:false` rejects an unusable forecast. Ties choose
 * the first listed portfolio; hold wins an objective tie and conserves resources.
 */
export function selectPortfolio(observation, config, h, forecast) {
  if (typeof forecast !== 'function') throw new TypeError('forecast must be a function');
  const plan = demandPlan(observation, config, h);
  const portfolios = [
    { id: 'hold', scale: 0 }, { id: 'balanced-half', scale: 0.5 }, { id: 'balanced', scale: 1 },
    { id: 'hardware-first', scale: 1, order: ['hardware', 'power', 'factory'] },
    { id: 'power-first', scale: 1, order: ['power', 'factory', 'hardware'] },
    { id: 'factory-first', scale: 1, order: ['factory', 'power', 'hardware'] },
  ];
  const candidates = portfolios.map(portfolio => {
    const requests = plan.requests.filter(r => r.owner === 'human' || portfolio.scale > 0).map(r => ({ ...r,
      amount: r.amount * (r.owner === 'human' ? 1 : portfolio.scale),
      priority: r.owner === 'ai' && portfolio.order ? 10 + portfolio.order.indexOf(r.kind) : r.priority }));
    const result = forecast({ observation: forecastObservation(observation),
      config: forecastConfig(config, observation), h, horizon: plan.diagnostics.window,
      requests: structuredClone(requests), candidateId: portfolio.id });
    const feasible = result?.feasible !== false && Number.isFinite(result?.effectiveCompute);
    return { id: portfolio.id, requests, objective: feasible ? result.effectiveCompute : null,
      status: feasible ? 'evaluated' : 'rejected' };
  });
  const selected = candidates.reduce((best, candidate) => candidate.status === 'evaluated' &&
    (best === null || candidate.objective > best.objective) ? candidate : best, null);
  if (!selected) throw new RangeError('No finite and feasible forecast objective');
  return { requests: selected.requests, diagnostics: plan.diagnostics, optimization: {
    method: 'finite-candidate rolling horizon', horizon: plan.diagnostics.window, executedYears: h,
    selectedCandidate: selected.id, objective: selected.objective,
    candidates: candidates.map(({ id, objective, status }) => ({ id, objective, status })),
  } };
}
