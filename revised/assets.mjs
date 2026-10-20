/** Physical cohorts and paid projects. All mutations are on newly detached working copies.
 * Quantities: rated power TWh/year, factories plants, hardware MW blocks; time years.
 * Materials include a separately declared initial embodied endowment and finite free stock.
 * Smaller priority numbers execute first; sequence numbers preserve FIFO within a priority.
 */
const KINDS = ['power', 'factory', 'hardware'];
const TARGETS = ['algorithm', 'hardware', 'manufacturing', 'land', 'power'];
const copy = value => structuredClone(value);
const stateKeys = new Set(['assets', 'projects', 'materials', 'nextId', 'accounts', 'requestIds', 'receipts']);
const nested = value => value !== null && (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol');
function copyRecord(value, childKey, copyChild) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length) return copy(value);
  const result = { ...value };
  for (const key of Object.keys(result)) if (key !== childKey && nested(result[key])) return copy(value);
  if (childKey && Object.hasOwn(result, childKey)) result[childKey] = copyChild(result[childKey]);
  return result;
}
function copyIds(ids) {
  if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype) return copy(ids);
  const keys = Object.keys(ids);
  if (keys.length !== ids.length || (ids.length && keys.at(-1) !== String(ids.length - 1)) || ids.some(nested)) return copy(ids);
  return ids.slice();
}
const copyProject = value => copyRecord(value, 'targetIds', copyIds);
const copyReceipt = value => copyRecord(value, 'targetIds', copyIds);
function copyRows(values, copier) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) return copy(values);
  const keys = Object.keys(values);
  if (keys.length !== values.length || (values.length && keys.at(-1) !== String(values.length - 1))) return copy(values);
  return values.map(copier);
}
function detachedState(value) {
  if (Object.keys(value).some(key => !stateKeys.has(key)) || nested(value.materials) || nested(value.nextId) ||
    !value.requestIds || typeof value.requestIds !== 'object' || Object.getOwnPropertySymbols(value).length ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value.requestIds)) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return copy(value);
  return { ...value, assets: copyRows(value.assets, a => copyRecord(a)), projects: copyRows(value.projects, copyProject),
    accounts: copyRecord(value.accounts), receipts: copyRows(value.receipts, copyReceipt),
    requestIds: Object.fromEntries(Object.entries(value.requestIds).map(([id, entry]) =>
      [id, copyRecord(entry, 'receipt', copyReceipt)])) };
}
const finite = (value, minimum = 0) => Number.isFinite(value) && value >= minimum;
const positive = value => Number.isFinite(value) && value > 0;
const total = (values, project) => values.reduce((sum, value) => sum + project(value), 0);
function checkTime(t, h = 0) {
  if (!finite(t) || !finite(h) || !finite(t + h)) throw new RangeError('Invalid time or step');
}
function performance(a, t, config) {
  const spec = config.assets[a.kind], age = t - a.birth;
  return a.retired || a.cleared || age < 0 || age >= spec.life ? 0 :
    1 - (1 - spec.endPerformance) * age / spec.life;
}
function bands(value = [0, 0.25, 0.5, 0.75]) {
  const rows = Number.isInteger(value) && value > 0 && value <= 1000 ?
    Array.from({ length: value }, (_, i) => ({ ageFraction: (i + 0.5) / value, share: 1 })) :
    Array.isArray(value) ? value.map(v => typeof v === 'number' ? { ageFraction: v, share: 1 / value.length } : v) : [];
  if (!rows.length || rows.some(v => !v || !finite(v.ageFraction) || v.ageFraction >= 1 ||
    !finite(v.share))) throw new RangeError('Invalid initial age bands');
  const weight = total(rows, v => v.share);
  if (!positive(weight)) throw new RangeError('Invalid initial age shares');
  return rows.map(v => ({ ...v, share: v.share / weight }));
}
function cohort(state, kind, owner, rated, birth, config, values = {}) {
  const spec = config.assets[kind];
  return { id: `asset-${state.nextId++}`, kind, owner, rated, birth: birth || 0,
    footprint: rated * spec.land, materials: rated * spec.materials,
    embodiedEnergy: rated * spec.energy, embodiedWork: rated * spec.work,
    hardwareEfficiency: config.initial.hardwareEfficiency??1, manufacturingEfficiency: config.initial.manufacturingEfficiency??1, retired: false,
    retiredAt: null, cleared: false, clearedAt: null, demolitionProjectId: null, ...values };
}

export function initialAssetState(config) {
  const stock = config.resources.materials;
  if (!finite(stock) || !finite(config.resources.land)) throw new RangeError('Invalid initial resources');
  const state = { assets: [], projects: [], materials: stock, nextId: 1, requestIds: {}, receipts: [],
    accounts: { initialStock: stock, initialEmbodied: 0, initialMaterials: stock,
      virginCommitted: 0, recycledCommitted: 0, recycledRecovered: 0, primarySupplied: 0,
      materialsCommitted: 0, materialsDisposed: 0, energySpent: 0, workDone: 0 } };
  const initial = [['hardware', 'ai', config.initial.hardware],
    ['power', 'human', config.initial.humanPower], ['power', 'ai', config.initial.aiPower],
    ['factory', 'human', config.initial.humanFactories], ['factory', 'ai', config.initial.aiFactories]];
  for (const [kind, owner, amount] of initial) {
    const specific=config.initial[`${kind}AgeBands`];
    const ages=bands(specific?.length?specific:config.initial.ageBands);
    if (!finite(amount)) throw new RangeError('Invalid initial asset quantity');
    for (const age of ages) if (amount > 0 && age.share > 0)
      state.assets.push(cohort(state, kind, owner, amount * age.share,
        -age.ageFraction * config.assets[kind].life, config));
  }
  state.accounts.initialEmbodied = total(state.assets, a => a.materials);
  state.accounts.initialMaterials += state.accounts.initialEmbodied;
  if (total(state.assets, a => a.footprint) > config.resources.land)
    throw new RangeError('Initial asset footprint exceeds available land');
  return state;
}

export function inspectAssets(assetState, t, config) {
  checkTime(t);
  const cohorts = assetState.assets.map(a => ({ ...copyRecord(a), performance: performance(a, t, config),
    effective: a.rated * performance(a, t, config) }));
  const output = (kind, owner, multiplier = () => 1) => total(cohorts.filter(a =>
    a.kind === kind && (!owner || a.owner === owner)), a => a.effective * multiplier(a));
  const humanPower = output('power', 'human'), aiPower = output('power', 'ai');
  const factory = a => config.assets.factoryProductivity * a.manufacturingEfficiency;
  const humanFactoryWork = output('factory', 'human', factory), aiFactoryWork = output('factory', 'ai', factory);
  const landOccupied = total(cohorts.filter(a => !a.cleared), a => a.footprint);
  const landCommitted = total(assetState.projects.filter(p => p.status === 'pending' &&
    KINDS.includes(p.kind)), p => p.footprint);
  return { power: humanPower + aiPower, humanPower, aiPower,
    factoryWork: humanFactoryWork + aiFactoryWork, humanFactoryWork, aiFactoryWork,
    hardware: total(cohorts.filter(a => a.kind === 'hardware' && a.performance > 0), a => a.rated),
    hardwareEffective: output('hardware', null, a => a.hardwareEfficiency),
    landOccupied, landCommitted, landAvailable: Math.max(0, config.resources.land - landOccupied - landCommitted),
    maintenanceWork: total(cohorts.filter(a => a.performance > 0), a => a.rated * config.assets[a.kind].maintenance),
    cohorts, projects: copyRows(assetState.projects, copyProject), materials: assetState.materials };
}

function problem(r, t) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'Invalid request';
  if (r.id !== undefined && (typeof r.id !== 'string' || !r.id.length)) return 'Invalid request ID';
  if (![...KINDS, 'adoption', 'retrofit', 'demolition'].includes(r.kind)) return 'Invalid asset kind';
  if (!['human', 'ai'].includes(r.owner) || !positive(r.amount)) return 'Invalid owner or amount';
  for (const key of ['hardwareEfficiency', 'manufacturingEfficiency', 'landMultiplier', 'energyMultiplier', 'multiplier'])
    if (r[key] !== undefined && !positive(r[key])) return `Invalid ${key}`;
  for (const key of ['energy', 'work', 'delay'])
    if (r[key] !== undefined && !finite(r[key])) return `Invalid ${key}`;
  if (r.priority !== undefined && !Number.isFinite(r.priority)) return 'Invalid priority';
  if (r.expiresAt != null && r.kind !== 'adoption') return 'Only adoption can expire';
  if (r.expiresAt != null && (!finite(r.expiresAt) || r.expiresAt <= t)) return 'Expired request';
  if (r.kind === 'adoption' && (!TARGETS.includes(r.target) || !positive(r.multiplier))) return 'Invalid adoption target';
  if (r.kind === 'retrofit' && (!['hardware', 'manufacturing'].includes(r.target) || !positive(r.multiplier)))
    return 'Invalid retrofit target';
  return null;
}
function signature(r) {
  // Canonical ordering makes repeated plain objects independent of property insertion order.
  return JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));
}
function targetsFor(state, r, t, config) {
  if (!Array.isArray(r.targetIds) || !r.targetIds.length || new Set(r.targetIds).size !== r.targetIds.length)
    return null;
  const targets = r.targetIds.map(id => state.assets.find(a => a.id === id));
  if (targets.some(a => !a || a.owner !== r.owner || a.cleared)) return null;
  const valid = r.kind === 'demolition' ? targets.every(a => a.retired && !a.demolitionProjectId) :
    targets.every(a => performance(a, t, config) > 0 &&
      a.kind === (r.target === 'hardware' ? 'hardware' : 'factory') &&
      !state.projects.some(p => p.status === 'pending' && p.kind === 'retrofit' && p.targetIds.includes(a.id)));
  const rated = total(targets, a => a.rated);
  return valid && Math.abs(rated - r.amount) <= 1e-10 * Math.max(rated, r.amount) ? targets : null;
}
function addProject(state, r, t, config) {
  let amount = r.amount, footprint = 0, materials = 0, energyRequired, workRequired, delay, targets = [];
  if (KINDS.includes(r.kind)) {
    const spec = config.assets[r.kind], land = spec.land * (r.landMultiplier ?? 1);
    amount = Math.min(amount, land > 0 ? inspectAssets(state, t, config).landAvailable / land : amount,
      spec.materials > 0 ? state.materials / spec.materials : amount);
    if (!(amount > 0)) return { reason: 'Insufficient land or materials' };
    footprint = amount * land; materials = amount * spec.materials;
    energyRequired = amount * spec.energy * (r.kind === 'power' ? r.energyMultiplier ?? 1 : 1);
    workRequired = amount * spec.work; delay = spec.delay;
  } else if (r.kind === 'demolition' || r.kind === 'retrofit') {
    targets = targetsFor(state, r, t, config);
    if (!targets) return { reason: 'Invalid, unavailable or mismatched target cohorts' };
    amount = total(targets, a => a.rated);
    if (r.kind === 'demolition') {
      energyRequired = total(targets, a => a.embodiedEnergy) * config.assets.demolitionEnergyFraction;
      workRequired = total(targets, a => a.embodiedWork) * config.assets.demolitionWorkFraction;
      delay = config.assets.demolitionDelay;
    }
  }
  if (r.kind === 'adoption' || r.kind === 'retrofit') {
    energyRequired = r.kind === 'adoption' ? r.energy ?? amount * config.assets.adoptionEnergy : amount * config.assets.adoptionEnergy;
    workRequired = r.kind === 'adoption' ? r.work ?? amount * config.assets.adoptionWork : amount * config.assets.adoptionWork;
    delay = r.delay ?? config.assets.adoptionDelay;
  }
  const readyAt = t + delay;
  if (![footprint, materials, energyRequired, workRequired, readyAt].every(v => finite(v)))
    return { reason: 'Nonfinite project resource requirements' };
  const sequence = state.nextId++, id = `project-${sequence}`;
  const project = { id, sequence, requestId: r.id ?? id, kind: r.kind, owner: r.owner,
    amount, priority: r.priority ?? 0, start: t, readyAt, energyRequired, workRequired,
    energySpent: 0, workDone: 0, remainingEnergy: energyRequired, remainingWork: workRequired,
    progress: 0, status: 'pending', footprint, materials,
    hardwareEfficiency: r.hardwareEfficiency ?? 1, manufacturingEfficiency: r.manufacturingEfficiency ?? 1,
    target: r.target ?? null, multiplier: r.multiplier ?? 1, targetIds: targets.map(a => a.id),
    eventId: r.eventId ?? null, expiresAt: r.expiresAt ?? null };
  const virgin = Math.min(materials, Math.max(0, state.accounts.initialStock+(state.accounts.primarySupplied??0) - state.accounts.virginCommitted));
  state.materials -= materials;
  state.accounts.virginCommitted += virgin;
  state.accounts.recycledCommitted += materials - virgin;
  state.accounts.materialsCommitted += materials;
  state.projects.push(project);
  if (r.kind === 'demolition') for (const a of targets) a.demolitionProjectId = id;
  return { project, amount };
}

/** Returns the new state, with accepted/rejected receipts in state.receipts.
 * Retrofit amounts match whole target cohorts; overlap is rejected until deployment.
 */
export function requestProjects(assetState, requests, t, config) {
  checkTime(t);
  if (!Array.isArray(requests)) throw new TypeError('Requests must be an array');
  const state = detachedState(assetState); state.receipts = [];
  for (const original of requests) {
    const r = copy(original), reason = problem(r, t);
    const key = r?.id, fingerprint = r && typeof r === 'object' ? signature(r) : '';
    const previous = typeof key === 'string' && Object.hasOwn(state.requestIds, key) ? state.requestIds[key] : null;
    if (previous && previous.signature === fingerprint) { state.receipts.push(copyReceipt(previous.receipt)); continue; }
    const result = reason || previous ? { reason: previous ? 'Conflicting request ID' : reason } : addProject(state, r, t, config);
    const receipt = { id: key ?? result.project?.requestId ?? null, requestId: key ?? result.project?.requestId ?? null,
      projectId: result.project?.id ?? null, kind: r?.kind ?? null, owner: r?.owner ?? null,
      requestedAmount: r?.amount ?? null, amount: result.amount ?? 0,
      status: result.reason ? 'rejected' : 'accepted', ...(result.reason ? { reason: result.reason } : {}) };
    state.receipts.push(receipt);
    if (typeof key === 'string' && !previous)
      state.requestIds = { ...state.requestIds, [key]: { signature: fingerprint, receipt: copyReceipt(receipt) } };
  }
  return state;
}

export function prepareAssets(assetState, t, config) {
  checkTime(t);
  return prepareWorking(detachedState(assetState), t, config);
}
function prepareWorking(state, t, config) {
  state.receipts = [];
  for (const a of state.assets) {
    if (!a.retired && t >= a.birth + config.assets[a.kind].life) {
      a.retired = true; a.retiredAt = a.birth + config.assets[a.kind].life;
    }
    if (a.retired && !a.cleared && !a.demolitionProjectId)
      addProject(state, { id: `demolition:${a.id}`, kind: 'demolition', owner: a.owner,
        amount: a.rated, priority: 0, targetIds: [a.id] }, t, config);
  }
  return state;
}

function complete(state, p, t, config) {
  let status = 'completed';
  if (KINDS.includes(p.kind)) state.assets.push(cohort(state, p.kind, p.owner, p.amount, t, config,
    { footprint: p.footprint, materials: p.materials, hardwareEfficiency: p.hardwareEfficiency,
      manufacturingEfficiency: p.manufacturingEfficiency, embodiedEnergy: p.energyRequired, embodiedWork: p.workRequired }));
  if (p.kind === 'demolition') for (const a of state.assets.filter(a => p.targetIds.includes(a.id) && !a.cleared)) {
    a.cleared = true; a.clearedAt = t;
    const recovered = a.materials * config.resources.recycling;
    state.materials += recovered; state.accounts.recycledRecovered += recovered;
    state.accounts.materialsDisposed += a.materials - recovered;
  }
  if (p.kind === 'retrofit') {
    const targets = state.assets.filter(a => p.targetIds.includes(a.id));
    if (targets.some(a => !performance(a, t, config))) status = 'cancelled';
    else for (const a of targets) a[p.target === 'hardware' ? 'hardwareEfficiency' : 'manufacturingEfficiency'] *= p.multiplier;
  }
  p.status = status; p.completedAt = t;
  return { id: p.requestId, requestId: p.requestId, projectId: p.id, kind: p.kind, owner: p.owner,
    amount: p.amount, status, completedAt: t, target: p.target, multiplier: p.multiplier,
    targetIds: [...p.targetIds], eventId: p.eventId, expiresAt: p.expiresAt };
}

function fundProjects(queue, t, energyBudget, workBudget, aiLimits={}) {
  let energyUsed = 0, workUsed = 0,aiEnergy=0,aiWork=0;
  for (const p of queue) {
    if (p.start > t || (p.expiresAt !== null && p.expiresAt <= t)) continue;
    const progress = Math.max(0, Math.min(1 - p.progress,
      p.energyRequired > 0 ? Math.max(0, energyBudget - energyUsed) / p.energyRequired : Infinity,
      p.workRequired > 0 ? Math.max(0, workBudget - workUsed) / p.workRequired : Infinity,
      p.owner==='ai'&&p.energyRequired>0?Math.max(0,(aiLimits.energy??Infinity)-aiEnergy)/p.energyRequired:Infinity,
      p.owner==='ai'&&p.workRequired>0?Math.max(0,(aiLimits.work??Infinity)-aiWork)/p.workRequired:Infinity));
    energyUsed += progress * p.energyRequired; workUsed += progress * p.workRequired;
    if(p.owner==='ai'){aiEnergy+=progress*p.energyRequired;aiWork+=progress*p.workRequired;}
    p.progress = Math.min(1, p.progress + progress);
    p.energySpent = p.progress * p.energyRequired; p.workDone = p.progress * p.workRequired;
    p.remainingEnergy = Math.max(0, p.energyRequired - p.energySpent);
    p.remainingWork = Math.max(0, p.workRequired - p.workDone);
  }
  return { energyUsed, workUsed };
}

/** Budgets are interval totals; energy and work buy the same proportional progress.
 * Optional humanShare reserves that fraction of BOTH budgets for human projects first.
 * This is a reserved fraction, not a fulfillment guarantee; unused energy/work return
 * independently to the common priority/FIFO queue. No config share is read implicitly.
 * Funding runs on one physical state; endpoint commissioning runs exactly once.
 */
export function advanceAssets(assetState, t, h, budget, config) {
  checkTime(t, h);
  if (!budget || !finite(budget.energy) || !finite(budget.work)) throw new RangeError('Invalid energy/work budget');
  if (budget.humanShare !== undefined && (!finite(budget.humanShare) || budget.humanShare > 1))
    throw new RangeError('humanShare must be finite in [0, 1]');
  if(budget.preferredOwner!==undefined&&!['human','ai'].includes(budget.preferredOwner))
    throw new RangeError('Invalid preferred construction owner');
  for(const key of ['aiEnergyLimit','aiWorkLimit'])if(budget[key]!==undefined&&!finite(budget[key]))
    throw new RangeError('Invalid AI financing limit');
  const state = prepareWorking(detachedState(assetState), t, config);
  const energyBudget = h > 0 ? budget.energy : 0, workBudget = h > 0 ? budget.work : 0;
  const receipts = [], endpoint = t + h;
  // [TH-PRIORITY] Protected human construction share is funded first; the
  // current winner orders the common queue without rewriting project contracts.
  const rank=p=>budget.preferredOwner&&p.owner!==budget.preferredOwner?1:0;
  const queue = state.projects.filter(p => p.status === 'pending').sort((a, b) => rank(a)-rank(b)||a.priority - b.priority || a.sequence - b.sequence);
  const reserved = budget.humanShare > 0 ? fundProjects(queue.filter(p => p.owner === 'human'), t,
    energyBudget * budget.humanShare, workBudget * budget.humanShare) : { energyUsed: 0, workUsed: 0 };
  const common = fundProjects(queue, t, Math.max(0, energyBudget - reserved.energyUsed),
    Math.max(0, workBudget - reserved.workUsed),{energy:budget.aiEnergyLimit,work:budget.aiWorkLimit});
  const energyUsed = reserved.energyUsed + common.energyUsed, workUsed = reserved.workUsed + common.workUsed;
  for (const p of queue) {
    if (p.start > t) continue;
    if (p.expiresAt !== null && endpoint >= p.expiresAt) {
      p.status = 'expired';
      receipts.push({ requestId: p.requestId, projectId: p.id, kind: p.kind, status: 'expired', completedAt: endpoint });
    } else if (p.progress >= 1 && endpoint >= p.readyAt) receipts.push(complete(state, p, endpoint, config));
  }
  state.accounts.energySpent += energyUsed; state.accounts.workDone += workUsed;
  prepareWorking(state, endpoint, config); state.receipts = receipts.map(copyReceipt);
  return { state, energyUsed, workUsed, receipts: receipts.map(copyReceipt) };
}

export function nextAssetTime(assetState, t, config) {
  checkTime(t);
  const times = assetState.assets.filter(a => !a.retired && !a.cleared).map(a => a.birth + config.assets[a.kind].life);
  for (const p of assetState.projects.filter(p => p.status === 'pending')) {
    times.push(p.readyAt);
    if (p.expiresAt !== null) times.push(p.expiresAt);
  }
  return times.reduce((next, time) => time > t ? Math.min(next, time) : next, Infinity);
}
