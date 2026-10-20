import {createWorld,advanceWorld,branchWorld,summarizeWorld,worldView,saveWorld,restoreWorld,trajectoryCSV,SPATIAL_VERSION,SOURCE_DIGEST} from '../spatial/world.mjs';
import {updateHexMap,mapLegend} from './hex-map.mjs?atlas=20261016-living-3';
import {decorateWorldMap,worldChanges,eventDescription} from './world-motion.mjs?atlas=20261016-living-3';
import {observeWorldMilestones} from './world-milestones.mjs?atlas=20261016-living-3';

const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(n,digits=0)=>Number(n??0).toLocaleString('en-GB',{maximumFractionDigits:digits,minimumFractionDigits:digits});
const pct=n=>`${number(100*(n??0),1)}%`;
const billion=n=>`${number(n/1000,2)} B`;
const kinds={hardware:['▦','Compute hardware','blocks'],power:['ϟ','Power capacity','TWh/yr'],factory:['▥','Fabrication','blocks/yr'],powerAutomation:['✧','Power automation','fraction'],fabAutomation:['✧','Fab automation','fraction']};
let world=createWorld({eventMode:'scenario'}),baseline=null,selectedId=null,overlay='adequacy',playing=false,timer=null,busy=false,zoom=1,lastView=null;
// LUI-04: an older asynchronous file read must not replace a newer accepted world.
let loadGeneration=0;
const initialH=()=>world.regions.reduce((sum,r)=>sum+r.config.H0,0);
function report(error){$('#error').hidden=false;$('#error').textContent=error.message??String(error);pause();}
function safe(action){try{$('#error').hidden=true;return action();}catch(error){report(error);}}
function announce(message){$('#chronicle-text').textContent=message;}
function fact(label,value,cls=''){return `<div class="fact-row"><span>${esc(label)}</span><strong class="${esc(cls)}">${esc(value)}</strong></div>`;}
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
 if(finished)pause();
 $('#turn-description').textContent=`${playing?'Playing':'Paused'} · autoplay +${$('#viewing-pace').value} yr/tick · kernel ${SPATIAL_VERSION}`;
 for(const id of ['#next-turn','#finish','#play'])$(id).disabled=finished||busy;
 $('#source-pin').textContent=`Regional ${SPATIAL_VERSION} · ${SOURCE_DIGEST.slice(0,16)}…`;
}
function renderRegion(view){
 const r=view.regions.find(region=>region.id===selectedId)??view.regions[0];selectedId=r.id;
 $('#region-name').textContent=r.name;
 $('#region-description').textContent=`At year ${number(view.t,2)} · ${r.regionalOutcome??'synthetic region'}`;
 $('#region-facts').innerHTML=fact('Population',`${number(r.H)} million`)+fact('Essential needs',view.t>0?pct(r.sH):'Unmeasured',r.sH>=.8?'safe':'warn')+fact('Installed hardware',`${number(r.B)} blocks`)+fact('Powered · last interval',`${number(r.active,1)} blocks`)+fact('Capability',`${number(r.Q,2)} Q`)+fact('Fabrication',`${number(r.F,1)} blocks/yr`);
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
function renderChart(view){
 const data=chartRows(world),control=baseline?chartRows(baseline):[],all=[...data,...control];
 const width=600,height=105,pad={x:35,y:8},maxT=Math.max(1,view.t),values=all.map(p=>p.H/1000);
 let low=Math.min(...values),high=Math.max(...values);const gap=Math.max(.05,(high-low)*.18);low=Math.max(0,low-gap);high+=gap;
 const x=t=>pad.x+(width-pad.x-12)*t/maxT,y=H=>height-18-(height-18-pad.y)*(H/1000-low)/(high-low);
 const path=rows=>rows.filter((_,i)=>i===0||i===rows.length-1||i%Math.max(1,Math.floor(rows.length/220))===0).map((p,i)=>`${i?'L':'M'}${x(p.t).toFixed(2)},${y(p.H).toFixed(2)}`).join(' ');
 const guides=[low,(low+high)/2,high].map(v=>`<line x1="${pad.x}" x2="${width-12}" y1="${y(v*1000)}" y2="${y(v*1000)}" stroke="#405249" stroke-width=".5"/><text x="25" y="${y(v*1000)+3}" text-anchor="end" fill="#9dad9f" font-size="8">${number(v,2)}</text>`).join('');
 $('#history-chart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Human population trajectory in billions, from contact to year ${number(view.t,2)}"><title>Human population: current world${baseline?' and paired no-new-action world':''}</title>${guides}${control.length?`<path d="${path(control)}" fill="none" stroke="#c9ad72" stroke-width="1.7" stroke-dasharray="5 4"/>`:''}<path d="${path(data)}" fill="none" stroke="#8ac8ad" stroke-width="2"/><circle cx="${x(data.at(-1)?.t??0)}" cy="${y(data.at(-1)?.H??initialH())}" r="3" fill="#b6e7ca"/><text x="${pad.x}" y="${height-2}" fill="#9dad9f" font-size="8">CONTACT</text><text x="${width-12}" y="${height-2}" text-anchor="end" fill="#9dad9f" font-size="8">YEAR ${number(view.t,1)}</text></svg>`;
 $('#baseline-key').hidden=!baseline;$('#baseline-key').innerHTML='<i></i>Without this latest action · same external events';
 const difference=baseline?summarizeWorld(world).H-summarizeWorld(baseline).H:0;
 $('#comparison-status').textContent=baseline?`${difference>=0?'+':''}${number(difference,2)} million vs no-latest-action parent`:'No action branch yet';
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
 const names={technology:'Human technology breakthrough',pandemic:'Pandemic shock',disaster:'Natural disaster','supply-shock':'Supply disruption'},icons={technology:'✧',pandemic:'✚',disaster:'ϟ','supply-shock':'ϟ'};
 $('#event-mode-label').textContent=world.config.eventMode==='scenario'?'SYNTHETIC EVENT LAW':'EXTRA EVENTS OFF · SUPPLY SHOCKS REMAIN';
 $('#event-list').innerHTML=rows.length?rows.slice(0,5).map(e=>{
  const detail=e.kind==='technology'?`Need reduction +${pct(e.amplitude)} of base electricity need. Permanent efficiency gain.`:(e.active?`Active until year ${number(e.end,2)}. `:`Ended at year ${number(e.end,2)}. `)+(e.kind==='pandemic'?`Additional mortality ${number(100*e.amplitude,2)}%/year.`:e.kind==='disaster'?`Electricity availability loss ${pct(e.amplitude)}.`:`Supply multiplier ${number(e.factor,2)}.`);
  return `<div class="event-item ${esc(e.kind)}${e.active?' is-active':''}"><span class="event-icon" aria-hidden="true">${icons[e.kind]??'◇'}</span><div><strong>${esc(e.regionName)} · ${esc(names[e.kind]??e.kind)}</strong><p>${esc(detail)}</p></div><small>YEAR ${number(e.t,2)}</small></div>`;
 }).join(''):'<p class="event-empty">No event starts yet. Events are seeded; quiet intervals are retained.</p>';
}
function showEvent(event,count=1){
 const box=$('#event-toast');if(!event){box.hidden=true;return;}
 const titles={technology:'A human breakthrough',pandemic:'A health crisis',disaster:'Disaster strikes','supply-shock':'Supply disrupted',commissioned:'Commissioned capacity observed'};
 const kind=event.type==='commissioned'?'commissioned':event.kind;
 const when=Number.isFinite(event.intervalStart)?`YEARS ${number(event.intervalStart,2)}–${number(event.t,2)}`:`YEAR ${number(event.t,2)}`;
 box.hidden=false;box.innerHTML=`<span class="label">DURING THE LAST ADVANCE · ${count?`${count} EVENT${count===1?'':'S'}`:'COMMISSIONED'} · ${when}</span><strong>${esc(titles[kind]??'World event')}</strong><p>${esc(eventDescription(event,event.regionName))}</p><button aria-label="Dismiss event">×</button>`;
 box.querySelector('button').addEventListener('click',()=>box.hidden=true);
}
function renderMilestones(){
 const rows=observeWorldMilestones(world);
 $('#milestone-count').textContent=String(rows.length);
 $('#milestone-latest').textContent=rows.length?rows.at(-1).title:'No qualifying observations yet';
 $('#milestone-list').innerHTML=rows.length?[...rows].reverse().map(row=>`<li><span class="milestone-year">YEAR ${number(row.t,2)}</span><div><strong>${esc(row.regionName)} · ${esc(row.title)}</strong><p>${esc(row.detail)}</p></div></li>`).join(''):'<li>Advance time to observe model thresholds. Initial stocks are not new transitions.</li>';
}
function mapView(){
 const view=worldView(world);
 return {...view,regions:view.regions.map(r=>{
  const c=world.regions.find(local=>local.id===r.id).config;
  return {...r,projectLeadTimes:{hardware:c.hardwareDelay,power:c.powerDelay,factory:c.fabDelay,powerAutomation:c.automationDelay,fabAutomation:c.automationDelay}};
 })};
}
function render(){
 const focusedId=document.activeElement?.closest?.('#hex-map [data-region]')?.dataset.region;
 const view=mapView();if(!selectedId||!view.regions.some(r=>r.id===selectedId))selectedId=view.regions[0].id;
 renderStats(view);renderRegion(view);renderChart(view);
 updateHexMap($('#hex-map'),view,{selectedId,overlay});
 decorateWorldMap($('#hex-map'),view,{previousView:lastView,playing});lastView=view;renderEvents();renderMilestones();
 $('#map-interval-note').textContent=view.t<=0?'Initial stocks · flows unmeasured':`${playing?'Playing':'Paused'} · lights and flows show the last physical interval`;
 if(focusedId)$('#hex-map').querySelector(`[data-region="${CSS.escape(focusedId)}"]`)?.focus({preventScroll:true});
 $('#map-legend').innerHTML=typeof mapLegend==='function'?mapLegend(overlay):'';
 for(const button of document.querySelectorAll('[data-overlay]'))button.setAttribute('aria-pressed',String(button.dataset.overlay===overlay));
}
function advance(years=1){
 if(busy)return;busy=true;
 try{
  const before=worldView(world),knownEvents=new Set(eventRows().map(e=>e.key)),target=Math.min(before.horizon,before.t+years);
  const next=advanceWorld(world,target-before.t),parent=baseline?advanceWorld(baseline,target-worldView(baseline).t):null;
  loadGeneration++;world=next;baseline=parent;
  const after=worldView(world),min=Math.min(...after.regions.map(r=>r.sH));
  announce(`Year ${number(after.t,2)}. ${billion(after.summary.H)} people; lowest regional needs met: ${pct(min)}. ${after.regions.reduce((n,r)=>n+r.queue.length,0)} committed project orders.`);
  const newEvents=eventRows().filter(e=>!knownEvents.has(e.key));showEvent(newEvents[0]??worldChanges(before,after).at(-1),newEvents.length);
 }finally{busy=false;}render();
}
function pause(){playing=false;clearInterval(timer);timer=null;document.body.classList.remove('simulation-running');$('#hex-map svg')?.classList.remove('motion-enabled');$('#play').textContent='▶ Play';$('#play').setAttribute('aria-label','Play simulation');$('#turn-description').textContent=`Paused · autoplay +${$('#viewing-pace').value} yr/tick · kernel ${SPATIAL_VERSION}`;$('#map-interval-note').textContent=world.t>0?'Paused · lights and flows show the last physical interval':'Initial stocks · flows unmeasured';}
function play(){if(playing){pause();render();return;}if(worldView(world).t>=worldView(world).horizon-1e-8){pause();render();return;}playing=true;document.body.classList.add('simulation-running');$('#play').textContent='Ⅱ Pause';$('#play').setAttribute('aria-label','Pause simulation');render();timer=setInterval(()=>safe(()=>advance(Number($('#viewing-pace').value))),500);}
function download(name,text,type='application/json'){
 const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function updateActionContext(){
 const form=$('#action-form'),r=worldView(world).regions.find(p=>p.id===selectedId),cap=Number(form.elements.cap.value);
 $('#action-context').textContent=form.elements.type.value==='cap'?`Powered last interval: ${number(r.active,1)} blocks; proposed cap: ${number(cap,1)}. ${cap>=r.active?'The cap would not bind at the displayed activity level; future activity may differ.':'The cap is below the displayed powered activity.'}`:'A successful attempt stops new orders. Existing prepaid projects still enter service; success is one scenario draw.';
}
function openAction(type){
 pause();const r=worldView(world).regions.find(p=>p.id===selectedId),form=$('#action-form');
 form.elements.type.value=type;form.elements.start.value=String(worldView(world).t);form.elements.start.min=form.elements.start.value;
 form.elements.cap.value=Math.max(0,Math.round(r.B*.5));
 $('#action-title').textContent=type==='cap'?'Limit compute':'Attempt shutdown';$('#action-region').textContent=`${r.name} · policy costs are paid from this region's usable electricity.`;
 for(const kind of ['cap','shutdown']){const group=$(`#${kind}-fields`);group.hidden=type!==kind;for(const input of group.querySelectorAll('input'))input.disabled=group.hidden;}updateActionContext();$('#action-dialog').showModal();
}
function applyAction(event){
 event.preventDefault();safe(()=>{
  const form=event.target,values=Object.fromEntries(new FormData(form)),policy={regionId:selectedId,type:values.type,start:+values.start,delay:+values.delay,cost:+values.cost};
  const action=values.type==='cap'?{...policy,cap:+values.cap,duration:+values.duration}:{...policy,success:+values.success,residual:+values.residual};
  const parent=world,next=branchWorld(world,action);loadGeneration++;baseline=parent;world=next;
  $('#action-dialog').close();announce(`Action branch created in ${worldView(world).regions.find(r=>r.id===selectedId).name}. Advance time to compare with the paired parent. Deployment eligibility: year ${number(action.start+action.delay,2)}.`);render();
 });
}
function createScenario(event){event?.preventDefault();safe(()=>{
 pause();const values=Object.fromEntries(new FormData($('#settings-form'))),options=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,k==='eventMode'?v:+v]));
 const next=createWorld(options);loadGeneration++;world=next;baseline=null;selectedId=null;lastView=null;zoom=1;$('#event-toast').hidden=true;$('#hex-map').style.transform='scale(1)';$('#zoom-reset').textContent='1×';$('#settings').close();
 announce('Initial stocks only. Advance once to measure flows; select a region, inspect its electricity balance, then compare a timed action.');render();
});}
function saveBundle(){return JSON.stringify({schema:'our-turn.world-ui.v1',world:saveWorld(world),baseline:baseline?saveWorld(baseline):null,selectedId,overlay});}
function restoreBundle(text){
 if(typeof text!=='string'||text.length>25e6)throw new Error('World file must be JSON under 25 MB.');
 const value=JSON.parse(text);
 if(value.schema==='our-turn.world-ui.v1'){
  if(typeof value.world!=='string'||(value.baseline!==null&&typeof value.baseline!=='string'))throw new Error('Invalid world bundle checkpoints.');
  const next=restoreWorld(value.world),parent=value.baseline===null?null:restoreWorld(value.baseline);
  if(parent&&(Math.abs(worldView(next).t-worldView(parent).t)>1e-8||next.config.horizon!==parent.config.horizon||next.branchOf?.configId!==parent.configId))throw new Error('Comparison world must be the saved branch parent at the same time and horizon.');
  loadGeneration++;world=next;baseline=parent;selectedId=String(value.selectedId??'');overlay=['adequacy','power','compute'].includes(value.overlay)?value.overlay:'adequacy';
 }else{const next=restoreWorld(text);loadGeneration++;world=next;baseline=null;selectedId=null;}
 pause();lastView=null;$('#event-toast').hidden=true;render();announce('Full world restored, including project queues, random streams and action history.');
}
function updateZoom(value){zoom=Math.min(1.6,Math.max(.8,value));$('#hex-map').style.transform=`scale(${zoom})`;$('#zoom-reset').textContent=`${number(zoom,1)}×`;}
$('#next-turn').addEventListener('click',()=>safe(()=>{pause();advance();}));
$('#play').addEventListener('click',()=>safe(play));
$('#finish').addEventListener('click',()=>safe(()=>{pause();advance(worldView(world).horizon-worldView(world).t);}));
$('#settings-button').addEventListener('click',()=>{pause();$('#settings').showModal();});
$('#settings-form').addEventListener('submit',createScenario);
$('#settings-form input[name=alignment]').addEventListener('input',e=>$('#alignment-output').textContent=pct(+e.target.value));
$('#action-form').addEventListener('submit',applyAction);$('#action-form input[name=cap]').addEventListener('input',updateActionContext);
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>document.getElementById(button.dataset.close).close());
for(const button of document.querySelectorAll('[data-action]'))button.addEventListener('click',()=>safe(()=>openAction(button.dataset.action)));
for(const button of document.querySelectorAll('[data-overlay]'))button.addEventListener('click',()=>safe(()=>{overlay=button.dataset.overlay;render();}));
function selectRegion(event){const target=event.target.closest('[data-region]');if(target){selectedId=target.dataset.region;render();announce(`${worldView(world).regions.find(r=>r.id===selectedId)?.name} selected. Inspect its regional report or plan an action.`);}}
$('#hex-map').addEventListener('click',selectRegion);
$('#hex-map').addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();const id=event.target.closest('[data-region]')?.dataset.region;selectRegion(event);if(id)$('#hex-map').querySelector(`[data-region="${CSS.escape(id)}"]`)?.focus();}});
$('#zoom-in').addEventListener('click',()=>updateZoom(zoom+.1));$('#zoom-out').addEventListener('click',()=>updateZoom(zoom-.1));$('#zoom-reset').addEventListener('click',()=>updateZoom(1));
$('#map-focus').addEventListener('click',()=>{
 const focused=document.body.classList.toggle('map-focused');
 $('#map-focus').setAttribute('aria-pressed',String(focused));$('#map-focus').textContent=focused?'Show strategy panels':'Focus map';
 updateZoom(1);
 if(!focused&&matchMedia('(max-width: 950px)').matches)document.querySelector('.decision-section').scrollIntoView({block:'start'});
});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>render());
$('#save').addEventListener('click',()=>safe(()=>download(`our-turn-world-year-${number(worldView(world).t,2)}.json`,saveBundle())));
$('#csv').addEventListener('click',()=>safe(()=>download('our-turn-regional-history.csv',trajectoryCSV(world),'text/csv')));
$('#load').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;const generation=++loadGeneration;pause();try{if(file.size>25e6)throw new Error('World file exceeds 25 MB.');const text=await file.text();if(generation===loadGeneration)restoreBundle(text);}catch(error){if(generation===loadGeneration)report(error);}finally{event.target.value='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){pause();render();}});
window.alphaWorld={getWorld:()=>structuredClone(world),getBaseline:()=>baseline?structuredClone(baseline):null,getView:()=>worldView(world),getSelected:()=>selectedId,getOverlay:()=>overlay,getMilestones:()=>observeWorldMilestones(world),createScenario:options=>safe(()=>{pause();const next=createWorld(options);loadGeneration++;world=next;baseline=null;selectedId=null;lastView=null;render();}),advance:years=>safe(()=>advance(years)),applyAction:action=>safe(()=>{pause();const parent=world,next=branchWorld(world,action);loadGeneration++;world=next;baseline=parent;render();}),save:saveBundle,restore:restoreBundle,pause,setOverlay:value=>{if(!['adequacy','power','compute'].includes(value))throw new Error('Invalid map overlay');overlay=value;render();},getCSV:()=>trajectoryCSV(world),version:SPATIAL_VERSION,sourceDigest:SOURCE_DIGEST};
render();
