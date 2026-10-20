/**
 * A read-only view of the shared simulator. No imports, assets, timers or model writes.
 * renderWorldScene(container, { level: 'rsi' | 'history', run, history, playing })
 * History accepts a visible point array, a point, or { trajectory, time? }.
 * The RSI engine uses run.trajectory; run.history is also accepted as a fallback.
 * Returns the mounted SVG. Calling again replaces only this container's children.
 */
const NS = 'http://www.w3.org/2000/svg';
const C = Object.freeze({
  ink: '#172e43', muted: '#536473', paper: '#f7f3e9', card: '#fffcf5',
  rule: '#d8d7cd', teal: '#14837b', amber: '#d39a35', coral: '#d86a50',
  tealPale: '#e6f0e8', amberPale: '#f4ead3', coralPale: '#f6e4da',
});
const PROJECTS = Object.freeze([
  ['hardware', 'Hardware', 'blocks'], ['power', 'Grid', 'TWh/year'],
  ['factory', 'Fabrication', 'blocks/year'],
  ['powerAutomation', 'Power autonomy', 'autonomy'],
  ['fabAutomation', 'Fab autonomy', 'autonomy'],
]);
const mounts = new WeakMap();
let serial = 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const first = (...values) => values.find(finite);
const object = value => value && typeof value === 'object' ? value : {};
const last = value => Array.isArray(value) ? object(value.at(-1)) : {};
const percent = value => finite(value) ? `${format(value * 100)}%` : '—';
const reading = (data, value, unit) => data.t === 0 ? 'unmeasured' : `${format(value)} ${unit}`;
const adequacyReading = data => data.t === 0 ? 'unmeasured' : percent(data.sH);
const supportReading = data => `Human support${data.t === 0 ? ' (initial)' : ''} · ${percent(data.support)}`;
function format(value) {
  if (!finite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e7 || (magnitude > 0 && magnitude < .001)) return value.toExponential(3).replace('e+', 'e');
  return new Intl.NumberFormat('en', { maximumSignificantDigits: 5 }).format(value);
}
function node(document, tag, attributes = {}, content) {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (content !== undefined) element.textContent = String(content);
  return element;
}
function add(parent, tag, attributes = {}, content) {
  const element = node(parent.ownerDocument, tag, attributes, content);
  parent.append(element); return element;
}
function label(parent, x, y, content, size = 15, attributes = {}) {
  return add(parent, 'text', { x, y, fill: C.ink, 'font-size': size, ...attributes }, content);
}
function line(parent, x1, y1, x2, y2, attributes = {}) {
  return add(parent, 'line', { x1, y1, x2, y2, stroke: C.rule, ...attributes });
}
function rect(parent, x, y, width, height, attributes = {}) {
  return add(parent, 'rect', { x, y, width, height, rx: 12, fill: C.card, ...attributes });
}
function group(parent, x = 0, y = 0, attributes = {}) {
  return add(parent, 'g', { transform: `translate(${x} ${y})`, ...attributes });
}
function metric(parent, x, y, value, unit, size = 30) {
  const g = group(parent, x, y);
  add(g, 'title', {}, `${finite(value) ? value : 'Unavailable'} ${unit}`);
  label(g, 0, 0, format(value), size, { 'font-weight': 650, 'letter-spacing': '-.8' });
  label(g, 0, 24, unit, 14, { fill: C.muted });
  return g;
}
function rail(parent, x, y, width, fraction, color) {
  rect(parent, x, y, width, 5, { rx: 2.5, fill: C.rule });
  if (finite(fraction)) rect(parent, x, y, width * Math.max(0, Math.min(1, fraction)), 5, { rx: 2.5, fill: color });
}
function chip(parent, x, y, content, color = C.teal) {
  const width = content.length * 7.1 + 24;
  rect(parent, x, y - 17, width, 27, { rx: 13.5, fill: C.card, stroke: C.rule });
  add(parent, 'circle', { cx: x + 13, cy: y - 4, r: 3, fill: color });
  label(parent, x + 23, y, content, 12);
}

function sceneStyle(svg) {
  add(svg, 'style', {}, `
    .world-scene { display:block; width:100%; height:auto; overflow:hidden;
      color:${C.ink}; background:${C.paper}; font-family:Inter,ui-sans-serif,system-ui,sans-serif;
      font-variant-numeric:tabular-nums; }
    .world-scene text { font-family:inherit; }
    .world-scene .ws-flow { fill:none; stroke-linecap:round; stroke-linejoin:round; }
    .world-scene .ws-flow-dashes { stroke-dasharray:3 9; }
    .world-scene.is-playing .ws-status { animation:ws-breathe 2.8s ease-in-out infinite; }
    @keyframes ws-breathe { 50% { opacity:.4; } }
    @media (prefers-reduced-motion:reduce) {
      .world-scene .flow-active,.world-scene.is-playing .ws-status { animation:none!important; }
    }
  `);
}
function definitions(svg, id) {
  const defs = add(svg, 'defs');
  for (const [key, color] of [['human', C.teal], ['power', C.coral], ['hardware', C.amber], ['ink', C.ink]]) {
    const marker = add(defs, 'marker', { id: `${id}-${key}`, viewBox: '0 0 8 8', refX: 7, refY: 4,
      markerWidth: 7, markerHeight: 7, orient: 'auto', markerUnits: 'userSpaceOnUse' });
    add(marker, 'path', { d: 'M1 1 L7 4 L1 7 Z', fill: color });
  }
  const hatch = add(defs, 'pattern', { id: `${id}-land`, width: 9, height: 9, patternUnits: 'userSpaceOnUse' });
  add(hatch, 'path', { d: 'M-2 2 L2 -2 M0 9 L9 0 M7 11 L11 7', fill: 'none', stroke: C.rule, 'stroke-width': .8 });
}
function flow(parent, id, d, type, dashed = false) {
  const color = ({ human: C.teal, power: C.coral, hardware: C.amber, ink: C.ink })[type];
  // The ivory underlay keeps crossings distinct; there are no implied junctions.
  add(parent, 'path', { d, fill: 'none', stroke: C.paper, 'stroke-width': 7 });
  const active = dashed && parent.getAttribute('class')?.includes('is-playing');
  const path = add(parent, 'path', { d, stroke: color, 'stroke-width': 1.8,
    class: `ws-flow${dashed ? ' ws-flow-dashes' : ''}${active ? ' flow-active' : ''}`, 'marker-end': `url(#${id}-${type})` });
  return path;
}
function flowLabel(parent, x, y, content, size = 13) {
  label(parent, x, y, content, size, { 'text-anchor': 'middle', fill: C.muted,
    stroke: C.paper, 'stroke-width': 6, 'paint-order': 'stroke', 'stroke-linejoin': 'round' });
}

// Small, fixed-size vector facilities: schematic illustrations, never magnitude marks.
function block(parent, x, y, width, depth, height, color, pale) {
  const g = group(parent, x, y, { 'stroke-linejoin': 'round', stroke: C.ink, 'stroke-width': 1.1 });
  add(g, 'path', { d: `M0 0 L${width} -${depth} L${width} ${height - depth} L0 ${height} Z`, fill: pale });
  add(g, 'path', { d: `M0 0 L-${width} -${depth} L-${width} ${height - depth} L0 ${height} Z`, fill: color, 'fill-opacity': .7 });
  add(g, 'path', { d: `M0 0 L-${width} -${depth} L0 -${depth * 2} L${width} -${depth} Z`, fill: pale });
  return g;
}
function facility(parent, kind, color, pale, x, y) {
  const g = group(parent, x, y, { 'aria-hidden': 'true' });
  add(g, 'path', { d: 'M-55 28 L0 1 L55 28 L0 55 Z', fill: pale, stroke: C.rule });
  if (kind === 'human') {
    block(g, -20, 7, 18, 9, 22, color, pale);
    block(g, 17, -4, 20, 10, 31, color, pale);
    add(g, 'path', { d: 'M17 -24 V-4 M8 -14 H26', stroke: color, 'stroke-width': 2.5 });
    add(g, 'circle', { cx: -31, cy: 25, r: 3, fill: color });
    line(g, -31, 29, -31, 38, { stroke: color, 'stroke-width': 2 });
  } else if (kind === 'power') {
    block(g, 12, 10, 26, 13, 17, color, pale);
    add(g, 'path', { d: 'M-23 28 L-17 -22 L-11 28 M-29 -6 H-5 M-26 4 H-8 M-23 14 H-11 M-23 -6 L-11 14 M-11 -6 L-23 14',
      fill: 'none', stroke: C.ink, 'stroke-width': 1.4 });
    add(g, 'path', { d: 'M12 -8 L6 3 H14 L9 15 L23 -1 H14 L20 -8', fill: color });
  } else if (kind === 'fab') {
    block(g, 0, 4, 33, 16, 29, color, pale);
    block(g, 15, -16, 7, 4, 16, color, pale);
    for (let i = 0; i < 3; i++) line(g, 7 + i * 8, 9 - i * 4, 7 + i * 8, 21 - i * 4, { stroke: C.ink, 'stroke-width': 3 });
  } else if (kind === 'hardware') {
    for (let i = 0; i < 3; i++) {
      const b = block(g, -24 + i * 24, 12 - i * 6, 10, 6, 30, color, pale);
      for (let row = 0; row < 3; row++) line(b, 3, 7 + row * 7, 7, 5 + row * 7, { stroke: C.ink });
    }
  } else if (kind === 'capability') {
    const points = [[0, -20], [-29, 0], [29, 0], [-18, 30], [18, 30], [0, 10]];
    for (const [a, b] of [[0, 1], [0, 2], [0, 5], [1, 3], [2, 4], [3, 5], [4, 5], [1, 5], [2, 5]]) {
      line(g, ...points[a], ...points[b], { stroke: C.ink, 'stroke-width': 1.3 });
    }
    points.forEach(([cx, cy]) => add(g, 'circle', { cx, cy, r: 4.5, fill: pale, stroke: color, 'stroke-width': 2 }));
  } else {
    add(g, 'path', { d: 'M-42 26 L0 5 L42 26 L0 47 Z', fill: `url(#${kind})`, stroke: C.ink });
    for (let i = -1; i <= 1; i++) line(g, i * 13, 17, i * 13 + 21, 28, { stroke: color });
  }
}
function card(parent, position, { overline, title, kind, color, pale, id }) {
  const [x, y, width, height] = position;
  const g = group(parent, x, y, { 'data-facility': kind });
  rect(g, 0, 4, width, height, { fill: C.ink, 'fill-opacity': .035 });
  rect(g, 0, 0, width, height, { stroke: C.rule });
  line(g, 22, 0, 68, 0, { stroke: color, 'stroke-width': 3 });
  label(g, 22, 29, overline, 11, { fill: C.muted, 'letter-spacing': '1.5', 'font-weight': 650 });
  label(g, 22, 57, title, 22, { 'font-weight': 600 });
  facility(g, kind === 'land' ? `${id}-land` : kind, color, pale, width - 72, 94);
  return g;
}
function header(svg, width, title, subtitle, time, playing) {
  label(svg, 24, 32, 'SYSTEMS OBSERVATORY', 11, { 'letter-spacing': '2.2', 'font-weight': 650, fill: C.muted });
  label(svg, 24, 67, title, width < 600 ? 26 : 31, { style: 'font-family:Georgia,serif', 'font-weight': 500, 'letter-spacing': '-.6' });
  label(svg, 24, 93, subtitle, 13, { fill: C.muted });
  chip(svg, 24, 121, `Year ${format(time)} · ${playing ? 'running' : 'paused'}`);
  add(svg, 'circle', { cx: width - 29, cy: 29, r: 4, fill: playing ? C.teal : C.muted, class: 'ws-status' });
}
function rsiData(run) {
  const s = object(run?.state), point = last(run?.trajectory ?? run?.history), config = object(run?.config);
  const keys = ['t', 'H', 'G', 'F', 'B', 'Q', 'active', 'aE', 'aF', 'sH', 'support', 'landUsed', 'stepDuration'];
  const values = Object.fromEntries(keys.map(key => [key, first(s[key], point[key])]));
  const ledger = Object.fromEntries(['supply', 'human', 'operation', 'research', 'industry', 'construction', 'policy', 'unused']
    .map(key => [key, first(s.ledger?.[key], point[key])]));
  return { ...values, ledger, config, shutdown: s.shutdown === true,
    infeasible: typeof s.infeasible === 'boolean' ? s.infeasible : point.infeasible === true,
    queueCount: first(Array.isArray(s.queue) ? s.queue.length : undefined, point.queued),
    queueDetailed: Array.isArray(s.queue), queue: Array.isArray(s.queue) ? s.queue : [] };
}
function historicalPoint(history, run) {
  const source = history ?? run ?? {};
  if (Array.isArray(source)) return last(source);
  const points = source.trajectory ?? source.history ?? source.points;
  if (!Array.isArray(points)) return object(source.point ?? source.state ?? source);
  // A full precomputed history must never leak its future into a replay snapshot.
  const time = first(source.time, source.t);
  if (!finite(time)) return last(points);
  for (let i = points.length - 1; i >= 0; i--) if (finite(points[i]?.t) && points[i].t <= time + 1e-8) return object(points[i]);
  return {};
}
function queueGroups(queue) {
  return PROJECTS.map(([kind, name, unit]) => ({ kind, name, unit,
    ...queue.reduce((total, project) => project?.kind !== kind ? total : {
      amount: total.amount + (finite(project.amount) ? Math.max(0, project.amount) : 0),
      due: finite(project.due) ? Math.min(total.due, project.due) : total.due,
      count: total.count + 1,
    }, { amount: 0, due: Infinity, count: 0 }),
  }));
}
function queuePanel(svg, data, compact, y) {
  const width = compact ? 400 : 1072, g = group(svg, 24, y);
  rect(g, 0, 0, width, compact ? 422 : 186, { fill: C.amberPale, 'fill-opacity': .45, stroke: C.rule });
  label(g, 20, 31, 'Construction pipeline', 19, { 'font-weight': 600 });
  label(g, 20, 54, `${format(data.queueCount)} queued projects · ${data.queueDetailed ? 'prepaid, not yet installed' : 'details unavailable'}`, 12, { fill: C.muted });
  queueGroups(data.queue).forEach((p, i) => {
    const x = compact ? 20 : 20 + i * 209, top = compact ? 88 + i * 65 : 87;
    label(g, x, top, p.name, 13, { fill: C.muted });
    const amount = !data.queueDetailed ? '—' : p.unit === 'autonomy' ? `${percent(p.amount)} autonomy` : `${format(p.amount)} ${p.unit}`;
    label(g, x, top + 25, amount, 16, { 'font-weight': 600 });
    label(g, compact ? 254 : x, compact ? top + 25 : top + 49,
      !data.queueDetailed ? 'Details unavailable' : p.count ? `Next: year ${format(p.due)}` : 'No orders', 12, { fill: C.muted });
  });
}
function rsiCards(svg, data, positions, id) {
  const definitions = [
    ['human', '01 / PEOPLE', 'Humans', C.teal, C.tealPale],
    ['power', '02 / ELECTRICITY', 'Grid', C.coral, C.coralPale],
    ['fab', '03 / MANUFACTURING', 'Fabrication', C.amber, C.amberPale],
    ['land', 'SHARED / FINITE STOCK', 'Land account', C.teal, C.tealPale],
    ['hardware', '04 / INSTALLED COMPUTE', 'RSI hardware', C.amber, C.amberPale],
    ['capability', '05 / RECURSIVE RESEARCH', 'Capability', C.ink, C.tealPale],
  ];
  const cards = definitions.map(([kind, overline, title, color, pale], i) =>
    card(svg, positions[i], { kind, overline, title, color, pale, id }));
  const [human, power, fab, land, hardware, capability] = cards;
  metric(human, 22, 102, data.H, 'million people');
  label(human, 22, 166, `Electricity · ${reading(data, data.ledger.human, 'TWh/year')}`, 13);
  label(human, 22, 194, `Resource adequacy · ${adequacyReading(data)}`, 14, { 'font-weight': 600 });
  if (data.t !== 0) rail(human, 22, 211, positions[0][2] - 44, data.sH, C.teal);
  metric(power, 22, 102, data.G, 'TWh/year installed');
  label(power, 22, 166, `Delivered · ${reading(data, data.ledger.supply, 'TWh/year')}`, 13);
  label(power, 22, 194, `Power autonomy · ${percent(data.aE)}`, 14, { 'font-weight': 600 });
  rail(power, 22, 211, positions[1][2] - 44, data.aE, C.coral);
  metric(fab, 22, 102, data.F, 'blocks/year installed');
  label(fab, 22, 166, `Industry · ${reading(data, data.ledger.industry, 'TWh/year')}`, 13);
  label(fab, 22, 194, `Fab autonomy · ${percent(data.aF)}`, 14, { 'font-weight': 600 });
  rail(fab, 22, 211, positions[2][2] - 44, data.aF, C.amber);
  fillLowerCards({ land, hardware, capability }, data, positions);
}
function fillLowerCards({ land, hardware, capability }, data, positions) {
  metric(land, 22, 102, data.landUsed, 'km² committed', 27);
  label(land, 22, 166, `Accessible · ${format(data.config.land)} km²`, 13);
  label(land, 22, 194, 'Installed + pending facilities', 13, { fill: C.muted });
  rail(land, 22, 211, positions[3][2] - 44, data.config.land > 0 ? data.landUsed / data.config.land : undefined, C.teal);
  metric(hardware, 22, 102, data.B, 'standard hardware blocks');
  label(hardware, 22, 166, `Powered last interval · ${reading(data, data.active, 'blocks')}`, 13, { 'font-weight': 600 });
  label(hardware, 22, 194, `Operation · ${reading(data, data.ledger.operation, 'TWh/year')}`, 13);
  label(hardware, 22, 216, data.shutdown ? 'Shutdown active · residual may operate' : data.infeasible ? 'Reserve infeasible · orders constrained' : '1 block = 1 MW rated facility load', 12, { fill: C.muted });
  metric(capability, 22, 102, data.Q, 'Q · dimensionless');
  label(capability, 22, 166, `R&D · ${reading(data, data.ledger.research, 'TWh/year')}`, 14, { 'font-weight': 600 });
  label(capability, 22, 194, 'Powered research feeds improvement', 13, { fill: C.muted });
  label(capability, 22, 216, 'Q weights resource claims + orders', 12, { fill: C.muted });
}
function rsiFlows(svg, data, compact, id) {
  if (compact) {
    for (const [start, end, type, caption] of [[376, 420, 'human', supportReading(data)],
      [652, 696, 'power', 'Electricity → fabrication'], [928, 972, 'hardware', 'Construction → installed hardware'],
      [1204, 1248, 'hardware', 'Powered compute → research']]) {
      flow(svg, id, `M224 ${start} V${end}`, type, true);
      flowLabel(svg, 224, (start + end) / 2 + 4, caption);
    }
    flow(svg, id, 'M24 536 H10 V260 H24', 'power');
    flow(svg, id, 'M24 320 H2 V812 H24', 'human', true);
    flow(svg, id, 'M424 536 H438 V1088 H424', 'power', true);
    flow(svg, id, 'M424 1356 H446 V812 H424', 'ink', true);
    flowLabel(svg, 224, 1506, 'All facilities commit land to one shared stock');
    return;
  }
  flow(svg, id, 'M400 258 H344', 'power');
  flow(svg, id, 'M720 258 H776', 'power');
  flow(svg, id, 'M560 376 V492', 'power', true);
  flowLabel(svg, 560, 459, 'Compute electricity');
  flow(svg, id, 'M936 376 V438 H750 V590 H720', 'hardware', true);
  flowLabel(svg, 858, 457, 'Delayed construction');
  flow(svg, id, 'M720 610 H776', 'hardware');
  flow(svg, id, 'M184 376 V407 H436 V376', 'human', true);
  flowLabel(svg, 309, 430, supportReading(data));
  flow(svg, id, 'M184 407 H808 V376', 'human', true);
  flow(svg, id, 'M1096 646 H1108 V312 H1096', 'ink', true);
  flowLabel(svg, 936, 478, 'Q → resource claims + orders');
}
function footer(svg, width, y, lines) {
  line(svg, 24, y - 18, width - 24, y - 18);
  lines.forEach((content, i) => label(svg, 24, y + i * 21, content, 12, { fill: C.muted }));
}
function renderRSI(svg, run, compact, id, playing) {
  const data = rsiData(run), width = compact ? 448 : 1120;
  svg.setAttribute('viewBox', `0 0 ${width} ${compact ? 2300 : 1044}`);
  header(svg, width, 'The dependency economy', compact ? 'People, power and the physical limits of recursion.' :
    'People sustain infrastructure. Infrastructure powers compute. Compute changes the balance.', data.t, playing);
  const positions = compact ? [144, 420, 696, 1524, 972, 1248].map(y => [24, y, 400, 232]) :
    [[24, 144, 320, 232], [400, 144, 320, 232], [776, 144, 320, 232],
      [24, 492, 320, 232], [400, 492, 320, 232], [776, 492, 320, 232]];
  rsiFlows(svg, data, compact, id);
  rsiCards(svg, data, positions, id);
  queuePanel(svg, data, compact, compact ? 1790 : 758);
  const note = data.t === 0 ? 'No interval advanced · resource flows are unmeasured.' :
    `Last interval · ${format(data.stepDuration)} year · electricity in TWh/year`;
  const balance = data.t === 0 ? 'Interval electricity allocations · unmeasured (TWh/year)' :
    `Build ${format(data.ledger.construction)} · policy ${format(data.ledger.policy)} · unused ${format(data.ledger.unused)} TWh/year`;
  footer(svg, width, compact ? 2244 : 980, [note, balance, compact ?
    'Schematic · solid: flow · dotted: dependency / delay' :
    'Schematic, not to scale · solid: resource flow · dotted: dependency / delay']);
  return `Year ${format(data.t)}. Humans ${format(data.H)} million people, adequacy ${adequacyReading(data)}. ` +
    `Grid ${format(data.G)} TWh/year installed, delivered ${reading(data, data.ledger.supply, 'TWh/year')}. ` +
    `Fabrication ${format(data.F)} blocks/year installed. Power autonomy ${percent(data.aE)}; fabrication autonomy ${percent(data.aF)}. ` +
    `Hardware ${format(data.B)} blocks; powered ${reading(data, data.active, 'blocks')}. Capability ${format(data.Q)}, dimensionless. ` +
    `${format(data.queueCount)} queued projects. ${note} Arrows show dependencies, not proportional quantities.`;
}

function historyGroup(svg, position, point, key, title, color, pale, id) {
  const g = card(svg, position, { overline: key === 'N' ? 'GROUP N / REFERENCE ADULTS' : 'GROUP M / REFERENCE ADULTS', title,
    kind: 'human', color, pale, id });
  metric(g, 22, 102, point[key], 'reference adult equivalents');
  label(g, 22, 166, `Food · ${format(point[`food${key}`])} kcal/year`, 13);
  label(g, 22, 191, `Land · ${format(point[`land${key}`])} km²`, 13);
  label(g, 22, 221, `Resource adequacy · ${percent(point[`s${key}`])}`, 14, { 'font-weight': 600 });
  rail(g, 22, 239, position[2] - 44, point[`s${key}`], color);
}
function historyPool(svg, position, point, food, id) {
  const g = card(svg, position, { overline: food ? 'SHARED / DIETARY ENERGY' : 'SHARED / FINITE STOCK',
    title: food ? 'Food energy' : 'Accessible land', kind: food ? 'fab' : 'land',
    color: food ? C.coral : C.teal, pale: food ? C.coralPale : C.tealPale, id });
  const prefix = food ? 'food' : 'land', unit = food ? 'kcal/year' : 'km²';
  metric(g, 22, 102, point[`${prefix}Supply`], unit, 28);
  label(g, 22, 166, `Unused · ${format(point[`${prefix}Unused`])} ${unit}`, 13);
  label(g, 22, 195, food ? 'One annual supply, two resource claims' : 'Shared stock; no territorial map', 13, { fill: C.muted });
}
function historyFlows(svg, compact, id) {
  if (compact) {
    for (const end of [808, 1108]) {
      flow(svg, id, `M24 260 H8 V${end} H24`, 'power', true);
      flow(svg, id, `M424 532 H440 V${end} H424`, 'human', true);
    }
    flowLabel(svg, 224, 669, 'Shared food + land → both groups');
    flowLabel(svg, 224, 969, 'Same allocator · distinct needs');
    return;
  }
  for (const [d, type] of [
    ['M400 250 H368 V318 H344', 'power'], ['M720 250 H752 V318 H776', 'power'],
    ['M400 568 H368 V445 H344', 'human'], ['M720 568 H752 V445 H776', 'human'],
  ]) flow(svg, id, d, type, true);
  flowLabel(svg, 560, 411, 'Shared allocation · distinct needs');
}
function historyBalances(svg, point, compact, y) {
  const width = compact ? 400 : 1072, g = group(svg, 24, y);
  rect(g, 0, 0, width, compact ? 226 : 166, { fill: C.tealPale, 'fill-opacity': .55, stroke: C.rule });
  label(g, 20, 31, 'One resource account, two populations', compact ? 17 : 19, { 'font-weight': 600 });
  for (const [i, prefix] of ['food', 'land'].entries()) {
    const x = compact ? 20 : 20 + i * 536, top = compact ? 63 + i * 82 : 68;
    const unit = prefix === 'food' ? 'kcal/year' : 'km²';
    label(g, x, top, `${prefix === 'food' ? 'Dietary energy' : 'Accessible land'} · ${unit}`, 13, { fill: C.muted });
    label(g, x, top + 26, `N ${format(point[`${prefix}N`])} + M ${format(point[`${prefix}M`])}`, 16, { 'font-weight': 600 });
    label(g, x, top + 49, `+ unused ${format(point[`${prefix}Unused`])} = ${format(point[`${prefix}Supply`])}`, 14);
  }
}
function renderHistory(svg, run, history, compact, id, playing) {
  const point = historicalPoint(history, run), width = compact ? 448 : 1120;
  const time = first((history ?? run)?.time, point.t);
  svg.setAttribute('viewBox', `0 0 ${width} ${compact ? 1630 : 990}`);
  header(svg, width, 'A shared-resource history', compact ? 'Two populations share food energy and land.' :
    'Two populations, one food supply and one land stock. A conditional local-contact replay.', time, playing);
  if (finite(time) && finite(point.t) && time !== point.t) label(svg, 224, 121, `Snapshot · year ${format(point.t)}`, 12, { fill: C.muted });
  historyFlows(svg, compact, id);
  historyPool(svg, compact ? [24, 144, 400, 232] : [400, 144, 320, 232], point, true, id);
  historyPool(svg, compact ? [24, 416, 400, 232] : [400, 492, 320, 232], point, false, id);
  historyGroup(svg, compact ? [24, 688, 400, 260] : [24, 252, 320, 260], point, 'N', 'Neandertal', C.teal, C.tealPale, id);
  historyGroup(svg, compact ? [24, 988, 400, 260] : [776, 252, 320, 260], point, 'M', 'Modern human', C.amber, C.amberPale, id);
  historyBalances(svg, point, compact, compact ? 1280 : 758);
  footer(svg, width, compact ? 1552 : 957, ['Hypothetical local contact · reference adults, not census counts.',
    'Schematic, not to scale · food is kcal/year; land is a km² stock.']);
  return `Replay year ${format(time)} since hypothetical local contact. Resource snapshot year ${format(point.t)}. ` +
    `Neandertal ${format(point.N)} and modern human ${format(point.M)} reference adult equivalents. ` +
    `Adequacy N ${percent(point.sN)}, M ${percent(point.sM)}. Shared dietary energy ${format(point.foodSupply)} kcal/year; ` +
    `N receives ${format(point.foodN)}, M ${format(point.foodM)} kcal/year. ` +
    `Shared land ${format(point.landSupply)} km²; N receives ${format(point.landN)}, M ${format(point.landM)} km². ` +
    'Illustrative shared-resource allocation, with no spatial geography or combat.';
}

function paint(container, options, compact) {
  const id = `world-scene-${++serial}`, document = container.ownerDocument;
  const svg = node(document, 'svg', { xmlns: NS, class: `world-scene${options.playing === true ? ' is-playing' : ''}`,
    role: 'img', 'aria-labelledby': `${id}-title ${id}-desc`, preserveAspectRatio: 'xMidYMin meet',
    width: '100%', style: 'display:block;width:100%;height:auto;max-width:100%;max-height:none;min-height:0;margin:0;background:#f7f3e9' });
  add(svg, 'title', { id: `${id}-title` }, options.level === 'history' ? 'Historical shared-resource scene' : 'RSI dependency and resource-flow scene');
  const description = add(svg, 'desc', { id: `${id}-desc` });
  sceneStyle(svg); definitions(svg, id);
  // role=img exposes the title and numeric description as one accessible image.
  description.textContent = options.level === 'history' ? renderHistory(svg, options.run, options.history, compact, id, options.playing === true) :
    renderRSI(svg, options.run, compact, id, options.playing === true);
  container.replaceChildren(svg);
  return svg;
}

/** Mount a complete scene; repeated calls are safe and never change run/history. */
export function renderWorldScene(container, options = {}) {
  if (!container?.ownerDocument?.createElementNS || typeof container.replaceChildren !== 'function') return null;
  const settings = object(options), compact = container.clientWidth > 0 && container.clientWidth < 680;
  const previous = mounts.get(container);
  previous?.observer?.disconnect();
  const environment = container.ownerDocument.defaultView;
  if (previous?.frame != null) environment?.cancelAnimationFrame?.(previous.frame);
  const svg = paint(container, settings, compact);
  const Observer = environment?.ResizeObserver;
  const mount = { observer: null, frame: null };
  // Paint outside observer delivery so layout changes cannot create a resize loop.
  const observer = typeof Observer === 'function' ? new Observer(entries => {
    const width = entries[0]?.contentRect?.width;
    if (!(width > 0) || (container.clientWidth < 680) === compact || mount.frame !== null) return;
    const refresh = () => {
      if (mounts.get(container) !== mount) return;
      mount.frame = null; renderWorldScene(container, settings);
    };
    if (environment?.requestAnimationFrame) mount.frame = environment.requestAnimationFrame(refresh);
    else refresh();
  }) : null;
  mount.observer = observer;
  mounts.set(container, mount);
  observer?.observe(container);
  return svg;
}
