import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun} from '../revised/engine.mjs';
import {physicalView, policyProjection, resourceRates, integrateState} from '../revised/dynamics.mjs';
import {initialPolicyState, observePolicy, requestPolicy} from '../revised/policy.mjs';

test('maintenance-adjusted nominal retirement forecast does not invent a physical shortage', () => {
  const {state, config} = createRun({horizon: 2, initial: {H: 40 / 1.5, hardware: 0,
    humanPower: 100, aiPower: 100, humanFactories: 0, aiFactories: 0, ageBands: [0]},
  assets: {power: {life: 10, endPerformance: 1, maintenance: 0}},
  policy: {mode: 'anticipatory', start: 0, observationDelay: 0, lookahead: 1, deficitThreshold: 0.2}});
  const s = structuredClone(state); s.maintenanceFactor = 0.5;
  s.assetState.assets.find(a => a.kind === 'power' && a.owner === 'human').birth = -9.5;
  const observed = policyProjection(s, config);
  assert.equal(observed.deficit, 0); assert.equal(observed.supply, 100); assert.equal(observed.need, 40);
  assert.equal(observed.powerAvailability, 0.5);
  assert.equal(observed.plans.find(p => p.time === 0.5).powerDelta, -100, 'plans retain nominal reusable values');
  assert.deepEqual(observed.plans, policyProjection({...s, maintenanceFactor: 1}, config).plans);
  const controller = observePolicy(initialPolicyState(config), observed, 0, config);
  assert.equal(requestPolicy(controller, 0, config).state.actions.length, 0);
  const next = integrateState(s, config, 0.5, resourceRates(s, config)), actual = physicalView(next, config);
  assert.equal(next.last.deficit, 0);
  assert.ok(actual.sourcePower > actual.criticalNeed);
});
