const NS='http://www.w3.org/2000/svg';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const element=(document,tag,attributes={})=>{const node=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));return node;};
const compact=value=>Number(value).toLocaleString('en-GB',{maximumFractionDigits:1});

/** Animate only observed model flows/activity. Motion never changes model state. */
export function decorateWorldMap(root,view,{previousView=null,playing=false}={}){
 const document=root.ownerDocument;
 const reduced=document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
 const svg=root.querySelector('svg');if(!svg)return;
 svg.classList.toggle('motion-enabled',!reduced&&playing&&view.t>0);
 svg.dataset.intervalState=view.t<=0?'unmeasured':playing?'playing':'paused-last-interval';
 for(const region of view.regions){
  const tile=Array.from(svg.querySelectorAll('[data-region]')).find(node=>node.dataset.region===region.id);if(!tile)continue;
  tile.classList.toggle('has-compute',view.t>0&&region.active>0);
  tile.classList.toggle('has-construction',(region.queue?.length??0)>0);
  tile.classList.toggle('has-shortage',view.t>0&&region.sH<.8);
  const host=tile.querySelector('[data-key="motion"]');if(!host)continue;
  const existingSmoke=host.querySelector('.working-smoke');
  if(view.t>0&&region.active>0&&!existingSmoke){
   const smoke=element(document,'g',{'class':'working-smoke','aria-hidden':'true'});
   for(let i=0;i<3;i++)smoke.append(element(document,'circle',{cx:-5+i*5,cy:-36-i*7,r:3+i,style:`--delay:${i*.7}s`}));host.append(smoke);
  }
  if((view.t<=0||!(region.active>0))&&existingSmoke)existingSmoke.remove();
  const previous=previousView?.regions.find(r=>r.id===region.id);
  if(!previous||view.t<previousView.t)host.querySelector('.commission-label')?.remove();
  if(previous&&view.t>previousView.t){
   host.querySelector('.commission-label')?.remove();
   const gain=region.G-previous.G;
   if(gain>1e-6){
    const label=element(document,'text',{'class':'commission-label',x:0,y:-90,'text-anchor':'middle','aria-hidden':'true'});
    label.textContent=`+${compact(gain)} TWh/yr`;host.append(label);
   }
  }
 }
 for(const link of svg.querySelectorAll('[data-link]')){
  const flow=Number(link.dataset.flow),capacity=Number(link.dataset.capacity);
  if(!finite(flow)||flow===0)continue;
  const path=link.querySelector('.link-flow');if(!path)continue;
  path.classList.add('moving-power');
  path.style.setProperty('--flow-duration',`${2.8-1.8*Math.min(1,Math.abs(flow)/Math.max(1e-12,capacity))}s`);
 }
}

export function worldChanges(before,after){
 if(!before||after.t<=before.t)return [];
 return after.regions.flatMap(region=>{
  const old=before.regions.find(r=>r.id===region.id);if(!old)return [];
  return [['power','G'],['factory','F']].filter(([,key])=>region[key]-old[key]>1e-6)
   .map(([kind,key])=>({t:after.t,intervalStart:before.t,regionId:region.id,regionName:region.name,type:'commissioned',kind,amount:region[key]-old[key]}));
 });
}

export function eventDescription(event,regionName=''){
 const kind=event.type==='commissioned'?'commissioned':event.kind??event.type;
 const name=regionName||event.regionName||event.regionId||'World';
 if(['tech','technology','breakthrough','human-tech','technology-breakthrough'].includes(kind))return `${name}: human technology breakthrough. Essential-resource efficiency improves under the scenario rule.`;
 if(['pandemic','epidemic'].includes(kind))return `${name}: pandemic. Temporary additional mortality; the model does not simulate transmission.`;
 if(['disaster','natural-disaster'].includes(kind))return `${name}: natural disaster. Usable electricity falls temporarily.`;
 if(kind==='supply-shock')return `${name}: supply shock. Usable electricity is reduced for this scenario year.`;
 if(kind==='commissioned'){
  const capacity=`${compact(event.amount)} ${event.kind==='power'?'TWh/year of power':'blocks/year of fabrication'}`;
  return finite(event.intervalStart)?`${name}: ${capacity} added between years ${compact(event.intervalStart)} and ${compact(event.t)}. First service time is not dated by this comparison.`:`${name}: ${capacity} entered service.`;
 }
 return `${name}: ${String(kind??'scenario event').replaceAll('-',' ')}.`;
}
