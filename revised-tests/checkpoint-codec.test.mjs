import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeCheckpoint, decodeCheckpoint, assertEncodedCheckpointTree} from '../revised/checkpoint-codec.mjs';
import * as codec from '../revised/checkpoint-codec.mjs';
import {createRun, advanceRun, finishRun, branchRun, restoreCheckpoint, saveCheckpoint} from '../revised/engine.mjs';
import {prepareState} from '../revised/dynamics.mjs';
import {ENCODED_NODES, EXPANDED_NODES, EXPANDED_BYTES, CHECKPOINT_DEPTH} from '../revised/checkpoint-limits.mjs';

const wire = value => JSON.parse(JSON.stringify(value));
const prepared = () => {
  const run = createRun({horizon: 2});
  return {...run, state: prepareState(run.state, run.config)};
};
function freeze(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); Object.values(value).forEach(v => freeze(v, seen)); Object.freeze(value);
  }
  return value;
}

test('compact codec preserves exact original JSON for initial, policy branch and paid event states', () => {
  const base = advanceRun(createRun({horizon: 3}), 1);
  const runs = [createRun(), base,
    branchRun(base, {mode: 'fixed', start: 1, type: 'cap', cost: 0, work: 0}),
    advanceRun(createRun({horizon: 3, eventMode: 'annual', annualProbability: 1}), 2),
    advanceRun(createRun({horizon: 3, events: [{id: 'adopt', type: 'hardware', time: 0,
      magnitude: 2, adoptionEnergy: 0.1, adoptionWork: 0.1, adoptionDelay: 0.25}]}), 1)];
  for (const run of runs) {
    const before = JSON.stringify(run), encoded = encodeCheckpoint(run);
    assert.equal(encoded.encoding, 'our-turn.checkpoint-tables/1');
    const decoded = decodeCheckpoint(freeze(wire(encoded)));
    assert.equal(JSON.stringify(decoded), before);
    assert.equal(JSON.stringify(run), before);
    assert.ok(assertEncodedCheckpointTree(encoded).expandedNodes > 0);
  }
});

test('compact replay and legacy small raw checkpoints continue identically', () => {
  const run = advanceRun(createRun({horizon: 3, eventMode: 'annual', annualProbability: 1,
    policy: {mode: 'fixed', start: 0.5, delay: 0.25, type: 'shutdown'}}), 1.25);
  assert.equal(JSON.parse(saveCheckpoint(run)).encoding, undefined);
  const decoded = restoreCheckpoint(JSON.stringify(encodeCheckpoint(run)));
  assert.equal(JSON.stringify(decoded), JSON.stringify(run));
  assert.equal(saveCheckpoint(finishRun(decoded)), saveCheckpoint(finishRun(run)));
});

test('column tables retain original ordered keys, optional fields and exact stored numbers', () => {
  const run = structuredClone(prepared()), row = run.state.policyState.controller.pending[0];
  row.dependencies.uncovered.push('Unicode snowman \u2603');
  const second = Object.fromEntries(Object.entries(row).reverse());
  delete second.authorized;
  second.t = Number.MIN_VALUE;
  second.observedAt = 0.39999999999999997;
  run.state.policyState.controller.history = [row, second];
  run.state.policyState.controller.known = second;
  const expected = JSON.stringify(run), encoded = encodeCheckpoint(freeze(run));
  assert.equal(encoded.run.state.policyState.controller.history.shapes.length, 2);
  assert.equal(JSON.stringify(decodeCheckpoint(wire(encoded))), expected);
});

test('empty tables, archived memories, known null and dictionary sharing are lossless and detached', () => {
  const empty = encodeCheckpoint(createRun());
  assert.deepEqual(empty.ledgers, {shapes: [], order: []});
  assert.equal(JSON.stringify(decodeCheckpoint(wire(empty))), JSON.stringify(createRun()));
  const run = structuredClone(prepared()), controller = run.state.policyState.controller;
  controller.history = [controller.pending[0]];
  controller.known = controller.history[0];
  run.state.policyArchive.push(structuredClone(run.state.policyState));
  const encoded = encodeCheckpoint(freeze(run)), expected = JSON.stringify(run);
  assert.equal(encoded.dictionaries.plans.length, 1);
  assert.equal(encoded.dictionaries.technology.length, 1);
  const decoded = decodeCheckpoint(encoded);
  encoded.dictionaries.plans[0][0].id = 'changed-after-decode';
  encoded.run.config.horizon = 999;
  assert.equal(JSON.stringify(decoded), expected);
  assert.equal(JSON.stringify(run), expected);
});

test('codec rejects wrapper, table, row, dictionary and reference tampering before reconstruction', () => {
  const mutations = [
    x => { x.encoding = 'unknown'; },
    x => { x.extra = 1; },
    x => { delete x.ledgers; },
    x => { x.dictionaries.extra = []; },
    x => { x.run.extra = 1; },
    x => { x.run.state.extra = 1; },
    x => { x.run.state.policyState.controller.extra = 1; },
    x => { x.run.state.history.extra = 1; },
    x => { x.run.state.history.order[0] = -1; },
    x => { x.run.state.history.order[0] = 0.5; },
    x => { x.run.state.history.order[0] = 4; },
    x => { x.run.state.history.shapes[0].keys[1] = 't'; },
    x => { x.run.state.history.shapes[0].keys[0] = 'secret'; },
    x => { x.run.state.history.shapes[0].columns.pop(); },
    x => { x.run.state.history.shapes[0].columns[0].push(3); },
    x => { x.run.state.history.shapes.push(structuredClone(x.run.state.history.shapes[0])); },
    x => { x.dictionaries.plans.push(structuredClone(x.dictionaries.plans[0])); },
    x => { x.dictionaries.plans[0] = {}; },
    x => { x.dictionaries.plans[0][0].extra = 1; },
    x => { x.dictionaries.technology[0].algorithm = '1'; },
    x => { x.dictionaries.dependencies[0].uncovered = [3]; },
    x => { const s = x.run.state.policyState.controller.pending.shapes[0]; s.columns[s.keys.indexOf('plans')][0] = -1; },
    x => { const s = x.run.state.policyState.controller.pending.shapes[0]; s.columns[s.keys.indexOf('plans')][0] = 999; },
    x => { const s = x.run.state.policyState.controller.pending.shapes[0]; s.columns[s.keys.indexOf('plans')][0] = '0'; },
    x => { x.run.state.policyState.controller.known = {shapes: [], order: []}; },
  ];
  const encoded = encodeCheckpoint(prepared());
  for (const mutate of mutations) {
    const candidate = wire(encoded); mutate(candidate);
    assert.throws(() => decodeCheckpoint(candidate), /codec|encoded|checkpoint/i);
  }
});

test('ledger references are ordered, exhaustive and cannot alias or point beyond storage', () => {
  const encoded = encodeCheckpoint(advanceRun(createRun({horizon: 2}), 0.25));
  const shape = encoded.run.state.history.shapes[0];
  const ledgerColumn = shape.keys.indexOf('ledger');
  for (const ref of [-1, 999, '0']) {
    const changed = wire(encoded);
    changed.run.state.history.shapes[0].columns[ledgerColumn][1] = ref;
    assert.throws(() => decodeCheckpoint(changed), /ledger|reference|codec/i);
  }
  const alias = wire(encoded);
  alias.run.state.history.shapes[0].columns[ledgerColumn][2] = 0;
  assert.throws(() => decodeCheckpoint(alias), /ledger|reference|codec/i);
});

test('encoded JSON rejects unsafe keys, sparse arrays, accessors, cycles and non-JSON values', () => {
  const encoded = encodeCheckpoint(prepared());
  const unsafe = wire(encoded);
  unsafe.run.config = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => decodeCheckpoint(unsafe), /unsafe|codec/i);
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date()]) {
    const changed = wire(encoded); changed.run.config.invalid = value;
    assert.throws(() => decodeCheckpoint(changed), /JSON|finite|plain|codec/i);
  }
  const sparse = wire(encoded); delete sparse.run.state.history.order[0];
  assert.throws(() => decodeCheckpoint(sparse), /array|codec/i);
  const accessor = wire(encoded); Object.defineProperty(accessor.run.config, 'trap', {enumerable: true, get() {throw new Error('getter called');}});
  assert.throws(() => decodeCheckpoint(accessor), /accessor|codec/i);
  const cyclic = wire(encoded); cyclic.run.config.loop = cyclic;
  assert.throws(() => decodeCheckpoint(cyclic), /cycle|depth|codec/i);
});

test('encoded and expanded budgets count repeated aliases without expanding a reference bomb', () => {
  const encoded = encodeCheckpoint(prepared());
  const bigEncoded = wire(encoded);
  bigEncoded.run.config.extra = Array(32).fill(Array(70000).fill(0));
  assert.ok(32 * 70000 > ENCODED_NODES);
  assert.throws(() => decodeCheckpoint(bigEncoded), /encoded.*(budget|complexity)|codec/i);
  const bomb = wire(encoded), table = bomb.run.state.policyState.controller.pending;
  const shape = table.shapes[0], index = shape.keys.indexOf('plans');
  const ref = shape.columns[index][0];
  bomb.dictionaries.plans[ref] = Array.from({length: 5000}, (_, i) => ({id: `p-${i}`, time: 1, powerDelta: -1, needDelta: 0}));
  table.order = Array(1000).fill(0);
  shape.columns = shape.columns.map(column => Array(1000).fill(column[0]));
  assert.ok(1000 * 5000 * 5 > EXPANDED_NODES);
  assert.throws(() => decodeCheckpoint(bomb), /expanded.*(budget|complexity)|codec/i);
});

test('depth, long strings and collection bounds reject before expansion', () => {
  const encoded = encodeCheckpoint(prepared());
  const deep = wire(encoded); let node = deep.run.config;
  for (let i = 0; i < CHECKPOINT_DEPTH + 1; i++) node = node.nested = {};
  assert.throws(() => decodeCheckpoint(deep), /depth|codec/i);
  const long = wire(encoded); long.run.config.extra = 'x'.repeat(500001);
  assert.throws(() => decodeCheckpoint(long), /string|codec/i);
  const wide = wire(encoded); wide.run.config.extra = Array(100002).fill(0);
  assert.throws(() => decodeCheckpoint(wide), /collection|codec/i);
});

test('array subclasses and altered prototypes cannot supply executable table methods', () => {
  const encoded = encodeCheckpoint(prepared());
  const changed = wire(encoded);
  class HostileArray extends Array { map() { throw new Error('untrusted method called'); } }
  Object.setPrototypeOf(changed.run.state.history.order, HostileArray.prototype);
  assert.throws(() => decodeCheckpoint(changed), /plain JSON array|codec/i);
});

test('schema type, unused storage and invalid encoder inputs fail closed', () => {
  const encoded = encodeCheckpoint(prepared());
  const mutations = [
    x => { delete x.run.state.H; },
    x => { x.run.state.policyState.extra = 0; },
    x => { x.run.state.policyState.actions = {}; },
    x => { x.run.state.policyArchive = {}; },
    x => { x.run.state.policyState.controller.signals = {}; },
    x => { const s = x.run.state.history.shapes[0]; s.columns[s.keys.indexOf('H')][0] = '8000'; },
    x => { const s = x.run.state.policyState.controller.pending.shapes[0]; s.columns[s.keys.indexOf('authorized')][0] = 1; },
    x => { x.dictionaries.technology.push({algorithm: 987}); },
    x => { x.dictionaries.dependencies[0].rsiOnHumans[0].covered = 1; },
    x => { Object.defineProperty(x.run.config, 'hidden', {value: 1}); },
    x => { x.run.config[Symbol('key')] = 1; },
  ];
  for (const mutate of mutations) {
    const changed = wire(encoded); mutate(changed);
    assert.throws(() => decodeCheckpoint(changed), /codec/i);
  }
  const invalid = structuredClone(prepared()); invalid.state.policyState.extra = 1;
  assert.throws(() => encodeCheckpoint(invalid), /codec/i);
  const cyclic = structuredClone(prepared()); cyclic.state.accounts.loop = cyclic;
  assert.throws(() => encodeCheckpoint(cyclic), /cycle|codec/i);
});

test('logical UTF-8 JSON byte costs include escaped strings, numbers, keys and punctuation', () => {
  assert.equal(typeof codec.assertExpandedCheckpointTree, 'function');
  const controls = Array.from({length: 32}, (_, i) => String.fromCharCode(i)).join('');
  const shared = {'quoted"\\\n': [null, true, false, -0, Number.MIN_VALUE, Number.MAX_VALUE,
    1e-7, 1e20, 'ASCII / \u2028 \u2029 \u4e16 \ud83d\ude00 \ud800 \udfff', controls]};
  const samples = [null, true, false, 0, -0, '', [], {}, shared, [shared, shared],
    {empty: {}, rows: [], 'UTF8-\u4e16-\ud800': shared}];
  for (const value of samples) {
    const stats = codec.assertExpandedCheckpointTree(value);
    assert.equal(stats.expandedBytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  }
  for (const run of [createRun(), prepared(), advanceRun(createRun({horizon: 3}), 0.5)]) {
    const encoded = encodeCheckpoint(run), stats = assertEncodedCheckpointTree(encoded);
    assert.equal(stats.expandedBytes, Buffer.byteLength(JSON.stringify(run), 'utf8'));
    assert.equal(stats.encodedBytes, Buffer.byteLength(JSON.stringify(encoded), 'utf8'));
    assert.equal(codec.assertExpandedCheckpointTree(run).expandedBytes, stats.expandedBytes);
  }
});

test('repeated long dictionary strings exceed logical byte budget before any decode allocation', () => {
  const bomb = encodeCheckpoint(prepared()), table = bomb.run.state.policyState.controller.pending;
  const shape = table.shapes[0], ref = shape.columns[shape.keys.indexOf('plans')][0];
  bomb.dictionaries.plans[ref] = [{id: 'x'.repeat(500000), time: 1, powerDelta: 0, needDelta: 0}];
  table.order = Array(1100).fill(0);
  shape.columns = shape.columns.map(column => Array(1100).fill(column[0]));
  assert.ok(Buffer.byteLength(JSON.stringify(bomb)) < 600000);
  assert.ok(1100 * 500000 > EXPANDED_BYTES);
  assert.throws(() => assertEncodedCheckpointTree(bomb), /expanded.*byte.*budget/i);
  const nativeClone = globalThis.structuredClone; let clones = 0;
  globalThis.structuredClone = () => { clones++; throw new Error('decode allocated before byte validation'); };
  try {
    assert.throws(() => decodeCheckpoint(bomb), /expanded.*byte.*budget/i);
    assert.equal(clones, 0);
  } finally { globalThis.structuredClone = nativeClone; }
});

test('raw preflight rejects oversize aliases and metadata that stringify would silently drop', () => {
  assert.equal(typeof codec.assertExpandedCheckpointTree, 'function');
  const assertRaw = codec.assertExpandedCheckpointTree;
  const part = {message: 'x'.repeat(500000)};
  assert.throws(() => assertRaw(Array(401).fill(part)), /expanded.*byte.*budget/i);
  const mutations = [
    x => { Object.defineProperty(x.config, 'hidden', {value: 1}); },
    x => { x.config[Symbol('hidden')] = 1; },
    x => { x.config.events.extra = 1; },
    x => { delete x.config.initial.ageBands[0]; },
    x => { Object.defineProperty(x.config, 'getter', {enumerable: true, get() {throw new Error('getter executed');}}); },
    x => { x.config.optional = undefined; },
    x => { x.config.loop = x; },
  ];
  for (const mutate of mutations) {
    const run = structuredClone(createRun()); mutate(run);
    assert.throws(() => assertRaw(run), /codec/i);
    assert.throws(() => encodeCheckpoint(run), /codec/i);
  }
});

test('logical byte bound is inclusive and counts repeated primitive strings without serialization', () => {
  const rows = Array(399).fill('x'.repeat(500000));
  // Array punctuation: 2 brackets + 399 commas + 400 quoted strings.
  const lastLength = EXPANDED_BYTES - (399 * 500000 + 2 + 399 + 800);
  rows.push('x'.repeat(lastLength));
  assert.equal(codec.assertExpandedCheckpointTree(rows).expandedBytes, EXPANDED_BYTES);
  rows[399] += 'x';
  assert.throws(() => codec.assertExpandedCheckpointTree(rows), /expanded.*byte.*budget/i);
});

test('all UTF-16 code units and deterministic mixed pairs agree with native JSON byte length', () => {
  let units = '';
  for (let i = 0; i <= 0xffff; i++) units += String.fromCharCode(i);
  const samples = [units, {'\ud800key\udc00': units},
    ['\ud800\ud800\udc00\udc00', '\udfff\udbff', '\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff']];
  for (const sample of samples) assert.equal(codec.assertExpandedCheckpointTree(sample).expandedBytes,
    Buffer.byteLength(JSON.stringify(sample), 'utf8'));
});
