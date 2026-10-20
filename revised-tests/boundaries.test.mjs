import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../revised/config.mjs';
import { criticalIntensity, demandStep, capabilityStep } from '../revised/math.mjs';

test('C9 zero elapsed time preserves the exact old flexible multiplier', () => {
  for (const minimumFlexible of [0.01, 0.1, 0.9]) {
    for (const maximumFlexible of [1, 1.1, 10]) {
      const human = makeConfig({ human: { minimumFlexible, maximumFlexible } }).human;
      for (const z of [minimumFlexible, 1, maximumFlexible]) {
        for (const adequacy of [0, 1]) {
          for (const spare of [0, 1]) assert.equal(demandStep(z, adequacy, 0, human, spare), z);
        }
      }
    }
  }
});

test('C9 tiny elapsed time preserves a representable response from a zero multiplier', () => {
  const human = makeConfig({ human: { minimumFlexible: 0, maximumFlexible: 1, demandTime: 1000 } }).human;
  const next = demandStep(0, 1, 1e-16, human);
  assert.ok(next > 0, 'a positive, representable adjustment must not cancel to zero');
  assert.ok(Math.abs(next / 1e-19 - 1) < 1e-14);
});

test('C9 endpoint and tiny-step outputs stay inside bounds and remain valid inputs', () => {
  for (const minimumFlexible of [0, 0.01, 0.1, 0.3, 0.9, 1]) {
    for (const maximumFlexible of [1, 1.1, 10]) {
      const human = makeConfig({ human: { minimumFlexible, maximumFlexible, demandTime: 1000 } }).human;
      for (const z of [minimumFlexible, 1, maximumFlexible]) {
        for (const adequacy of [0, 1]) {
          for (const spare of [0, 1]) {
            for (const h of [0, Number.MIN_VALUE, 1e-16, 0.005, 1, 1e6]) {
              const next = demandStep(z, adequacy, h, human, spare);
              assert.ok(Number.isFinite(next) && next >= minimumFlexible && next <= maximumFlexible);
              assert.doesNotThrow(() => demandStep(next, adequacy, 0.125, human, spare));
            }
          }
        }
      }
    }
  }
});

test('C9 finite-time lag remains a gradual response for shortage and spare supply', () => {
  const human = makeConfig({ human: { demandTime: 2 } }).human;
  for (const [adequacy, spare, target] of [[0, 0, 0.9], [1, 1, 1.1]]) {
    const one = demandStep(1, adequacy, 1, human, spare);
    const split = demandStep(demandStep(1, adequacy, 0.25, human, spare), adequacy, 0.75, human, spare);
    assert.ok(Math.abs(one - (target + (1 - target) * Math.exp(-0.5))) < 1e-14);
    assert.ok(Math.abs(split - one) < 1e-14);
    assert.ok(one > Math.min(1, target) && one < Math.max(1, target));
  }
});

test('C9 rejects malformed demand time and spare energy before zero-step handling', () => {
  const human = makeConfig().human;
  for (const demandTime of [0, -1, NaN, Infinity, -Infinity, undefined, null, '2']) {
    assert.throws(() => demandStep(1, 1, 0, { ...human, demandTime }), /demand.*time/i);
  }
  for (const spare of [-1, NaN, Infinity, -Infinity, null, '1']) {
    assert.throws(() => demandStep(1, 1, 0, human, spare), /spare/i);
  }
  assert.equal(demandStep(1, 1, 0, human), 1);
});

test('C7 rejects zero critical floor and energy while retaining their ordering', () => {
  for (const human of [{ criticalFloor: 0 }, { criticalEnergy: 0 },
    { criticalFloor: 0, criticalEnergy: 0 }]) {
    assert.throws(() => makeConfig({ human }), /critical(Floor|Energy)/);
  }
  assert.throws(() => makeConfig({ human: { criticalFloor: 2, criticalEnergy: 1 } }), /floor/i);
});

test('C7 accepts positive floors, preserves a constant floor and never trends below it', () => {
  const constant = makeConfig({ human: { criticalEnergy: 0.01, criticalFloor: 0.01 } }).human;
  for (const t of [0, 1, 300, 1e6]) assert.equal(criticalIntensity(t, constant), 0.01);
  const human = makeConfig({ human: { criticalEnergy: 2, criticalFloor: Number.MIN_VALUE,
    technologyRate: 1 } }).human;
  assert.equal(criticalIntensity(0, human), 2);
  assert.equal(criticalIntensity(1e6, human), Number.MIN_VALUE);
});

test('C6 validation still rejects malformed AI inputs before no-growth early returns', () => {
  const ai = makeConfig().ai;
  for (const name of ['difficulty', 'growth', 'researchReference', 'researchElasticity']) {
    for (const invalid of [-1, NaN, Infinity, undefined, null, '1']) {
      assert.throws(() => capabilityStep(1, 0, 0, { ...ai, [name]: invalid }));
    }
  }
});

test('C6 tiny-dose grid and finite-overflow witnesses remain nondecreasing', () => {
  const ai = makeConfig().ai;
  for (const q of [1, 1.1, 2, 3, 10, 100, 1e3, 1e6]) {
    for (const difficulty of [0.01, 0.015, 0.03, 0.05, 0.1, 0.15, 0.3, 0.7, 1, 1.5, 2.3, 3, 10]) {
      assert.equal(capabilityStep(q, 1e-30, 0.005, { ...ai, difficulty }), q);
    }
  }
  const expected = 1.2873332935452238e34; // Independent 90-digit Decimal oracle.
  const next = capabilityStep(1, 1e25, 0.125, { ...ai, growth: 10, difficulty: 10,
    researchReference: 1e-9, researchElasticity: 10 });
  assert.ok(Math.abs(next / expected - 1) < 1e-13);
  assert.equal(capabilityStep(1e40, 1, 1, { ...ai, growth: 1, difficulty: 10,
    researchReference: 1, researchElasticity: 1 }), 1e40);
  const zeroDifficulty = { ...ai, difficulty: 0, growth: 0.1, researchReference: 1, researchElasticity: 1 };
  assert.ok(Math.abs(capabilityStep(2, 1, 1, zeroDifficulty) - 2 * Math.exp(0.1)) < 1e-14);
  assert.throws(() => capabilityStep(1, 1, 1e6, zeroDifficulty), /numerical domain/);
});

test('configuration retains explicit event and weighted-age boundary validation', () => {
  const event = { id: 'boundary-event', type: 'power', target: 'power', time: 0,
    magnitude: 2, duration: 1, observationDelay: 0, adoptionEnergy: 0,
    adoptionWork: 1, adoptionDelay: 0 };
  const ageBands = [{ ageFraction: 0, share: 0.5 }, { ageFraction: 0.9, share: 0.5 }];
  const config = makeConfig({ events: [event], initial: { ageBands } });
  assert.deepEqual(config.events, [event]);
  assert.deepEqual(config.initial.ageBands, ageBands);
  assert.ok(Object.isFrozen(config.events[0]) && Object.isFrozen(config.initial.ageBands[0]));
  assert.throws(() => makeConfig({ events: [{ ...event, duration: 0 }] }), /duration/);
  assert.throws(() => makeConfig({ events: [{ ...event, target: 'land' }] }), /target/);
  assert.throws(() => makeConfig({ events: [event, event] }), /ID/);
  assert.throws(() => makeConfig({ initial: { ageBands: [{ ageFraction: 0.5, share: 1, hidden: true }] } }), /age band/);
});
