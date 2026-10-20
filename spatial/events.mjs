/** Optional synthetic hazards; probabilities/amplitudes are scenario assumptions. */
import {uniform,canonical} from '../sim/rng.mjs';
export const EVENT_DEFAULTS=Object.freeze({technologyProbability:.06,technologyGain:.02,maxEfficiency:.25,
 pandemicProbability:.04,pandemicMortality:.015,pandemicDuration:1,disasterProbability:.08,disasterLoss:.1,disasterDuration:1});
const ranges={technologyProbability:[0,1],technologyGain:[0,.5],maxEfficiency:[0,.8],
 pandemicProbability:[0,1],pandemicMortality:[0,.2],pandemicDuration:[.005,5],
 disasterProbability:[0,1],disasterLoss:[0,.8],disasterDuration:[.005,5]};
export function normalizeEvents(mode='off',overrides={}) {
 if(!['off','scenario'].includes(mode))throw new RangeError('Invalid eventMode');
 if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||![Object.prototype,null].includes(Object.getPrototypeOf(overrides)))throw new TypeError('Invalid eventConfig');
 if(Reflect.ownKeys(overrides).some(k=>!Object.hasOwn(EVENT_DEFAULTS,k)))throw new RangeError('Unknown eventConfig key');
 const config={...EVENT_DEFAULTS,...overrides};
 for(const [key,[min,max]] of Object.entries(ranges))if(!Number.isFinite(config[key])||config[key]<min||config[key]>max)throw new RangeError(`Invalid eventConfig ${key}`);
 return {eventMode:mode,eventConfig:config};
}
export function initialEvents(seed) {return {rng:(seed^0x7f4a7c15)>>>0,year:-1,efficiency:0,active:[],history:[]};}
function expire(events,t) {
 const due=events.active.filter(e=>e.end<=t+1e-10).sort((a,b)=>a.end-b.end||(a.id<b.id?-1:1));
 if(!due.length)return events;
 return {...events,active:events.active.filter(e=>e.end>t+1e-10),
  history:[...events.history,...due.map(e=>({t:e.end,type:'event-end',eventId:e.id,kind:e.kind,amplitude:e.amplitude}))]};
}
function annual(events,year,c) {
 let next={...events,year};
 for(const kind of ['technology','pandemic','disaster']){
  const draw=uniform(next.rng);next={...next,rng:draw.state};
  if(draw.value>=c[`${kind}Probability`])continue;
  const id=`${year}-${kind}`;
  const amplitude=kind==='technology'?Math.min(c.technologyGain,Math.max(0,c.maxEfficiency-next.efficiency)):
   kind==='pandemic'?c.pandemicMortality:c.disasterLoss;
  const end=kind==='technology'?year:year+c[`${kind}Duration`];
  const start={t:year,type:'event-start',eventId:id,kind,amplitude,end};
  if(kind==='technology')next={...next,efficiency:Math.min(c.maxEfficiency,next.efficiency+amplitude),
   history:[...next.history,start,{t:year,type:'event-end',eventId:id,kind,amplitude}]};
  else next={...next,active:[...next.active,{id,kind,start:year,end,amplitude}],history:[...next.history,start]};
 }
 return next;
}
export function prepareEvents(state,config,seed) {
 if(config.eventMode!=='scenario')return state;
 let events=expire(state.scenarioEvents??initialEvents(seed),state.t),year=Math.floor(state.t+1e-9);
 if(events.year!==year)events=expire(annual(events,year,config.eventConfig),state.t);
 return {...state,scenarioEvents:events};
}
export function expireEvents(state) {
 if(!state.scenarioEvents)return state;
 const events=expire(state.scenarioEvents,state.t);
 return events===state.scenarioEvents?state:{...state,scenarioEvents:events};
}
export function effectiveConfig(base,state) {
 const e=state.scenarioEvents;if(!e)return base;
 const extraDeath=e.active.filter(p=>p.kind==='pandemic').reduce((a,p)=>a+p.amplitude,0);
 return e.efficiency===0&&extraDeath===0?base:{...base,humanEnergy:base.humanEnergy*(1-e.efficiency),death:base.death+extraDeath};
}
export function disasterFactor(state) {
 return (state.scenarioEvents?.active??[]).filter(e=>e.kind==='disaster').reduce((a,e)=>a*(1-e.amplitude),1);
}
export function eventDuration(state) {
 return Math.min(Infinity,...(state.scenarioEvents?.active??[]).map(e=>e.end-state.t).filter(h=>h>1e-10));
}
export function validateEventState(state,config,seed) {
 const actual=state.scenarioEvents;
 if(!actual||!Number.isInteger(actual.year)||actual.year< -1||actual.year>Math.floor(state.t+1e-9))throw new Error('Invalid event year');
 const expectedYear=state.t===0?-1:Math.floor(state.t-state.stepDuration+1e-9);
 if(config.eventMode==='scenario'&&actual.year!==expectedYear)throw new Error('Missing/mismatched processed event year');
 let expected=initialEvents(seed);
 if(config.eventMode==='scenario')for(let year=0;year<=actual.year;year++)expected=annual(expire(expected,year),year,config.eventConfig);
 expected=expire(expected,state.t);
 if(canonical(actual)!==canonical(expected))throw new Error('Event RNG/effects/history replay mismatch');
}
