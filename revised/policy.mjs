/**
 * Stateful policy controller and execution receipts, in years/TWh/work units.
 * The parent owns the common ledger: funding budgets here must be actual shared
 * allocations, and returned energyUsed/workUsed are the only policy debit.
 * Observation projections must already exclude unobserved event IDs. Only the
 * explicit projection fields below enter controller memory; true execution
 * coverage/authority belong exclusively in activatePolicy/policyControls.
 *
 * One configured intervention has one ID for its entire lifecycle. delay is a
 * pre-funding eligibility wait; duration runs from requested start, not payment.
 * Funding may prepare an unauthorized action, but deployment needs authority.
 * Expiry is exclusive. Completion at an endpoint takes effect at that endpoint.
 * Shutdown success is drawn once after paid, eligible, authorized deployment.
 * A successful shutdown suppresses only covered activity to residual; neither
 * action deletes assets or reduces uncovered operation. The parent applies the
 * physical covered-block cap before power allocation and computes research from
 * the surviving cohort mix. Alignment never enters these functions.
 */

const DEFAULTS = {
  mode: 'none', type: 'cap', start: 5, delay: 0, cost: 0, work: 0,
  duration: null, cap: 0, success: 1, residual: 0, priority: 0,
  coverage: 1, authorized: true, observationDelay: 0,
  deficitThreshold: 0.1, exposureThreshold: 0.5, lookahead: 5, falseSignal: 0,
};
const TERMINAL = new Set(['failed', 'expired']);
const TECH_KEYS = ['algorithm', 'hardware', 'manufacturing', 'land', 'power'];

function finite(value, name, min = 0, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be finite in [${min}, ${max}]`);
  }
  return value;
}

function settings(config) {
  const p = {...DEFAULTS, ...config.policy};
  if (!['none', 'fixed', 'deficit', 'anticipatory'].includes(p.mode)) throw new TypeError('Invalid policy mode');
  if (!['cap', 'shutdown'].includes(p.type)) throw new TypeError('Invalid policy type');
  for (const key of ['start', 'delay', 'cost', 'work', 'cap', 'priority', 'observationDelay', 'lookahead']) finite(p[key], key);
  for (const key of ['success', 'residual', 'coverage', 'deficitThreshold', 'exposureThreshold']) finite(p[key], key, 0, 1);
  finite(p.falseSignal, 'falseSignal', -1, 1);
  if (p.duration !== null) finite(p.duration, 'duration');
  if (typeof p.authorized !== 'boolean') throw new TypeError('authorized must be boolean');
  return p;
}

function seeded(seed) {
  return [...`policy:${seed ?? 1}`].reduce((hash, c) => Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
}

function drawOnce(rngState) {
  const next = (rngState + 0x6D2B79F5) >>> 0;
  let bits = Math.imul(next ^ (next >>> 15), next | 1);
  bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
  return {rngState: next, draw: ((bits ^ (bits >>> 14)) >>> 0) / 4294967296};
}

export function initialPolicyState(config) {
  settings(config);
  return {version: 1, controller: {pending: [], history: [], known: null, signals: []},
    actions: [], receipts: [], rngState: seeded(config.seed), nextId: 1, energySpent: 0, workSpent: 0};
}

function dependencies(raw = {}) {
  const services = rows => (rows ?? []).map(row => ({service: String(row.service),
    fraction: finite(row.fraction ?? 0, 'dependency fraction', 0, 1), covered: row.covered === true}));
  return {rsiOnHumans: services(raw.rsiOnHumans), humansOnRsi: services(raw.humansOnRsi),
    uncovered: (raw.uncovered ?? []).map(String)};
}

function projectObservation(raw, t, p) {
  finite(raw.t, 'observation time');
  if (raw.t > t) throw new RangeError('Cannot observe a future projection');
  const numeric = Object.fromEntries(['H', 'q', 'exposure', 'deficit', 'supply', 'need', 'coverage', 'fundingShare']
    .filter(key => raw[key] !== undefined).map(key => [key, finite(raw[key], `observation ${key}`)]));
  const technology = Object.fromEntries(TECH_KEYS.filter(key => raw.technology?.[key] !== undefined)
    .map(key => [key, finite(raw.technology[key], `technology ${key}`)]));
  const plans = (raw.plans ?? []).map(plan => ({id: String(plan.id), time: finite(plan.time, 'plan time'),
    powerDelta: finite(plan.powerDelta ?? 0, 'plan powerDelta', -Infinity),
    needDelta: finite(plan.needDelta ?? 0, 'plan needDelta', -Infinity)}));
  return {t: raw.t, ...numeric, technology, plans, dependencies: dependencies(raw.dependencies),
    ...(raw.powerAvailability === undefined ? {} :
      {powerAvailability: finite(raw.powerAvailability, 'power availability', 0, 1)}),
    ...(raw.authorized === undefined ? {} : {authorized: raw.authorized === true}),
    observedAt: raw.t + p.observationDelay};
}

export function observePolicy(state, projection, t, config) {
  finite(t, 'time');
  const p = settings(config);
  const c = state.controller;
  const duplicate = projection && [...c.pending, ...c.history].some(row => row.t === projection.t);
  const pending = projection && !duplicate ? [...c.pending, projectObservation(projection, t, p)] : [...c.pending];
  if (projection?.t > t) throw new RangeError('Cannot observe a future projection');
  const released = pending.filter(row => row.observedAt <= t).sort((a, b) => a.t - b.t);
  const history = [...c.history, ...released].sort((a, b) => a.t - b.t);
  const known = history.at(-1) ?? null;
  return {...state, controller: {...c, pending: pending.filter(row => row.observedAt > t), history, known}};
}

function deficitAt(supply, need) {
  return need > 0 ? Math.max(0, Math.min(1, (need - supply) / need)) : 0;
}

function signalFor(known, p, t) {
  if (!known) return null;
  const deficit = Math.max(0, Math.min(1, (known.deficit ?? deficitAt(known.supply ?? 0, known.need ?? 0)) + p.falseSignal));
  if (deficit > 0 && deficit >= p.deficitThreshold) return {reason: 'observed-deficit', value: deficit, observedTime: known.t};
  if ((known.exposure ?? 0) > 0 && known.exposure >= p.exposureThreshold) {
    return {reason: 'observed-exposure', value: known.exposure, observedTime: known.t};
  }
  if (p.mode !== 'anticipatory') return null;
  let supply = known.supply ?? 0;
  let need = known.need ?? 0;
  // Published changes after sampling but before now are still known changes.
  const plans = known.plans.filter(plan => plan.time > known.t && plan.time <= t + p.lookahead)
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  for (const time of [...new Set(plans.map(plan => plan.time))]) {
    const simultaneous = plans.filter(plan => plan.time === time);
    // Plans keep nominal reusable quantities. Hold the released observation's
    // availability fixed; pending telemetry cannot revise this forecast.
    supply = Math.max(0, supply + (known.powerAvailability ?? 1) *
      simultaneous.reduce((sum, plan) => sum + plan.powerDelta, 0));
    need = Math.max(0, need + simultaneous.reduce((sum, plan) => sum + plan.needDelta, 0));
    const predicted = deficitAt(supply, need);
    if (predicted > 0 && predicted >= p.deficitThreshold) {
      return {reason: 'known-plan-deficit', value: predicted, observedTime: known.t,
        planId: simultaneous[0].id, planIds: simultaneous.map(plan => plan.id), planTime: time};
    }
  }
  return null;
}

function expireActions(state, t) {
  return {...state, actions: state.actions.map(action => action.expiresAt !== null && t >= action.expiresAt
    && !TERMINAL.has(action.status) ? {...action, status: 'expired'} : {...action})};
}

function resourceRequests(state, t) {
  return state.actions.filter(a => !TERMINAL.has(a.status) && a.status !== 'active' && t >= a.eligibleAt)
    .map(a => ({id: a.id, kind: 'policy', owner: 'human', type: a.type, target: a.target,
      energy: Math.max(0, a.energyRequired - a.energyPaid), work: Math.max(0, a.workRequired - a.workPaid),
      priority: a.priority, eligibleAt: a.eligibleAt, expiresAt: a.expiresAt}))
    .filter(request => request.energy > 0 || request.work > 0);
}

export function requestPolicy(state, t, config) {
  finite(t, 'time');
  const p = settings(config);
  let next = expireActions(state, t);
  if (p.mode === 'none' || t < p.start || next.actions.length) return {state: next, requests: resourceRequests(next, t)};
  const signal = p.mode === 'fixed' ? {reason: 'fixed-start', observedTime: t} : signalFor(next.controller.known, p, t);
  if (!signal) return {state: next, requests: []};
  const start = p.mode === 'fixed' ? p.start : t;
  const action = {id: `policy-${next.nextId}`, type: p.type, target: 'covered-operating-blocks',
    intensity: p.type === 'cap' ? p.cap : 1 - p.residual, cap: p.cap, residual: p.residual, success: p.success,
    start, createdAt: t, eligibleAt: finite(start + p.delay, 'eligibility time'),
    expiresAt: p.duration === null ? null : finite(start + p.duration, 'expiry time'),
    energyRequired: p.cost, workRequired: p.work, energyPaid: 0, workPaid: 0, paidAt: null,
    priority: p.priority, status: 'waiting', attempted: false, draw: null, effective_from: null,
    prerequisites: ['eligibility', 'paid-energy', 'paid-work', 'authority', 'validity']};
  next = expireActions({...next, nextId: next.nextId + 1, actions: [action],
    controller: {...next.controller, signals: [...next.controller.signals, {...signal, actionId: action.id, time: t}]}}, t);
  return {state: next, requests: resourceRequests(next, t)};
}

function intervalIsSplit(state, t, endpoint) {
  return state.actions.some(a => !TERMINAL.has(a.status) && a.status !== 'active'
    && [a.eligibleAt, a.expiresAt].some(boundary => boundary !== null && boundary > t && boundary < endpoint));
}

/** Actual allocation over [t,t+h); receiptId is the common-ledger idempotency key. */
export function fundPolicy(state, t, h, budget, config) {
  settings(config);
  finite(t, 'time'); finite(h, 'interval');
  finite(budget.energy, 'energy'); finite(budget.work, 'work');
  const endpoint = finite(t + h, 'endpoint');
  if (state.actions.some(a => a.createdAt > t)) throw new RangeError('Cannot backdate funding time');
  const key = String(budget.receiptId ?? `policy-funding:${t}:${endpoint}`);
  if (state.receipts.some(row => row.id === key)) return {state: {...state}, energyUsed: 0, workUsed: 0, receipts: []};
  if (intervalIsSplit(state, t, endpoint)) throw new RangeError('Split funding interval at eligibility/expiry boundary');
  let energyUsed = 0;
  let workUsed = 0;
  const actions = expireActions(state, t).actions.map(a => {
    if (TERMINAL.has(a.status) || a.status === 'active' || t < a.eligibleAt || h === 0) return a;
    const energy = Math.max(0, Math.min(a.energyRequired - a.energyPaid, budget.energy - energyUsed));
    const work = Math.max(0, Math.min(a.workRequired - a.workPaid, budget.work - workUsed));
    energyUsed += energy; workUsed += work;
    const energyPaid = Math.min(a.energyRequired, a.energyPaid + energy);
    const workPaid = Math.min(a.workRequired, a.workPaid + work);
    const ready = energyPaid >= a.energyRequired && workPaid >= a.workRequired;
    return {...a, energyPaid, workPaid, paidAt: ready ? a.paidAt ?? endpoint : null,
      status: ready ? 'ready' : energyPaid + workPaid > 0 ? 'funding' : 'unfunded'};
  });
  const settled = h > 0 && actions.some(a => !TERMINAL.has(a.status) && a.status !== 'active' && t >= a.eligibleAt);
  const receipts = settled ? [{id: key, requestId: actions[0].id, kind: 'policy-funding',
    time: endpoint, intervalStart: t, energy: energyUsed, work: workUsed}] : [];
  const next = {...state, actions, receipts: [...state.receipts, ...receipts],
    energySpent: state.energySpent + energyUsed, workSpent: state.workSpent + workUsed};
  return {state: next, energyUsed, workUsed, receipts};
}

function executionConditions(config, conditions) {
  const p = settings(config);
  const coverage = finite(conditions.coverage ?? p.coverage, 'coverage', 0, 1);
  const fundingShare = finite(conditions.fundingShare ?? config.resources?.policyEnergyShare ?? 0, 'fundingShare', 0, 1);
  const authorized = conditions.authorized ?? p.authorized;
  if (typeof authorized !== 'boolean') throw new TypeError('authorized must be boolean');
  return {coverage, authorized, fundingShare};
}

export function activatePolicy(state, t, config, conditions = {}) {
  finite(t, 'time');
  if (state.actions.some(a => a.createdAt > t)) throw new RangeError('Cannot backdate deployment time');
  const actual = executionConditions(config, conditions);
  let rngState = state.rngState;
  let receipts = [];
  const actions = expireActions(state, t).actions.map(a => {
    if (TERMINAL.has(a.status) || a.status === 'active' || t < a.eligibleAt
      || a.energyPaid < a.energyRequired || a.workPaid < a.workRequired || (a.paidAt ?? 0) > t) return a;
    if (!actual.authorized) return {...a, status: 'unauthorized'};
    const attempt = a.type === 'shutdown' ? drawOnce(rngState) : {rngState, draw: null};
    rngState = attempt.rngState;
    const success = a.type === 'cap' || attempt.draw < a.success;
    const updated = {...a, attempted: a.type === 'shutdown', draw: attempt.draw,
      status: success ? 'active' : 'failed', effective_from: success ? t : null, attemptedAt: t};
    receipts = [...receipts, {id: `deployment:${a.id}`, requestId: a.id, kind: 'policy-deployment',
      time: t, status: updated.status, effective_from: updated.effective_from, draw: updated.draw}];
    return updated;
  });
  return {state: {...state, actions, rngState, receipts: [...state.receipts, ...receipts]}, receipts};
}

export function policyControls(state, t, config, conditions = {}) {
  finite(t, 'time');
  const actual = executionConditions(config, conditions);
  const a = state.actions.find(action => action.status === 'active' && action.effective_from <= t
    && (action.expiresAt === null || t < action.expiresAt));
  const active = Boolean(a && actual.authorized);
  return {...actual, active, type: a?.type ?? null, actionId: a?.id ?? null,
    capCoveredBlocks: active && a.type === 'cap' ? a.cap : null,
    coveredOperatingFraction: active && a.type === 'shutdown' ? a.residual : 1,
    uncoveredOperatingFraction: 1, effective_from: a?.effective_from ?? null};
}

export function nextPolicyTime(state, t, config, rates = {}) {
  finite(t, 'time');
  const p = settings(config);
  const boundaries = [
    ...(p.mode !== 'none' && !state.actions.length ? [p.start] : []),
    ...state.controller.pending.map(row => row.observedAt),
    ...state.actions.filter(a => !TERMINAL.has(a.status)).flatMap(a => [a.eligibleAt, a.expiresAt]),
  ].filter(value => value !== null && value > t);
  for (const a of state.actions.filter(a => !TERMINAL.has(a.status) && a.status !== 'active' && t >= a.eligibleAt)) {
    const completion = ['energy', 'work'].map(key => {
      const remaining = a[`${key}Required`] - a[`${key}Paid`];
      const rate = rates[key] ?? 0;
      finite(rate, `${key} rate`);
      return remaining <= 0 ? 0 : rate > 0 ? remaining / rate : Infinity;
    });
    const wait = Math.max(...completion);
    if ((a.energyPaid < a.energyRequired || a.workPaid < a.workRequired) && Number.isFinite(wait)) {
      // A sub-ULP completion time must not become a zero-length interval. Move
      // to a representable future endpoint; fundPolicy still debits only the
      // actual remaining energy/work, with no free completion tolerance.
      const endpoint = t + wait;
      boundaries.push(endpoint > t ? endpoint : t + Number.EPSILON * Math.max(1, t));
    }
  }
  return Math.min(...boundaries);
}
