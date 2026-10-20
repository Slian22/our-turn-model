import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialPolicyState, observePolicy, requestPolicy, fundPolicy, activatePolicy,
  policyControls, nextPolicyTime,
} from '../revised/policy.mjs';

const config = (policy = {}) => ({seed: 42, resources: {policyEnergyShare: 0.2}, policy: {
  mode: 'fixed', type: 'cap', start: 5, delay: 2, cost: 10, work: 4,
  duration: 20, cap: 30, success: 1, residual: 0.1, priority: 2,
  coverage: 0.6, authorized: true, observationDelay: 0,
  deficitThreshold: 0.2, exposureThreshold: 0.5, lookahead: 5,
  falseSignal: 0, ...policy,
}});
const projection = (t, extra = {}) => ({t, H: 100, q: 1, exposure: 0,
  deficit: 0, supply: 100, need: 80, ...extra});
const requested = c => requestPolicy(initialPolicyState(c), c.policy.start, c).state;
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('fixed 5/30/60 starts create one common action and wait before any spending', () => {
  for (const start of [5, 30, 60]) {
    const c = config({start});
    let s = initialPolicyState(c);
    assert.equal(requestPolicy(s, start - 0.01, c).state.actions.length, 0);
    s = requestPolicy(s, start, c).state;
    const repeated = requestPolicy(s, start, c);
    assert.equal(repeated.state.actions.length, 1);
    assert.equal(repeated.requests.length, 0);
    assert.equal(s.actions[0].eligibleAt, start + 2);
    const paid = fundPolicy(s, start, 1, {energy: 10, work: 4}, c);
    assert.equal(paid.energyUsed, 0);
    assert.equal(paid.workUsed, 0);
    assert.equal(nextPolicyTime(s, start, c), start + 2);
    assert.throws(() => fundPolicy(s, start + 1, 2, {energy: 10, work: 4}, c), /boundar/i);
  }
});

test('both resources must be paid and endpoint deployment is nonretroactive', () => {
  const c = config();
  let s = requested(c);
  const request = requestPolicy(s, 7, c).requests[0];
  assert.equal(request.id, s.actions[0].id);
  assert.equal(request.energy, 10);
  assert.equal(request.work, 4);
  let paid = fundPolicy(s, 7, 1, {energy: 100, work: 2, receiptId: 'ledger:1'}, c);
  assert.equal(paid.energyUsed, 10);
  assert.equal(paid.workUsed, 2);
  assert.equal(activatePolicy(paid.state, 8, c).state.actions[0].effective_from, null);
  paid = fundPolicy(paid.state, 8, 1, {energy: 100, work: 100, receiptId: 'ledger:2'}, c);
  assert.equal(paid.energyUsed, 0);
  assert.equal(paid.workUsed, 2);
  const active = activatePolicy(paid.state, 9, c);
  assert.equal(active.state.actions[0].effective_from, 9);
  assert.equal(policyControls(active.state, 8.999, c).active, false);
  assert.equal(policyControls(active.state, 9, c).active, true);
  assert.equal(active.state.energySpent, 10);
  assert.equal(active.state.workSpent, 4);
});

test('funding replay cannot pay twice, including after checkpoint JSON roundtrip', () => {
  const c = config({delay: 0});
  const first = fundPolicy(requested(c), 5, 1, {energy: 3, work: 1, receiptId: 'same'}, c);
  const replay = fundPolicy(JSON.parse(JSON.stringify(first.state)), 5, 1,
    {energy: 3, work: 1, receiptId: 'same'}, c);
  assert.equal(replay.energyUsed, 0);
  assert.equal(replay.workUsed, 0);
  assert.equal(replay.state.energySpent, 3);
  assert.equal(replay.state.receipts.length, first.state.receipts.length);
  assert.equal(nextPolicyTime(first.state, 6, c, {energy: 7, work: 3}), 7);
});

test('cap expiry rejects endpoint deployment and leaves already paid costs recorded', () => {
  const c = config({delay: 0, duration: 1});
  const paid = fundPolicy(requested(c), 5, 1, {energy: 10, work: 4}, c);
  const expired = activatePolicy(paid.state, 6, c);
  assert.equal(expired.state.actions[0].status, 'expired');
  assert.equal(expired.state.actions[0].effective_from, null);
  assert.equal(expired.state.energySpent, 10);
  assert.equal(policyControls(expired.state, 6, c).active, false);
});

test('unfunded, unauthorized, failed, active and expired remain distinguishable', () => {
  const c = config({delay: 0, type: 'shutdown', success: 0});
  let s = fundPolicy(requested(c), 5, 1, {energy: 0, work: 0}, c).state;
  assert.equal(s.actions[0].status, 'unfunded');
  s = fundPolicy(s, 6, 1, {energy: 10, work: 4}, c).state;
  const blocked = activatePolicy(s, 7, c, {authorized: false});
  assert.equal(blocked.state.actions[0].status, 'unauthorized');
  assert.equal(blocked.state.actions[0].attempted, false);
  s = activatePolicy(blocked.state, 8, c).state;
  assert.equal(s.actions[0].status, 'failed');
  assert.equal(s.actions[0].attempted, true);
  const checkpoint = JSON.parse(JSON.stringify(s));
  const again = activatePolicy(checkpoint, 9, config({type: 'shutdown', success: 1}));
  assert.equal(again.state.actions[0].draw, s.actions[0].draw);
  assert.equal(again.state.rngState, s.rngState);
  assert.equal(again.state.actions[0].status, 'failed');
  assert.equal(requestPolicy(again.state, 9, c).state.actions.length, 1);
});

test('cap controls expose physical covered-block bound and preserve uncovered compute', () => {
  const c = config({delay: 0, cost: 0, work: 0});
  const s = activatePolicy(requested(c), 5, c).state;
  const control = policyControls(s, 5, c, {coverage: 0.4, fundingShare: 0.3});
  assert.equal(control.capCoveredBlocks, 30);
  assert.equal(control.coverage, 0.4);
  assert.equal(control.fundingShare, 0.3);
  assert.equal(control.uncoveredOperatingFraction, 1);
  assert.equal(Math.min(100 * control.coverage, control.capCoveredBlocks)
    + 100 * (1 - control.coverage), 90);
  assert.equal(policyControls(s, 5, c, {authorized: false}).active, false);
  assert.equal(policyControls(s, 25, c).active, false);
});

test('shutdown residual applies only to covered/reachable activity', () => {
  const c = config({delay: 0, cost: 0, work: 0, type: 'shutdown'});
  const s = activatePolicy(requested(c), 5, c).state;
  const control = policyControls(s, 5, c);
  assert.equal(control.coveredOperatingFraction, 0.1);
  assert.equal(control.uncoveredOperatingFraction, 1);
  assert.equal(100 * (1 - control.coverage + control.coverage * control.coveredOperatingFraction), 46);
  assert.equal(activatePolicy(s, 6, c).state.rngState, s.rngState);
});

test('observations are delayed, allowlisted and cannot reveal world or schedule', () => {
  const c = config({mode: 'deficit', start: 0, observationDelay: 2});
  const raw = projection(1, {deficit: 0.4, world: {secret: 1}, futureSchedule: [{time: 4}],
    technology: {algorithm: 2, hiddenCoverage: 1},
    dependencies: {rsiOnHumans: [{service: 'maintenance', fraction: 0.7, covered: true}],
      humansOnRsi: [{service: 'critical power', fraction: 0.2, covered: true}],
      uncovered: ['medicine']}});
  let s = observePolicy(initialPolicyState(c), freeze(raw), 1, c);
  assert.equal(s.controller.known, null);
  assert.equal(requestPolicy(s, 1, c).state.actions.length, 0);
  assert.equal(nextPolicyTime(s, 1, c), 3);
  s = observePolicy(s, null, 3, c);
  assert.equal(s.controller.known.deficit, 0.4);
  assert.equal('futureSchedule' in s.controller.known, false);
  assert.deepEqual(s.controller.known.technology, {algorithm: 2});
  assert.deepEqual(s.controller.known.dependencies.uncovered, ['medicine']);
  assert.equal(requestPolicy(s, 3, c).state.actions.length, 1);
  assert.throws(() => observePolicy(s, projection(9), 3, c), /future/i);
});

test('deficit/exposure/false signals trigger from observed information only', () => {
  for (const [p, extra] of [
    [{}, {deficit: 0.25}], [{}, {exposure: 0.6}],
    [{falseSignal: 0.3}, {deficit: 0}],
  ]) {
    const c = config({mode: 'deficit', start: 0, ...p});
    const s = observePolicy(initialPolicyState(c), projection(1, extra), 1, c);
    assert.equal(requestPolicy(s, 1, c).state.actions.length, 1);
  }
  const c = config({mode: 'none'});
  assert.equal(requestPolicy(initialPolicyState(c), 100, c).state.actions.length, 0);
});

test('anticipatory trigger uses only published plans within lookahead', () => {
  const c = config({mode: 'anticipatory', start: 0});
  let s = observePolicy(initialPolicyState(c), projection(1, {plans: [
    {id: 'known retirement', time: 4, powerDelta: -50, needDelta: 0},
  ]}), 1, c);
  assert.equal(requestPolicy(s, 1, c).state.actions.length, 1);
  s = observePolicy(initialPolicyState(c), projection(1, {plans: [
    {id: 'later retirement', time: 10, powerDelta: -50, needDelta: 0},
  ], futureSchedule: [{time: 2, powerDelta: -1000}]}), 1, c);
  assert.equal(requestPolicy(s, 1, c).state.actions.length, 0);
});

test('all policy functions preserve input objects and reject invalid resource budgets', () => {
  const c = freeze(config({delay: 0}));
  const s = freeze(requested(c));
  const paid = fundPolicy(s, 5, 1, freeze({energy: 10, work: 4}), c);
  const active = activatePolicy(freeze(paid.state), 6, c);
  policyControls(freeze(active.state), 6, c);
  assert.equal(s.energySpent, 0);
  assert.throws(() => fundPolicy(s, 5, 1, {energy: NaN, work: 4}, c), /energy/i);
  assert.throws(() => fundPolicy(s, 5, 1, {energy: 1, work: -1}, c), /work/i);
  assert.throws(() => initialPolicyState(config({coverage: 2})), /coverage/i);
});

test('simultaneous published deliveries and retirements are evaluated together', () => {
  const c = config({mode: 'anticipatory', start: 0});
  const s = observePolicy(initialPolicyState(c), projection(1, {plans: [
    {id: 'a-retirement', time: 4, powerDelta: -50},
    {id: 'z-replacement', time: 4, powerDelta: 50},
  ]}), 1, c);
  assert.equal(requestPolicy(s, 1, c).state.actions.length, 0);
});

test('known projected margin uses all changes before evaluating a shared endpoint', () => {
  const c = config({mode: 'anticipatory', start: 0});
  const s = observePolicy(initialPolicyState(c), projection(1, {plans: [
    {id: 'need increase', time: 4, needDelta: 100},
    {id: 'power increase', time: 4, powerDelta: 10},
  ]}), 1, c);
  const result = requestPolicy(s, 1, c);
  assert.equal(result.state.actions.length, 1);
  assert.equal(result.state.controller.signals.at(-1).planTime, 4);
});

test('replayed zero funding receipt remains settled even if a caller changes its budget', () => {
  const c = config({delay: 0});
  const first = fundPolicy(requested(c), 5, 1, {energy: 0, work: 0, receiptId: 'zero'}, c);
  const replay = fundPolicy(first.state, 5, 1, {energy: 10, work: 4, receiptId: 'zero'}, c);
  assert.equal(replay.energyUsed, 0);
  assert.equal(replay.workUsed, 0);
});

test('late receipts cannot backdate adoption or deployment of a policy', () => {
  const c = config({delay: 0, cost: 0, work: 0, duration: null});
  const s = requestPolicy(initialPolicyState(c), 10, c).state;
  assert.throws(() => activatePolicy(s, 6, c), /time|backdat/i);
});

test('sub-ULP funding completion returns a future boundary and pays only the actual remainder', () => {
  const c = config({start: 0, delay: 0, cost: 1, work: 0});
  let s = fundPolicy(requested(c), 0, 1,
    {energy: 1 - Number.EPSILON / 2, work: 0, receiptId: 'nearly-paid'}, c).state;
  const t = 2.000280153265474;
  const rate = 1e6;
  const next = nextPolicyTime(s, t, c, {energy: rate, work: 0});
  assert.ok(next > t, 'a funding boundary must be representably later than current time');
  const budget = rate * (next - t);
  const remaining = s.actions[0].energyRequired - s.actions[0].energyPaid;
  const funded = fundPolicy(s, t, next - t, {energy: budget, work: 0}, c);
  assert.equal(funded.energyUsed, remaining);
  assert.ok(funded.energyUsed <= budget);
  assert.equal(funded.state.energySpent, 1);
  assert.equal(activatePolicy(funded.state, next, c).state.actions[0].status, 'active');
});

test('anticipatory plans use the released maintenance snapshot, with legacy nominal default', () => {
  const c = config({mode: 'anticipatory', start: 0});
  const plans = [{id: 'retirement', time: 2, powerDelta: -100, needDelta: 0}];
  for (const availability of [0, 0.5, 1, undefined]) {
    const extra = availability === undefined ? {} : {powerAvailability: availability};
    const s = observePolicy(initialPolicyState(c), projection(0, {supply: 100, need: 40, plans, ...extra}), 0, c);
    assert.equal(s.controller.known.powerAvailability, availability);
    const result = requestPolicy(s, 0, c);
    assert.equal(result.state.actions.length, availability === 1 || availability === undefined ? 1 : 0);
  }
});

test('published commissioning scales availability while future physical demand changes stay unscaled', () => {
  const c = config({mode: 'anticipatory', start: 0, deficitThreshold: 0.1});
  const s = observePolicy(initialPolicyState(c), projection(0, {powerAvailability: 0.5,
    plans: [{id: 'commission', time: 2, powerDelta: 100, needDelta: 100}]}), 0, c);
  const result = requestPolicy(s, 0, c);
  assert.equal(result.state.actions.length, 1);
  assert.ok(Math.abs(result.state.controller.signals[0].value - 1 / 6) < 1e-14);
  assert.equal(result.state.energySpent, 0);
});

test('pending observations cannot change availability in an already released plan forecast', () => {
  const c = config({mode: 'anticipatory', start: 0, observationDelay: 1});
  const plans = [{id: 'retirement', time: 3, powerDelta: -100, needDelta: 0}];
  const first = observePolicy(initialPolicyState(c), projection(0, {need: 40, plans, powerAvailability: 0.5}), 0, c);
  const next = observePolicy(first, projection(1, {need: 40, plans, powerAvailability: 1}), 1, c);
  assert.equal(next.controller.known.powerAvailability, 0.5);
  assert.equal(next.controller.pending[0].powerAvailability, 1);
  assert.equal(requestPolicy(next, 1, c).state.actions.length, 0);
  const released = observePolicy(next, null, 2, c);
  assert.equal(released.controller.known.powerAvailability, 1);
  assert.equal(requestPolicy(released, 2, c).state.actions.length, 1);
});

test('observed power availability rejects nonfinite and out-of-range values', () => {
  const c = config();
  for (const value of [-0.1, 1.1, NaN, Infinity, '0.5']) assert.throws(() =>
    observePolicy(initialPolicyState(c), projection(0, {powerAvailability: value}), 0, c), /availability|finite/i);
});
