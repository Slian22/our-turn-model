import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, stepRun } from '../sim/engine.mjs';
import { runHistory } from '../sim/history.mjs';
import { renderWorldScene } from './world-scene.mjs';

class Node {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.attributes = {}; this.children = []; this.textContent = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
}
function container(width = 1120) {
  const document = { createElementNS: (_ns, tag) => new Node(tag, document), defaultView: {} };
  const node = new Node('div', document); node.clientWidth = width; return node;
}
const nodes = root => [root, ...root.children.flatMap(nodes)];
const text = root => nodes(root).map(node => node.textContent).join(' ');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('robust empty defaults produce one accessible SVG with no invented values', () => {
  const target = container(), svg = renderWorldScene(target);
  assert.equal(target.children[0], svg);
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.ok(svg.getAttribute('viewBox'));
  assert.ok(svg.getAttribute('aria-labelledby'));
  assert.match(text(svg), /Humans/);
  assert.match(text(svg), /—/);
  assert.doesNotMatch(text(svg), /NaN|undefined|Infinity/);
});

test('real RSI model fields and separate autonomy are rendered without mutation', () => {
  const run = freeze(stepRun(createRun({ aE0: .17, aF0: .63 })));
  const before = JSON.stringify(run), target = container();
  const svg = renderWorldScene(target, { run, playing: true });
  assert.match(text(svg), /million people/);
  assert.match(text(svg), /TWh\/year/);
  assert.match(text(svg), /blocks\/year/);
  assert.match(text(svg), /17%/);
  assert.match(text(svg), /63%/);
  assert.match(text(svg), /Capability/);
  assert.match(text(svg), /dimensionless/);
  assert.match(svg.getAttribute('class'), /is-playing/);
  assert.ok(nodes(svg).some(node => node.getAttribute('class')?.includes('flow-active')));
  assert.equal(JSON.stringify(run), before);
});

test('zero initial ledger is not presented as a zero grid capacity', () => {
  const svg = renderWorldScene(container(), { run: createRun() });
  assert.match(text(svg), /28,000/);
  assert.match(text(svg), /No interval/);
  assert.match(text(svg), /Electricity · unmeasured/);
  assert.match(text(svg), /Delivered · unmeasured/);
  assert.match(text(svg), /Resource adequacy · unmeasured/);
  assert.match(text(svg), /million people, adequacy unmeasured/);
  assert.doesNotMatch(text(svg), /Resource adequacy · 100%/);
  assert.doesNotMatch(text(svg), /Electricity · 0|Delivered · 0|Operation · 0|R&D · 0/);
});

test('queue amounts are grouped by kind with correct units and earliest due time', () => {
  const run = createRun();
  const input = freeze({ ...run, state: { ...run.state, queue: [
    { kind: 'hardware', amount: 12, due: 4, energy: 1, land: 2 },
    { kind: 'hardware', amount: 3, due: 2, energy: 1, land: 2 },
    { kind: 'power', amount: 7, due: 3, energy: 1, land: 2 },
    { kind: 'fabAutomation', amount: .04, due: 3, energy: 1, land: 0 },
  ] } });
  const svg = renderWorldScene(container(), { run: input });
  assert.match(text(svg), /15 blocks/);
  assert.match(text(svg), /7 TWh\/year/);
  assert.match(text(svg), /4% autonomy/);
  assert.match(text(svg), /year 2/);
});

test('history snapshot uses visible point at time, not the future end of the run', () => {
  const history = freeze({ ...runHistory({ horizon: 10, dt: 1, outputEvery: 1 }), time: 0 });
  const svg = renderWorldScene(container(), { level: 'history', history });
  const content = text(svg);
  assert.match(content, /Neandertal/);
  assert.match(content, /Modern human/);
  assert.match(content, /90/);
  assert.match(content, /10/);
  assert.match(content, /reference adult equivalents/);
  assert.match(content, /kcal\/year/);
  assert.match(content, /km²/);
  assert.doesNotMatch(content, /RSI hardware|TWh\/year/);
});

test('history accepts an already sliced array and preserves absent resources', () => {
  const svg = renderWorldScene(container(), { level: 'history', history: [{ t: 2, N: 0, M: 12, sN: null, sM: 1 }] });
  assert.match(text(svg), /12/);
  assert.doesNotMatch(text(svg), /NaN|undefined|Infinity|null/);
});

test('state zeros take precedence over an older trajectory and paused redraw replaces scene', () => {
  const target = container(), run = createRun();
  renderWorldScene(target, { run, playing: true });
  const svg = renderWorldScene(target, { run: { ...run, state: { ...run.state, H: 0, Q: 0, shutdown: true } } });
  assert.equal(target.children.length, 1);
  assert.doesNotMatch(svg.getAttribute('class'), /is-playing/);
  assert.ok(nodes(svg).every(node => !node.getAttribute('class')?.includes('flow-active')));
  assert.match(text(svg), /Shutdown active/);
  assert.match(text(svg), /0 million people/);
});

test('compact scene reflows and separate instances have unique accessible IDs', () => {
  const small = renderWorldScene(container(380));
  const large = renderWorldScene(container());
  assert.notEqual(small.getAttribute('viewBox'), large.getAttribute('viewBox'));
  assert.notEqual(small.getAttribute('aria-labelledby'), large.getAttribute('aria-labelledby'));
  assert.ok(nodes(small).some(node => node.tagName === 'style' && /prefers-reduced-motion/.test(node.textContent)));
});

test('large queue stays bounded, and external text is never parsed as markup', () => {
  const run = createRun();
  const queue = Array.from({ length: 100000 }, () => ({ kind: 'hardware', amount: 1, due: 2 }));
  const svg = renderWorldScene(container(), { run: { ...run, state: { ...run.state, queue } } });
  assert.ok(nodes(svg).length < 650);
  assert.match(text(svg), /100,000 blocks/);
  assert.ok(nodes(svg).every(node => !['script', 'foreignObject', 'image', 'animate'].includes(node.tagName)));
});

test('powered blocks may exceed endpoint installed stock; malformed numbers remain unavailable', () => {
  const run = createRun();
  const svg = renderWorldScene(container(), { run: { ...run, state: { ...run.state,
    t: 1, stepDuration: 1, B: 300, active: 1000, Q: Number.MAX_VALUE, aE: 0, aF: 1, support: 0, infeasible: true } } });
  assert.match(text(svg), /Powered last interval · 1,000 blocks/);
  assert.match(text(svg), /Reserve infeasible/);
  assert.match(text(svg), /1\.798e308/);
  assert.doesNotMatch(text(svg), /NaN|Infinity/);
  const empty = renderWorldScene(container(), { run: { state: { H: '<script>alert(1)</script>', Q: Infinity } } });
  assert.doesNotMatch(text(empty), /<script>|Infinity/);
  assert.equal(renderWorldScene(null), null);
});

test('trajectory-only run and history point are accepted', () => {
  const svg = renderWorldScene(container(), { run: { history: [{ t: 3, H: 5, Q: 9, supply: 12, queued: 7, infeasible: true }] } });
  assert.match(text(svg), /Humans 5 million/);
  assert.match(text(svg), /delivered 12 TWh\/year/);
  assert.match(text(svg), /7 queued projects · details unavailable/);
  assert.match(text(svg), /Reserve infeasible/);
  const historical = renderWorldScene(container(380), { level: 'history', history: { t: 0, N: 10, M: 20 } });
  assert.match(text(historical), /Neandertal 10 and modern human 20/);
});

test('historical replay clock distinguishes sample time from replay time', () => {
  const svg = renderWorldScene(container(), { level: 'history', history: {
    time: 7, trajectory: [{ t: 0, N: 90, M: 10 }, { t: 20, N: 60, M: 40 }],
  } });
  assert.match(text(svg), /Year 7 · paused/);
  assert.match(text(svg), /Snapshot · year 0/);
  assert.match(text(svg), /Resource snapshot year 0/);
  assert.doesNotMatch(text(svg), /Neandertal 60/);
});

test('resize observer reflows once at the breakpoint and disconnects on replacement', () => {
  const target = container();
  const observers = [];
  target.ownerDocument.defaultView.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  renderWorldScene(target);
  const wide = target.children[0].getAttribute('viewBox');
  target.clientWidth = 380;
  observers[0].callback([{ contentRect: { width: 380 } }]);
  assert.equal(observers[0].disconnected, true);
  assert.notEqual(target.children[0].getAttribute('viewBox'), wide);
  observers[1].callback([{ contentRect: { width: 360 } }]);
  assert.equal(observers.length, 2);
});
test('browser resize painting is deferred outside observer delivery and stale frames are cancelled', () => {
  const target=container(),observers=[],frames=[],cancelled=[];
  target.ownerDocument.defaultView={
    requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},
    cancelAnimationFrame:id=>cancelled.push(id),
    ResizeObserver:class {constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},
  };
  renderWorldScene(target);const initial=target.children[0];target.clientWidth=380;
  observers[0].callback([{contentRect:{width:380}}]);
  assert.equal(target.children[0],initial,'must not repaint while ResizeObserver is delivering');
  frames[0]();assert.notEqual(target.children[0],initial);
  target.clientWidth=1120;observers[1].callback([{contentRect:{width:1120}}]);
  renderWorldScene(target);const latest=target.children[0];
  assert.deepEqual(cancelled,[2]);frames[1]();assert.equal(target.children[0],latest);
});
