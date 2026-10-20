import { uniform } from './rng.mjs';

const COMMON_KEYS = ['type', 'start', 'delay', 'cost'];
const TYPE_KEYS = { cap: ['capBlocks', 'duration'], shutdown: ['success', 'residual'] };

function numberInRange(value, name, min = 0, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`Invalid ${name}; expected a finite number in ${min}..${max}`);
  }
  return value;
}

function normalizePolicy(policy, index, horizon) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(policy))) {
    throw new TypeError(`Policy ${index} must be a plain object`);
  }
  if (policy.type !== 'cap' && policy.type !== 'shutdown') {
    throw new RangeError(`Invalid policy ${index} type; expected cap or shutdown`);
  }
  const allowed = [...COMMON_KEYS, ...TYPE_KEYS[policy.type]];
  if (Reflect.ownKeys(policy).some((key) => !allowed.includes(key))) {
    throw new RangeError(`Unknown key in policy ${index}`);
  }
  const start = numberInRange(policy.start, `policy ${index} start (year)`);
  const delay = numberInRange(policy.delay, `policy ${index} delay (year)`);
  const cost = numberInRange(Object.hasOwn(policy, 'cost') ? policy.cost : 5,
    `policy ${index} cost (TWh/attempt)`);
  const common = { type: policy.type, start, delay, cost };
  const trigger = numberInRange(start + delay, `policy ${index} trigger (year)`);
  if (policy.type === 'shutdown') {
    return {
      ...common,
      success: numberInRange(policy.success, `policy ${index} success`, 0, 1),
      residual: numberInRange(policy.residual, `policy ${index} residual`, 0, 1),
    };
  }
  const duration = numberInRange(Object.hasOwn(policy, 'duration') ? policy.duration : horizon + 1,
    `policy ${index} duration (year)`);
  numberInRange(trigger + duration, `policy ${index} expiry (year)`);
  return { ...common, capBlocks: numberInRange(policy.capBlocks, `policy ${index} capBlocks`), duration };
}

/** Normalize scenario assumptions once at configuration creation, preserving array indices. */
export function validatePolicies(policies, horizon) {
  numberInRange(horizon, 'policy horizon (year)');
  if (!Array.isArray(policies) || policies.length > 64) {
    throw new TypeError('Policies must be an array of at most 64 policies');
  }
  return Array.from(policies, (policy, index) => normalizePolicy(policy, index, horizon));
}

function inCapWindow(policy, t) {
  const trigger = policy.start + policy.delay;
  return !before(t, trigger) && before(t, trigger + policy.duration);
}

// Treat only machine-scale roundoff as equality; a positive cost still exceeds zero energy.
function before(a, b) {
  return b - a > 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
}

function attemptPolicy(state, policy, index) {
  const draw = policy.type === 'shutdown' ? uniform(state.rng.policy) : null;
  const outcome = draw && draw.value >= policy.success ? 'failure' : 'success';
  const details = { t: state.t, outcome, ...(draw ? { draw: draw.value } : {}) };
  const succeeded = draw !== null && outcome === 'success';
  return {
    ...state,
    shutdown: state.shutdown || succeeded,
    residual: succeeded ? Math.min(state.residual, policy.residual) : state.residual,
    rng: draw ? { ...state.rng, policy: draw.state } : state.rng,
    policyLog: [...state.policyLog, { index, ...details }],
    events: [...state.events, { type: 'policy', policyIndex: index, ...details }],
  };
}

/** Spend available TWh on due attempts once; return active caps independently of other actions. */
export function processPolicies(state, config, availableEnergyTWh) {
  numberInRange(availableEnergyTWh, 'available policy energy (TWh)');
  const attempted = new Set(state.policyLog.map(({ index }) => index));
  const result = config.policies.reduce((current, policy, index) => {
    if (attempted.has(index) || before(state.t, policy.start + policy.delay)
      || (policy.type === 'cap' && !inCapWindow(policy, state.t))) return current;
    const cost = current.cost + policy.cost;
    if ((policy.cost > 0 && current.cost === availableEnergyTWh)
      || !Number.isFinite(cost) || before(availableEnergyTWh, cost)) return current;
    return {
      state: attemptPolicy(current.state, policy, index),
      cost: Math.min(cost, availableEnergyTWh),
    };
  }, { state, cost: 0 });
  const active = new Set(result.state.policyLog.map(({ index }) => index));
  const capBlocks = config.policies.reduce((limit, policy, index) => (
    policy.type === 'cap' && active.has(index) && inCapWindow(policy, state.t)
      ? Math.min(limit, policy.capBlocks) : limit
  ), Infinity);
  return { ...result, capBlocks };
}
