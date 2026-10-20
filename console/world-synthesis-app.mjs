import {createWorld,advanceWorld,branchWorld,summarizeWorld,worldView,saveWorld,restoreWorld,trajectoryCSV,SPATIAL_VERSION,SOURCE_DIGEST} from '../spatial/world.mjs';
import {updateHexMap,mapLegend} from './hex-map.mjs?atlas=20261016-living-3';
import {decorateWorldMap} from './world-motion.mjs?atlas=20261016-living-3';
import {observeWorldMilestones} from './world-milestones.mjs?atlas=20261016-living-3';
import {simulateThomasTrajectory, DEFAULT_THOMAS_PARAMS} from './thomas-kernel.mjs';
import {canonical} from '../sim/rng.mjs';

const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(n,digits=0)=>Number(n??0).toLocaleString('en-GB',{maximumFractionDigits:digits,minimumFractionDigits:digits});
const pct=n=>`${number(100*(n??0),1)}%`;
const billion=n=>`${number(n/1000,2)} B`;
const kinds={hardware:['▦','Compute hardware','blocks'],power:['ϟ','Power capacity','TWh/yr'],factory:['▥','Fabrication','blocks/yr'],powerAutomation:['✧','Power automation','fraction'],fabAutomation:['✧','Fab automation','fraction']};
let world=createWorld({eventMode:'scenario'}),baseline=null,selectedId=null,overlay='adequacy',playing=false,timer=null,busy=false,zoom=1,lastView=null;
const EPS=1e-8,MAX_FILE=25e6,BENCHMARK_DT=.05;
let benchmarkCache=null,loadGeneration=0;

const initialH=()=>world.regions.reduce((sum,r)=>sum+r.config.H0,0);
function report(error){$('#error').hidden=false;$('#error').textContent=error.message??String(error);pause();}
function safe(action){try{$('#error').hidden=true;return action();}catch(error){report(error);}}
function announce(message){$('#chronicle-text').textContent=message;}
function fact(label,value,cls=''){return `<div class="fact-row"><span>${esc(label)}</span><strong class="${esc(cls)}">${esc(value)}</strong></div>`;}

// The Thomas trajectory shares alignment only. Regional policies/events never
// enter its dynamics; population is rescaled solely for the comparison chart.
function benchmarkSpecification(run=world){
 return {kind:'independent-0d',parameters:{...DEFAULT_THOMAS_PARAMS},policy:{alignment:run.config.alignment},dt:BENCHMARK_DT,
  regionalInitialPopulationMillion:run.regions.reduce((sum,r)=>sum+r.config.H0,0),regionalInterventionsApplied:false};
}
function benchmarkAt(t){
 const alignment=world.config.alignment;
 if(!benchmarkCache||benchmarkCache.t!==t||benchmarkCache.alignment!==alignment){
  const p=DEFAULT_THOMAS_PARAMS;
  const trajectory=t===0?[{t:0,H:p.initial_humans,A:p.initial_hardware,C:p.initial_capability,P:p.initial_power,F:p.initial_fabrication}]
   :simulateThomasTrajectory(p,{alignment},t,BENCHMARK_DT);
  benchmarkCache={t,alignment,trajectory,latest:trajectory.at(-1)};
 }
 return benchmarkCache;
}
function renderBenchmark(benchmark){
 const p=DEFAULT_THOMAS_PARAMS,s=benchmark.latest;
 $('#thomas-H').textContent=`${number(s.H/p.initial_humans*initialH()/1000,2)} B`;
 $('#benchmark-facts').innerHTML=fact('Power P / initial P',`${number(s.P/p.initial_power,3)} × initial`)
  +fact('Fabrication F / initial F',`${number(s.F/p.initial_fabrication,3)} × initial`)
  +fact('Capability C',`${number(s.C,3)} normalized index`);
}
function renderStats(view){
 const s=view.summary??summarizeWorld(world),H=s.H,B=s.B,G=s.G,Q=s.Q;
 $('#total-H').textContent=billion(H);$('#total-B').textContent=number(B);$('#total-G').textContent=number(G);$('#total-Q').textContent=number(Q,2);
 const change=initialH()>0?100*(H/initialH()-1):0;
 $('#human-change').textContent=view.t>0?`${change>=0?'+':''}${number(change,2)}% since contact`:'Initial population';
 $('#total-s').textContent=view.t>0?pct(s.sH):'—';$('#needs-note').textContent=view.t>0?`Last interval · lowest region ${pct(s.minAdequacy)}`:'Not measured yet';
 const alignment=world.config.alignment;
 $('#alignment-value').textContent=pct(alignment);$('#alignment-meter').value=alignment;
 $('#year').innerHTML=`${number(view.t,view.t%1>1e-6?2:0)} <small>/ ${number(view.horizon)}</small>`;
 $('#time-progress').max=view.horizon;$('#time-progress').value=view.t;
 const finished=view.t>=view.horizon-1e-8;
 $('#turn-description').textContent=`${playing?'Playing':'Paused'} · autoplay +${$('#viewing-pace').value} yr/tick · regional ${SPATIAL_VERSION} · independent Thomas benchmark`;
 for(const id of ['#next-turn','#finish','#play'])$(id).disabled=finished||busy;
 $('#source-pin').textContent=`Regional ${SPATIAL_VERSION} · ${SOURCE_DIGEST.slice(0,16)}… · Thomas independent fixed-default ODE · dt ${BENCHMARK_DT} yr. Save includes the benchmark specification; use the matching source release.`;
}

function renderRegion(view){
 const r=view.regions.find(region=>region.id===selectedId)??view.regions[0];selectedId=r.id;
 $('#region-name').textContent=r.name;
 $('#region-description').textContent=`At year ${number(view.t,2)} · ${r.regionalOutcome??'synthetic region'}`;
 $('#region-facts').innerHTML=fact('Population',`${number(r.H)} million`)+fact('Essential needs',view.t>0?pct(r.sH):'Unmeasured',r.sH>=.8?'safe':'warn')+fact('Installed hardware',`${number(r.B)} blocks`)+fact('Powered · last interval',`${number(r.active,1)} blocks`)+fact('Capability',`${number(r.Q,2)} Q`)+fact('Fabrication',`${number(r.F,1)} blocks/yr`);
 
 $('#region-facts').insertAdjacentHTML('beforeend',fact('Installed power',`${number(r.G,1)} TWh/yr`));

 const ledger=r.ledger??{};
 $('#power-balance').innerHTML=fact('Local usable supply',number(r.rawPower,1))+fact('Imports',`+${number(r.imports,1)}`)+fact('Exports',`−${number(r.exports,1)}`)+`<div class="balance-total">${fact('Delivered electricity',number(r.deliveredPower,1))}</div>`+fact('Human allocation',number(ledger.human,1))+fact('Compute + research',number((ledger.operation??0)+(ledger.research??0),1))+fact('Construction',number(ledger.construction,1))+fact('Deployment + industry',number((ledger.policy??0)+(ledger.industry??0),1))+fact('Unused',number(ledger.unused,1));
 $('#grid-note').textContent=view.t>0?'Transfers serve protected reserves, not every unmet need. Spare link capacity alone does not guarantee more imports.':'Power transfers and allocations appear after a physical substep.';
 $('#autonomy').innerHTML=autonomyBar('Power systems',r.aE)+autonomyBar('Fabrication systems',r.aF);
 renderQueue(r,view.t);renderPolicy(r);
 $('#selected-links').innerHTML=view.links.filter(l=>l.from===r.id||l.to===r.id).map(l=>fact(`${view.regions.find(n=>n.id===(l.from===r.id?l.to:l.from))?.name??'Region'} connection`,`${number(Math.abs(l.flow),1)} / ${number(l.capacity)} TWh/yr`)).join('')||'<p>No power connections.</p>';
 const effects=world.regions.find(p=>p.id===r.id).state.scenarioEvents;
 if(effects){
  const pandemic=effects.active.filter(e=>e.kind==='pandemic').reduce((sum,e)=>sum+e.amplitude,0);
  $('#region-facts').insertAdjacentHTML('beforeend',fact('Electricity need reduction',pct(effects.efficiency),'safe')+fact('Current outage multiplier',number(effects.active.filter(e=>e.kind==='disaster').reduce((a,e)=>a*(1-e.amplitude),1),2))+(pandemic?fact('Extra event mortality',`${number(pandemic*100,2)}% / yr`,'warn'):''));
 }
}

function autonomyBar(label,value){return `<div class="bar-label"><span>${esc(label)}</span><strong>${pct(value)}</strong></div><div class="autonomy-track"><i style="width:${Math.max(0,Math.min(100,value*100))}%"></i></div>`;}

function renderQueue(r,t){
 const queue=r.queue??[],groups=Object.entries(kinds).map(([kind,info])=>({kind,info,items:queue.filter(p=>p.kind===kind)})).filter(g=>g.items.length);
 $('#queue-count').textContent=`${queue.length} orders`;
 const work=r.work??{used:0,capacity:0};
 const budget=`<div class="bar-label"><span>Last-interval work used / available</span><strong>${number(work.used,1)} / ${number(work.capacity,1)} work/yr</strong></div><div class="autonomy-track"><i style="width:${work.capacity>0?Math.min(100,100*work.used/work.capacity):0}%"></i></div>`;
 $('#construction-queue').innerHTML=budget+(groups.length?groups.map(({kind,info,items})=>{
  const amount=items.reduce((sum,p)=>sum+p.amount,0),due=Math.min(...items.map(p=>p.due));
  const first=items.reduce((a,p)=>p.due<a.due?p:a),delay=r.projectLeadTimes?.[kind];
  const start=Number.isFinite(first.requestedDue)&&Number.isFinite(delay)?first.requestedDue-delay:null;
  const elapsed=start!==null&&due>start?Math.max(0,Math.min(1,(t-start)/(due-start))):null;
  return `<div class="queue-item"><span class="queue-icon" aria-hidden="true">${info[0]}</span><div><strong>${info[1]} · ${items.length} orders</strong><small>${number(amount,kind.includes('Automation')?3:1)} ${info[2]}</small>${elapsed===null?'':`<progress value="${elapsed}" max="1" aria-label="${esc(info[1])}: ${number(elapsed*100)}% of next order lead time elapsed"></progress><small>${number(elapsed*100)}% lead time elapsed</small>`}</div><span>Next service<br>year ${number(due,2)}</span></div>`;
 }).join(''):'<p class="empty-queue">No committed projects.</p>');
}

function renderPolicy(r){
 const region=world.regions.find(p=>p.id===r.id),policies=region.config.policies??[],records=region.state.policyLog??[];
 $('#policy-report').hidden=policies.length===0;
 $('#policy-record').innerHTML=policies.map((p,index)=>{
  const record=records.find(item=>item.index===index),paid=region.state.policyFunding[index]??0,eligible=p.start+p.delay,expires=eligible+(p.duration??Infinity);
  let status=world.t<eligible?`Scheduled; eligible year ${number(eligible,2)}.`:world.t>=expires&&!record?'Expired without deployment.':`Eligible; not deployed. Funded ${number(paid,2)} / ${number(p.cost,2)} TWh. Requires electricity above the protected reserve.`;
  if(record)status=`${record.outcome==='success'?'Successful':'Failed'} attempt at year ${number(record.t,3)}.`+(p.type==='cap'?` Cap ${world.t<expires?'valid until':'expired at'} year ${number(expires,2)}.`:` Residual powered fraction ${pct(p.residual)} on success.`);
  return `<div class="policy-record"><strong>${p.type==='cap'?'Compute cap':'Shutdown attempt'}</strong><p>${esc(status)}</p></div>`;
 }).join('');
}

function chartRows(run){return (worldView(run).history??[]).map(p=>({t:p.t,H:p.H}));}

function renderChart(view,benchmark){
 const data=chartRows(world),control=baseline?chartRows(baseline):[];
 const maxT=Math.max(1,view.t);
 const thomasData=benchmark.trajectory.map(pt=>({t:pt.t,H:pt.H/DEFAULT_THOMAS_PARAMS.initial_humans*initialH()}));

 const all=[...data,...control,...thomasData];
 const width=600,height=110,pad={x:35,y:8},values=all.map(p=>p.H/1000);
 let low=values.reduce((a,b)=>Math.min(a,b),Infinity),high=values.reduce((a,b)=>Math.max(a,b),0);const gap=Math.max(.05,(high-low)*.18);low=Math.max(0,low-gap);high+=gap;
 const x=t=>pad.x+(width-pad.x-12)*t/maxT,y=H=>height-18-(height-18-pad.y)*(H/1000-low)/(high-low);
 const path=rows=>rows.filter((_,i)=>i===0||i===rows.length-1||i%Math.max(1,Math.floor(rows.length/220))===0).map((p,i)=>`${i?'L':'M'}${x(p.t).toFixed(2)},${y(p.H).toFixed(2)}`).join(' ');
 const guides=[low,(low+high)/2,high].map(v=>`<line x1="${pad.x}" x2="${width-12}" y1="${y(v*1000)}" y2="${y(v*1000)}" stroke="#405249" stroke-width=".5"/><text x="25" y="${y(v*1000)+3}" text-anchor="end" fill="#9dad9f" font-size="8">${number(v,2)}</text>`).join('');

 $('#history-chart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Human population trajectory in billions, from contact to year ${number(view.t,2)}">
 <title>Independent population comparison: regional world and Thomas normalized 0D benchmark</title>
 ${guides}
 <path data-series="thomas" d="${path(thomasData)}" fill="none" stroke="#f1c40f" stroke-width="1.8" stroke-dasharray="4 3"/>
 ${control.length?`<path d="${path(control)}" fill="none" stroke="#c9ad72" stroke-width="1.7" stroke-dasharray="5 4"/>`:''}
 <path d="${path(data)}" fill="none" stroke="#8ac8ad" stroke-width="2.2"/>
 <circle cx="${x(data.at(-1)?.t??0)}" cy="${y(data.at(-1)?.H??initialH())}" r="3.5" fill="#b6e7ca"/>
 <text x="${pad.x}" y="${height-2}" fill="#9dad9f" font-size="8">CONTACT</text>
 <text x="${width-12}" y="${height-2}" text-anchor="end" fill="#9dad9f" font-size="8">YEAR ${number(view.t,1)}</text>
 </svg>`;

 $('#baseline-key').hidden=!baseline;
 $('#baseline-key').innerHTML='<i></i>Without this latest action · same external events';
 const diff=baseline?summarizeWorld(world).H-summarizeWorld(baseline).H:0;
 const diffText = baseline ? ` | ${diff>=0?'+':''}${number(diff,2)}M vs parent` : '';
 $('#comparison-status').innerHTML=`<span style="color:#8ac8ad;">■ 7-Hex Regional</span> vs <span style="color:#f1c40f;">┄ Thomas 0D ODE</span>${diffText}`;
}

function eventRows(run=world){return run.regions.flatMap(r=>[
 ...(r.state.scenarioEvents?.history??[]).filter(e=>e.type==='event-start').map(e=>({...e,regionId:r.id,regionName:r.name,key:`${r.id}:${e.eventId}`})),
 ...r.state.events.filter(e=>e.type==='supply-shock').map(e=>({...e,kind:e.type,end:e.t+1,regionId:r.id,regionName:r.name,key:`${r.id}:shock:${e.t}`}))
]).sort((a,b)=>b.t-a.t||a.key.localeCompare(b.key));}

function renderEvents(){
 const rows=eventRows().map(e=>{
  const region=world.regions.find(r=>r.id===e.regionId),active=(region.state.scenarioEvents?.active??[]).some(a=>a.id===e.eventId);
  return {...e,active:e.kind==='supply-shock'?world.t<e.end:active};
 }).sort((a,b)=>Number(b.active)-Number(a.active)||b.t-a.t||a.key.localeCompare(b.key));
 $('#event-mode-label').textContent=world.config.eventMode==='scenario'?'SYNTHETIC EVENT LAW':'EXTRA EVENTS OFF · SUPPLY SHOCKS REMAIN';
 $('#event-list').innerHTML=rows.length?rows.slice(0,5).map(e=>{
  const detail=e.kind==='technology'?`Need reduction +${pct(e.amplitude)} of base electricity need. Permanent efficiency gain.`:(e.active?`Active until year ${number(e.end,2)}. `:`Ended at year ${number(e.end,2)}. `)+(e.kind==='pandemic'?`Additional mortality ${number(100*e.amplitude,2)}%/year.`:e.kind==='disaster'?`Electricity availability loss ${pct(e.amplitude)}.`:`Supply multiplier ${number(e.factor,2)}.`);
  return `<div class="event-item ${esc(e.kind)}${e.active?' is-active':''}"><span class="event-icon" aria-hidden="true">◇</span><div><strong>${esc(e.regionName)} · ${esc(e.kind)}</strong><p>${esc(detail)}</p></div><small>YEAR ${number(e.t,2)}</small></div>`;
 }).join(''):'<p class="event-empty">No scenario events recorded yet.</p>';
}

function mapView(){
 const view=worldView(world);
 return {...view,regions:view.regions.map(r=>{
  const c=world.regions.find(local=>local.id===r.id).config;
  return {...r,projectLeadTimes:{hardware:c.hardwareDelay,power:c.powerDelay,factory:c.fabDelay,powerAutomation:c.automationDelay,fabAutomation:c.automationDelay}};
 })};
}

function renderAll(){
 const focusedId=document.activeElement?.closest?.('#hex-map [data-region]')?.dataset.region;
 const view=mapView();
 if(!selectedId||!view.regions.some(r=>r.id===selectedId))selectedId=view.regions[0].id;
 if(view.t>=view.horizon-EPS)pause();
 const benchmark=benchmarkAt(view.t);
 renderStats(view);
 renderRegion(view);
 renderBenchmark(benchmark);
 renderChart(view,benchmark);
 renderEvents();
 renderMilestones();
 updateHexMap($('#hex-map'),view,{selectedId,overlay});
 decorateWorldMap($('#hex-map'),view,{previousView:lastView,playing});
 lastView=view;
 if(focusedId)$('#hex-map').querySelector(`[data-region="${CSS.escape(focusedId)}"]`)?.focus({preventScroll:true});
 $('#map-interval-note').textContent=view.t<=0?'Initial stocks · flows unmeasured':`${playing?'Playing':'Paused'} · lights and flows show the last physical interval`;
 if(typeof mapLegend==='function')$('#map-legend').innerHTML=mapLegend(overlay);
 for(const button of document.querySelectorAll('[data-overlay]'))button.setAttribute('aria-pressed',String(button.dataset.overlay===overlay));
}

function renderMilestones(){
 const rows=observeWorldMilestones(world);
 $('#milestone-count').textContent=String(rows.length);
 $('#milestone-latest').textContent=rows.length?rows.at(-1).title:'No qualifying observations yet';
 $('#milestone-list').innerHTML=rows.length?[...rows].reverse().map(row=>`<li><span class="milestone-year">YEAR ${number(row.t,2)}</span><div><strong>${esc(row.regionName)} · ${esc(row.title)}</strong><p>${esc(row.detail)}</p></div></li>`).join(''):'<li>Advance time to observe model thresholds. Initial stocks are not new transitions.</li>';
}

function advance(stepYears=1){
 if(busy)return;busy=true;
 try{
  const before=worldView(world),target=Math.min(before.horizon,before.t+stepYears);
  const next=advanceWorld(world,target-before.t),parent=baseline?advanceWorld(baseline,target-worldView(baseline).t):null;
  // LUI-05: a newer accepted advance supersedes any pending file import.
  loadGeneration++;world=next;baseline=parent;
  const after=worldView(world);
  announce(`Year ${number(after.t,2)}. ${billion(after.summary.H)} people; lowest regional needs met: ${pct(after.summary.minAdequacy)}. Regional actions do not change the independent Thomas benchmark.`);
 }finally{busy=false;}
 renderAll();
}

function play(){
 if(playing){pause();renderAll();return;}
 if(worldView(world).t>=worldView(world).horizon-EPS){pause();renderAll();return;}
 playing=true;
 document.body.classList.add('simulation-running');
 $('#play').textContent='⏸ Pause';
 $('#play').setAttribute('aria-label','Pause simulation');
 $('#play').classList.add('active');
 renderAll();
 if(playing)timer=setInterval(()=>safe(()=>advance(Number($('#viewing-pace').value))),500);
}

function pause(){
 playing=false;
 clearInterval(timer);
 timer=null;
 document.body.classList.remove('simulation-running');
 $('#hex-map svg')?.classList.remove('motion-enabled');
 $('#play').textContent='▶ Play';
 $('#play').setAttribute('aria-label','Play simulation');
 $('#play').classList.remove('active');
 $('#turn-description').textContent=`Paused · autoplay +${$('#viewing-pace').value} yr/tick · regional ${SPATIAL_VERSION} · independent Thomas benchmark`;
 $('#map-interval-note').textContent=world.t>0?'Paused · lights and flows show the last physical interval':'Initial stocks · flows unmeasured';
}

function updateZoom(value){
 zoom=Math.min(1.6,Math.max(.8,value));
 $('#hex-map').style.transform=`scale(${zoom})`;
 $('#zoom-reset').textContent=`${number(zoom,1)}×`;
}
function selectRegion(event){
 const id=event.target.closest?.('[data-region]')?.dataset.region;
 if(!world.regions.some(r=>r.id===id))return;
 selectedId=id;renderAll();
 announce(`${world.regions.find(r=>r.id===id).name} selected. Actions apply to this regional world only.`);
}
function updateActionContext(){
 const form=$('#action-form'),r=worldView(world).regions.find(p=>p.id===selectedId),cap=Number(form.elements.cap.value);
 $('#action-context').textContent=form.elements.type.value==='cap'
  ?`Powered last interval: ${number(r.active,1)} blocks; proposed cap: ${number(cap,1)}. ${cap>=r.active?'The cap would not bind at the displayed activity level; future activity may differ.':'The cap is below the displayed powered activity.'}`
  :'A successful attempt stops new orders. Existing prepaid projects still enter service; success is one scenario draw.';
}
function openAction(type){
 pause();renderAll();
 const r=worldView(world).regions.find(p=>p.id===selectedId),form=$('#action-form');
 form.elements.type.value=type;form.elements.start.value=String(world.t);form.elements.start.min=String(world.t);
 form.elements.cap.value=String(Math.max(0,Math.round(r.B*.5)));
 $('#action-title').textContent=type==='cap'?'Limit compute':'Attempt shutdown';
 $('#action-region').textContent=`${r.name} · costs are paid from this region's usable electricity. The independent Thomas benchmark receives no regional actions.`;
 for(const kind of ['cap','shutdown']){
  const group=$(`#${kind}-fields`);group.hidden=type!==kind;
  for(const input of group.querySelectorAll('input'))input.disabled=group.hidden;
 }
 updateActionContext();$('#action-dialog').showModal();
}
function branchAction(action){
 const parent=world,next=branchWorld(world,action);
 loadGeneration++;world=next;baseline=parent;
 $('#action-dialog').close();
 announce(`Regional action branch created. Compare it with the same world without this latest action. Thomas remains an independent benchmark.`);
 renderAll();
}
function applyAction(event){
 event.preventDefault();safe(()=>{
  pause();const values=Object.fromEntries(new FormData(event.target));
  const policy={regionId:selectedId,type:values.type,start:+values.start,delay:+values.delay,cost:+values.cost};
  branchAction(values.type==='cap'?{...policy,cap:+values.cap,duration:+values.duration}:{...policy,success:+values.success,residual:+values.residual});
 });
}
function resetWorld(options){
 pause();const next=createWorld(options);
 loadGeneration++;world=next;baseline=null;selectedId=null;lastView=null;benchmarkCache=null;
 updateZoom(1);$('#event-toast').hidden=true;$('#settings').close();
 announce('New regional world at contact. Thomas uses independent fixed defaults and the same alignment. Advance to measure regional flows.');
 renderAll();
}
function createScenario(event){
 event.preventDefault();safe(()=>{
  const values=Object.fromEntries(new FormData(event.target));
  resetWorld(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,key==='eventMode'?value:+value])));
 });
}
function openSettings(){
 pause();renderAll();const form=$('#settings-form');
 for(const key of ['alignment','horizon','seed','gridScale','workScale','eventMode']){
  const input=form.elements[key],value=String(world.config[key]);
  if(input.options&&!Array.from(input.options).some(option=>option.value===value)){
   const option=document.createElement('option');option.value=value;option.textContent=`${value} (current)`;input.append(option);
  }
  input.value=value;
 }
 $('#alignment-output').textContent=pct(world.config.alignment);$('#settings').showModal();
}
function saveBundle(){
 const text=JSON.stringify({schema:'our-turn.synthesis-ui.v1',world:saveWorld(world),baseline:baseline?saveWorld(baseline):null,
  selectedId,overlay,benchmark:benchmarkSpecification()});
 if(text.length>MAX_FILE)throw new Error('Comparison save exceeds 25 MB. Export regional data separately.');
 return text;
}
function validateParent(next,parent){
 if(!parent)return;
 const t=next.branchOf?.t;
 if(Math.abs(next.t-parent.t)>EPS||next.config.horizon!==parent.config.horizon||next.branchOf?.configId!==parent.configId
  ||next.actions.length!==parent.actions.length+1||canonical(next.actions.slice(0,-1))!==canonical(parent.actions)
  ||canonical(next.history.filter(p=>p.t<=t+EPS))!==canonical(parent.history.filter(p=>p.t<=t+EPS)))
  throw new Error('Comparison must contain the saved branch parent at the same time and horizon.');
}
function restoreBundle(text){
 if(typeof text!=='string'||text.length>MAX_FILE)throw new Error('Comparison file must be JSON under 25 MB.');
 const value=JSON.parse(text),wrapped=['our-turn.synthesis-ui.v1','our-turn.world-ui.v1'].includes(value?.schema);
 let next,parent=null,id=null,mode='adequacy';
 if(wrapped){
  if(typeof value.world!=='string'||(value.baseline!==null&&typeof value.baseline!=='string'))throw new Error('Invalid comparison checkpoints.');
  next=restoreWorld(value.world);parent=value.baseline===null?null:restoreWorld(value.baseline);validateParent(next,parent);
  if(value.schema==='our-turn.synthesis-ui.v1'&&canonical(value.benchmark)!==canonical(benchmarkSpecification(next)))
   throw new Error('Saved Thomas specification differs from the current fixed-default benchmark. Use the matching source release.');
  id=String(value.selectedId??'');mode=['adequacy','power','compute'].includes(value.overlay)?value.overlay:'adequacy';
 }else next=restoreWorld(text);
 pause();loadGeneration++;world=next;baseline=parent;selectedId=id;overlay=mode;lastView=null;benchmarkCache=null;
 updateZoom(1);$('#event-toast').hidden=true;renderAll();
 announce(value?.schema==='our-turn.synthesis-ui.v1'?'Comparison restored with its regional parent; Thomas recomputed from the recorded specification.':'Regional world restored; Thomas recomputed using current independent defaults and restored alignment.');
}
function download(name,text,type='application/json'){
 const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a');
 link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function loadFile(event){
 const file=event.target.files?.[0];if(!file)return;
 pause();renderAll();const generation=++loadGeneration;
 try{
  if(file.size>MAX_FILE)throw new Error('Comparison file exceeds 25 MB.');
  const text=await file.text();
  if(generation===loadGeneration)safe(()=>restoreBundle(text));
 }catch(error){if(generation===loadGeneration)report(error);}
 finally{event.target.value='';}
}
function handleShortcut(event){
 if(event.defaultPrevented||event.ctrlKey||event.altKey||event.metaKey||event.isComposing||document.querySelector('dialog[open]'))return;
 if(event.target.isContentEditable||event.target.closest?.('button,a,input,select,textarea,summary,[contenteditable],[role="button"]'))return;
 if(event.code==='Space'){event.preventDefault();safe(play);}
 else if(event.code==='ArrowRight'){event.preventDefault();safe(()=>{pause();advance(1);});}
 else if(/^[1-7]$/.test(event.key)){
  const r=world.regions[Number(event.key)-1];
  if(r){selectedId=r.id;safe(renderAll);$('#hex-map').querySelector(`[data-region="${CSS.escape(r.id)}"]`)?.focus();}
 }
}
function bindControls(){
 $('#next-turn').addEventListener('click',()=>safe(()=>{pause();advance(1);}));
 $('#play').addEventListener('click',()=>safe(play));
 $('#finish').addEventListener('click',()=>safe(()=>{pause();advance(world.config.horizon-world.t);}));
 $('#viewing-pace').addEventListener('change',()=>safe(renderAll));
 for(const button of document.querySelectorAll('[data-overlay]'))button.addEventListener('click',()=>safe(()=>{overlay=button.dataset.overlay;renderAll();}));
 for(const button of document.querySelectorAll('[data-action]'))button.addEventListener('click',()=>safe(()=>openAction(button.dataset.action)));
 for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>document.getElementById(button.dataset.close).close());
 $('#action-form').addEventListener('submit',applyAction);
 $('#action-form input[name=cap]').addEventListener('input',updateActionContext);
 $('#hex-map').addEventListener('click',event=>safe(()=>selectRegion(event)));
 $('#hex-map').addEventListener('keydown',event=>{
  if(!['Enter',' '].includes(event.key)||!event.target.closest?.('[data-region]'))return;
  event.preventDefault();event.stopPropagation();safe(()=>selectRegion(event));
  $('#hex-map').querySelector(`[data-region="${CSS.escape(selectedId)}"]`)?.focus({preventScroll:true});
 });
 window.addEventListener('keydown',handleShortcut);
 $('#zoom-in').addEventListener('click',()=>updateZoom(zoom+.1));
 $('#zoom-out').addEventListener('click',()=>updateZoom(zoom-.1));
 $('#zoom-reset').addEventListener('click',()=>updateZoom(1));
 $('#map-focus').addEventListener('click',()=>{
  const focused=document.body.classList.toggle('map-focused');
  $('#map-focus').setAttribute('aria-pressed',String(focused));$('#map-focus').textContent=focused?'Show strategy panels':'Focus map';updateZoom(1);
  if(!focused&&matchMedia('(max-width: 950px)').matches)document.querySelector('.decision-section').scrollIntoView({block:'start'});
 });
 $('#settings-button').addEventListener('click',()=>safe(openSettings));
 $('#settings-form').addEventListener('submit',createScenario);
 $('#settings-form input[name=alignment]').addEventListener('input',event=>$('#alignment-output').textContent=pct(+event.target.value));
 $('#save').addEventListener('click',()=>safe(()=>download(`our-turn-comparison-year-${number(world.t,2)}.json`,saveBundle())));
 $('#csv').addEventListener('click',()=>safe(()=>download('our-turn-regional-history.csv',trajectoryCSV(world),'text/csv')));
 $('#load').addEventListener('change',loadFile);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)safe(()=>{pause();renderAll();});});
 matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>safe(renderAll));
}

window.alphaSynthesis={getWorld:()=>structuredClone(world),getBaseline:()=>baseline?structuredClone(baseline):null,
 getView:()=>worldView(world),getSelected:()=>selectedId,getOverlay:()=>overlay,getMilestones:()=>observeWorldMilestones(world),
 getBenchmark:()=>structuredClone({...benchmarkAt(world.t),specification:benchmarkSpecification()}),
 createScenario:options=>safe(()=>resetWorld(options)),advance:years=>safe(()=>{pause();advance(years);}),
 applyAction:action=>safe(()=>{pause();branchAction(action);}),save:saveBundle,restore:restoreBundle,
 pause:()=>{pause();renderAll();},getCSV:()=>trajectoryCSV(world),version:SPATIAL_VERSION,sourceDigest:SOURCE_DIGEST};
bindControls();
renderAll();
