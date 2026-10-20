import {supportFactor} from '../sim/infrastructure.mjs';
import {reserveFraction} from '../sim/dynamics.mjs';
import {disasterFactor} from './events.mjs';

/** Edmonds–Karp on undirected capacity pairs, plus donor/deficit supernodes.
 * A physical pair starts with capacity in BOTH residual directions; its net flow
 * remains in [-capacity,capacity]. Parallel physical links retain distinct pairs.
 */
export function routePower(regions,links,gridScale) {
 const n=regions.length,source=n,sink=n+1,graph=Array.from({length:n+2},()=>[]);
 const index=new Map(regions.map((r,i)=>[r.id,i]));
 const edge=(from,to,capacity,reverseCapacity=0)=>{
  const forward={to,reverse:graph[to].length,remaining:capacity,flow:0};
  const reverse={to:from,reverse:graph[from].length,remaining:reverseCapacity,flow:0};
  graph[from].push(forward);graph[to].push(reverse);return forward;
 };
 const power=regions.map(({state:s,config:base,effectiveConfig:c=base})=>{
  const rawPower=s.G*supportFactor(s.aE,s.support)*s.shockFactor*disasterFactor(s);
  const reserve=reserveFraction(c)*c.humanEnergy*Math.max(s.H,c.H0);
  return {rawPower,reserve,imports:0,exports:0};
 });
 power.forEach((p,i)=>{edge(source,i,Math.max(0,p.rawPower-p.reserve));edge(i,sink,Math.max(0,p.reserve-p.rawPower));});
 const physical=links.map(l=>{
  const capacity=l.capacity*gridScale;
  return {link:l,capacity,edge:edge(index.get(l.from),index.get(l.to),capacity,capacity)};
 });
 for(;;){
  const parents=Array(n+2).fill(null),queue=[source];parents[source]={from:-1};
  for(let q=0;q<queue.length&&!parents[sink];q++){
   const from=queue[q];graph[from].forEach((e,j)=>{
    if(e.remaining>0&&!parents[e.to]){parents[e.to]={from,j};queue.push(e.to);}
   });
  }
  if(!parents[sink])break;
  let amount=Infinity;
  for(let to=sink;to!==source;to=parents[to].from){const {from,j}=parents[to];amount=Math.min(amount,graph[from][j].remaining);}
  for(let to=sink;to!==source;to=parents[to].from){
   const {from,j}=parents[to],e=graph[from][j],reverse=graph[to][e.reverse];
   e.remaining-=amount;reverse.remaining+=amount;
   // Keep the signed augmentation account: capacity - residual loses small
   // transfers on large links. Reverse augmentations cancel the same account.
   e.flow+=amount;reverse.flow-=amount;
  }
 }
 const routed=physical.map(({link,edge:e})=>{
  const flow=e.flow,a=index.get(link.from),b=index.get(link.to);
  if(flow>=0){power[a].exports+=flow;power[b].imports+=flow;}
  else{power[a].imports-=flow;power[b].exports-=flow;}
  return {...link,flow};
 });
 return {links:routed,power:power.map(p=>({...p,deliveredPower:Math.max(0,p.rawPower+(p.imports-p.exports))}))};
}
