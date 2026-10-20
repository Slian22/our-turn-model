import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialEventState, processEvents, recordEventAdoptions, eventConditions,
  eventTechnology, nextEventTime,
} from '../revised/events.mjs';

const config = (events = [], extra = {}) => ({seed: 71, events, eventMode: 'off',
  annualProbability: 0.4, eventMagnitude: 1.5, eventObservationDelay: 2,
  assets: {adoptionEnergy: 3, adoptionWork: 2, adoptionDelay: 1},
  policy: {coverage: 0.8, authorized: true}, resources: {policyEnergyShare: 0.2}, ...extra});
const tech = (id, type = 'hardware', extra = {}) => ({id, type, time: 2,
  magnitude: 2, observationDelay: 2, ...extra});

test('explicit technology discovery returns paid adoption request, never free effects', () => {
  const c = config([tech('breakthrough')]);
  const initial = initialEventState(c);
  assert.equal(nextEventTime(initial, 0, c), 2);
  assert.equal(processEvents(initial, 1, c).adoptionRequests.length, 0);
  const found = processEvents(initial, 2, c);
  assert.equal(found.adoptionRequests.length, 1);
  assert.equal(found.adoptionRequests[0].id, 'adoption:breakthrough');
  assert.equal(found.adoptionRequests[0].energy, 3);
  assert.equal(found.adoptionRequests[0].work, 2);
  assert.equal(found.adoptionRequests[0].delay, 1);
  assert.equal(eventTechnology(found.state, 2).hardware, 1);
  assert.equal(found.observations.length, 0);
  assert.equal(nextEventTime(found.state, 2, c), 4);
  const observed = processEvents(found.state, 4, c);
  assert.equal(observed.observations.length, 1);
  assert.equal(observed.observations[0].id, 'breakthrough');
  assert.equal(processEvents(observed.state, 4, c).observations.length, 0);
  assert.equal(processEvents(observed.state, 4, c).adoptionRequests.length, 0);
});

test('adoption receipts match requestId, are idempotent and preserve effective endpoint', () => {
  const c = config([tech('algorithm', 'algorithm')]);
  let s = processEvents(initialEventState(c), 2, c).state;
  assert.equal(recordEventAdoptions(s, [{requestId: 'adoption:algorithm', status: 'funding'}], 3).deployments.length, 0);
  const adopted = recordEventAdoptions(s, [{id: 'internal-project-9', requestId: 'adoption:algorithm',
    status: 'completed', effective_from: 3}], 3);
  assert.equal(adopted.deployments.length, 1);
  assert.equal(adopted.deployments[0].effective_from, 3);
  assert.equal(eventTechnology(adopted.state, 2.99).algorithm, 1);
  assert.equal(eventTechnology(adopted.state, 3).algorithm, 2);
  assert.equal(eventTechnology(adopted.state, 3).hardware, 1);
  assert.equal(recordEventAdoptions(adopted.state, [{requestId: 'adoption:algorithm', status: 'completed'}], 4).deployments.length, 0);
});

test('all direct technology targets remain distinct with explicit cost and lead overrides', () => {
  const types = ['algorithm', 'hardware', 'manufacturing', 'land', 'power'];
  const c = config(types.map(type => tech(type, type, {adoptionEnergy: 7,
    adoptionWork: 5, adoptionDelay: 3, observationDelay: 0})));
  const result = processEvents(initialEventState(c), 2, c);
  assert.equal(result.adoptionRequests.length, 5);
  assert.equal(result.observations.length, 5);
  for (const request of result.adoptionRequests) {
    assert.equal(request.target, request.eventId);
    assert.equal(request.energy, 7);
    assert.equal(request.work, 5);
    assert.equal(request.delay, 3);
  }
  assert.deepEqual(eventTechnology(result.state, 2), Object.fromEntries(types.map(x => [x, 1])));
});

test('temporary adoption expires prospectively, late paid adoption has no effect', () => {
  const c = config([tech('temporary', 'algorithm', {duration: 3}),
    tech('too-late', 'land', {duration: 1})]);
  let s = processEvents(initialEventState(c), 2, c).state;
  let adopted = recordEventAdoptions(s, [{requestId: 'adoption:temporary', status: 'completed'}], 3);
  s = adopted.state;
  assert.equal(eventTechnology(s, 4.999).algorithm, 2);
  assert.equal(eventTechnology(s, 5).algorithm, 1);
  adopted = recordEventAdoptions(s, [{requestId: 'adoption:too-late', status: 'completed'}], 3);
  assert.equal(adopted.deployments.length, 0);
  assert.equal(adopted.state.records.find(x => x.id === 'too-late').adoptionStatus, 'expired');
  assert.equal(eventTechnology(adopted.state, 3).land, 1);
});

test('coverage, authority, funding each change one actual channel and revert at expiry', () => {
  for (const type of ['coverage', 'authority', 'funding']) {
    const c = config([tech(type, type, {magnitude: type === 'authority' ? 0 : 0.5, duration: 2})]);
    const result = processEvents(initialEventState(c), 2, c);
    assert.equal(result.adoptionRequests.length, 0);
    const conditions = eventConditions(result.state, 2, c);
    assert.equal(conditions.coverage, type === 'coverage' ? 0.4 : 0.8);
    assert.equal(conditions.authorized, type !== 'authority');
    assert.equal(conditions.fundingShare, type === 'funding' ? 0.1 : 0.2);
    assert.deepEqual(eventConditions(result.state, 4, c), {coverage: 0.8, authorized: true, fundingShare: 0.2});
    assert.equal('alignment' in conditions, false);
  }
});

test('overlapping shifts compose, clamp shares and never grant baseline denied authority', () => {
  const c = config([tech('a', 'coverage', {magnitude: 2}),
    tech('b', 'coverage', {magnitude: 2}), tech('c', 'funding', {magnitude: 20}),
    tech('d', 'authority', {magnitude: 2})], {policy: {coverage: 0.8, authorized: false}});
  const s = processEvents(initialEventState(c), 2, c).state;
  assert.deepEqual(eventConditions(s, 2, c), {coverage: 1, authorized: false, fundingShare: 1});
});

test('annual draws occur once at calendar boundaries, independent of calls and policy', () => {
  const c = config([], {eventMode: 'annual', annualProbability: 1});
  const initial = initialEventState(c);
  assert.equal(nextEventTime(initial, 0.2, c), 1);
  const before = processEvents(initial, 0.9, c);
  assert.equal(before.state.rngState, initial.rngState);
  const coarse = processEvents(initial, 10, c).state;
  let fine = initial;
  for (let i = 1; i <= 40; i++) fine = processEvents(fine, i / 4, c).state;
  assert.deepEqual(fine, coarse);
  assert.equal(coarse.records.length, 10);
  assert.equal(coarse.nextAnnualYear, 11);
  assert.equal(processEvents(coarse, 10, c).state.rngState, coarse.rngState);
  const changed = config([], {eventMode: 'annual', annualProbability: 1,
    policy: {mode: 'shutdown', coverage: 0, authorized: false}});
  assert.deepEqual(processEvents(initialEventState(changed), 10, changed).state.schedule, coarse.schedule);
  assert.notDeepEqual(processEvents(initialEventState({...c, seed: 72}), 10, {...c, seed: 72}).state.schedule, coarse.schedule);
});

test('annual zero probability still consumes one fixed draw batch per year', () => {
  const c = config([], {eventMode: 'annual', annualProbability: 0});
  const noEvents = processEvents(initialEventState(c), 3, c).state;
  const allConfig = {...c, annualProbability: 1};
  const allEvents = processEvents(initialEventState(allConfig), 3, allConfig).state;
  assert.equal(noEvents.records.length, 0);
  assert.equal(noEvents.rngState, allEvents.rngState);
  assert.equal(noEvents.nextAnnualYear, 4);
});

test('JSON checkpoint replay preserves schedules, observations and processed/adopted IDs', () => {
  const c = config([tech('x')], {eventMode: 'annual', annualProbability: 0.5});
  const original = processEvents(initialEventState(c), 2, c).state;
  const restored = JSON.parse(JSON.stringify(original));
  assert.deepEqual(processEvents(restored, 5, c), processEvents(original, 5, c));
});

test('explicit validation rejects ambiguous targets, duplicate IDs and invalid numbers', () => {
  for (const event of [tech('bad', 'unknown'), tech('bad', 'power', {target: 'land'}),
    tech('bad', 'hardware', {magnitude: 0}), tech('bad', 'coverage', {magnitude: -1}),
    tech('bad', 'power', {time: NaN}), tech('bad', 'power', {adoptionEnergy: -1})]) {
    assert.throws(() => initialEventState(config([event])));
  }
  assert.throws(() => initialEventState(config([tech('same'), tech('same')])) , /duplicate/i);
});

test('coarse/fine calls preserve canonical observation IDs with mixed observation delays', () => {
  const c = config([tech('first-discovered-last-observed', 'algorithm', {time: 1, observationDelay: 9}),
    tech('last-discovered-first-observed', 'power', {time: 2, observationDelay: 0})]);
  const initial = initialEventState(c);
  const coarse = processEvents(initial, 10, c).state;
  const fine = processEvents(processEvents(initial, 2, c).state, 10, c).state;
  assert.deepEqual(fine, coarse);
});

test('adoption failures are distinct from pending and cannot be completed by replay', () => {
  const c = config([tech('failed'), tech('rejected')]);
  let s = processEvents(initialEventState(c), 2, c).state;
  s = recordEventAdoptions(s, [{requestId: 'adoption:failed', status: 'failed'},
    {requestId: 'adoption:rejected', status: 'rejected'}], 3).state;
  assert.equal(s.records.find(e => e.id === 'failed').adoptionStatus, 'failed');
  assert.equal(s.records.find(e => e.id === 'rejected').adoptionStatus, 'rejected');
  assert.equal(recordEventAdoptions(s, [{requestId: 'adoption:failed', status: 'completed'}], 4).deployments.length, 0);
});

test('observation reports discovered technology and its separate deployment state', () => {
  const c = config([tech('observed-after-adoption', 'algorithm')]);
  let s = processEvents(initialEventState(c), 2, c).state;
  s = recordEventAdoptions(s, [{requestId: 'adoption:observed-after-adoption', status: 'completed'}], 3).state;
  const result = processEvents(s, 4, c);
  assert.equal(result.observations[0].adoptionStatus, 'adopted');
  assert.equal(result.observations[0].adoptedAt, 3);
});
