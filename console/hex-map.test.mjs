import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHexMap, updateHexMap, mapLegend } from './hex-map.mjs';
import { decorateWorldMap, worldChanges, eventDescription } from './world-motion.mjs';

const positions = [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const fixture = () => ({
  t: 3, horizon: 30,
  regions: positions.map(([q, r], i) => ({
    id: `r${i}`, name: `Region ${i}`, q, r, terrain: ['plains', 'forest', 'coast', 'highlands'][i % 4],
    H: 12 + i, B: 100 + i, active: 70 + i, Q: 1.25 + i, G: 90 + i,
    F: 8 + i, sH: .7 + i * .05, rawPower: 90 + i, deliveredPower: 95 + i,
    work: { capacity: 15, used: 7, requested: 12 }, queue: [],
  })),
  links: [
    { id: 'north', from: 'r0', to: 'r5', capacity: 20, flow: 8 },
    { id: 'east', from: 'r0', to: 'r1', capacity: 40, flow: -12 },
    { id: 'idle', from: 'r0', to: 'r2', capacity: 10, flow: 0 },
  ],
});
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const groups = svg => [...svg.matchAll(/<g\b[^>]*data-region="([^"]*)"[^>]*>/g)].map(match => match[0]);

test('accepted checkpoint labels cannot put XML-forbidden characters in the atlas',()=>{
 const view=fixture();
 view.regions[0].name='A\u0001B\ufffeC\ud800D😀𐍈中 & <safe>';
 const svg=renderHexMap(freeze(view));
 assert.doesNotMatch(svg,/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/u);
 assert.match(svg,/A�B�C�D😀𐍈中 &amp; &lt;safe&gt;/u);
});

test('seven actual axial regions are selectable; decorative terrain has no invented regions', () => {
  const svg = renderHexMap(fixture());
  assert.equal(groups(svg).length, 7);
  assert.ok(groups(svg).every(group => /tabindex="0"/.test(group) && /role="button"/.test(group)));
  assert.match(svg, /viewBox="300 150 840 565"/);
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(svg, /data-layer="decoration"[^>]*aria-hidden="true"/);
  assert.match(svg, /Synthetic regions/);
  assert.match(svg, /decorative terrain/);
  assert.match(svg, /data-q="1" data-r="-1"/);
  assert.doesNotMatch(svg, /<script|<foreignObject|<image|https?:\/\/(?!www\.w3\.org)/);
});

test('all caller-controlled text and IDs are escaped in SVG attributes and text', () => {
  const hostile = `\"><script>alert('x')</script>&<img onerror="bad">`;
  const view = fixture();
  view.regions[0] = { ...view.regions[0], id: hostile, name: hostile, terrain: hostile };
  view.links[0] = { ...view.links[0], id: hostile, from: hostile };
  const svg = renderHexMap(view, { selectedId: hostile, overlay: hostile });
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&quot;/);
  assert.match(svg, /&amp;/);
  assert.doesNotMatch(svg, /<script|<img|onerror="bad"/);
  assert.ok(groups(svg).some(group => /aria-pressed="true"/.test(group)));
});

test('selection is explicit, keyboard visible and independent of the overlay', () => {
  const svg = renderHexMap(fixture(), { selectedId: 'r3', overlay: 'power' });
  const selected = groups(svg).filter(group => /aria-pressed="true"/.test(group));
  assert.equal(selected.length, 1);
  assert.match(selected[0], /data-region="r3"/);
  assert.match(svg, /class="selection-ring"/);
  assert.match(svg, /:focus-visible/);
  assert.match(svg, /data-overlay="power"/);
});

test('overlay labels contain actual numbers, units and honest scales', () => {
  const view = fixture();
  const adequacy = renderHexMap(view, { frameless: false });
  assert.match(adequacy, /70%/);
  assert.match(adequacy, /Human needs/);
  assert.match(adequacy, /0%/);
  assert.match(adequacy, /100%/);
  const power = renderHexMap(view, { overlay: 'power' });
  assert.match(power, /95 TWh\/year/);
  assert.match(power, /Delivered power/);
  const compute = renderHexMap(view, { overlay: 'compute' });
  assert.match(compute, /70 blocks/);
  assert.match(compute, /Q 1\.25/);
  assert.match(compute, /Powered compute/);
  for (const mode of ['adequacy', 'power', 'compute']) assert.match(mapLegend(mode), /<span/);
});

test('actual links show capacity, signed flow, reverse direction and idle state', () => {
  const svg = renderHexMap(fixture(), { frameless: false });
  assert.equal((svg.match(/data-link="/g) ?? []).length, 3);
  assert.match(svg, /data-capacity="20" data-flow="8"/);
  assert.match(svg, /data-capacity="40" data-flow="-12"/);
  assert.match(svg, /8 \/ 20/);
  assert.match(svg, /12 \/ 40/);
  assert.match(svg, /Region 1 → Region 0/);
  assert.match(svg, /0 \/ 10/);
  assert.match(svg, /Width: link capacity/);
  assert.match(svg, /TWh\/year/);
});

test('missing data stays unavailable, zeros stay zero, and initial adequacy is unmeasured', () => {
  const view = fixture();
  view.t = 0;
  view.regions[0] = { ...view.regions[0], sH: 1, deliveredPower: null, active: null, H: Infinity };
  assert.match(renderHexMap(view), /unmeasured/);
  assert.doesNotMatch(renderHexMap(view), /NaN|Infinity|undefined/);
  assert.match(renderHexMap(view, { overlay: 'power' }), /unavailable/);
  view.t = 1;
  view.regions[0] = { ...view.regions[0], sH: 0, deliveredPower: 0, active: 0 };
  assert.match(renderHexMap(view), /0%/);
  assert.match(renderHexMap(view, { overlay: 'power' }), /0 TWh\/year/);
  assert.match(renderHexMap(view, { overlay: 'compute' }), /0 blocks/);
});

test('no fabricated regions or connections for empty, incomplete or disconnected views', () => {
  const empty = renderHexMap();
  assert.equal(groups(empty).length, 0);
  assert.match(empty, /No regional data/);
  const view = fixture();
  view.regions = [view.regions[0], { id: 'bad', name: 'No location', q: NaN, r: 0 }];
  view.links = [...view.links, { id: 'ghost', from: 'r0', to: 'missing', capacity: 30, flow: 5 }];
  const svg = renderHexMap(view);
  assert.equal(groups(svg).length, 1);
  assert.equal((svg.match(/data-link="/g) ?? []).length, 0);
  assert.match(svg, /omitted/);
});

test('rendering is immutable and each SVG has isolated internal IDs', () => {
  const view = freeze(fixture()), before = JSON.stringify(view);
  const first = renderHexMap(view), second = renderHexMap(view);
  assert.equal(JSON.stringify(view), before);
  const ids = svg => [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.ok(ids(first).length > 2);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, ids(first).length + ids(second).length);
  assert.ok(first.length < 250000);
});

test('capacity widths are proportional and flow direction follows actual endpoint positions', () => {
  const svg = renderHexMap(fixture());
  const link = id => svg.match(new RegExp(`<g data-link="${id}"[\\s\\S]*?</g></g>`))?.[0];
  assert.match(link('north'), /class="link-track"[^>]*stroke-width="5"/);
  assert.match(link('east'), /class="link-track"[^>]*stroke-width="10"/);
  assert.match(link('idle'), /class="link-track"[^>]*stroke-width="2\.5"/);
  const direction = link('east').match(/class="link-flow" d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"/);
  assert.ok(Number(direction[1]) > Number(direction[3]), 'negative flow travels from eastern endpoint toward center');
  assert.equal(direction[2], direction[4]);
  assert.doesNotMatch(link('idle'), /class="link-flow"|marker-end=/);
});

test('unknown selection and overlays fall back safely; standalone legends do not invent a maximum', () => {
  const svg = renderHexMap(fixture(), { selectedId: 'unknown', overlay: 'unknown' });
  assert.ok(groups(svg).every(group => /aria-pressed="false"/.test(group)));
  assert.match(svg, /data-overlay="adequacy"/);
  assert.match(mapLegend('power'), /view max/);
  assert.match(mapLegend('compute', { maximum: 650 }), />650<\/span>/);
  assert.match(mapLegend('compute', { maximum: NaN }), /view max/);
});

test('numeric extrema, unknown terrain and invalid links remain finite and do not add connections', () => {
  const view = fixture();
  view.regions[0] = { ...view.regions[0], active: Number.MAX_VALUE, terrain: null, name: 'A very long name & <script>text</script> with quotes "x"' };
  view.regions.push({ ...view.regions[0] });
  view.links.push(
    { id: 'self', from: 'r0', to: 'r0', capacity: 1, flow: 1 },
    { id: 'negative', from: 'r0', to: 'r1', capacity: -1, flow: 0 },
    { id: 'nan', from: 'r0', to: 'r1', capacity: 2, flow: NaN },
  );
  const svg = renderHexMap(view, { overlay: 'compute' });
  assert.match(svg, /1\.80e308 blocks/);
  assert.match(svg, /…/);
  assert.match(svg, /&amp; &lt;script&gt;text&lt;\/script&gt;/);
  assert.equal(groups(svg).length, 7);
  assert.equal((svg.match(/data-link="/g) ?? []).length, 3);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test('spatial positions come from axial coordinates, not input order', () => {
  const view = fixture();
  const first = renderHexMap(view);
  const reversed = renderHexMap({ ...view, regions: [...view.regions].reverse() });
  const locate = svg => Object.fromEntries(groups(svg).map(group => [group.match(/data-region="([^"]*)"/)[1], group.match(/transform="([^"]*)"/)[1]]));
  assert.deepEqual(locate(first), locate(reversed));
});

test('embedded default removes duplicate heading, compass and legend; optional frame remains complete', () => {
  const embedded = renderHexMap(fixture());
  assert.doesNotMatch(embedded, /Land, power &amp; possibility|AXIAL r−|Width: link capacity/);
  const framed = renderHexMap(fixture(), { frameless: false });
  assert.match(framed, /Land, power &amp; possibility/);
  assert.match(framed, /AXIAL r−/);
  assert.match(framed, /Width: link capacity/);
  assert.match(framed, /viewBox="0 0 1440 900"/);
  assert.match(embedded, /data-layer="links" pointer-events="none"/);
});

test('tiny positive transfers remain nonzero and large capacities never overflow SVG widths', () => {
  const view = fixture();
  view.links[0] = { ...view.links[0], flow: .004 };
  view.links[1] = { ...view.links[1], capacity: Number.MAX_VALUE, flow: Number.MAX_VALUE };
  const svg = renderHexMap(view);
  assert.match(svg, /4\.00e-3 \/ 20/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('terrain districts have distinct original silhouettes; compute lights and tiers follow actual stocks', () => {
  const view = fixture();
  const terrain = ['plain', 'mountain', 'desert', 'wetland', 'plateau', 'coast', 'forest'];
  view.regions = view.regions.map((r, i) => ({ ...r, terrain: terrain[i], B: i * 60, active: i === 1 ? 0 : i * 20 }));
  const svg = renderHexMap(freeze(view));
  for (const kind of ['plains', 'highlands', 'arid', 'wetland', 'plateau', 'coast', 'forest']) assert.match(svg, new RegExp(`data-district="${kind}"`));
  assert.match(svg, /data-compute-status="idle"/);
  assert.match(svg, /data-compute-status="powered"/);
  assert.match(svg, /data-compute-status="absent"/);
  for (const tier of ['hall', 'campus', 'complex']) assert.match(svg, new RegExp(`data-visual-tier="${tier}"`));
  assert.match(svg, /20 of 60 installed blocks|0 of 60 installed blocks/);
  assert.match(svg, /IDLE/);
  assert.match(svg, /POWERED/);
  assert.match(renderHexMap({ ...view, t: 0 }), /data-compute-status="unmeasured"/);
  assert.doesNotMatch(renderHexMap({ ...view, t: 0 }), /data-compute-status="powered"/);
});

test('construction blueprints summarize real orders and elapsed lead time, never fabricated completion', () => {
  const view = fixture();
  view.t = 3;
  view.regions[0] = { ...view.regions[0], projectLeadTimes: { hardware: 2 }, queue: [
    { id: 7, kind: 'hardware', amount: 5, requestedDue: 4, due: 4 },
    { id: 8, kind: 'hardware', amount: 2, requestedDue: 5, due: 5 },
    { id: 9, kind: 'power', amount: 8, due: 6 },
  ] };
  const svg = renderHexMap(freeze(view));
  assert.match(svg, /data-queue-kind="hardware" data-orders="2"/);
  assert.match(svg, /data-lead-elapsed="0.5"/);
  assert.match(svg, /7 blocks/);
  assert.match(svg, /Next service: year 4/);
  assert.match(svg, /50% lead time elapsed/);
  assert.match(svg, /data-queue-kind="power" data-orders="1"/);
  assert.match(svg, /Lead time unavailable/);
  assert.doesNotMatch(svg, /% complete|data-orders="0"/);
  assert.doesNotMatch(renderHexMap(fixture()), /data-queue-kind=/);
});

test('location effects require real active events or recorded technology history, and expire by model time', () => {
  const view = fixture();
  view.regions[0] = { ...view.regions[0], scenarioEvents: { efficiency: .02, active: [
    { id: 'p', kind: 'pandemic', start: 2, end: 4, amplitude: .015 },
    { id: 'd', kind: 'disaster', start: 2, end: 3, amplitude: .1 },
    { id: 'future', kind: 'disaster', start: 5, end: 6, amplitude: .1 },
  ], history: [{ type: 'event-start', eventId: 'tech', kind: 'technology', t: 1, amplitude: .02 }] } };
  const svg = renderHexMap(freeze(view));
  assert.equal((svg.match(/data-location-effect="pandemic"/g) ?? []).length, 1);
  assert.equal((svg.match(/data-location-effect="technology"/g) ?? []).length, 1);
  assert.doesNotMatch(svg, /data-location-effect="disaster"/);
  assert.match(svg, /1.5%\/year additional mortality/);
  assert.match(svg, /2% reduction in base electricity need/);
  assert.doesNotMatch(renderHexMap({ ...view, t: 4 }), /data-location-effect="pandemic"/);
  assert.doesNotMatch(renderHexMap(fixture()), /data-location-effect=/);
  const activeDisaster = renderHexMap({ ...view, t: 2.5 });
  assert.match(activeDisaster, /data-location-effect="disaster"/);
  assert.match(activeDisaster, /10% electricity availability loss/);
});

// A small SVG DOM fixture exercises reconciliation without a browser or dependencies.
class SvgNode {
  constructor(nodeName, ownerDocument, nodeType = 1, nodeValue = null) {
    Object.assign(this, { nodeName, ownerDocument, nodeType, nodeValue, parentNode: null, childNodes: [], attrs: new Map() });
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  get dataset() { return new Proxy({}, { get: (_t, key) => this.getAttribute(`data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`), set: (_t, key, value) => { this.setAttribute(`data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value); return true; } }); }
  get classList() {
    const has = cls => (this.getAttribute('class') ?? '').split(' ').includes(cls);
    const toggle = (cls, enabled = !has(cls)) => { this.setAttribute('class', [...new Set((this.getAttribute('class') ?? '').split(' ').filter(c => c && c !== cls).concat(enabled ? [cls] : []))].join(' ')); return enabled; };
    return { toggle, add: cls => toggle(cls, true), remove: cls => toggle(cls, false), contains: has };
  }
  get style() { return { setProperty: (key, value) => this.setAttribute(`style-${key}`, value) }; }
  querySelectorAll(selector) {
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    return descendants(this).slice(1).filter(node => attr ? node.hasAttribute(attr[1]) && (attr[2] === undefined || node.getAttribute(attr[1]) === attr[2]) : selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.nodeName === selector);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  insertBefore(node, reference) {
    node.remove();
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    this.childNodes.splice(index, 0, node); node.parentNode = this;
  }
  remove() { if (this.parentNode) { const siblings = this.parentNode.childNodes; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } }
  replaceChildren(...nodes) { for (const node of [...this.childNodes]) node.remove(); for (const node of nodes) this.insertBefore(node, null); }
}
const descendants = node => [node, ...node.childNodes.flatMap(descendants)];
function svgContainer() {
  const doc = { defaultView: { matchMedia: () => ({ matches: false }) }, createElementNS: (_ns, name) => new SvgNode(name, doc) };
  doc.importNode = (source, deep) => {
    const copy = new SvgNode(source.nodeName, doc, source.nodeType, source.nodeValue);
    for (const attr of source.attributes) copy.setAttribute(attr.name, attr.value);
    if (deep) for (const child of source.childNodes) copy.insertBefore(doc.importNode(child, true), null);
    return copy;
  };
  doc.defaultView.DOMParser = class {
    parseFromString(source) {
      const wrapper = new SvgNode('document', doc), stack = [wrapper];
      for (const token of source.match(/<[^>]+>|[^<]+/g)) {
        if (token.startsWith('</')) { stack.pop(); continue; }
        const tag = token.match(/^<([\w:-]+)/);
        const node = tag ? new SvgNode(tag[1], doc) : new SvgNode('#text', doc, 3, token);
        if (tag) for (const [, key, value] of token.matchAll(/([\w:-]+)="([^"]*)"/g)) node.setAttribute(key, value);
        stack.at(-1).insertBefore(node, null);
        if (tag && !token.endsWith('/>')) stack.push(node);
      }
      assert.equal(stack.length, 1, 'balanced SVG markup');
      return { documentElement: wrapper.childNodes[0] };
    }
  };
  return new SvgNode('div', doc);
}

test('XML parsing failure leaves the last valid atlas intact and reports the error',()=>{
 const root=svgContainer(),svg=updateHexMap(root,fixture());
 root.ownerDocument.defaultView.DOMParser=class{
  parseFromString(){return {documentElement:new SvgNode('parsererror',root.ownerDocument)};}
 };
 assert.throws(()=>updateHexMap(root,fixture()),/valid SVG/);
 assert.equal(root.childNodes[0],svg);
 assert.equal(svg.querySelectorAll('[data-region]').length,7);
});

test('updates preserve the SVG, selectable tiles, link paths and animation nodes while changing actual readings', () => {
  const root = svgContainer(), view = fixture();
  const svg = updateHexMap(root, view, { selectedId: 'r0' });
  const find = (key, value, node = svg) => descendants(node).find(n => n.getAttribute(key) === value);
  const region = find('data-region', 'r0'), link = find('data-link', 'north');
  const path = find('class', 'link-flow', link), district = find('data-key', 'district', region);
  const motion = find('data-key', 'motion', region), smoke = new SvgNode('g', root.ownerDocument);
  smoke.setAttribute('class', 'working-smoke'); motion.insertBefore(smoke, null);
  const next = { ...view, t: 4, regions: view.regions.map(r => ({ ...r, active: 0, queue: [{ id: 1, kind: 'power', amount: 2, due: 5 }] })) };
  const updated = updateHexMap(root, freeze(next), { selectedId: 'r1', overlay: 'compute' });
  assert.equal(updated, svg);
  assert.equal(find('data-region', 'r0'), region);
  assert.equal(find('data-key', 'district', region), district);
  assert.equal(find('class', 'link-flow', link), path);
  assert.equal(find('class', 'working-smoke', region), smoke);
  assert.equal(region.getAttribute('aria-pressed'), 'false');
  assert.equal(find('data-region', 'r1').getAttribute('aria-pressed'), 'true');
  assert.equal(find('data-key', 'compute', region).getAttribute('data-compute-status'), 'idle');
  assert.ok(find('data-queue-kind', 'power', region));
  updateHexMap(root, { ...next, regions: [next.regions[0]], links: [] });
  assert.equal(descendants(svg).filter(n => n.hasAttribute('data-region')).length, 1);
  assert.equal(descendants(svg).filter(n => n.hasAttribute('data-link')).length, 0);
});

test('live motion requires Play, pauses immediately, honors reduced motion and keeps one activity group per region', () => {
  const root = svgContainer(), view = fixture(), svg = updateHexMap(root, view);
  decorateWorldMap(root, view, { playing: true });
  assert.ok(svg.classList.contains('motion-enabled'));
  const smoke = svg.querySelector('.working-smoke');
  assert.equal(svg.querySelectorAll('.working-smoke').length, 7);
  decorateWorldMap(root, view, { playing: true });
  assert.equal(svg.querySelector('.working-smoke'), smoke);
  assert.equal(svg.querySelectorAll('.working-smoke').length, 7);
  decorateWorldMap(root, view, { playing: false });
  assert.equal(svg.classList.contains('motion-enabled'), false);
  assert.equal(svg.dataset.intervalState, 'paused-last-interval');
  root.ownerDocument.defaultView.matchMedia = () => ({ matches: true });
  decorateWorldMap(root, view, { playing: true });
  assert.equal(svg.classList.contains('motion-enabled'), false);
  const idle = { ...view, regions: view.regions.map(r => ({ ...r, active: 0 })) };
  updateHexMap(root, idle); decorateWorldMap(root, idle, { playing: true });
  assert.equal(svg.querySelectorAll('.working-smoke').length, 0);
  const initial = { ...view, t: 0 };
  updateHexMap(root, initial); decorateWorldMap(root, initial, { playing: true });
  assert.equal(svg.classList.contains('motion-enabled'), false);
  assert.equal(svg.querySelectorAll('.working-smoke').length, 0);
  assert.equal(svg.dataset.intervalState, 'unmeasured');
});

test('existing commissioning feedback keeps real units and updates its preserved motion host once per advance', () => {
  const root = svgContainer(), before = fixture();
  const after = freeze({ ...before, t: 4, regions: before.regions.map(r => ({ ...r, G: r.G + 2, F: r.F + 3 })) });
  updateHexMap(root, after);
  decorateWorldMap(root, after, { previousView: before, playing: true });
  const labels = root.querySelectorAll('.commission-label');
  assert.equal(labels.length, 7);
  assert.equal(labels[0].textContent, '+2 TWh/yr');
  decorateWorldMap(root, after, { previousView: before, playing: true });
  assert.equal(root.querySelectorAll('.commission-label').length, 7);
  assert.equal(worldChanges(before, after).length, 14);
  assert.deepEqual(worldChanges(after, before), []);
  assert.deepEqual(worldChanges(null, after), []);
  const withoutPredecessor = { ...before, regions: [] };
  assert.deepEqual(worldChanges(withoutPredecessor, after), []);
  assert.deepEqual(worldChanges(before, { ...before, t: 4 }), []);
  assert.match(eventDescription(worldChanges(before, after)[0]), /2 TWh\/year of power/);
  assert.match(eventDescription(worldChanges(before, after)[0]), /between years 3 and 4/);
  assert.match(eventDescription(worldChanges(before, after)[1]), /3 blocks\/year of fabrication/);
  for (const kind of ['technology', 'tech', 'breakthrough', 'human-tech', 'technology-breakthrough']) assert.match(eventDescription({ kind }, 'Hearth'), /Hearth: human technology breakthrough/);
  assert.match(eventDescription({ kind: 'pandemic', regionName: 'Delta' }), /does not simulate transmission/);
  assert.match(eventDescription({ kind: 'disaster', regionId: 'coast' }), /coast: natural disaster/);
  assert.match(eventDescription({ kind: 'supply-shock' }), /World: supply shock/);
  assert.match(eventDescription({ type: 'new-event' }), /new event/);
  assert.match(eventDescription({}), /scenario event/);
  decorateWorldMap(root, after, { previousView: null });
  assert.equal(root.querySelectorAll('.commission-label').length, 0, 'restore clears feedback from a previous timeline');
});
