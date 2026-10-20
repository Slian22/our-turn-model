import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun, advanceRun, saveCheckpoint, restoreCheckpoint} from '../revised/engine.mjs';

const expiryFixture = dt => ({horizon: 2, dt, aiEnabled: false, alignment: 0,
  initial: {H: 1, hardware: 0, humanPower: 10, aiPower: 0,
    humanFactories: 0, aiFactories: 0, ageBands: [0]},
  human: {criticalEnergy: 1e-6, criticalFloor: 1e-6, flexEnergy: 0,
    landPerMillion: 0, growth: 0},
  resources: {maintenanceEnergyPerWork: 0, constructionEnergyShare: 0, policyEnergyShare: 0.5},
  assets: {power: {endPerformance: 1, maintenance: 0}},
  policy: {mode: 'fixed', type: 'cap', start: 0, delay: 0.03,
    cost: 2, work: 0, success: 1, observationDelay: 0, duration: 0.43}});

test('R1 scheduler honors absolute eligibility/expiry despite rounded time subtraction', () => {
  assert.ok(0.03 + (0.43 - 0.03) > 0.43, 'fixture must exercise the round-trip overshoot');
  for (const dt of [1, 0.25, 0.125]) {
    const run = advanceRun(createRun(expiryFixture(dt)), 0.5);
    assert.equal(run.state.t, 0.5);
    assert.equal(run.state.policyState.actions[0].status, 'expired');
    assert.equal(run.state.policyState.actions[0].effective_from, null);
    const paid = run.state.policyState.energySpent;
    const allocated = run.state.history.slice(1).filter(row => row.ledger.start >= 0.03 && row.ledger.end <= 0.43)
      .reduce((total, row) => total + row.ledger.available * 0.5, 0);
    assert.equal(paid, Math.min(2, allocated));
    if (dt === 1) assert.equal(paid, 2, 'the final positive interval must pay the actual remainder');
    if (paid < 2) assert.equal(run.state.policyState.actions[0].paidAt, null);
    assert.equal(run.state.policyState.receipts.filter(r => r.kind === 'policy-funding')
      .reduce((total, r) => total + r.energy, 0), paid);
    for (const row of run.state.history.slice(1)) {
      for (const boundary of [0.03, 0.43]) {
        assert.ok(!(row.ledger.start < boundary && row.ledger.end > boundary));
      }
      assert.ok(row.ledger.end > row.ledger.start);
    }
    assert.deepEqual(restoreCheckpoint(saveCheckpoint(run)), run);
  }
});
