/** Local review UI. All dynamics and checkpoint validation belong to the v2 kernel. */
import * as engine from '../revised/engine.mjs';
import {inspectAssets} from '../revised/assets.mjs';
import {INFRA_DEFAULTS} from '../revised/infrastructure-config.mjs';
import {wideOutputRow,wideInputRow,wideCSV} from '../revised/wide-output.mjs';
import {ledgerRows} from './revised-ledger.mjs';

const $ = id => document.getElementById(id);
const MAXFILE = engine.CONSOLE_BYTES;
const CONSOLE_SCHEMA = 'our-turn-review/2';
const number = new Intl.NumberFormat('en-GB', {maximumFractionDigits:3});
let run = null, parent = null, playing = false, busy = false, timer = null;
let message = 'Ready. All results are conditional on the active scenario.';

function display(value, digits = 3) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (!Number.isFinite(value)) return String(value);
  if (value !== 0 && (Math.abs(value) >= 1e8 || Math.abs(value) < 0.001)) return value.toExponential(2);
  return digits === 3 ? number.format(value) : value.toLocaleString('en-GB', {maximumFractionDigits:digits});
}
const percent = value => Number.isFinite(value) ? `${display(value * 100, 2)}%` : '—';
const json = value => JSON.stringify(value ?? null, null, 2);
function preview(value, depth = 0) {
  if (depth > 8) return '[Deeper state is retained in the JSON checkpoint]';
  if (Array.isArray(value)) return value.length > 100
    ? [`[Latest 100 of ${value.length}; full state in JSON checkpoint]`,...value.slice(-100).map(item => preview(item,depth+1))]
    : value.map(item => preview(item,depth+1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,preview(item,depth+1)]));
  return value;
}
const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
const text = (id, value) => { $(id).textContent = value; };
function node(tag, content, className) {
  const result = document.createElement(tag);
  if (content !== undefined) result.textContent = content;
  if (className) result.className = className;
  return result;
}
function showError(error) {
  $('error').hidden = false;
  text('error', `${error.message || error}. The active scenario has been retained.`);
  text('status', 'Action rejected. Review the error and try again.');
}
function clearError() { $('error').hidden = true; text('error', ''); }
function field(form, name) { return form.elements.namedItem(name); }
function numeric(form, name) {
  const input = field(form, name), value = Number(input.value);
  if (input.value.trim() === '' || !Number.isFinite(value)) throw new Error(`${label(name)} must be a finite number`);
  return value;
}
function numericFields(form, names) {
  return Object.fromEntries(names.map(name => [name, numeric(form, name)]));
}

function eventOptions(form) {
  const scenario = field(form, 'eventScenario').value;
  if (scenario === 'annual') return {eventMode:'annual', events:[]};
  if (scenario === 'off') return {eventMode:'off', events:[]};
  if (scenario === 'custom') return {eventMode:run.config.eventMode, events:run.config.events};
  const events = [], time = numeric(form, 'eventTime');
  if (['efficiency','both'].includes(scenario)) events.push({id:'review-efficiency', type:'algorithm', time,
    magnitude:numeric(form, 'eventMagnitude'), observationDelay:1, adoptionEnergy:5, adoptionWork:1, adoptionDelay:1});
  if (['coverage','both'].includes(scenario)) events.push({id:'review-coverage', type:'coverage', time,
    magnitude:0.5, duration:5, observationDelay:1});
  return {eventMode:'off', events};
}
// [TH-INPUTS] Preserve unedited calibrated/optional fields when using the short
// form. The kernel's strict configuration validator remains the single schema.
function mergeOverrides(base, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Configuration overrides must be a JSON object');
  return Object.fromEntries([...new Set([...Object.keys(base),...Object.keys(overrides)])].map(key => {
    const value = Object.hasOwn(overrides,key) ? overrides[key] : base[key];
    return [key,Object.hasOwn(overrides,key) && value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? mergeOverrides(base[key],value) : value];
  }));
}
function scenarioOptions() {
  const form = $('scenario-form');
  const controls = {...numericFields(form, ['alignment','horizon','dt','seed']),
    aiEnabled:field(form, 'aiEnabled').value === 'true', planner:field(form, 'planner').value,
    human:{...run.config.human,...numericFields(form,['memEnergy','qolMaximum','qolScale'])},
    priority:{...numericFields(form,['processingReference','humanUsageReference','aiWeight','humanWeight','lambda','sharpness','hysteresis']),
      mode:field(form,'priorityMode').value,operatingMode:field(form,'operatingMode').value,tieBreak:field(form,'tieBreak').value},
    ...eventOptions(form)};
  return mergeOverrides(mergeOverrides(run.config,controls),JSON.parse($('scenario-overrides').value || '{}'));
}
function policyOptions() {
  const form = $('policy-form');
  const mode=field(form,'mode').value,type=field(form,'type').value;
  if(mode==='none')return {mode};
  const names=['start','delay','duration','cost','work','coverage','observationDelay',
    ...(type==='cap'?['cap']:['success','residual']),
    ...(mode==='fixed'?[]:['deficitThreshold','exposureThreshold','falseSignal']),
    ...(mode==='anticipatory'?['lookahead']:[])];
  return {...numericFields(form,names),mode,type,
    authorized:field(form, 'authorized').value === 'true'};
}
function draftTiming() {
  const form = $('policy-form'), start = Number(field(form,'start').value), delay = Number(field(form,'delay').value);
  const fixed = field(form,'mode').value === 'fixed', expiry = start + Number(field(form,'duration').value);
  text('policy-preview', fixed ? `Eligibility: year ${display(start + delay)}. Expiry: year ${display(expiry)}. Activation requires paid deployment before expiry.`
    : 'Online triggers use delayed observations. Actual eligibility and deployment appear in the receipts.');
  $('cap-fields').hidden = field(form,'type').value !== 'cap';
  $('shutdown-fields').hidden = field(form,'type').value !== 'shutdown';
  const mode=field(form,'mode').value,type=field(form,'type').value;
  for(const input of form.elements){
    if(!input.name||input.name==='mode')continue;
    input.disabled=mode==='none'||(input.name==='cap'&&type!=='cap')
      ||(['success','residual'].includes(input.name)&&type!=='shutdown')
      ||(['deficitThreshold','exposureThreshold','falseSignal'].includes(input.name)&&mode==='fixed')
      ||(input.name==='lookahead'&&mode!=='anticipatory');
  }
}
function eventNote() {
  const scenario = field($('scenario-form'),'eventScenario').value;
  $('event-fields').hidden = !['efficiency','coverage','both'].includes(scenario);
  field($('scenario-form'),'eventTime').disabled=!['efficiency','coverage','both'].includes(scenario);
  field($('scenario-form'),'eventMagnitude').disabled=!['efficiency','both'].includes(scenario);
  const descriptions = {off:'No exogenous discoveries or policy-environment shifts.',
    annual:`Annual events use the declared seeded stream. Scenario probability per year: ${display(run.config.annualProbability)}; magnitude: ${display(run.config.eventMagnitude)}.`,
    efficiency:'Preset: observation delay 1 year; adoption costs 5 TWh and 1 work unit, with a 1-year lead time.',
    coverage:'Preset: coverage is multiplied by 0.5 for 5 years; observation delay 1 year. Alignment is unchanged.',
    both:'Presets: efficiency adoption costs 5 TWh and 1 work unit with a 1-year lead; coverage ×0.5 for 5 years. Both have a 1-year observation delay.',
    custom:'The complete loaded event schedule is preserved. Edit it through advanced JSON or load another configuration.'};
  text('event-note',descriptions[scenario]);
}
function syncForms() {
  const form = $('scenario-form'), config = run.config;
  for (const name of ['alignment','horizon','dt','seed','aiEnabled','planner']) {
    if (config[name] !== undefined) field(form,name).value = String(config[name]);
  }
  for (const name of ['memEnergy','qolMaximum','qolScale']) field(form,name).value=String(config.human[name]);
  for (const name of ['processingReference','humanUsageReference','aiWeight','humanWeight','tieBreak','operatingMode','lambda','sharpness','hysteresis'])
    field(form,name).value=String(config.priority[name]);
  field(form,'priorityMode').value=config.priority.mode;
  $('scenario-overrides').value='{}';
  const types = (config.events || []).map(event => event.type);
  const custom=config.events?.some(event=>!['review-efficiency','review-coverage'].includes(event.id));
  field(form,'eventScenario').value = custom ? 'custom' : config.eventMode === 'annual' ? 'annual' : types.includes('algorithm') && types.includes('coverage')
    ? 'both' : types.includes('algorithm') ? 'efficiency' : types.includes('coverage') ? 'coverage' : 'off';
  if (config.events?.length) field(form,'eventTime').value = config.events[0].time;
  const algorithm = config.events?.find(event => event.type === 'algorithm');
  if (algorithm) field(form,'eventMagnitude').value = algorithm.magnitude;
  // Even known preset IDs may carry a custom duration, delay or adoption cost.
  // Preserve the entire schedule if it differs from the generated preset.
  if(config.events?.length&&field(form,'eventScenario').value!=='custom'
    &&json(eventOptions(form).events)!==json(config.events))field(form,'eventScenario').value='custom';
  const policy = run.config.policy || {};
  for (const [name,value] of Object.entries(policy)) {
    const input = field($('policy-form'),name);
    if (input && ['string','number','boolean'].includes(typeof value)) input.value = String(value);
  }
  eventNote(); draftTiming();
}

function table(id, rows, columns, caption = '') {
  const container = $(id);
  if (!rows.length) { container.replaceChildren(node('p', 'No records at this time.', 'empty')); return; }
  const result = node('table');
  if (caption) result.append(node('caption', caption));
  const heading = node('tr');
  for (const column of columns) {
    const cell = node('th', column.title || label(column.key)); cell.scope = 'col'; heading.append(cell);
  }
  const head = node('thead'); head.append(heading); result.append(head);
  const body = node('tbody');
  for (const row of rows) {
    const tr = node('tr');
    for (const column of columns) {
      const value = column.value ? column.value(row) : row[column.key];
      const cell = node('td', display(value), typeof value === 'number' ? 'number' : '');
      if (typeof value === 'object' && value !== null) cell.title = json(value);
      tr.append(cell);
    }
    body.append(tr);
  }
  result.append(body); container.replaceChildren(result);
}
function records(value) {
  if (Array.isArray(value)) return value.map(item => item && typeof item === 'object' ? item : {value:item});
  if (value && typeof value === 'object') return Object.entries(value).map(([key,item]) => ({account:label(key), value:item}));
  return [];
}
function recordTable(id, rows, preferred = [], caption = '') {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const ordered = [...preferred.filter(key => keys.includes(key)), ...keys.filter(key => !preferred.includes(key))].slice(0,12);
  table(id, rows, ordered.map(key => ({key})), caption);
}
function compact(id, values) {
  const fragment = document.createDocumentFragment();
  for (const [title, value] of values) {
    const entry = node('div'), dl = node('dl');
    dl.append(node('dt',title),node('dd',display(value))); entry.append(dl); fragment.append(entry);
  }
  $(id).replaceChildren(fragment);
}
function metrics(summary) {
  const values = [
    ['H','Population',display(summary.H),'million people · current'],
    ['qualityOfLife','Quality of life',display(summary.qualityOfLife),'HDI-like scenario curve · delivered electricity'],
    ['q','Relative capability',display(summary.q),'index · initial capability = 1'],
    ['qolPersonYears','QoL-weighted life',display(summary.qolPersonYears),'million QoL-person-years · cumulative'],
    ['criticalAdequacy','Critical adequacy',percent(summary.criticalAdequacy),'minimum of critical energy & land adequacy'],
    ['exposure','Deficit exposure',percent(summary.exposure),'lagged deficit signal · not deaths'],
    ['effectiveCompute','Effective processing',display(summary.effectiveCompute),'delivered useful processing blocks'],
    ['perCapitaElectricity','Human electricity',display(summary.perCapitaElectricity),'kWh per person per year · latest interval']
  ];
  $('metrics').replaceChildren(...values.map(([key,title,value,note]) => {
    const card = node('div',undefined,'metric'), reading = node('strong',value,'metric-value');
    reading.dataset.metric = key;
    card.append(node('span',title,'metric-label'),reading,node('span',note,'metric-note')); return card;
  }));
  compact('resource-metrics', [
    ['Power · TWh/year',summary.power],['Hardware · 1 MW blocks',summary.hardware],
    ['Factory work · block-equivalent/year',summary.factoryWork],['Land used · km²',summary.landUsed],
    ['Material stock · hypothetical units',summary.materialStock],['Gross additional deaths · million',summary.extraDeaths],
    ['Shortage · million person-years',summary.shortagePersonYears],['Lived · million person-years',summary.personYears],
    ['Minimum population · million',summary.minPopulation],['Minimum critical adequacy',summary.minAdequacy]
  ]);
}

// [TH-V1] Display the kernel's unit-preserving vector without re-deriving it in
// the browser. Nested resource/owner accounts remain separately inspectable.
function outputRows(value,path='',unit=''){
  if(value===null||typeof value!=='object')return [{account:path,value,unit}];
  const nextUnit=value.unit??unit;
  return Object.entries(value).filter(([key])=>!['unit','definition','accounting','serviceLandDefinition'].includes(key))
    .flatMap(([key,item])=>outputRows(item,[path,label(key)].filter(Boolean).join(' / '),nextUnit));
}
function renderOutcomes(summary){
  const groups=summary.outputVectorV1?.groups??[];
  const titles={humanPopulation:'Human Population',starvationEventCount:'Starvation / service-shortfall episodes',
    endPopulation:'End Population',qualityOfLife:'Quality of Life',endQualityOfLife:'End Quality of Life',
    effectiveCompute:'AI Processing',endAiLand:'End AI Land',endHumanLand:'End Human Land',endWorldResources:'End World Resources'};
  table('output-vector',groups.map(group=>({group:group.index,metric:titles[group.name]??label(group.name),
    value:group.value,unit:group.unit??'Separate accounts; see breakdown'})),
    [{key:'group',title:'V1 group'},{key:'metric'},{key:'value'},{key:'unit'}]);
  table('world-resource-table',groups.filter(group=>group.index>=7).flatMap(group=>
    outputRows(group.value,titles[group.name]??label(group.name),group.unit)),
    [{key:'account'},{key:'value'},{key:'unit'}]);
  const priority=summary.priority??{};
  compact('priority-metrics',[['Allocation mode',run.config.priority.mode],['AI score',priority.aiScore],
    ['Human score',priority.humanScore],['Priority winner',priority.winner],
    ['AI processing reference',run.config.priority.processingReference],
    ['Human electricity reference · TWh/year',run.config.priority.humanUsageReference]]);
  // [DOM-MARGINAL] Requested share, delivered share and held lead are distinct.
  const wide=wideOutputRow(run,{runId:`console-${run.configId}`,reportedOutcome:summary.outcome});
  compact('competition-metrics',[
    ['Operating rule',run.config.priority.operatingMode],['Held lead',run.state.competitionLead],
    ['Realized AI share · time mean',wide.pri_ai_share_mean===null?null:percent(wide.pri_ai_share_mean)],
    ['Nominal AI share · time mean',wide.pri_ai_share_nominal_mean===null?null:percent(wide.pri_ai_share_nominal_mean)],
    ['First AI majority · year',wide.pri_takeover_t],['Lead flips',wide.pri_flip_count],
    ['AI lead · years',wide.pri_ai_years],['Human reserve equality · years',wide.pri_floor_years],
    ['Priority chatter screen',wide.flag_priority_chatter]]);
}

function history(current) {
  if (!current) return [];
  const rows = (current.state.history || []).map(row => ({...row,t:row.t ?? row.time}));
  if (!rows.length || rows.at(-1).t !== current.state.t) rows.push({t:current.state.t,H:current.state.H,q:current.state.q,exposure:current.state.exposure});
  return rows;
}
/** Retain endpoints and local extrema in time order; bound SVG work at any horizon. */
function chartSamples(rows, key, buckets = 100) {
  const valid = rows.filter(row => Number.isFinite(row.t) && Number.isFinite(row[key]));
  if (valid.length <= buckets * 2 + 2) return valid;
  const result = [valid[0]], width = (valid.length - 2) / buckets;
  for (let index = 0; index < buckets; index++) {
    const start = 1 + Math.floor(index * width), end = Math.min(valid.length - 1,1 + Math.floor((index + 1) * width));
    let low = start, high = start;
    for (let point = start; point < end; point++) {
      if (valid[point][key] < valid[low][key]) low = point;
      if (valid[point][key] > valid[high][key]) high = point;
    }
    for (const point of [...new Set([low,high])].sort((a,b) => a-b)) result.push(valid[point]);
  }
  return [...result,valid.at(-1)];
}
function svgNode(tag, attrs = {}, content) {
  const element = document.createElementNS('http://www.w3.org/2000/svg',tag);
  for (const [key,value] of Object.entries(attrs)) element.setAttribute(key,String(value));
  if (content !== undefined) element.textContent = content;
  return element;
}
function chart(key, title, unit, rows, parentRows) {
  const figure = node('figure'), svg = svgNode('svg',{viewBox:'0 0 320 205',role:'img','aria-label':`${title}, ${unit}. Solid active, dashed parent. Exact values in trajectory data.`});
  const active = chartSamples(rows,key), paired = chartSamples(parentRows,key);
  const maximum = Math.max(1,...active.map(row => row[key]),...paired.map(row => row[key]));
  const horizon = Math.max(Number.EPSILON,run.config.horizon,run.state.t);
  svg.append(svgNode('title',{},`${title} — ${unit}; vertical axis starts at zero`));
  for (const fraction of [0,.5,1]) {
    const y = 167 - fraction * 145;
    svg.append(svgNode('line',{x1:53,x2:309,y1:y,y2:y,class:'chart-gridline'}));
    svg.append(svgNode('text',{x:46,y:y+4,'text-anchor':'end',class:'chart-text'},display(maximum*fraction)));
  }
  for (const [points,isParent] of [[paired,true],[active,false]]) {
    if (!points.length) continue;
    const d = points.map((row,index) => `${index?'L':'M'}${(53+row.t/horizon*256).toFixed(3)},${(167-row[key]/maximum*145).toFixed(3)}`).join(' ');
    svg.append(svgNode('path',{d,class:`chart-line${isParent?' chart-parent':''}`}));
    const last = points.at(-1);
    if (!isParent) svg.append(svgNode('circle',{cx:53+last.t/horizon*256,cy:167-last[key]/maximum*145,r:3,fill:'#187a70'}));
  }
  svg.append(svgNode('text',{x:53,y:191,class:'chart-text'},'Year 0'));
  svg.append(svgNode('text',{x:309,y:191,'text-anchor':'end',class:'chart-text'},`Year ${display(horizon)}`));
  figure.append(node('figcaption',title),svg,node('p',`${unit} · zero baseline`,'chart-caption'));
  return figure;
}
function renderHistory() {
  const rows = history(run), paired = history(parent);
  $('trajectories').replaceChildren(chart('H','Population','million people',rows,paired),
    chart('q','Relative capability','index',rows,paired),chart('exposure','Deficit exposure','fraction',rows,paired));
  table('history-table',rows.slice(-250),[{key:'t',title:'Year'},{key:'H',title:'Population · million'},
    {key:'q',title:'Capability · index'},{key:'exposure',title:'Exposure · fraction'}]);
  text('history-note',`Latest ${Math.min(rows.length,250)} of ${rows.length} records. Charts retain endpoints and local extrema in at most 202 marks per series. CSV contains every recorded row.`);
}

function renderComparison(summary) {
  $('comparison').hidden = !parent;
  if (!parent) return;
  const baseline = engine.summarize(parent);
  const units = {time:'years',H:'million people',qualityOfLife:'HDI-like index',qolPersonYears:'million QoL-person-years',q:'index',exposure:'fraction',extraDeaths:'million people',shortagePersonYears:'million person-years',policyCost:'TWh'};
  table('comparison-table', Object.keys(units).map(key => ({metric:`${label(key)} · ${units[key]}`,
    active:summary[key],parent:baseline[key],difference:Number.isFinite(summary[key]) && Number.isFinite(baseline[key]) ? summary[key]-baseline[key] : null})),
    [{key:'metric'},{key:'active',title:'Active branch'},{key:'parent',title:'Parent'},{key:'difference',title:'Active − parent'}]);
}
function renderAssets() {
  const assets = run.state.assetState || {}, inventory = inspectAssets(assets,run.state.t,run.config);
  const cohorts = inventory.cohorts, projects = inventory.projects;
  const aged = cohorts.slice(-200).map(cohort => ({...cohort,age:typeof cohort.born === 'number' ? run.state.t-cohort.born
    : typeof cohort.birth === 'number' ? run.state.t-cohort.birth : typeof cohort.birthTime === 'number' ? run.state.t-cohort.birthTime : null}));
  recordTable('asset-table',aged,['id','kind','owner','age','rated','effective','performance','retired','footprint'],
    'Age: years. Rated/effective power: TWh/year; factories: plants; hardware: 1 MW blocks. Footprint: km².');
  recordTable('project-table',projects.slice(-150),['id','kind','owner','status','amount','progress','start','readyAt','energySpent','workDone','remainingEnergy','remainingWork'],
    'Energy: TWh. Work: hypothetical block-equivalent units. Times: absolute years. Amount follows project kind.');
  text('asset-count',`${cohorts.length} cohorts · ${projects.length} projects`);
  text('asset-note',`Showing the latest ${aged.length} cohorts and ${Math.min(projects.length,150)} projects. Complete asset and project state is retained in the JSON checkpoint. Ages are years; capacity and work units follow each asset kind.`);
}
function receiptRows(source, sourceName) {
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).flatMap(([key,value]) => Array.isArray(value)
    ? records(value).map(record => ({source:sourceName,record:label(key),...record})) : []);
}
function renderPolicy(summary) {
  const policy = run.state.policyState || {}, events = run.state.eventState || {};
  const policies=[...(run.state.policyArchive||[]),policy];
  compact('timing-metrics', [['Scenario time · years',run.state.t],['Policy status',summary.policyStatus],
    ['Policy energy spent · TWh',summary.policyCost],['Configured start · year',run.config.policy?.start],
    ['Eligibility wait · years',run.config.policy?.delay],['Latest observed time · year',policy.controller?.known?.t]]);
  table('action-table',policies.flatMap((item,index)=>(item.actions||[]).map(action=>({...action,
    origin:index<policies.length-1?'Inherited':'Current'}))),['origin','id','type','status','start','eligibleAt','paidAt','effective_from','expiresAt','energyPaid','workPaid'].map(key => ({key})),
    'Realized timing: absolute years. Energy paid: TWh. Work paid: block-equivalent units.');
  const known = summary.dependencies || policy.controller?.known?.dependencies, dependence = [];
  for (const [key,direction] of [['rsiOnHumans','AI on humans'],['humansOnRsi','Humans on AI']]) {
    for (const row of known?.[key] || []) dependence.push({direction,service:row.service,fraction:row.fraction,covered:row.covered});
  }
  for (const service of known?.uncovered || []) dependence.push({direction:'Outside modeled coverage',service,fraction:null,covered:false});
  if (!dependence.length) dependence.push({direction:'AI on humans',service:'Summary diagnostic',fraction:summary.aiHumanDependence},
    {direction:'Humans on AI',service:'Summary diagnostic',fraction:summary.humanAIDependence});
  table('dependence',dependence,[{key:'direction'},{key:'service'},{key:'fraction'},{key:'covered'}],
    'Current kernel service diagnostics. The controller uses its delayed observations, shown in memory below. Unmodeled services have no inferred coverage.');
  text('observations-json',json(preview({current:policy.controller||policy,inherited:policies.slice(0,-1).map(item=>item.controller)})));
  const receipts = [...policies.flatMap((item,index)=>receiptRows(item,index<policies.length-1?'Inherited policy':'Policy')),...receiptRows(events,'Event'),...receiptRows(run.state.assetState,'Assets').filter(row => /receipt/i.test(row.record))];
  recordTable('receipt-table',receipts.slice(-200),['source','record','id','time','t','type','status','effective_from','target','magnitude']);
  text('receipts-json',json(preview({policy,inheritedPolicies:run.state.policyArchive||[],event:events})));
}
function render() {
  if (!run) return;
  const summary = engine.summarize(run), horizon = run.config.horizon, complete = run.state.t >= horizon - 1e-10;
  $('clock').dataset.time = run.state.t;
  text('clock',`Year ${display(run.state.t)} / ${display(horizon)} · ${complete?'complete':busy?'advancing':playing?'playing':'paused'}`);
  $('timeline').max = Math.max(Number.EPSILON,horizon); $('timeline').value = Math.min(run.state.t,horizon);
  for (const id of ['step','play','finish']) $(id).disabled = busy || complete || playing;
  $('pause').disabled = !playing;
  $('scenario-fields').disabled = busy;
  $('policy-fields').disabled = busy || playing;
  for (const id of ['save-json','export-csv','export-wide','export-inputs','restore-file','clear-parent']) $(id).disabled = busy || playing;
  text('status',message);
  metrics(summary); renderOutcomes(summary); renderComparison(summary); renderHistory(); renderAssets(); renderPolicy(summary);
  recordTable('ledger-table',ledgerRows(summary.ledger),['account','value','unit'],'Most recent interval · source-derived energy, spending and industrial work');
  text('ledger-json',json(summary.ledger)); text('config-json',json(run.config));
}
function pause() {
  playing = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
async function action(operation, success) {
  if (busy) return;
  pause(); busy = true; clearError(); render();
  try { await operation(); message = success; }
  catch(error) { showError(error); message = 'Action rejected. Current physical state retained.'; }
  finally { busy = false; render(); }
}
function advancePair(years) {
  const next = engine.advanceRun(run,years);
  const paired = parent ? engine.advanceRun(parent,Math.max(0,next.state.t-parent.state.t)) : null;
  run = next; parent = paired;
}
async function finish() {
  let iterations = 0;
  while (run.state.t < run.config.horizon - 1e-10) {
    const previous = run.state.t, remaining = run.config.horizon-run.state.t;
    if (remaining <= 2) {
      const next = engine.finishRun(run), paired = parent ? engine.finishRun(parent) : null;
      run = next; parent = paired;
    } else advancePair(Math.min(2,remaining));
    if (run.state.t <= previous) throw new Error('Kernel made no progress toward the horizon');
    if (++iterations % 2 === 0) { render(); await new Promise(resolve => setTimeout(resolve,0)); }
  }
}
function tick() {
  if (!playing || busy) return;
  try {
    const next = engine.stepRun(run,Math.min(0.25,run.config.horizon-run.state.t));
    const paired = parent ? engine.advanceRun(parent,Math.max(0,next.state.t-parent.state.t)) : null;
    if (next.state.t <= run.state.t) { pause(); message = 'Scenario horizon reached.'; }
    run = next; parent = paired;
    if (run.state.t >= run.config.horizon - 1e-10) { pause(); message = 'Scenario horizon reached.'; }
    render(); if (playing) timer = setTimeout(tick,100);
  } catch(error) { pause(); showError(error); }
}
function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const anchor = node('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
function saveText() {
  const active = engine.saveCheckpoint(run);
  const content = parent ? json({consoleSchema:CONSOLE_SCHEMA,active,parent:engine.saveCheckpoint(parent)}) : active;
  if (new Blob([content]).size > MAXFILE) throw new Error('Complete checkpoint exceeds the 100 MB console replay limit');
  return content;
}
function decodeCheckpoint(content) {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Checkpoint must be a JSON object');
  if (!Object.hasOwn(parsed,'consoleSchema')) return {active:engine.restoreCheckpoint(content),paired:null};
  if (parsed.consoleSchema !== CONSOLE_SCHEMA || Object.keys(parsed).sort().join(',') !== 'active,consoleSchema,parent'
    || typeof parsed.active !== 'string' || typeof parsed.parent !== 'string') throw new Error('Invalid paired-console checkpoint');
  const active = engine.restoreCheckpoint(parsed.active), paired = engine.restoreCheckpoint(parsed.parent);
  if (active.state.t !== paired.state.t || active.config.horizon !== paired.config.horizon) throw new Error('Paired checkpoint times or horizons differ');
  const withoutPolicy = config => Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'policy'));
  if (json(withoutPolicy(active.config)) !== json(withoutPolicy(paired.config))) throw new Error('Paired checkpoints must share all non-policy assumptions');
  return {active,paired};
}
async function restoreFile(file) {
  if (!file) return;
  if (file.size > MAXFILE) throw new Error('Complete checkpoint exceeds the 100 MB console import limit');
  const {active,paired} = decodeCheckpoint(await file.text());
  engine.summarize(active); if (paired) engine.summarize(paired);
  run = active; parent = paired; syncForms();
}
function bindControls() {
  $('scenario-form').addEventListener('submit',event => {
    event.preventDefault(); void action(() => { const next = engine.createRun(scenarioOptions()); run = next; parent = null; syncForms(); },'New scenario created.');
  });
  $('policy-form').addEventListener('submit',event => {
    event.preventDefault(); void action(() => { const next = engine.branchRun(run,policyOptions()); parent = run; run = next; },'Policy branch created. Parent retained for paired advance.');
  });
  $('policy-form').addEventListener('input',draftTiming);
  $('scenario-form').addEventListener('change',eventNote);
  $('step').addEventListener('click',() => void action(() => advancePair(Math.min(1,run.config.horizon-run.state.t)),'Advanced through the shared physical kernel.'));
  $('finish').addEventListener('click',() => void action(finish,'Scenario horizon reached. Results are conditional on the active assumptions.'));
  $('play').addEventListener('click',() => { if (busy || run.state.t >= run.config.horizon) return; clearError(); playing = true; message = 'Playing the full revised kernel.'; tick(); });
  $('pause').addEventListener('click',() => { pause(); message = busy ? 'Finishing the requested advance.' : 'Paused. Physical and random state retained.'; render(); });
  $('clear-parent').addEventListener('click',() => { parent = null; message = 'Active branch retained. Parent comparison cleared.'; render(); });
  $('save-json').addEventListener('click',() => { try { download(saveText(),`our-turn-v2-year-${run.state.t}.json`,'application/json'); } catch(error) { showError(error); } });
  $('export-csv').addEventListener('click',() => { try { download(engine.trajectoryCSV(run),`our-turn-v2-year-${run.state.t}.csv`,'text/csv'); } catch(error) { showError(error); } });
  $('export-wide').addEventListener('click',()=>{try{
    const row=wideOutputRow(run,{runId:`console-${run.configId}`,reportedOutcome:engine.summarize(run).outcome});
    download(wideCSV([row]),`our-turn-wide-${run.configId}.csv`,'text/csv');
  }catch(error){showError(error);}});
  $('export-inputs').addEventListener('click',()=>{try{
    const row=wideInputRow(run.config,{runId:`console-${run.configId}`,configId:run.configId,
      engineVersion:run.version,sourceDigest:run.sourceDigest,seed:run.config.seed,
      switches:{marginal_priority:run.config.priority.operatingMode==='marginal',weighted_action_order:run.config.priority.mode==='weighted'}});
    download(wideCSV([row],{columns:Object.keys(row)}),`our-turn-inputs-${run.configId}.csv`,'text/csv');
  }catch(error){showError(error);}});
  $('restore-file').addEventListener('change',event => {
    const file = event.target.files[0]; void action(() => restoreFile(file),'Checkpoint restored with complete kernel state.').finally(() => { event.target.value = ''; });
  });
  $('save-config').addEventListener('click',()=>{
    try{download(json(run.config),'our-turn-active-config.json','application/json');}catch(error){showError(error);}
  });
  $('load-config').addEventListener('change',event=>{
    const file=event.target.files[0];void action(async()=>{
      if(!file)return;
      if(file.size>1_000_000)throw new Error('Configuration exceeds the 1 MB import limit');
      const options=JSON.parse(await file.text());
      if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Configuration must be a JSON object');
      const next=engine.createRun(options);run=next;parent=null;syncForms();
    },'Configuration loaded into a new run.').finally(()=>{event.target.value='';});
  });
  window.addEventListener('pagehide',pause);
}
async function sourceLinks() {
  // Source documents are not mirrored in standalone distribution
}

run = engine.createRun();
text('infrastructure-schema',json({infrastructure:INFRA_DEFAULTS}));
syncForms(); bindControls(); render();
text('version',`v${engine.VERSION} · Scenario model`);
text('footer-version',`Engine ${engine.VERSION} · English console · Local & reproducible`);
text('source-digest',`Numerical source: ${typeof engine.SOURCE_DIGEST === 'string' ? engine.SOURCE_DIGEST : json(engine.SOURCE_DIGEST)}`);
Object.defineProperty(window,'revisedConsole',{value:Object.freeze({snapshot:() => JSON.parse(json({run,parent,
  summary:engine.summarize(run),parentSummary:parent ? engine.summarize(parent) : null,playing,busy}))}),writable:false,configurable:false});
void sourceLinks();
