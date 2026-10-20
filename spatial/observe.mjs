import {summarize} from '../sim/engine.mjs';
import {disasterFactor} from './events.mjs';

export function summarizeWorld(world) {
 const sum=fn=>world.regions.reduce((a,r)=>a+fn(r.state,r),0);
 const H=sum(s=>s.H),B=sum(s=>s.B),active=sum(s=>s.active),G=sum(s=>s.G),F=sum(s=>s.F);
 const weighted=(value,weight,fallback=0)=>{
  const total=sum(weight);return total>0?sum((s,r)=>value(s,r)*weight(s,r))/total:fallback;
 };
 return {t:world.t,H,B,G,F,Q:weighted(s=>s.Q,active>0?s=>s.active:s=>s.B),active,
  sH:weighted(s=>s.sH,s=>s.H,1),minAdequacy:Math.min(...world.regions.map(r=>r.state.sH)),
  powerAutonomy:weighted(s=>s.aE,s=>s.G),fabAutonomy:weighted(s=>s.aF,s=>s.F),
  constructionWork:sum((s,r)=>r.work.used),constructionCapacity:sum((s,r)=>r.work.capacity),
  rawPower:sum((s,r)=>r.power.rawPower),deliveredPower:sum((s,r)=>r.power.deliveredPower),
  definition:'Q is powered-block-weighted (installed-block-weighted if no active blocks), not worldwide individual capability.'};
}
export function historyPoint(world) {
 const {t,H,B,Q,sH,minAdequacy}=summarizeWorld(world);return {t,H,B,Q,sH,minAdequacy};
}
export function worldView(world) {
 return {t:world.t,horizon:world.config.horizon,regions:world.regions.map(({state:s,config:c,power,work,...r})=>({
  id:r.id,name:r.name,q:r.q,r:r.r,terrain:r.terrain,H:s.H,H0:c.H0,B:s.B,Q:s.Q,G:s.G,F:s.F,
  aE:s.aE,aF:s.aF,sH:s.sH,support:s.support,active:s.active,queue:s.queue,ledger:s.ledger,
  imports:power.imports,exports:power.exports,rawPower:power.rawPower,deliveredPower:power.deliveredPower,
  work,events:[...s.events,...(s.scenarioEvents?.history??[])].sort((a,b)=>a.t-b.t),
  scenarioEvents:s.scenarioEvents,humanEfficiency:s.scenarioEvents?.efficiency??0,
  activePandemicRate:(s.scenarioEvents?.active??[]).filter(e=>e.kind==='pandemic').reduce((a,e)=>a+e.amplitude,0),
  disasterFactor:disasterFactor(s),regionalOutcome:summarize({state:s,config:c}).outcome})),
 events:world.regions.flatMap(r=>(r.state.scenarioEvents?.history??[]).filter(e=>e.type==='event-start').map(e=>({
  id:`${r.id}-${e.eventId}`,kind:e.kind==='technology'?'tech':e.kind,regionId:r.id,start:e.t,end:e.end,magnitude:e.amplitude}))),
 links:world.links.map(l=>({...l,capacity:l.capacity*world.config.gridScale})),summary:summarizeWorld(world),
 history:world.history,branchOf:world.branchOf};
}
export function trajectoryCSV(world) {
 const keys=['t','H','B','Q','sH','minAdequacy'];
 return keys.join(',')+'\n'+world.history.map(row=>keys.map(k=>row[k]).join(',')).join('\n')+'\n';
}
