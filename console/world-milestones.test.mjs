import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, stepWorld, advanceWorld, branchWorld, saveWorld, restoreWorld, worldView} from '../spatial/world.mjs';
import {observeWorldMilestones} from './world-milestones.mjs';

const amounts = overrides => ({hardware:0, power:0, factory:0, powerAutomation:0, fabAutomation:0, ...overrides});
const region = (id = 'r', state = {}, config = {}) => ({
 id, name:`Region ${id}`, config:{Q0:1, aE0:0, aF0:0, ...config},
 state:{t:4, Q:1, aE:0, aF:0, events:[], commissionedAmounts:amounts(), ...state},
});
const point = (t, minAdequacy = 1, H = 10) => ({t, H, B:0, Q:0, sH:1, minAdequacy});
const snapshot = (regions = [region()], history = [point(0), point(4)]) => ({t:4, config:{dt:1}, regions, history});
const row = (rows, id) => {
 const found = rows.find(value => value.id === id);
 assert.ok(found, `Missing ${id}: ${JSON.stringify(rows)}`);
 return found;
};
const freeze = value => {
 if (value && typeof value === 'object') Object.values(value).forEach(freeze);
 return value && typeof value === 'object' ? Object.freeze(value) : value;
};

test('initial zero stocks and unmeasured initial adequacy invent no events', () => {
 const world = createWorld({regions:[{id:'empty', config:{H0:0, B0:0, G0:0, F0:0, aE0:0, aF0:0}}], links:[]});
 assert.deepEqual(observeWorldMilestones(world), []);
 assert.deepEqual(observeWorldMilestones({...snapshot(), t:0, history:[point(0, 0)]}), []);
 assert.deepEqual(observeWorldMilestones(), []);
 assert.deepEqual(observeWorldMilestones({t:NaN, regions:[]}), []);
});

test('recorded commissioning chooses earliest positive record, with deterministic simultaneous tie', () => {
 const events = [
  {t:3, type:'commissioned', kind:'hardware', amount:5},
  {t:1, type:'commissioned', kind:'power', amount:2},
  {t:1, type:'commissioned', kind:'hardware', amount:3},
  {t:0, type:'ordered', kind:'hardware', amount:99},
  {t:.5, type:'commissioned', kind:'hardware', amount:0},
  {t:-1, type:'commissioned', kind:'hardware', amount:1},
  {t:.2, type:'commissioned', kind:'unknown', amount:1},
  {t:8, type:'commissioned', kind:'factory', amount:10},
 ];
 const world = snapshot([region('r', {events, commissionedAmounts:amounts({hardware:8, power:2})})]);
 const first = row(observeWorldMilestones(world), 'r:first-commissioned');
 assert.equal(first.t, 1);
 assert.match(first.title, /first recorded commissioning/i);
 assert.match(first.detail, /3 standard hardware blocks/);
 assert.match(first.detail, /earlier.*unrecorded|unrecorded.*earlier/i);
 assert.deepEqual(observeWorldMilestones(snapshot([region('r', {...world.regions[0].state, events:[...events].reverse()})])), [first]);
});

test('cumulative commissioned quantities prove service, but never invent a first commissioning time', () => {
 const rows = observeWorldMilestones(snapshot([region('r', {
  B:999, G:999, F:999, cumulativeBuildEnergy:100, commissionedBuildEnergy:1,
  commissionedAmounts:amounts({hardware:.125, power:2, factory:3, powerAutomation:.1, fabAutomation:.2}),
 })]));
 const commissioned = row(rows, 'r:first-commissioned');
 assert.equal(commissioned.t, 4);
 assert.match(commissioned.title, /commissioned assets observed/i);
 assert.match(commissioned.detail, /observed at (?:the )?saved endpoint/i);
 assert.match(commissioned.detail, /first commissioning time.*unavailable/i);
 for (const unit of ['standard hardware blocks', 'TWh/year', 'blocks/year', 'dimensionless fraction'])
  assert.ok(commissioned.detail.includes(unit), unit);
});

test('initial installed stocks, orders, paid construction and due dates are not commissioning evidence', () => {
 const state = {B:100, G:100, F:100, cumulativeBuildEnergy:20, cumulativeBuildWork:10,
  queue:[{kind:'hardware', amount:100, due:1}], events:[{t:1, type:'ordered', kind:'hardware', amount:100}]};
 assert.deepEqual(observeWorldMilestones(snapshot([region('r', state)])), []);
 assert.deepEqual(observeWorldMilestones(snapshot([region('r', {...state, commissionedAmounts:undefined})])), []);
});

test('regional Q uses explicit positive config.Q0 and is only an endpoint observation', () => {
 const world = snapshot([region('r', {Q:4}, {Q0:2})]);
 const doubled = row(observeWorldMilestones(world), 'r:q-doubled');
 assert.equal(doubled.t, 4);
 assert.match(doubled.detail, /Q=4.*Q0=2/);
 assert.match(doubled.detail, /dimensionless/);
 assert.match(doubled.detail, /observed at (?:the )?saved endpoint/i);
 assert.match(doubled.detail, /first threshold crossing.*unavailable/i);
 assert.doesNotMatch(`${doubled.title} ${doubled.detail}`, /explosion|singularity|intelligence takeoff/i);
 for (const Q0 of [0, -1, undefined, NaN, Infinity])
  assert.deepEqual(observeWorldMilestones(snapshot([region('r', {Q:4}, {Q0})])), []);
 for (const Q of [3.999999999, 0, NaN, Infinity])
  assert.deepEqual(observeWorldMilestones(snapshot([region('r', {Q}, {Q0:2})])), []);
});

test('Q and commissioned endpoint observations are not backdated to synthetic initial state', () => {
 const world = {...snapshot([region('r', {t:0, Q:2, commissionedAmounts:amounts({hardware:1})})]), t:0, history:[point(0)]};
 assert.deepEqual(observeWorldMilestones(world), []);
});

test('both modeled automation fractions must meet 0.5; label explicitly limits the proxy', () => {
 const proxy = row(observeWorldMilestones(snapshot([region('r', {aE:.5, aF:.5})])), 'r:automation-proxy');
 assert.equal(proxy.t, 4);
 assert.match(proxy.detail, /aE=0\.5.*aF=0\.5/);
 assert.match(proxy.detail, /dimensionless fractions/);
 assert.match(proxy.detail, /proxy only/i);
 assert.match(proxy.detail, /(?:does not|cannot).*autonomy/i);
 assert.match(proxy.detail, /first threshold crossing.*unavailable/i);
 for (const state of [{aE:.5, aF:.499999999}, {aE:.499999999, aF:1}, {aE:NaN, aF:1}, {aE:1.1, aF:1}])
  assert.deepEqual(observeWorldMilestones(snapshot([region('r', state)])), []);
});

test('initially satisfied proxy is explicitly an initial condition, not a new transition', () => {
 const world = snapshot([region('r', {aE:.6, aF:.8}, {aE0:.6, aF0:.8})]);
 const proxy = row(observeWorldMilestones(world), 'r:automation-proxy');
 assert.equal(proxy.t, 0);
 assert.match(proxy.title, /initial/i);
 assert.match(proxy.detail, /initial condition/i);
 assert.match(proxy.detail, /proxy only/i);
 assert.doesNotMatch(proxy.title, /reached|crossed|transition/i);
});

test('complete aggregate history gives earliest observed shortage and subsequent recovery, including equality', () => {
 const history = [point(0, 0), point(1, .999), point(2, .998999), point(3, .999), point(4, .2)];
 const rows = observeWorldMilestones(snapshot([], history));
 assert.equal(rows.length, 2);
 const shortage = row(rows, 'world:first-shortage'), recovery = row(rows, 'world:first-recovery');
 assert.equal(shortage.t, 2);
 assert.equal(recovery.t, 3);
 for (const value of rows) {
  assert.equal(value.regionId, null);
  assert.equal(value.regionName, 'World');
  assert.match(value.detail, /minAdequacy/);
  assert.match(value.detail, /0\.999/);
  assert.match(value.detail, /dimensionless/);
  assert.match(value.detail, /years since contact/);
  assert.match(value.detail, /complete aggregate history/i);
  assert.match(value.detail, /(?:onset|crossing).*between.*observations/i);
 }
 assert.match(recovery.detail, /(?:does not|not).*population recovery/i);
});

test('global minAdequacy detects a regional deficit hidden by weighted aggregate sH', () => {
 const rows = observeWorldMilestones(snapshot([], [point(0), point(1, .3), point(2, 1), point(3), point(4)]));
 assert.equal(row(rows, 'world:first-shortage').t, 1);
 assert.equal(row(rows, 'world:first-recovery').t, 2);
});

test('no recovery before a shortage, during continued shortage, or from zero-population adequacy', () => {
 for (const history of [
  [point(0), point(1), point(2), point(3), point(4)],
  [point(0), point(1, .1), point(2, .2), point(3, .3), point(4, .4)],
  [point(0), point(1, .1), point(2, 1, 0), point(3, 1, 0), point(4, 1, 0)],
 ]) assert.ok(!observeWorldMilestones(snapshot([], history)).some(value => value.id === 'world:first-recovery'));
 const extinct = [point(0), point(1, 0, 0), point(2, 0, 0), point(3, 0, 0), point(4, 0, 0)];
 assert.deepEqual(observeWorldMilestones(snapshot([], extinct)), []);
});

test('truncation, missing fields, absent cadence and gaps are explicit, never silently called complete', () => {
 const histories = [
  [point(2, .5), point(3), point(4)],
  [point(0), point(1, .5), point(4)],
  [point(0), point(1, .5), {t:2}, point(3), point(4)],
  [point(0), point(1, .5), point(2)],
 ];
 for (const history of histories) {
  const rows = observeWorldMilestones(snapshot([], history));
  assert.ok(rows.length > 0);
  for (const value of rows) assert.match(value.detail, /history (?:gap|incomplete)|incomplete.*history/i);
 }
 const unknown = {...snapshot([], [point(0), point(1, .5), point(4)]), config:{}};
 assert.match(row(observeWorldMilestones(unknown), 'world:first-shortage').detail, /incomplete|unverified/i);
 assert.deepEqual(observeWorldMilestones(snapshot([], [{t:0}, {t:4, sH:.1}])), []);
});

test('stable row shape, unique IDs and ordering do not depend on region iteration order', () => {
 const regions = [region('z', {Q:2, aE:.5, aF:.5}), region('a', {Q:2, commissionedAmounts:amounts({hardware:1})})];
 const world = snapshot(regions, [point(0), point(1, .5), point(2), point(3), point(4)]);
 const rows = observeWorldMilestones(world);
 assert.ok(rows.length >= 5);
 assert.deepEqual(rows, observeWorldMilestones({...world, regions:[...regions].reverse()}));
 assert.equal(new Set(rows.map(value => value.id)).size, rows.length);
 assert.deepEqual(rows.map(({t, id}) => [t, id]), rows.map(({t, id}) => [t, id]).sort((a, b) => a[0]-b[0] || (a[1]<b[1]?-1:a[1]>b[1]?1:0)));
 for (const value of rows) {
  assert.deepEqual(Object.keys(value).sort(), ['detail','id','regionId','regionName','t','title']);
  assert.ok(Number.isFinite(value.t));
  for (const key of ['id','regionName','title','detail']) assert.equal(typeof value[key], 'string');
  assert.doesNotMatch(value.detail, /NaN|undefined|Infinity/);
 }
});

test('observer is read-only, calls no RNG, retains no memory and returns detached rows', t => {
 const world = freeze(snapshot([region('r', {Q:2, aE:.5, aF:.5, rng:{environment:123}})]));
 const before = JSON.stringify(world);
 t.mock.method(Math, 'random', () => assert.fail('Observer must not draw randomness'));
 const rows = observeWorldMilestones(world), expected = structuredClone(rows);
 assert.ok(rows.length > 0);
 assert.deepEqual(observeWorldMilestones(snapshot()), []);
 rows[0].title = 'consumer edit';
 rows.pop();
 assert.deepEqual(observeWorldMilestones(world), expected);
 assert.equal(JSON.stringify(world), before);
});

test('detail numbers use four significant digits, compact scientific notation and no padded zeros', () => {
 const endpoint = 12.345678901;
 const world = freeze({...snapshot([region('r', {
  Q:123456789.123, aE:.567891234, aF:.678912345,
  commissionedAmounts:amounts({hardware:12.3456789, power:123456789.123, factory:.0000123456789,
   powerAutomation:.123456789, fabAutomation:1e-12}),
 }, {Q0:12345.6789})]), t:endpoint});
 const before = JSON.stringify(world), rows = observeWorldMilestones(world);
 const commissioned = row(rows, 'r:first-commissioned');
 assert.match(commissioned.detail, /year 12\.35 \(years since contact\)/);
 for (const text of ['12.35 standard hardware blocks', '1.235e8 TWh/year', '1.235e-5 blocks/year',
  '0.1235 dimensionless fraction', '1e-12 dimensionless fraction']) assert.ok(commissioned.detail.includes(text), text);
 assert.match(row(rows, 'r:q-doubled').detail, /Q=1\.235e8;.*Q0=1\.235e4/);
 assert.match(row(rows, 'r:automation-proxy').detail, /aE=0\.5679, aF=0\.6789/);
 for (const value of rows) {
  assert.equal(value.t, endpoint);
  assert.doesNotMatch(value.detail, /12\.345678901|123456789\.123|0\.567891234|e\+/);
 }
 assert.equal(JSON.stringify(world), before);
 assert.deepEqual(observeWorldMilestones(JSON.parse(before)), rows);
});

test('recorded event times, initial fractions and aggregate detail values use the same formatter', () => {
 const recordedTime = .123456789;
 const event = {t:recordedTime, type:'commissioned', kind:'hardware', amount:.0000123456789};
 const commissioned = row(observeWorldMilestones(snapshot([region('r', {events:[event]})])), 'r:first-commissioned');
 assert.equal(commissioned.t, recordedTime);
 assert.match(commissioned.detail, /1\.235e-5 standard hardware blocks.*year 0\.1235 /);
 const initial = row(observeWorldMilestones(snapshot([region('r', {aE:.567891, aF:.678912},
  {aE0:.567891, aF0:.678912})])), 'r:automation-proxy');
 assert.match(initial.detail, /aE0=0\.5679, aF0=0\.6789/);
 const rows = observeWorldMilestones({...snapshot([], [point(0), point(recordedTime, .998999999), point(.234567891)]),
  t:.234567891});
 const shortage = row(rows, 'world:first-shortage'), recovery = row(rows, 'world:first-recovery');
 assert.equal(shortage.t, recordedTime);
 assert.equal(recovery.t, .234567891);
 assert.match(shortage.detail, /Year 0\.1235 .*minAdequacy≈0\.999/);
 assert.match(shortage.detail, /unrounded/i);
 assert.match(recovery.detail, /Year 0\.2346 .*minAdequacy≈1/);
});

test('display rounding handles notation boundaries and extreme finite commissioned quantities', () => {
 for (const [amount, displayed] of [
  [1, '1'], [.001, '0.001'], [.000999999, '0.001'], [.0000999999, '1e-4'],
  [9999, '9999'], [9999.9, '1e4'], [10000, '1e4'],
  [Number.MIN_VALUE, '4.941e-324'], [Number.MAX_VALUE, '1.798e308'],
 ]) {
  const value = row(observeWorldMilestones(snapshot([region('r', {commissionedAmounts:amounts({hardware:amount})})])),
   'r:first-commissioned');
  assert.ok(value.detail.includes(`${displayed} standard hardware blocks`), `${amount}: ${value.detail}`);
  assert.doesNotMatch(value.detail, /NaN|Infinity/);
 }
});

test('real canonical and policy substeps each append history, and partial coarse endpoints satisfy cadence', () => {
 const base = branchWorld(createWorld({horizon:1, dt:.1, regions:[{id:'r', config:{H0:10, G0:0, B0:0, F0:0,
  shockProbability:0}}], links:[]}), {regionId:'r', type:'cap', start:.07, delay:0, cost:0, duration:.11, cap:0});
 const first = stepWorld(base), canonical = stepWorld(first), substep = stepWorld(canonical);
 assert.deepEqual(first.history.map(value => value.t), [0, .07]);
 assert.deepEqual(canonical.history.map(value => value.t), [0, .07, .1]);
 assert.deepEqual(substep.history.map(value => value.t), [0, .07, .1, .18]);
 const coarse = advanceWorld(base, .37);
 assert.equal(coarse.history.at(-1).t, .37);
 assert.deepEqual(coarse.history.slice(0, 4), substep.history);
 assert.ok(coarse.history.every((value, i) => !i || value.t-coarse.history[i-1].t <= coarse.config.dt+1e-8));
 const observed = row(observeWorldMilestones(coarse), 'world:first-shortage');
 assert.equal(observed.t, .07);
 assert.match(observed.detail, /complete aggregate history/i);
 assert.deepEqual(observeWorldMilestones(restoreWorld(saveWorld(coarse))), observeWorldMilestones(coarse));
 const missing = {...coarse, history:coarse.history.filter(value => value.t !== .1)};
 assert.match(row(observeWorldMilestones(missing), 'world:first-shortage').detail, /history incomplete/i);
});

function realWorld() {
 return createWorld({horizon:4, dt:.25, alignment:1, eventMode:'scenario',
  eventConfig:{technologyProbability:0, pandemicProbability:0, disasterProbability:1, disasterLoss:.8, disasterDuration:.5},
  regions:[
   {id:'r', name:'Productive', config:{H0:10, G0:100, B0:10, F0:100, aE0:.45, aF0:.45,
    automationRate:.2, automationEnergy:0, automationDelay:.25, hardwareDelay:.25, powerDelay:.25, fabDelay:.25,
    shockProbability:0, birth:0, death:0, shortfall:0, supportTime:10, improvement:'exponential', rdExponent:0, kappa:.5}},
   {id:'needs', name:'Needs', config:{H0:10, G0:60, B0:0, F0:0, aE0:1, aF0:0, shockProbability:0,
    birth:0, death:0, shortfall:0}},
  ], links:[]});
}

test('real coarse advance reconstructs aggregate first events and honest endpoint rows after save/restore', () => {
 const base = realWorld(), early = advanceWorld(base, .75);
 const world = advanceWorld(base, 3.75), rows = observeWorldMilestones(world);
 assert.equal(row(rows, 'world:first-shortage').t, .25);
 assert.equal(row(rows, 'world:first-recovery').t, .75);
 for (const id of ['r:first-commissioned','r:q-doubled','r:automation-proxy']) assert.equal(row(rows, id).t, 3.75);
 assert.ok(early.regions[0].state.commissionedAmounts.hardware > 0);
 assert.equal(row(observeWorldMilestones(early), 'r:first-commissioned').t, .75);
 assert.ok(!rows.some(value => value.id === 'needs:first-commissioned'));
 const serialized = saveWorld(world), restored = restoreWorld(serialized);
 assert.deepEqual(observeWorldMilestones(restored), rows);
 assert.equal(saveWorld(restored), serialized);
 const resumed = advanceWorld(restoreWorld(saveWorld(early)), 3);
 assert.deepEqual(resumed, world);
 assert.deepEqual(observeWorldMilestones(resumed), rows);
 assert.deepEqual(observeWorldMilestones(base), []);
 // A view intentionally lacks commissioning counters and regional Q0; do not synthesize that evidence.
 const fromView = observeWorldMilestones(worldView(world));
 assert.ok(fromView.every(value => value.regionId === null));
});

test('real immutable checkpoint observation leaves continuation and all model random streams unchanged', () => {
 const world = advanceWorld(realWorld(), 1.25), before = saveWorld(world);
 const control = advanceWorld(restoreWorld(before), 1);
 assert.ok(Object.isFrozen(world.regions[0].state.rng));
 observeWorldMilestones(world);
 assert.equal(saveWorld(world), before);
 assert.deepEqual(advanceWorld(world, 1), control);
});
