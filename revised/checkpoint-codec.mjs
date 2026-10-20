/** Lossless, bounded storage tables. This module changes no model state or arithmetic.
 * Only observation dictionaries and ordered history rows are represented differently.
 * Validation counts the complete reconstructed JSON tree and its exact UTF-8 JSON
 * bytes before allocating its rows or serializing a raw checkpoint.
 * Physical/source/config validation remains the checkpoint engine's responsibility.
 */
import {ENCODED_NODES, EXPANDED_NODES, EXPANDED_BYTES, CHECKPOINT_DEPTH, COLLECTION_LENGTH, MAX_STRING} from './checkpoint-limits.mjs';

const ENCODING = 'our-turn.checkpoint-tables/1';
const ROOT = ['schema', 'version', 'sourceDigest', 'configId', 'config', 'branchOf', 'state'];
const STATE = ['t', 'H', 'q', 'exposure', 'flexibleDemand', 'maintenanceFactor', 'assetState', 'technology',
  'policyState', 'policyArchive', 'policyRng', 'eventState', 'nextDecision', 'accounts', 'last', 'planning', 'infrastructure', 'history', 'competitionLead'];
const POLICY = ['version', 'controller', 'actions', 'receipts', 'rngState', 'nextId', 'energySpent', 'workSpent'];
const CONTROLLER = ['pending', 'history', 'known', 'signals'];
const HISTORY = ['t', 'H', 'q', 'exposure', 'power', 'hardware', 'factoryWork', 'criticalAdequacy',
  'extraDeaths', 'shortagePersonYears', 'policyCost', 'landUsed', 'materialStock', 'effectiveCompute',
  'qualityOfLife', 'perCapitaElectricity', 'qolPersonYears', 'flexibleDemand', 'ledger',
  'queuePendingCount', 'autonomousWork', 'humanOwnedPower', 'competitionLead'];
const LEDGER = ['start', 'end', 'h', 'available', 'humanCritical', 'humanFlexible', 'operation', 'maintenance',
  'construction', 'policy', 'unused', 'workAvailable', 'maintenanceWork', 'constructionWork', 'policyWork',
  'sourcePower', 'maintenanceAvailability', 'poweredBlocks', 'utilisation', 'assetEnergyBefore', 'assetEnergyAfter',
  'policyEnergyBefore', 'policyEnergyAfter', 'aiPriorityScore', 'humanPriorityScore', 'priorityWinner',
  'priorityProcessing', 'serviceAdequacy', 'extraction', 'extractionWork', 'primaryMaterials',
  'generatedEnergy', 'storageDischarge', 'storageCharge', 'minimumPopulation', 'maximumPopulation',
  'landAdequacy', 'materialFree', 'policyAccess', 'regionalPowerLimited', 'storageLimited',
  'coolingWaterLimited', 'heatLimited', 'refiningLimited', 'workLimited', 'energyLimited',
  'competitionMode', 'competitionHumanValue', 'competitionAiValue', 'competitionLogRatio',
  'competitionTargetAiShare', 'competitionActualAiShare', 'competitionObserved', 'competitionLeader',
  'competitionFlip', 'competitionPool', 'protectedReserve', 'competitionHumanAtFloor', 'queuePendingCount'];
const OBSERVATION = ['t', 'H', 'q', 'exposure', 'deficit', 'supply', 'need', 'coverage', 'fundingShare', 'powerAvailability',
  'technology', 'plans', 'dependencies', 'authorized', 'observedAt'];
const TECH = ['algorithm', 'hardware', 'manufacturing', 'land', 'power'];
const DICTIONARIES = ['plans', 'technology', 'dependencies'];
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const fail = label => { throw new TypeError(`Invalid checkpoint codec: ${label}`); };
const requireValue = (ok, label) => { if (!ok) fail(label); };
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const objectMap = (value, map) => Object.fromEntries(Object.entries(value).map(([key, cell]) => [key, map(key, cell)]));
const clone = value => structuredClone(value);

function fields(value, allowed, required = allowed) {
  requireValue(plain(value), 'plain schema object');
  const keys = Object.keys(value);
  requireValue(keys.every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'unknown or missing field');
}
function array(value) { requireValue(Array.isArray(value), 'expected array'); }
function number(value) { requireValue(typeof value === 'number' && Number.isFinite(value), 'finite numeric cell'); }
function reference(value, length) {
  requireValue(Number.isSafeInteger(value) && value >= 0 && value < length, 'dictionary or ledger reference');
}
/** JSON.stringify emits lone surrogates as six ASCII escape bytes. Valid pairs
 * become four UTF-8 bytes; controls, quotes and backslashes use JSON escaping.
 */
function stringBytes(value) {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 92) bytes += 2;
    else if (c < 32) bytes += [8, 9, 10, 12, 13].includes(c) ? 2 : 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = value.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
      else bytes += 6;
    } else bytes += 3;
  }
  return bytes;
}
function scalarCost(value) {
  const bytes = value === null ? 4 : typeof value === 'boolean' ? (value ? 4 : 5)
    : typeof value === 'string' ? stringBytes(value) : String(value).length;
  return {nodes: 1, height: 0, bytes};
}
function container(children, budget = EXPANDED_NODES, label = 'expanded', keys = null) {
  let nodes = 1, height = 0, bytes = 2 + Math.max(0, children.length - 1);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    nodes += child.nodes; height = Math.max(height, child.height + 1);
    bytes += child.bytes + (keys === null ? 0 : stringBytes(keys[i]) + 1);
    requireValue(nodes <= budget, `${label} node budget`);
    requireValue(bytes <= EXPANDED_BYTES, `${label} byte budget`);
  }
  requireValue(height <= CHECKPOINT_DEPTH, `${label} depth budget`);
  return {nodes, height, bytes};
}

/** Reject getters, cycles and non-JSON values without evaluating user code.
 * Cached aliases still contribute their full logical JSON size on every visit.
 */
function inspectJson(root, budget, label) {
  const cache = new WeakMap(), strings = new Map();
  const active = new WeakSet();
  function cost(value) {
    if (value !== null && typeof value === 'object') return cache.get(value);
    if (typeof value !== 'string') return scalarCost(value);
    if (!strings.has(value)) strings.set(value, scalarCost(value));
    return strings.get(value);
  }
  function visit(value, depth) {
    requireValue(depth <= CHECKPOINT_DEPTH, `${label} depth budget`);
    if (value === null || typeof value === 'boolean') return cost(value);
    if (typeof value === 'number') { number(value); return cost(value); }
    if (typeof value === 'string') {
      requireValue(value.length <= MAX_STRING, 'JSON string length'); return cost(value);
    }
    requireValue(typeof value === 'object', 'JSON value type');
    requireValue(!active.has(value), 'JSON cycle');
    const saved = cache.get(value);
    if (saved) {
      requireValue(depth + saved.height <= CHECKPOINT_DEPTH, `${label} depth budget`); return saved;
    }
    const isArray = Array.isArray(value);
    requireValue(isArray || plain(value), 'plain JSON object');
    if (isArray) requireValue(Object.getPrototypeOf(value) === Array.prototype, 'plain JSON array');
    const keys = Reflect.ownKeys(value);
    requireValue(keys.length - (isArray ? 1 : 0) <= COLLECTION_LENGTH, 'JSON collection length');
    if (isArray) requireValue(value.length <= COLLECTION_LENGTH && keys.length === value.length + 1, 'dense JSON array');
    active.add(value);
    const children = [];
    for (const key of keys) {
      requireValue(typeof key === 'string' && !UNSAFE.has(key) && key.length <= MAX_STRING, 'unsafe JSON key');
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireValue(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'JSON accessor or hidden property');
      if (isArray) requireValue(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, 'JSON array property');
      children.push(visit(descriptor.value, depth + 1));
    }
    const result = container(children, budget, label, isArray ? null : keys);
    active.delete(value); cache.set(value, result); return result;
  }
  const stats = visit(root, 0);
  return {stats, cost};
}

/** Preflight raw state BEFORE JSON.stringify, which would otherwise erase invalid
 * metadata and could allocate an oversized string even for a small alias graph.
 */
export function assertExpandedCheckpointTree(run) {
  const {stats} = inspectJson(run, EXPANDED_NODES, 'expanded');
  return {expandedNodes: stats.nodes, expandedDepth: stats.height, expandedBytes: stats.bytes};
}

function table(rows, transform = (key, value) => value) {
  const shapes = [], indexes = new Map(), order = [];
  for (const row of rows) {
    const keys = Object.keys(row), signature = JSON.stringify(keys);
    let id = indexes.get(signature);
    if (id === undefined) {
      id = shapes.length; indexes.set(signature, id);
      shapes.push({keys, columns: keys.map(() => [])});
    }
    order.push(id);
    keys.forEach((key, column) => shapes[id].columns[column].push(transform(key, row[key])));
  }
  return {shapes, order};
}

export function encodeCheckpoint(run) {
  assertExpandedCheckpointTree(run);
  fields(run, ROOT); fields(run.state, STATE);
  const dictionaries = {plans: [], technology: [], dependencies: []};
  const indexes = Object.fromEntries(DICTIONARIES.map(key => [key, new Map()]));
  function observationCell(key, value) {
    if (!DICTIONARIES.includes(key)) return clone(value);
    const signature = JSON.stringify(value), index = indexes[key];
    if (!index.has(signature)) {
      index.set(signature, dictionaries[key].length); dictionaries[key].push(clone(value));
    }
    return index.get(signature);
  }
  const observations = rows => table(rows, observationCell);
  const controller = value => objectMap(value, (key, cell) => key === 'pending' || key === 'history' ? observations(cell)
    : key === 'known' && cell !== null ? observations([cell]) : clone(cell));
  const policy = value => objectMap(value, (key, cell) => key === 'controller' ? controller(cell) : clone(cell));
  const ledgers = [];
  const history = table(run.state.history, (key, value) => {
    if (key !== 'ledger' || value === null) return clone(value);
    ledgers.push(value); return ledgers.length - 1;
  });
  const state = objectMap(run.state, (key, value) => key === 'policyState' ? policy(value)
    : key === 'policyArchive' ? value.map(policy) : key === 'history' ? history : clone(value));
  const encoded = {encoding: ENCODING, run: objectMap(run, (key, value) => key === 'state' ? state : clone(value)),
    dictionaries, ledgers: table(ledgers, (key, value) => clone(value))};
  assertEncodedCheckpointTree(encoded);
  return encoded;
}

function validateDictionary(key, values) {
  array(values); const signatures = new Set();
  for (const value of values) {
    const signature = JSON.stringify(value);
    requireValue(!signatures.has(signature), 'duplicate dictionary entry'); signatures.add(signature);
    if (key === 'plans') {
      array(value);
      for (const plan of value) {
        fields(plan, ['id', 'time', 'powerDelta', 'needDelta']);
        requireValue(typeof plan.id === 'string', 'plan id');
        ['time', 'powerDelta', 'needDelta'].forEach(field => number(plan[field]));
      }
    } else if (key === 'technology') {
      fields(value, TECH, []); Object.values(value).forEach(number);
    } else {
      fields(value, ['rsiOnHumans', 'humansOnRsi', 'uncovered']);
      for (const field of ['rsiOnHumans', 'humansOnRsi']) {
        array(value[field]);
        for (const service of value[field]) {
          fields(service, ['service', 'fraction', 'covered']); number(service.fraction);
          requireValue(typeof service.service === 'string' && typeof service.covered === 'boolean', 'dependency type');
        }
      }
      array(value.uncovered); requireValue(value.uncovered.every(v => typeof v === 'string'), 'dependency uncovered type');
    }
  }
}

/** Validate columns and count rows without constructing any expanded objects. */
function tableCost(value, allowed, required, cellCost) {
  fields(value, ['shapes', 'order']); array(value.shapes); array(value.order);
  const counts = value.shapes.map(() => 0), signatures = new Set();
  for (const id of value.order) { reference(id, counts.length); counts[id]++; }
  for (let id = 0; id < value.shapes.length; id++) {
    const shape = value.shapes[id]; fields(shape, ['keys', 'columns']); array(shape.keys); array(shape.columns);
    requireValue(counts[id] > 0 && new Set(shape.keys).size === shape.keys.length &&
      shape.keys.every(key => typeof key === 'string' && allowed.includes(key)) && required.every(key => shape.keys.includes(key)), 'row schema keys');
    const signature = JSON.stringify(shape.keys);
    requireValue(!signatures.has(signature), 'duplicate row schema'); signatures.add(signature);
    requireValue(shape.columns.length === shape.keys.length, 'column count');
    for (const column of shape.columns) { array(column); requireValue(column.length === counts[id], 'column row length'); }
  }
  const cursors = counts.map(() => 0), rows = [];
  for (const id of value.order) {
    const shape = value.shapes[id], row = cursors[id]++;
    rows.push(container(shape.keys.map((key, column) => cellCost(key, shape.columns[column][row])),
      EXPANDED_NODES, 'expanded', shape.keys));
  }
  return {rows, array: container(rows)};
}

export function assertEncodedCheckpointTree(encoded) {
  const json = inspectJson(encoded, ENCODED_NODES, 'encoded');
  fields(encoded, ['encoding', 'run', 'dictionaries', 'ledgers']);
  requireValue(encoded.encoding === ENCODING, 'unknown encoding');
  fields(encoded.run, ROOT); fields(encoded.run.state, STATE); fields(encoded.dictionaries, DICTIONARIES);
  const used = Object.fromEntries(DICTIONARIES.map(key => [key, new Set()]));
  DICTIONARIES.forEach(key => validateDictionary(key, encoded.dictionaries[key]));
  const ledgers = tableCost(encoded.ledgers, LEDGER, LEDGER, (key, value) => { number(value); return json.cost(value); });
  let ledgerIndex = 0;
  const history = tableCost(encoded.run.state.history, HISTORY, HISTORY, (key, value) => {
    if (key === 'competitionLead') {
      requireValue(value === null || value === 'human' || value === 'ai', 'competition history leader');
      return json.cost(value);
    }
    if (key !== 'ledger') { number(value); return json.cost(value); }
    if (value === null) return json.cost(value);
    reference(value, ledgers.rows.length);
    requireValue(value === ledgerIndex++, 'ledger references must be ordered and exhaustive'); return ledgers.rows[value];
  }).array;
  requireValue(ledgerIndex === ledgers.rows.length, 'unreferenced ledger');
  function observationCost(value, known = false) {
    const costs = tableCost(value, OBSERVATION, ['t', 'technology', 'plans', 'dependencies', 'observedAt'], (key, cell) => {
      if (DICTIONARIES.includes(key)) {
        reference(cell, encoded.dictionaries[key].length); used[key].add(cell); return json.cost(encoded.dictionaries[key][cell]);
      }
      if (key === 'authorized') requireValue(typeof cell === 'boolean', 'observation authorized type');
      else number(cell);
      return json.cost(cell);
    });
    if (known) { requireValue(costs.rows.length === 1, 'known observation row count'); return costs.rows[0]; }
    return costs.array;
  }
  const mappedCost = (value, replacements) => container(Object.entries(value).map(([key, cell]) =>
    Object.hasOwn(replacements, key) ? replacements[key] : json.cost(cell)), EXPANDED_NODES, 'expanded', Object.keys(value));
  function policyCost(value) {
    fields(value, POLICY); const c = value.controller; fields(c, CONTROLLER);
    array(value.actions); array(value.receipts); array(c.signals);
    const controller = mappedCost(c, {pending: observationCost(c.pending), history: observationCost(c.history),
      known: c.known === null ? json.cost(null) : observationCost(c.known, true)});
    return mappedCost(value, {controller});
  }
  const state = encoded.run.state; array(state.policyArchive);
  const stateCost = mappedCost(state, {history, policyState: policyCost(state.policyState),
    policyArchive: container(state.policyArchive.map(policyCost))});
  const expanded = mappedCost(encoded.run, {state: stateCost});
  for (const key of DICTIONARIES) requireValue(used[key].size === encoded.dictionaries[key].length, 'unreferenced dictionary entry');
  return {encodedNodes: json.stats.nodes, encodedBytes: json.stats.bytes,
    expandedNodes: expanded.nodes, expandedDepth: expanded.height, expandedBytes: expanded.bytes};
}

function untable(encoded, transform = (key, value) => clone(value)) {
  const cursors = encoded.shapes.map(() => 0);
  return encoded.order.map(id => {
    const shape = encoded.shapes[id], row = cursors[id]++;
    return Object.fromEntries(shape.keys.map((key, column) => [key, transform(key, shape.columns[column][row])]));
  });
}

export function decodeCheckpoint(encoded) {
  assertEncodedCheckpointTree(encoded);
  const dictionaries = clone(encoded.dictionaries), ledgers = untable(encoded.ledgers);
  const observations = value => untable(value, (key, cell) => DICTIONARIES.includes(key) ? dictionaries[key][cell] : clone(cell));
  const controller = value => objectMap(value, (key, cell) => key === 'pending' || key === 'history' ? observations(cell)
    : key === 'known' && cell !== null ? observations(cell)[0] : clone(cell));
  const policy = value => objectMap(value, (key, cell) => key === 'controller' ? controller(cell) : clone(cell));
  const state = objectMap(encoded.run.state, (key, value) => key === 'policyState' ? policy(value)
    : key === 'policyArchive' ? value.map(policy) : key === 'history'
      ? untable(value, (field, cell) => field === 'ledger' && cell !== null ? ledgers[cell] : clone(cell)) : clone(value));
  return objectMap(encoded.run, (key, value) => key === 'state' ? state : clone(value));
}
