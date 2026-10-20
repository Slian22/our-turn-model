import {
  createRun, stepRun, summarize, saveCheckpoint, restoreCheckpoint, branchRun,
  trajectoryCSV, ENGINE_VERSION, SOURCE_DIGEST,
} from '../sim/engine.mjs';
import { PARAMETERS, parameterTable, makeConfig } from '../sim/config.mjs';
import { runHistory, summarizeHistory, ENERGY_PAIRS, HISTORY_DEFAULTS } from '../sim/history.mjs';
import { telemetryReadings, draftMatchesConfig } from './presentation.mjs';
import { renderWorldScene } from './world-scene.mjs';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const EPS = 1e-8;
const MAX_FILE = 20e6;
const number = value => Number.isFinite(value)
  ? new Intl.NumberFormat('en', { maximumSignificantDigits: 6 }).format(value) : '—';
const text = (id, value) => { $(id).textContent = value; };
const elem = (tag, content) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
};
const svgNode = (tag, attributes = {}, content) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (content !== undefined) node.textContent = content;
  return node;
};
let currentRun = createRun();
const POINT_SCHEMA = Object.fromEntries(Object.entries(currentRun.trajectory[0]).map(([key, val]) => [key, typeof val]));
let parentRun = null;
let savedCheckpoint = null;
let historyRun = null;
let historyTime = 0;
let level = 'rsi';
let playing = false;
let finishing = false;
let frame = 0;
let lastTick = 0;
let pendingYears = 0;
let tablePage = 0;
let plotSerial = 0;
let provenanceKey = '';
let activeView = 'overview';
// LUI-06: accept a delayed file read only while its requested state is current.
let loadGeneration = 0;

function selectView(view) {
  activeView = view;
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = !panel.dataset.panel.split(' ').includes(view);
  for (const button of document.querySelectorAll('[data-view]')) {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
}
function selectControl(control) {
  for (const panel of document.querySelectorAll('[data-control-panel]')) panel.hidden = panel.dataset.controlPanel !== control;
  for (const button of document.querySelectorAll('[data-control]')) {
    const selected = button.dataset.control === control;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  }
}
function renderDraftState() {
  const draft = Object.fromEntries(new FormData($('scenario-form')));
  const active = draftMatchesConfig(draft, currentRun.config);
  text('draft-state', active ? 'Active' : 'Edits pending');
  $('draft-state').classList.toggle('pending', !active);
}
function renderTelemetry() {
  const historical = level === 'history' ? historySnapshot() : null;
  const readings = telemetryReadings({ level, run: currentRun, history: historical });
  for (const [key, reading] of Object.entries(readings)) {
    text(`stat-${key}-label`, reading.label); text(`stat-${key}-note`, reading.note);
    const formatted = reading.value === null ? '—' : new Intl.NumberFormat('en', { maximumSignificantDigits: 4 }).format(reading.value);
    const node = $(`stat-${key}`); node.replaceChildren(document.createTextNode(formatted));
    if (reading.value !== null) node.append(elem('small', reading.unit));
  }
  const inadequate = readings.adequacy.value !== null && readings.adequacy.value < 99.9;
  $('stat-adequacy').parentElement.classList.toggle('constrained', inadequate);
  if (level === 'rsi') {
    const note = $('stat-population-note'), delta = currentRun.state.H - currentRun.config.H0;
    note.classList.toggle('negative', delta < -EPS); note.classList.toggle('positive', delta > EPS);
  } else $('stat-population-note').classList.remove('negative', 'positive');
  $('timeline').max = horizon(); $('timeline').value = activeTime();
  text('horizon-label', `${number(horizon())} YEARS`);
  $('play-state').classList.toggle('running', playing);
  text('outcome-pill', atEnd() ? 'Horizon reached' : 'Interim reading');
  text('scene-title', level === 'rsi' ? 'A connected world' : 'A shared ancestral landscape');
  text('plots-title', level === 'rsi' ? 'A future in motion' : 'The competition over time');
  $('history-policy-note').hidden = level !== 'history';
  renderWorldScene($('world-scene'), { level, run: currentRun, history: historical, playing });
  renderDraftState();
}

function reportError(error) {
  pause();
  text('error-text', error instanceof Error ? error.message : String(error));
  $('error').hidden = false;
  text('status', 'Action stopped. Check the error above; the last accepted run is retained.');
  text('clock', `Year ${number(activeTime())} / ${number(horizon())} · paused after error`);
}
function guarded(action) {
  return (...args) => {
    try {
      const result = action(...args);
      if (result?.catch) result.catch(reportError);
      return result;
    } catch (error) { reportError(error); }
  };
}
function clearError() { $('error').hidden = true; }
function announce(message) { clearError(); text('status', message); }
function value(id) {
  const input = $(id);
  if (!input.value.trim() || !input.checkValidity()) throw new Error(`Invalid ${input.labels?.[0]?.textContent ?? id}`);
  const result = Number(input.value);
  if (!Number.isFinite(result)) throw new Error(`A finite value is required for ${id}`);
  return result;
}
function formConfig(form) {
  return Object.fromEntries([...new FormData(form)].map(([key, val]) => [key,
    form.elements.namedItem(key).type === 'number' ? Number(val) : val]));
}
function table(id, caption, columns, rows) {
  const target = $(id);
  if (!rows.length) { target.replaceChildren(elem('p', 'None at this time.')); return; }
  const grid = elem('table');
  grid.append(elem('caption', caption));
  const head = elem('thead'), tr = elem('tr');
  for (const label of columns) { const th = elem('th', label); th.scope = 'col'; tr.append(th); }
  head.append(tr);
  const body = elem('tbody');
  for (const row of rows) {
    const line = elem('tr');
    for (const cell of row) line.append(elem('td', typeof cell === 'number' ? number(cell) : String(cell ?? '—')));
    body.append(line);
  }
  grid.append(head, body);
  target.replaceChildren(grid);
}
function metrics(entries) {
  $('summary').replaceChildren(...entries.map(([label, val]) => {
    const group = elem('div'); group.append(elem('dt', label), elem('dd', val)); return group;
  }));
}
function visibleHistory() {
  return historyRun.trajectory.filter(point => point.t <= historyTime + EPS);
}
function activeTime() { return level === 'rsi' ? currentRun.state.t : historyTime; }
function horizon() { return level === 'rsi' ? currentRun.config.horizon : historyRun.config.horizon; }
function atEnd() { return activeTime() >= horizon() - EPS; }

// Select actual points, retaining endpoints and each bucket's min/max, never average away a spike.
function displayPoints(points, key, limit = 700) {
  if (points.length <= limit) return points;
  const count = Math.floor((limit - 2) / 2), width = (points.length - 2) / count;
  const selected = [points[0]];
  for (let bucket = 0; bucket < count; bucket++) {
    const start = 1 + Math.floor(bucket * width), end = Math.min(points.length - 1, 1 + Math.floor((bucket + 1) * width));
    let lo = start, hi = start;
    for (let i = start; i < end; i++) {
      if (points[i][key] < points[lo][key]) lo = i;
      if (points[i][key] > points[hi][key]) hi = i;
    }
    for (const i of [...new Set([lo, hi])].sort((a, b) => a - b)) selected.push(points[i]);
  }
  return [...selected, points.at(-1)];
}
function linePlot(title, unit, points, key, comparison = null) {
  const width = 560, height = 245, left = 80, right = 22, top = 30, bottom = 40;
  const series = [points, comparison ?? []];
  let max = 0;
  for (const path of series) for (const p of path) if (Number.isFinite(p[key])) max = Math.max(max, p[key]);
  const ymax = max > 0 ? max * 1.08 : 1, xmax = Math.max(1, points.at(-1)?.t ?? 0, comparison?.at(-1)?.t ?? 0);
  const x = t => left + t / xmax * (width - left - right);
  const y = v => height - bottom - v / ymax * (height - top - bottom);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const titleId = `plot-${++plotSerial}`;
  svg.setAttribute('aria-labelledby', `${titleId} ${titleId}-desc`);
  svg.append(svgNode('title', { id: titleId }, `${title} (${unit})`), svgNode('desc', { id: `${titleId}-desc` },
    `Zero-based vertical axis. Current value ${number(points.at(-1)?.[key])} ${unit} at year ${number(points.at(-1)?.t)}. Solid current, dashed parent. Exact data are available in the trajectory table and CSV.`));
  for (let tick = 0; tick <= 4; tick++) {
    const val = tick / 4 * ymax;
    svg.append(svgNode('line', { x1: left, x2: width - right, y1: y(val), y2: y(val), stroke: '#dce3e7', 'stroke-width': 1 }),
      svgNode('text', { x: left - 8, y: y(val) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#344d5b' }, number(val)));
  }
  svg.append(svgNode('text', { x: left, y: 17, 'font-size': 12, fill: '#192c36' }, unit));
  for (let tick = 0; tick <= 4; tick++) {
    const t = tick / 4 * xmax;
    svg.append(svgNode('text', { x: x(t), y: height - 23, 'text-anchor': 'middle', 'font-size': 11, fill: '#344d5b' }, number(t)));
  }
  svg.append(svgNode('text', { x: (left + width - right) / 2, y: height - 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#344d5b' },
    level === 'history' ? 'Years since hypothetical local contact' : 'Scenario year'));
  series.forEach((path, index) => {
    const valid = displayPoints(path, key).filter(p => Number.isFinite(p[key]) && Number.isFinite(p.t));
    if (!valid.length) return;
    const color = index ? '#687777' : ({ H: '#187a70', B: '#b67927', Q: '#3d6482', sH: '#ba5a46', N: '#187a70', M: '#b67927', sN: '#187a70', sM: '#b67927' })[key] ?? '#187a70';
    svg.append(svgNode('path', { d: valid.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' '),
      fill: 'none', stroke: color, 'stroke-width': index ? 2 : 2.5, ...(index ? { 'stroke-dasharray': '7 5' } : {}) }));
    const last = valid.at(-1);
    svg.append(svgNode('circle', { cx: x(last.t), cy: y(last[key]), r: 3, fill: color }));
  });
  const figure = elem('figure'); figure.append(elem('figcaption', title), svg); return figure;
}
function barPlot(title, unit, rows) {
  const width = 560, height = 58 + rows.length * 30, left = 120, right = 100;
  const max = Math.max(1, ...rows.map(row => row[1]));
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const titleId = `plot-${++plotSerial}`;
  svg.setAttribute('aria-labelledby', titleId);
  svg.append(svgNode('title', { id: titleId }, `${title}, ${unit}. Bars start at zero; exact values follow in the resource table.`));
  rows.forEach(([name, amount], i) => {
    const y = 22 + i * 30;
    svg.append(svgNode('text', { x: left - 10, y: y + 13, 'text-anchor': 'end', 'font-size': 12, fill: '#192c36' }, name),
      svgNode('rect', { x: left, y, width: Math.max(0, amount / max * (width - left - right)), height: 18, rx: 3, fill: name === 'Supply' ? '#71816f' : '#187a70' }),
      svgNode('text', { x: width - right + 9, y: y + 13, 'font-size': 11, fill: '#192c36' }, number(amount)));
  });
  svg.append(svgNode('text', { x: left, y: height - 9, 'font-size': 11, fill: '#192c36' }, `0 → ${number(max)} ${unit}`));
  const figure = elem('figure'); figure.append(elem('figcaption', `${title} (${unit})`), svg); return figure;
}
function renderPlots() {
  if (level === 'rsi') {
    const points = currentRun.trajectory, parent = parentRun?.trajectory;
    $('plots').replaceChildren(
      linePlot('Human population H', 'million people', points, 'H', parent),
      linePlot('Installed hardware B', 'standard blocks', points, 'B', parent),
      linePlot('Capability Q', 'dimensionless', points, 'Q', parent),
      linePlot('Human resource adequacy', 'fraction', points, 'sH', parent));
  } else {
    const points = visibleHistory();
    $('plots').replaceChildren(
      linePlot('Neandertal population N', 'reference adult equivalents', points, 'N'),
      linePlot('Modern-human population M', 'reference adult equivalents', points, 'M'),
      linePlot('Neandertal resource adequacy', 'fraction', points, 'sN'),
      linePlot('Modern-human resource adequacy', 'fraction', points, 'sM'));
  }
}
function renderLedger() {
  const future = level === 'rsi';
  let rows;
  if (future) {
    const ledger = currentRun.state.ledger;
    const keys = ['human', 'operation', 'research', 'construction', 'industry', 'policy', 'unused'];
    rows = keys.map(key => [key[0].toUpperCase() + key.slice(1), ledger[key]]);
    const sum = rows.reduce((total, row) => total + row[1], 0);
    $('ledger-plots').replaceChildren(barPlot('Electricity allocation', 'TWh/year', [...rows, ['Supply', ledger.supply]]));
    text('ledger-note', currentRun.state.t === 0 ? 'No interval has advanced: the core initialises the flow ledger at zero.'
      : `Last integration interval (${number(currentRun.state.stepDuration)} year). Debits + unused = ${number(sum)} TWh/year; supply = ${number(ledger.supply)}. Residual = ${ledger.supply - sum} TWh/year. Operation and R&D divide one powered-compute account. Project/policy TWh costs are divided by interval length.`);
    rows = [...rows, ['Supply', ledger.supply]].map(row => [...row, 'TWh/year']);
  } else {
    const p = visibleHistory().at(-1);
    const food = [['Neandertal', p.foodN], ['Modern human', p.foodM], ['Unused', p.foodUnused], ['Supply', p.foodSupply]];
    const land = [['Neandertal', p.landN], ['Modern human', p.landM], ['Unused', p.landUnused], ['Supply', p.landSupply]];
    $('ledger-plots').replaceChildren(barPlot('Dietary food allocation', 'kcal/year', food), barPlot('Land allocation', 'km²', land));
    text('ledger-note', 'Dietary energy is kcal/year; land is a km² stock. These units are distinct from future electricity. Both levels call the same core allocator, adequacy and demographic response.');
    rows = [...food.map(row => [`Food: ${row[0]}`, row[1], 'kcal/year']), ...land.map(row => [`Land: ${row[0]}`, row[1], 'km²'])];
  }
  table('ledger-table', 'Exact resource allocations', ['Account', 'Value', 'Unit'], rows);
}
function renderSummary() {
  if (level === 'history') {
    const points = visibleHistory(), s = summarizeHistory(points);
    const passage = s.contactTo1Percent, window = s.window10to90;
    text('result-note', 'Conditional historical replay. Contact-to-1% is a share threshold, not absolute extinction; censored values remain visible.');
    metrics([['Neandertal adults', number(s.final.N)], ['Modern-human adults', number(s.final.M)],
      ['Modern-human share', number(s.final.modernFraction)],
      ['Contact → 1% N (years)', passage.censored ? `Right-censored at ${number(passage.censorTime)}` : `${number(passage.time)}${passage.leftCensored ? ' (left-censored)' : ''}`],
      ['10–90% window (years)', window.available ? number(window.duration) : `Unavailable${window.leftCensored ? ' · left-censored' : ''}${window.rightCensored ? ' · right-censored' : ''}`]]);
    $('comparison').hidden = true; return;
  }
  const s = summarize(currentRun);
  text('result-note', `${atEnd() ? 'Horizon reached.' : 'Interim classification; horizon not reached.'} ${s.definition}`);
  metrics([['Outcome', s.outcome], ['Human H (million)', number(s.finalH)], ['Minimum H (million)', number(s.minPopulation)],
    ['Mean adequacy (fraction)', number(s.meanAdequacy)], ['Shortage duration (years)', number(s.shortageYears)],
    ['Power / fabrication autonomy', `${number(currentRun.state.aE)} / ${number(currentRun.state.aF)}`]]);
  $('comparison').hidden = !parentRun;
  if (parentRun) {
    const p = summarize(parentRun);
    const paired = Math.abs(s.time - p.time) < EPS;
    const difference = (a, b) => paired ? a - b : 'different times';
    table('comparison-table', paired ? `Paired conditional results at year ${number(s.time)}`
      : `Branch year ${number(s.time)}; parent year ${number(p.time)}. Core event boundaries differ; deltas withheld.`,
    ['Metric', 'Branch', 'Parent', 'Branch − parent'],
      [['Scenario year', s.time, p.time, '—'], ['Outcome', s.outcome, p.outcome, '—'], ['Human H (million)', s.finalH, p.finalH, difference(s.finalH, p.finalH)],
        ['Minimum H (million)', s.minPopulation, p.minPopulation, difference(s.minPopulation, p.minPopulation)],
        ['Mean adequacy (fraction)', s.meanAdequacy, p.meanAdequacy, difference(s.meanAdequacy, p.meanAdequacy)],
        ['Shortage (years)', s.shortageYears, p.shortageYears, difference(s.shortageYears, p.shortageYears)],
        ['Hardware B (blocks)', s.finalB, p.finalB, difference(s.finalB, p.finalB)], ['Capability Q', s.finalQ, p.finalQ, difference(s.finalQ, p.finalQ)]]);
  }
}
function projectUnit(kind) {
  return ({ hardware: 'blocks', power: 'TWh/year', factory: 'blocks/year', powerAutomation: 'autonomy fraction', fabAutomation: 'autonomy fraction' })[kind] ?? 'unknown';
}
function renderPhysical() {
  $('physical-details').hidden = level !== 'rsi';
  if (level !== 'rsi') return;
  const s = currentRun.state;
  text('physical-status', `Powered blocks: ${number(s.active)}; shutdown: ${s.shutdown ? 'active' : 'inactive'}; residual operation: ${number(s.residual)}. Land committed/installed: ${number(s.landUsed)} km². Reserve infeasible: ${s.infeasible ? 'yes' : 'no'}.`);
  text('queue-title', `Queued projects (${s.queue.length})`);
  table('queue-table', 'Earliest pending projects', ['ID', 'Kind', 'Amount', 'Unit', 'Due year', 'Prepaid TWh', 'Land km²'],
    [...s.queue].sort((a, b) => a.due - b.due).slice(0, 100).map(p => [p.id, p.kind, p.amount, projectUnit(p.kind), p.due, p.energy, p.land]));
  table('policies-table', 'Policy schedule (all timings are absolute scenario years)', ['Index / type', 'Start', 'Delay', 'Due', 'Cost TWh', 'Assumed settings', 'Attempt'],
    currentRun.config.policies.map((p, index) => [ `${index} / ${p.type}`, p.start, p.delay, p.start + p.delay, p.cost,
      p.type === 'cap' ? `${number(p.capBlocks)} blocks; duration ${number(p.duration)} years` : `success ${number(p.success)}; residual ${number(p.residual)}`,
      s.policyLog.find(log => log.index === index)?.outcome ?? (s.t < p.start + p.delay ? 'scheduled' : 'not recorded (funding/next interval/expiry)') ]));
  table('events-table', 'Recorded intervention attempts', ['Year', 'Policy index', 'Type', 'Outcome', 'Policy-stream draw'],
    s.policyLog.map(p => [p.t, p.index, currentRun.config.policies[p.index]?.type, p.outcome, p.draw]));
  text('events-title', `All engine events (${s.events.length})`);
  if ($('events-title').parentElement.open) renderAllEvents();
}
function renderAllEvents() {
  table('all-events', 'Latest engine events', ['Year', 'Event details'], currentRun.state.events.slice(-100).reverse().map(p => [p.t, JSON.stringify(p)]));
}
function renderData() {
  const points = level === 'rsi' ? currentRun.trajectory : visibleHistory();
  tablePage = Math.max(0, Math.min(tablePage, Math.ceil(points.length / 50) - 1));
  const first = tablePage * 50, columns = Object.keys(points[0]);
  text('data-page', `Rows ${first + 1}–${Math.min(first + 50, points.length)} of ${points.length}. Column units are in provenance and plot labels. RSI resources: TWh/year; H: million; B: blocks; Q: dimensionless. Historical N/M: reference adults; food: kcal/year; land: km².`);
  table('data-table', 'Recorded trajectory; exact numeric values in CSV', columns, points.slice(first, first + 50).map(p => columns.map(k => p[k])));
  $('data-prev').disabled = tablePage === 0;
  $('data-next').disabled = first + 50 >= points.length;
}
function renderProvenance() {
  const key = level === 'rsi' ? currentRun.configId : `history:${JSON.stringify(historyRun.config)}`;
  if (key === provenanceKey) return;
  provenanceKey = key;
  const digest = level === 'rsi' ? currentRun.sourceDigest : SOURCE_DIGEST;
  text('version', `Engine ${ENGINE_VERSION} · source SHA256: ${digest}${digest === 'development' ? ' (development marker; source hash not pinned yet)' : ''}${level === 'history' ? ` · history engine ${historyRun.summary.engine}` : ''}`);
  text('assumptions', level === 'rsi'
    ? 'H is million people. One standard hardware block is a fixed 1 MW facility-load equivalent (0.00876 TWh/year at rated full load), not an RSI agent. Q is dimensionless. Essential electricity, land, demographic response, recursive gain, autonomy, shocks and policy effectiveness are scenario assumptions. Alignment is a reserve rule, not an empirically calibrated safety probability. No ensemble probability is inferred here.'
    : historyRun.summary.assumptions.join(' '));
  const c = level === 'rsi' ? currentRun.config : historyRun.config;
  text('config-json', JSON.stringify(c, null, 2));
  if (level === 'rsi') {
    table('provenance-table', 'Complete numeric configuration from shared PARAMETERS metadata', ['Parameter', 'Value', 'Unit', 'Allowed range', 'Classification', 'Provenance / rationale'],
      parameterTable(c).map(p => [p.name, p.value, p.unit, p.range.join('…'), p.classification, p.rationale]));
  } else {
    const units = { horizon: 'year', dt: 'year', outputEvery: 'year', initialTotal: 'reference adult equivalents', initialModernFraction: 'fraction',
      foodAccess: 'dimensionless multiplier', areaKm2: 'km²', landPerAdultKm2: 'km²/adult equivalent', rates: '1/year', energyPair: 'kcal/adult/day pair' };
    table('provenance-table', 'Historical configuration; scenario assumptions unless stated', ['Parameter', 'Value', 'Unit / classification', 'Provenance'],
      Object.entries(c).map(([name, v]) => [name, typeof v === 'object' ? JSON.stringify(v) : v, units[name] ?? 'dimensionless claim weight',
        name === 'energyPair' ? ENERGY_PAIRS.find(pair => pair.id === v)?.source : 'HISTORY_DEFAULTS / explicit scenario assumption; no fitted demographic law']));
  }
}
function policyTiming() {
  try {
    const start = value('policy-start'), delay = value('policy-delay');
    text('policy-timing', `Earliest implementation: year ${number(start + delay)}. Requires funding and an integration interval; success chance is an assumed scenario input.`);
  } catch { text('policy-timing', 'Enter a finite start and an explicit nonnegative delay.'); }
}
function render() {
  const future = level === 'rsi';
  $('rsi-settings').hidden = !future;
  $('history-settings').hidden = future;
  $('policy-settings').hidden = !future;
  for (const id of ['save-checkpoint', 'download-checkpoint', 'restore-file']) $(id).disabled = !future;
  for (const id of ['step', 'play', 'finish']) $(id).disabled = atEnd() || playing;
  $('pause').disabled = !playing;
  text('clock', `Year ${number(activeTime())} / ${number(horizon())}${playing ? finishing ? ' · running to horizon' : ' · playing' : ' · paused'}`);
  text('run-meta', future ? `Config ${currentRun.configId} · seed ${currentRun.config.seed} · dt ${currentRun.config.dt} year${currentRun.branchOf ? ` · branch of ${currentRun.branchOf.configId} at year ${currentRun.branchOf.t}` : ''}`
    : `Historical shared-resource run · pair ${historyRun.config.energyPair} · dt ${historyRun.config.dt} year · no future RSI policy`);
  text('interval-note', `Current scenario interval: ${currentRun.config.dt} year. Shared-core default: ${PARAMETERS.dt.value} year. Other inputs use shared-core defaults; see the complete provenance table.`);
  renderSummary(); renderPlots(); renderLedger(); renderPhysical(); renderProvenance(); renderTelemetry();
  if ($('data-details').open) renderData();
}

function advanceTo(run, target, deadline = Infinity) {
  let result = run;
  while (result.state.t < Math.min(target, result.config.horizon) - EPS) {
    if (performance.now() >= deadline) break;
    const next = stepRun(result);
    if (next.state.t <= result.state.t) throw new Error('Shared core did not advance time.');
    result = next;
  }
  return result;
}
function advance(years, deadline = Infinity) {
  if (level === 'history') { historyTime = Math.min(historyRun.config.horizon, historyTime + years); loadGeneration++; return; }
  const next = advanceTo(currentRun, currentRun.state.t + years, deadline);
  // Commit the pair together: a failed parent never produces a mismatched comparison.
  const parent = parentRun ? advanceTo(parentRun, next.state.t) : null;
  loadGeneration++; currentRun = next; parentRun = parent;
}
function pause() {
  playing = false; finishing = false; cancelAnimationFrame(frame); frame = 0; pendingYears = 0;
  $('play-state').classList.remove('running');
  for (const path of $('world-scene').querySelectorAll('.flow-active')) path.classList.remove('flow-active');
  $('world-scene').querySelector('.is-playing')?.classList.remove('is-playing');
  $('pause').disabled = true;
  for (const id of ['step', 'play', 'finish']) $(id).disabled = level === 'history' && !historyRun ? true : atEnd();
}
function tick(now) {
  if (!playing) return;
  try {
    const speed = Number($('speed').value);
    pendingYears += Math.min((now - lastTick) / 1000, .25) * speed;
    lastTick = now;
    if (finishing || pendingYears >= 1) {
      const before = activeTime();
      advance(finishing ? horizon() - before : Math.floor(pendingYears), performance.now() + 30);
      pendingYears = Math.max(0, pendingYears - (activeTime() - before));
      if (atEnd()) { pause(); announce('Horizon reached. Conditional results and exports are ready.'); }
      render();
    }
    if (playing) frame = requestAnimationFrame(tick);
  } catch (error) { reportError(error); render(); }
}
function play(toEnd = false) {
  if (playing || atEnd()) return;
  clearError(); playing = true; finishing = toEnd; lastTick = performance.now(); pendingYears = 0;
  render(); frame = requestAnimationFrame(tick);
}
function syncScenarioForm() {
  for (const [key, val] of Object.entries(currentRun.config)) {
    const input = $('scenario-form').elements.namedItem(key);
    if (input) input.value = val;
  }
  $('policy-start').value = Math.min(currentRun.config.horizon, currentRun.state.t + 1);
  $('policy-duration').value = currentRun.config.horizon + 1;
  policyTiming();
}
function newScenario(overrides) {
  const next = createRun(makeConfig(overrides));
  pause(); loadGeneration++; currentRun = next; parentRun = null; level = 'rsi'; $('level').value = level; tablePage = 0;
  syncScenarioForm(); announce('New RSI scenario created from the shared core.'); render(); return currentRun;
}
function newHistory(config = {}) {
  const next = runHistory({ ...config, dt: 1, outputEvery: 1 });
  pause(); loadGeneration++; historyRun = next; historyTime = 0; level = 'history'; $('level').value = level; tablePage = 0;
  announce('Historical trajectory computed by the shared core; replay starts at local contact.'); render(); return historyRun;
}
function setRun(run) {
  const next = validatedRun(saveCheckpoint(run));
  pause(); loadGeneration++; currentRun = next; parentRun = null; level = 'rsi'; $('level').value = level; tablePage = 0;
  syncScenarioForm(); announce('RSI run accepted through checkpoint validation.'); render(); return currentRun;
}
function validatedRun(serialized) {
  const next = restoreCheckpoint(serialized);
  for (const key of ['supply', 'human', 'operation', 'research', 'construction', 'industry', 'policy', 'unused']) {
    if (!Number.isFinite(next.state.ledger?.[key]) || next.state.ledger[key] < 0) throw new Error(`Checkpoint has an invalid ${key} ledger entry.`);
  }
  for (const point of next.trajectory) {
    if (Object.keys(point).some(key => !Object.hasOwn(POINT_SCHEMA, key))) throw new Error('Checkpoint trajectory contains an unknown column.');
    for (const [key, type] of Object.entries(POINT_SCHEMA)) {
      if (typeof point[key] !== type || (type === 'number' && !Number.isFinite(point[key]))) {
        throw new Error(`Checkpoint trajectory has an invalid ${key} value.`);
      }
    }
  }
  return next;
}
function saveInTab() {
  savedCheckpoint = saveCheckpoint(currentRun);
  const option = $('branch-source').options[1]; option.disabled = false; option.textContent = 'Saved checkpoint';
  text('saved-info', `Saved config ${currentRun.configId} at year ${number(currentRun.state.t)} (${number(savedCheckpoint.length)} characters).`);
  return savedCheckpoint;
}
function restoreText(serialized) {
  const next = validatedRun(serialized);
  setRun(next); saveInTab(); announce('Full checkpoint restored; also available as the saved branch source.'); return currentRun;
}
function applyPolicy(policy, source = 'current') {
  if (source !== 'current' && source !== 'saved') throw new Error('Unknown branch source.');
  if (source === 'saved' && !savedCheckpoint) throw new Error('Save or restore a checkpoint first.');
  const base = source === 'saved' ? restoreCheckpoint(savedCheckpoint) : currentRun;
  if (base.state.t >= base.config.horizon - EPS) throw new Error('This checkpoint is at its horizon; select an earlier saved checkpoint.');
  if (policy.start + policy.delay >= base.config.horizon - EPS) throw new Error('Implementation must occur before the scenario horizon.');
  const next = branchRun(base, policy);
  pause(); loadGeneration++; parentRun = structuredClone(base); currentRun = next; level = 'rsi'; $('level').value = level; tablePage = 0;
  syncScenarioForm(); announce(`Branched from year ${number(base.state.t)}; parent comparison is retained.`); render(); return currentRun;
}
function policyFromForm() {
  const type = $('policy-type').value;
  const common = { type, start: value('policy-start'), delay: value('policy-delay'), cost: value('policy-cost') };
  return type === 'cap' ? { ...common, capBlocks: value('policy-cap'), duration: value('policy-duration') }
    : { ...common, success: value('policy-success'), residual: value('policy-residual') };
}
function updatePolicyType() {
  const cap = $('policy-type').value === 'cap';
  $('cap-fields').hidden = !cap; $('shutdown-fields').hidden = cap;
  for (const id of ['policy-cap', 'policy-duration']) $(id).disabled = !cap;
  for (const id of ['policy-success', 'policy-residual']) $(id).disabled = cap;
}
function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = elem('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function historySnapshot() {
  const trajectory = visibleHistory();
  return { schema: 'our-turn.history-view.v1', engineVersion: ENGINE_VERSION, sourceDigest: SOURCE_DIGEST,
    config: historyRun.config, time: historyTime, trajectory,
    summary: { ...historyRun.summary, ...summarizeHistory(trajectory) }, conditional: true };
}
function csvText() {
  if (level === 'rsi') return trajectoryCSV(currentRun);
  const points = visibleHistory(), keys = Object.keys(points[0]);
  return `${keys.join(',')}\n${points.map(p => keys.map(k => p[k] ?? '').join(',')).join('\n')}\n`;
}
function svgText() {
  const figures = [...$('plots').querySelectorAll('figure'), ...$('ledger-plots').querySelectorAll('figure')];
  const totalHeight = figures.reduce((sum, fig) => sum + Number(fig.querySelector('svg').viewBox.baseVal.height) + 45, 110);
  const root = svgNode('svg', { xmlns: NS, viewBox: `0 0 720 ${totalHeight}`, width: 720, height: totalHeight, role: 'img' });
  root.append(svgNode('title', {}, 'M10 conditional scenario plots'), svgNode('rect', { width: 720, height: totalHeight, fill: 'white' }));
  root.append(svgNode('text', { x: 20, y: 25, 'font-size': 17 }, `Conditional ${level === 'rsi' ? 'RSI' : 'historical'} results · year ${number(activeTime())}`),
    svgNode('text', { x: 20, y: 47, 'font-size': 12 }, `Engine ${ENGINE_VERSION} · ${level === 'rsi' ? `config ${currentRun.configId} · seed ${currentRun.config.seed}` : historyRun.config.energyPair}`),
    svgNode('text', { x: 20, y: 66, 'font-size': 10 }, `Source: ${SOURCE_DIGEST}`),
    svgNode('text', { x: 20, y: 85, 'font-size': 12 }, 'Scenario assumptions; not a forecast. Solid: current. Dashed: parent. Zero-based axes.'));
  let offset = 110;
  for (const figure of figures) {
    root.append(svgNode('text', { x: 20, y: offset + 12, 'font-size': 14 }, figure.querySelector('figcaption').textContent));
    const plot = figure.querySelector('svg').cloneNode(true), height = Number(plot.viewBox.baseVal.height);
    plot.setAttribute('x', '20'); plot.setAttribute('y', String(offset + 22)); plot.setAttribute('width', '680'); plot.setAttribute('height', String(height));
    root.append(plot); offset += height + 45;
  }
  return new XMLSerializer().serializeToString(root);
}
function exportFile(kind) {
  const stem = `m10-${level}-${level === 'rsi' ? currentRun.configId : historyRun.config.energyPair}-year-${activeTime().toFixed(3)}`;
  if (kind === 'csv') download(csvText(), `${stem}.csv`, 'text/csv;charset=utf-8');
  if (kind === 'json') download(level === 'rsi' ? saveCheckpoint(currentRun) : JSON.stringify(historySnapshot(), null, 2), `${stem}.json`, 'application/json');
  if (kind === 'svg') download(svgText(), `${stem}.svg`, 'image/svg+xml');
  announce(`${kind.toUpperCase()} export prepared at year ${number(activeTime())}.`);
}

// Parent QA surface: every mutating entry point refreshes the actual interface.
window.alphaConsole = {
  getRun: () => currentRun, setRun, createScenario: newScenario,
  stepYear: () => { pause(); advance(1); render(); return level === 'rsi' ? currentRun : historySnapshot(); },
  play: () => play(), pause: () => { pause(); render(); },
  runToHorizon: () => play(true), applyPolicy,
  saveCheckpoint: () => saveInTab(), restoreCheckpoint: restoreText,
  getSavedCheckpoint: () => savedCheckpoint, getParentRun: () => parentRun,
  getHistory: () => historyRun ? historySnapshot() : null, createHistory: newHistory,
  getLevel: () => level, getCSV: csvText, getSVG: svgText, exportFile,
  selectView, selectControl, getView: () => activeView, ENGINE_VERSION, SOURCE_DIGEST,
};

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => selectView(button.dataset.view));
for (const button of document.querySelectorAll('[data-control]')) button.addEventListener('click', () => selectControl(button.dataset.control));
$('scenario-form').addEventListener('input', renderDraftState);
$('scenario-form').addEventListener('change', renderDraftState);
$('world-scene').addEventListener('click', event => {
  const inspect = event.target.closest('[data-inspect-view]');
  if (inspect) selectView(inspect.dataset.inspectView);
});

$('scenario-form').addEventListener('submit', guarded(event => {
  event.preventDefault(); newScenario(formConfig(event.currentTarget));
}));
$('history-form').addEventListener('submit', guarded(event => {
  event.preventDefault(); newHistory(formConfig(event.currentTarget));
}));
$('policy-form').addEventListener('submit', guarded(event => {
  event.preventDefault(); applyPolicy(policyFromForm(), $('branch-source').value);
}));
$('level').addEventListener('change', guarded(() => {
  pause();
  if ($('level').value === 'history' && !historyRun) newHistory();
  else { level = $('level').value; tablePage = 0; announce(`${level === 'rsi' ? 'RSI' : 'Historical'} view selected.`); render(); }
}));
$('step').addEventListener('click', guarded(() => { pause(); advance(1); announce('Advanced through shared core intervals to the next one-year target.'); render(); }));
$('play').addEventListener('click', guarded(() => play()));
$('pause').addEventListener('click', () => { pause(); announce('Paused.'); render(); });
$('finish').addEventListener('click', guarded(() => play(true)));
$('clear-comparison').addEventListener('click', () => { parentRun = null; render(); });
$('policy-type').addEventListener('change', updatePolicyType);
for (const id of ['policy-start', 'policy-delay']) $(id).addEventListener('input', policyTiming);
$('branch-source').addEventListener('change', guarded(() => {
  const source = $('branch-source').value === 'saved' ? restoreCheckpoint(savedCheckpoint) : currentRun;
  $('policy-start').value = Math.min(source.config.horizon, source.state.t + 1); policyTiming();
}));
$('save-checkpoint').addEventListener('click', guarded(() => { saveInTab(); announce('Full checkpoint saved in this tab.'); }));
$('download-checkpoint').addEventListener('click', guarded(() => {
  download(saveInTab(), `m10-checkpoint-${currentRun.configId}-${currentRun.state.t.toFixed(3)}.json`, 'application/json');
  announce('Full checkpoint saved in this tab and prepared for download.');
}));
$('restore-file').addEventListener('change', guarded(async event => {
  const file = event.target.files[0]; if (!file) return;
  const generation = ++loadGeneration;
  pause(); render();
  try {
    if (file.size > MAX_FILE) throw new Error('Checkpoint exceeds the core limit of 20 MB.');
    const serialized = await file.text();
    if (generation === loadGeneration) restoreText(serialized);
  } catch (error) {
    if (generation === loadGeneration) throw error;
  } finally { event.target.value = ''; }
}));
for (const kind of ['csv', 'json', 'svg']) $(`export-${kind}`).addEventListener('click', guarded(() => exportFile(kind)));
$('dismiss-error').addEventListener('click', clearError);
$('data-details').addEventListener('toggle', guarded(() => { if ($('data-details').open) renderData(); }));
$('events-title').parentElement.addEventListener('toggle', guarded(() => { if ($('events-title').parentElement.open) renderAllEvents(); }));
$('data-prev').addEventListener('click', guarded(() => { tablePage--; renderData(); }));
$('data-next').addEventListener('click', guarded(() => { tablePage++; renderData(); }));
window.addEventListener('error', event => reportError(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => reportError(event.reason));
for (const pair of ENERGY_PAIRS) {
  const option = elem('option', `${pair.id} · N ${pair.N} / M ${pair.M} kcal/adult/day`); option.value = pair.id; $('energy-pair').append(option);
}
$('energy-pair').value = HISTORY_DEFAULTS.energyPair;
for (const input of $('scenario-form').querySelectorAll('input[type="number"]')) {
  const meta = PARAMETERS[input.name]; input.min = meta.range[0]; input.max = meta.range[1];
}
for (const id of ['scenario-fields', 'history-fields', 'policy-fields']) $(id).disabled = false;
for (const id of ['export-csv', 'export-json', 'export-svg']) $(id).disabled = false;
text('footer-version', ENGINE_VERSION);
syncScenarioForm(); updatePolicyType(); selectView('overview'); render(); announce('Ready. Advance one year, watch the system, then explore an intervention branch.');
