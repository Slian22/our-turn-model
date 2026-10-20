/** Checkpoint consistency checks, not cryptographic authentication of user data.
 * A checkpoint is source/config bound, finite, bounded JSON with independently
 * reconciled physical, demographic, policy and interval accounts.
 */
import {makeConfig,VERSION,SCHEMA,plain} from './config.mjs';
import {SOURCE_DIGEST} from './version.mjs';
import {configurationId,canonical} from './identity.mjs';
import {initialAssetState} from './assets.mjs';
import {initialEventState,processEvents,eventConditions} from './events.mjs';
import {initialPolicyState} from './policy.mjs';
import {energyPerBlock,efficiency,support,capabilityStep,criticalIntensity,humanStep,demandStep,demographicParameters} from './math.mjs';
import {physicalView} from './dynamics.mjs';
import {initialInfrastructure,validateInfrastructureState,infrastructureView,extractMaterials,settleInfrastructure} from './infrastructure.mjs';
import {CHECKPOINT_BYTES,EXPANDED_NODES,CHECKPOINT_DEPTH,COLLECTION_LENGTH,MAX_STRING} from './checkpoint-limits.mjs';

export const MAX_TEXT=CHECKPOINT_BYTES;
const PHYSICAL=['hardware','factory','power'],KINDS=[...PHYSICAL,'adoption','retrofit','demolition'];
const TECH=['algorithm','hardware','manufacturing','land','power'];
const DIAGNOSTICS=['minimumPopulation','maximumPopulation','landAdequacy','materialFree','policyAccess',
 'regionalPowerLimited','storageLimited','coolingWaterLimited','heatLimited','refiningLimited','workLimited','energyLimited'];
const COMPETITION=['competitionMode','competitionHumanValue','competitionAiValue','competitionLogRatio',
 'competitionTargetAiShare','competitionActualAiShare','competitionObserved','competitionLeader',
 'competitionFlip','competitionPool','protectedReserve','competitionHumanAtFloor','queuePendingCount'];
const sum=(rows,f)=>rows.reduce((v,row)=>v+f(row),0);
function requireValue(ok,label){if(!ok)throw new TypeError(`Invalid revised checkpoint: ${label}`);}
function num(v,label,min=0,max=Infinity){requireValue(Number.isFinite(v)&&v>=min&&v<=max,label);}
function close(a,b,label){requireValue(Math.abs(a-b)<=1e-7+2e-10*Math.max(Math.abs(a),Math.abs(b)),label);}
function identity(a,b,label){requireValue(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-12*Math.max(Math.abs(a),Math.abs(b)),label);}
function keys(v,allowed,label){requireValue(plain(v),label);requireValue(Object.keys(v).every(k=>allowed.includes(k)),`${label} unknown field`);}
function unique(rows,label){requireValue(new Set(rows).size===rows.length,label);}
function finiteTree(root){
 const stack=[[root,0]];let nodes=0;
 while(stack.length){
  const [v,depth]=stack.pop();requireValue(++nodes<=EXPANDED_NODES&&depth<=CHECKPOINT_DEPTH,'JSON complexity budget');
  if(typeof v==='number')num(v,'finite JSON number',-Infinity);
  else if(typeof v==='string')requireValue(v.length<=MAX_STRING,'string length');
  else if(v!==null&&typeof v==='object'){
   requireValue(Array.isArray(v)||plain(v),'plain JSON object');
   requireValue(Object.keys(v).length<=COLLECTION_LENGTH,'collection length');
   for(const [key,value] of Object.entries(v)){
    requireValue(!['__proto__','prototype','constructor'].includes(key),'unsafe object key');
    stack.push([value,depth+1]);
   }
  }else requireValue(v===null||typeof v==='boolean','JSON value');
 }
}
function physicalInitial(c){
 return c.aiEnabled?c:{...c,initial:{...c.initial,hardware:0,aiPower:0,aiFactories:0,
  humanPower:c.initial.humanPower+c.initial.aiPower,humanFactories:c.initial.humanFactories+c.initial.aiFactories}};
}
function requestContract(s,p){
 const entry=s.requestIds[p.requestId];
 if(!entry){
  requireValue(p.requestId===p.id||(p.kind==='demolition'&&p.targetIds.length===1&&
   p.requestId===`demolition:${p.targetIds[0]}`),'project request cache missing');return {};
 }
 requireValue(entry.receipt.status==='accepted'&&entry.receipt.projectId===p.id,'accepted request project');
 const pairs=JSON.parse(entry.signature);
 requireValue(Array.isArray(pairs)&&pairs.every(pair=>Array.isArray(pair)&&pair.length===2&&typeof pair[0]==='string'),'request signature');
 unique(pairs.map(pair=>pair[0]),'request signature keys');
 const r=Object.fromEntries(pairs);
 keys(r,['id','kind','owner','amount','priority','hardwareEfficiency','manufacturingEfficiency','landMultiplier',
  'energyMultiplier','target','multiplier','targetIds','energy','work','delay','eventId','expiresAt'],'request contract');
 requireValue(r.id===p.requestId&&r.kind===p.kind&&r.owner===p.owner,'request contract identity');
 close(entry.receipt.requestedAmount,r.amount,'request original amount');close(entry.receipt.amount,p.amount,'accepted request amount');
 requireValue(p.amount<=r.amount+2e-10*Math.max(p.amount,r.amount),'scaled request quantity');
 close(p.priority,r.priority??0,'request priority');
 for(const key of ['hardwareEfficiency','manufacturingEfficiency','multiplier'])close(p[key],r[key]??1,`request ${key}`);
 for(const key of ['target','eventId','expiresAt'])requireValue(p[key]===(r[key]??null),`request ${key}`);
 if(!PHYSICAL.includes(p.kind)&&p.kind!=='adoption')requireValue(canonical(p.targetIds)===canonical(r.targetIds),'request target IDs');
 return r;
}
function intrinsic(s,target,time){
 return Math.max(1,...s.projects.filter(p=>p.kind==='adoption'&&p.status==='completed'&&
  p.requestId.startsWith('capability:')&&p.target===target&&p.completedAt<=time).map(p=>p.multiplier));
}
function knownEfficiency(s,events,target,time){
 return intrinsic(s,target,time)*events.records.filter(e=>e.type===target&&e.adoptionStatus==='adopted'&&
  e.adoptedAt<=time&&e.observedAt<=time&&(e.expiresAt===null||time<e.expiresAt)).reduce((v,e)=>v*e.magnitude,1);
}
function validateContracts(s,c,t,events){
 plain(s.requestIds,'request cache');
 for(const [id,entry] of Object.entries(s.requestIds)){
  keys(entry,['signature','receipt'],'request cache entry');requireValue(typeof entry.signature==='string','request signature');
  const r=entry.receipt;
  keys(r,['id','requestId','projectId','kind','owner','requestedAmount','amount','status','reason'],'cached receipt');
  requireValue(r.id===id&&r.requestId===id&&['accepted','rejected'].includes(r.status),'cached receipt identity');
  num(r.amount,'cached amount');
  if(r.status==='accepted')requireValue(s.projects.some(p=>p.id===r.projectId&&p.requestId===id&&p.kind===r.kind&&p.owner===r.owner),'cached project');
  else requireValue(r.projectId===null&&r.amount===0&&typeof r.reason==='string','rejected receipt');
 }
 unique(s.projects.map(p=>p.requestId),'project request IDs');
 const initial=initialAssetState(physicalInitial(c)),old=new Map(initial.assets.map(a=>[a.id,a])),unmatched=new Set(s.assets.filter(a=>!old.has(a.id)));
 for(const p of s.projects){
  const r=requestContract(s,p),spec=c.assets[p.kind];
  let energy,work,delay;
  if(PHYSICAL.includes(p.kind)){
   const land=r.landMultiplier??1,multiplier=r.energyMultiplier??1;
   num(land,'land multiplier',Number.MIN_VALUE);num(multiplier,'energy multiplier',Number.MIN_VALUE);
   close(p.footprint,p.amount*spec.land*land,'declared new footprint');
   if(r.landMultiplier!==undefined)close(land,1/knownEfficiency(s,events,'land',p.start),'known land efficiency');
   if(p.kind==='power'&&r.energyMultiplier!==undefined)close(multiplier,1/knownEfficiency(s,events,'power',p.start),'known power efficiency');
   energy=p.amount*spec.energy*(p.kind==='power'?multiplier:1);work=p.amount*spec.work;delay=spec.delay;
   for(const [field,target] of [['hardwareEfficiency','hardware'],['manufacturingEfficiency','manufacturing']])
    close(p[field],knownEfficiency(s,events,target,p.start),`known new ${target} efficiency`);
   requireValue(p.targetIds.length===0&&p.target===null&&p.eventId===null&&p.expiresAt===null,'physical project targets');
   if(p.status==='completed'){
    const a=[...unmatched].find(a=>a.kind===p.kind&&a.owner===p.owner&&a.birth===p.completedAt&&a.rated===p.amount&&
     a.footprint===p.footprint&&a.materials===p.materials&&a.embodiedEnergy===p.energyRequired&&a.embodiedWork===p.workRequired);
    requireValue(Boolean(a),'bijective commissioned cohort');old.set(a.id,{...a,hardwareEfficiency:p.hardwareEfficiency,manufacturingEfficiency:p.manufacturingEfficiency});unmatched.delete(a);
   }
  }else{
   requireValue(p.footprint===0&&p.materials===0,'nonconstruction commitments');
   if(p.kind==='demolition'){
    const targets=p.targetIds.map(id=>s.assets.find(a=>a.id===id));
    requireValue(targets.length>0&&targets.every(a=>a.owner===p.owner&&a.birth+c.assets[a.kind].life<=p.start&&a.demolitionProjectId===p.id),'demolition ownership/retirement');
    close(p.amount,sum(targets,a=>a.rated),'demolition rated amount');
    energy=sum(targets,a=>a.embodiedEnergy)*c.assets.demolitionEnergyFraction;
    work=sum(targets,a=>a.embodiedWork)*c.assets.demolitionWorkFraction;delay=c.assets.demolitionDelay;
    for(const a of targets)requireValue(a.cleared===(p.status==='completed')&&(!a.cleared||a.clearedAt===p.completedAt),'funded demolition clearance');
   }else{
    energy=p.kind==='adoption'?(r.energy??p.amount*c.assets.adoptionEnergy):p.amount*c.assets.adoptionEnergy;
    work=p.kind==='adoption'?(r.work??p.amount*c.assets.adoptionWork):p.amount*c.assets.adoptionWork;delay=r.delay??c.assets.adoptionDelay;
    if(p.kind==='adoption')requireValue(TECH.includes(p.target)&&p.targetIds.length===0,'adoption target');
    else {
     requireValue(['hardware','manufacturing'].includes(p.target)&&p.targetIds.length>0,'retrofit target');
     const targets=p.targetIds.map(id=>s.assets.find(a=>a.id===id));
     requireValue(targets.every(a=>a.owner===p.owner&&a.kind===(p.target==='hardware'?'hardware':'factory')&&a.birth<=p.start&&p.start<a.birth+c.assets[a.kind].life),'owned active retrofit');
     close(p.amount,sum(targets,a=>a.rated),'retrofit rated amount');
     if(p.status==='completed')requireValue(targets.every(a=>p.completedAt<a.birth+c.assets[a.kind].life),'retrofit before retirement');
    }
   }
  }
  identity(p.energyRequired,energy,'declared project energy');identity(p.workRequired,work,'declared project work');identity(p.readyAt,p.start+delay,'exact project lead');
  if(p.requestId.startsWith('capability:')){
   requireValue(p.kind==='adoption'&&['algorithm','hardware','manufacturing'].includes(p.target)&&p.eventId===null,'capability adoption contract');
  }
 }
 requireValue(unmatched.size===0,'cohort without completed project');
 for(const a of s.assets){
  const base=old.get(a.id);requireValue(Boolean(base),'cohort origin');
  for(const [field,target] of [['hardwareEfficiency','hardware'],['manufacturingEfficiency','manufacturing']]){
   const retrofits=s.projects.filter(p=>p.kind==='retrofit'&&p.status==='completed'&&p.target===target&&p.targetIds.includes(a.id));
   close(a[field],retrofits.reduce((v,p)=>v*p.multiplier,base[field]),'paid vintage efficiency');
  }
  if(a.retired)requireValue(s.projects.some(p=>p.kind==='demolition'&&p.id===a.demolitionProjectId&&p.targetIds.includes(a.id)),'retirement demolition project');
  else requireValue(a.demolitionProjectId===null,'live cohort demolition');
 }
 for(const receipt of s.receipts){
  const p=s.projects.find(p=>p.id===receipt.projectId),cache=s.requestIds[receipt.requestId];
  if(['accepted','rejected'].includes(receipt.status))requireValue(cache&&canonical(receipt)===canonical(cache.receipt),'asset request receipt');
  else {
   requireValue(p&&receipt.requestId===p.requestId&&receipt.kind===p.kind&&receipt.status===p.status,'asset completion receipt');
   requireValue(['completed','cancelled','expired'].includes(receipt.status),'asset receipt status');
   if(receipt.status!=='expired')for(const key of ['completedAt','owner','amount','target','multiplier','eventId','expiresAt'])
    requireValue(receipt[key]===p[key],`asset receipt ${key}`);
  }
 }
 return old;
}
function validateAssets(s,c,t){
 keys(s,['assets','projects','materials','nextId','accounts','requestIds','receipts'],'asset state');
 requireValue(Array.isArray(s.assets)&&Array.isArray(s.projects)&&Array.isArray(s.receipts),'asset arrays');
 num(s.materials,'material stock');requireValue(Number.isSafeInteger(s.nextId)&&s.nextId>0,'physical next ID');
 const initial=initialAssetState(physicalInitial(c)),initialById=new Map(initial.assets.map(a=>[a.id,a]));
 const allIds=[...s.assets,...s.projects].map(a=>a.id);unique(allIds,'physical IDs');
 let greatest=0;
 for(const a of s.assets){
  keys(a,['id','kind','owner','rated','birth','footprint','materials','embodiedEnergy','embodiedWork',
   'hardwareEfficiency','manufacturingEfficiency','retired','retiredAt','cleared','clearedAt','demolitionProjectId'],'cohort');
  requireValue(/^asset-\d+$/.test(a.id)&&PHYSICAL.includes(a.kind)&&['human','ai'].includes(a.owner),'cohort identity');
  requireValue(Number.isSafeInteger(Number(a.id.slice(6)))&&Number(a.id.slice(6))>0,'cohort numeric ID');
  greatest=Math.max(greatest,Number(a.id.slice(6)));
  num(a.rated,'cohort rated',Number.MIN_VALUE);num(a.birth,'cohort birth',-Infinity,t);
  for(const k of ['footprint','materials','embodiedEnergy','embodiedWork'])num(a[k],`cohort ${k}`);
  for(const k of ['hardwareEfficiency','manufacturingEfficiency'])num(a[k],`cohort ${k}`,Number.MIN_VALUE);
  requireValue(typeof a.retired==='boolean'&&typeof a.cleared==='boolean','cohort flags');
  const retiredAt=a.birth+c.assets[a.kind].life;
  requireValue(a.retired===(retiredAt<=t),'retirement by age');
  if(a.retired)close(a.retiredAt,retiredAt,'retirement time');else requireValue(a.retiredAt===null,'unretired timestamp');
  if(a.cleared){requireValue(a.retired,'clearance after retirement');num(a.clearedAt,'clearance time',a.retiredAt,t);}
  else requireValue(a.clearedAt===null,'uncleared timestamp');
  const old=initialById.get(a.id);
  if(old)for(const k of ['kind','owner','rated','birth','footprint','materials','embodiedEnergy','embodiedWork'])
   requireValue(a[k]===old[k],`initial cohort ${k}`);
 }
 for(const a of initial.assets)requireValue(s.assets.some(v=>v.id===a.id),'initial cohort retained');
 for(const p of s.projects){
  keys(p,['id','sequence','requestId','kind','owner','amount','priority','start','readyAt','energyRequired','workRequired',
   'energySpent','workDone','remainingEnergy','remainingWork','progress','status','footprint','materials',
   'hardwareEfficiency','manufacturingEfficiency','target','multiplier','targetIds','eventId','expiresAt','completedAt'],'project');
  requireValue(p.id===`project-${p.sequence}`&&Number.isSafeInteger(p.sequence)&&p.sequence>0,'project ID');
  greatest=Math.max(greatest,p.sequence);requireValue(KINDS.includes(p.kind)&&['ai','human'].includes(p.owner),'project kind/owner');
  num(p.amount,'project amount',Number.MIN_VALUE);num(p.start,'project start',0,t);num(p.readyAt,'project lead',p.start);
  num(p.priority,'project priority',-Infinity);num(p.progress,'project progress',0,1);
  for(const key of ['hardwareEfficiency','manufacturingEfficiency','multiplier'])num(p[key],`project ${key}`,Number.MIN_VALUE);
  requireValue(typeof p.requestId==='string'&&p.requestId.length>0,'request ID');
  for(const k of ['energyRequired','workRequired','energySpent','workDone','remainingEnergy','remainingWork','footprint','materials'])num(p[k],`project ${k}`);
  close(p.energySpent,p.energyRequired*p.progress,'project paid energy');close(p.workDone,p.workRequired*p.progress,'project paid work');
  close(p.remainingEnergy,p.energyRequired-p.energySpent,'remaining energy');close(p.remainingWork,p.workRequired-p.workDone,'remaining work');
  requireValue(['pending','completed','cancelled','expired'].includes(p.status),'project status');
  requireValue(Array.isArray(p.targetIds)&&p.targetIds.every(id=>s.assets.some(a=>a.id===id)),'project targets');
  unique(p.targetIds,'project target IDs');
  if(p.expiresAt!==null)num(p.expiresAt,'project expiry',p.start);
  if(p.status==='completed'||p.status==='cancelled'){
   num(p.completedAt,'project completion',p.readyAt,t);requireValue(p.progress===1,'completed project funding');
   if(p.expiresAt!==null)requireValue(p.completedAt<p.expiresAt,'deployment before expiry');
  }
  if(p.status==='expired')requireValue(p.kind==='adoption'&&p.expiresAt!==null&&p.expiresAt<=t,'expired adoption');
  if(PHYSICAL.includes(p.kind)){
   close(p.workRequired,p.amount*c.assets[p.kind].work,'physical construction work');
   close(p.materials,p.amount*c.assets[p.kind].materials,'physical embodied materials');
   if(p.status==='completed')requireValue(s.assets.some(a=>!initialById.has(a.id)&&a.kind===p.kind&&a.owner===p.owner&&
    a.birth===p.completedAt&&a.rated===p.amount&&a.footprint===p.footprint&&a.materials===p.materials),'commissioned cohort');
  }
 }
 requireValue(s.nextId>greatest,'physical next ID collision');
 const a=s.accounts;
 keys(a,['initialStock','initialEmbodied','initialMaterials','primarySupplied','virginCommitted','recycledCommitted','recycledRecovered',
  'materialsCommitted','materialsDisposed','energySpent','workDone'],'asset accounts');
 for(const [k,v] of Object.entries(a))num(v,`asset account ${k}`);
 for(const k of ['initialStock','initialEmbodied','initialMaterials'])close(a[k],initial.accounts[k],`initial material ${k}`);
 const embodied=sum(s.assets.filter(a=>!a.cleared),a=>a.materials);
 const pipeline=sum(s.projects.filter(p=>p.status==='pending'&&PHYSICAL.includes(p.kind)),p=>p.materials);
 close(s.materials+embodied+pipeline+a.materialsDisposed,a.initialMaterials+a.primarySupplied,'material conservation');
 close(s.materials,a.initialStock+a.primarySupplied-a.virginCommitted+a.recycledRecovered-a.recycledCommitted,'material stock account');
 close(a.materialsCommitted,a.virginCommitted+a.recycledCommitted,'material commitment accounts');
 close(a.materialsCommitted,sum(s.projects,p=>p.materials),'project committed materials');
 close(a.energySpent,sum(s.projects,p=>p.energySpent),'project energy accounts');
 close(a.workDone,sum(s.projects,p=>p.workDone),'project work accounts');
 close(a.recycledRecovered,sum(s.assets.filter(a=>a.cleared),a=>a.materials*c.resources.recycling),'recycled material');
 close(a.materialsDisposed,sum(s.assets.filter(a=>a.cleared),a=>a.materials*(1-c.resources.recycling)),'disposed material');
 requireValue(sum(s.assets.filter(a=>!a.cleared),a=>a.footprint)+sum(s.projects.filter(p=>p.status==='pending'&&PHYSICAL.includes(p.kind)),p=>p.footprint)<=c.resources.land+1e-7,'land overcommitment');
}
function validateObservation(row,t){
 keys(row,['t','H','q','exposure','deficit','supply','need','coverage','fundingShare','powerAvailability',
  'technology','plans','dependencies','authorized','observedAt'],'policy observation');
 num(row.t,'observation sample',0,t);num(row.observedAt,'observation release',row.t);
 for(const key of ['H','q','exposure','deficit','supply','need','coverage','fundingShare'])
  if(Object.hasOwn(row,key))num(row[key],`observed ${key}`);
 if(Object.hasOwn(row,'powerAvailability'))num(row.powerAvailability,'observed powerAvailability',0,1);
 if(Object.hasOwn(row,'authorized'))requireValue(typeof row.authorized==='boolean','observed authority');
 keys(row.technology,TECH,'observed technology');for(const value of Object.values(row.technology))num(value,'observed technology');
 requireValue(Array.isArray(row.plans),'observed plans');
 for(const plan of row.plans){
  keys(plan,['id','time','powerDelta','needDelta'],'observed plan');requireValue(typeof plan.id==='string','observed plan ID');
  num(plan.time,'observed plan time');num(plan.powerDelta,'observed power change',-Infinity);num(plan.needDelta,'observed need change',-Infinity);
 }
 keys(row.dependencies,['rsiOnHumans','humansOnRsi','uncovered'],'observed dependencies');
 for(const key of ['rsiOnHumans','humansOnRsi']){
  requireValue(Array.isArray(row.dependencies[key]),'observed dependency services');
  for(const service of row.dependencies[key]){
   keys(service,['service','fraction','covered'],'observed service');
   requireValue(typeof service.service==='string'&&typeof service.covered==='boolean','observed service type');
   num(service.fraction,'observed service fraction',0,1);
  }
 }
 requireValue(Array.isArray(row.dependencies.uncovered)&&row.dependencies.uncovered.every(v=>typeof v==='string'),'observed uncovered services');
}
function validatePolicies(s,c){
 const policies=[...s.policyArchive,s.policyState],actions=policies.flatMap(p=>p.actions);unique(actions.map(a=>a.id),'policy action IDs');
 for(const p of policies){
  keys(p,['version','controller','actions','receipts','rngState','nextId','energySpent','workSpent'],'policy state');
  requireValue(p.version===1&&Number.isSafeInteger(p.nextId)&&p.nextId>0,'policy version/ID');
  num(p.rngState,'policy RNG',0,4294967295);requireValue(Number.isInteger(p.rngState),'integer policy RNG');
  for(const a of p.actions){
   keys(a,['id','type','target','intensity','cap','residual','success','start','createdAt','eligibleAt','expiresAt',
    'energyRequired','workRequired','energyPaid','workPaid','paidAt','priority','status','attempted','draw',
    'effective_from','prerequisites','attemptedAt'],'policy action');
   requireValue(/^policy-\d+$/.test(a.id)&&['cap','shutdown'].includes(a.type),'policy action');
   requireValue(Number(a.id.slice(7))<p.nextId,'policy next ID collision');
   for(const k of ['start','createdAt','eligibleAt'])num(a[k],`action ${k}`);
   requireValue(a.createdAt<=s.t&&a.eligibleAt>=a.start,'policy chronology');
   for(const k of ['energyRequired','workRequired','energyPaid','workPaid'])num(a[k],`action ${k}`);
   requireValue(a.energyPaid<=a.energyRequired&&a.workPaid<=a.workRequired,'policy overpayment');
   requireValue(['waiting','unfunded','funding','ready','unauthorized','active','failed','expired'].includes(a.status),'policy status');
   const paid=a.energyPaid===a.energyRequired&&a.workPaid===a.workRequired;
   if(['active','ready','unauthorized'].includes(a.status))requireValue(paid,'policy status paid funding');
   if(a.status==='active')requireValue(a.effective_from!==null,'active policy deployment');
   for(const k of ['cap','priority'])num(a[k],`action ${k}`);
   for(const k of ['success','residual'])num(a[k],`action ${k}`,0,1);
   requireValue(typeof a.attempted==='boolean','policy attempted flag');
   if(p===s.policyState){
    for(const [field,key] of [['energyRequired','cost'],['workRequired','work'],['cap','cap'],['success','success'],['residual','residual']])close(a[field],c.policy[key],`configured policy ${key}`);
    close(a.eligibleAt,a.start+c.policy.delay,'configured policy eligibility');
   }
   if(a.expiresAt!==null)num(a.expiresAt,'policy expiry',a.start);
   if(a.paidAt!==null)num(a.paidAt,'policy payment time',Math.max(a.createdAt,a.eligibleAt),s.t);
   if(a.effective_from!==null){
    num(a.effective_from,'policy effective time',Math.max(a.createdAt,a.eligibleAt,a.paidAt??0),s.t);
    close(a.energyPaid,a.energyRequired,'deployed policy paid energy');close(a.workPaid,a.workRequired,'deployed policy paid work');
    if(a.expiresAt!==null)requireValue(a.effective_from<a.expiresAt,'policy deployed before expiry');
   }
   if(a.attempted){requireValue(a.type==='shutdown','only shutdown draws');num(a.draw,'shutdown draw',0,1);num(a.attemptedAt,'attempt time',a.eligibleAt,s.t);}
   else requireValue(a.draw===null,'undrawn action');
   if(a.type==='shutdown'&&a.effective_from!==null)requireValue(a.attempted&&a.draw<a.success,'successful shutdown draw');
  }
  close(p.energySpent,sum(p.actions,a=>a.energyPaid),'policy paid energy account');
  close(p.workSpent,sum(p.actions,a=>a.workPaid),'policy paid work account');
  const funding=p.receipts.filter(r=>r.kind==='policy-funding');unique(p.receipts.map(r=>r.id),'policy receipt IDs');
  for(const r of p.receipts){
   const action=p.actions.find(a=>a.id===r.requestId);requireValue(Boolean(action),'policy receipt action');
   requireValue(typeof r.id==='string'&&r.id.length>0,'policy receipt ID');
   if(r.kind==='policy-funding'){
    keys(r,['id','requestId','kind','time','intervalStart','energy','work'],'funding receipt');
    num(r.energy,'receipt energy');num(r.work,'receipt work');num(r.time,'receipt time',action.eligibleAt,s.t);
    num(r.intervalStart,'receipt interval',Math.max(action.createdAt,action.eligibleAt),r.time);
    requireValue(r.time>r.intervalStart,'positive funding interval');
   }else{
    keys(r,['id','requestId','kind','time','status','effective_from','draw'],'deployment receipt');
    requireValue(r.kind==='policy-deployment'&&r.id===`deployment:${action.id}`,'deployment receipt identity');
    num(r.time,'deployment receipt time',action.eligibleAt,s.t);
    requireValue(r.effective_from===action.effective_from&&r.draw===action.draw&&['active','failed'].includes(r.status),'deployment receipt result');
   }
  }
  close(p.energySpent,sum(funding,r=>r.energy),'policy energy receipts');close(p.workSpent,sum(funding,r=>r.work),'policy work receipts');
  keys(p.controller,['pending','history','known','signals'],'policy controller');
  requireValue(Array.isArray(p.controller.pending)&&Array.isArray(p.controller.history),'controller observations');
  for(const row of [...p.controller.pending,...p.controller.history])validateObservation(row,s.t);
  requireValue(canonical(p.controller.known)===canonical(p.controller.history.at(-1)??null),'latest known controller observation');
 }
 // Recompute the actual one-shot execution stream, independent of policy calls.
 let rng=initialPolicyState(c).rngState;
 const attempted=actions.filter(a=>a.attempted).sort((a,b)=>a.attemptedAt-b.attemptedAt||Number(a.id.slice(7))-Number(b.id.slice(7)));
 for(const a of attempted){
  rng=(rng+0x6D2B79F5)>>>0;let bits=Math.imul(rng^(rng>>>15),rng|1);bits^=bits+Math.imul(bits^(bits>>>7),bits|61);
  close(a.draw,((bits^(bits>>>14))>>>0)/4294967296,'execution RNG draw');
 }
 requireValue(s.policyRng===rng,'execution RNG stream');
}
function validateEvents(e,c,t,assets){
 keys(e,['version','rngState','nextAnnualYear','schedule','records','processedIds','observedIds','adoptedIds'],'event state');
 const expected=t===0?initialEventState(c):processEvents(initialEventState(c),t,c).state;
 for(const key of ['version','rngState','nextAnnualYear','schedule','processedIds','observedIds'])
  requireValue(canonical(e[key])===canonical(expected[key]),`exogenous event ${key}`);
 unique(e.records.map(r=>r.id),'event record IDs');unique(e.adoptedIds,'adopted event IDs');
 requireValue(e.records.length===expected.records.length,'event discovery records');
 for(const record of e.records){
  const original=expected.records.find(r=>r.id===record.id);requireValue(Boolean(original),'event record');
  for(const [k,v] of Object.entries(original))if(!['adoptionStatus','adoptedAt'].includes(k))requireValue(canonical(record[k])===canonical(v),`event ${k}`);
  if(record.adoptedAt!==null)num(record.adoptedAt,'adoption time',record.discoveredAt,t);
  const p=assets.projects.find(p=>p.requestId===record.adoptionRequestId);
  requireValue(['pending','adopted','expired','cancelled','rejected','not-applicable'].includes(record.adoptionStatus),'event adoption status');
  if(TECH.includes(record.type)&&c.aiEnabled){
   requireValue(p&&p.kind==='adoption'&&p.eventId===record.id&&p.target===record.type&&p.multiplier===record.magnitude,'event adoption project');
   close(p.energyRequired,record.adoptionEnergy,'event paid energy requirement');close(p.workRequired,record.adoptionWork,'event paid work requirement');
   close(p.readyAt,p.start+record.adoptionDelay,'event adoption lead');
   requireValue(p.expiresAt===record.expiresAt,'event adoption expiry');
   if(record.adoptionStatus==='adopted')requireValue(p.status==='completed'&&record.adoptedAt===p.completedAt&&
    (record.expiresAt===null||record.adoptedAt<record.expiresAt),'paid event deployment');
   else requireValue(record.adoptedAt===null&&p.status!=='completed','undeployed event record');
  }else requireValue(record.adoptedAt===null,'no-AI/nontechnology deployment');
 }
 requireValue(e.adoptedIds.every(id=>e.records.some(r=>r.id===id&&r.adoptedAt!==null)),'adopted event records');
 requireValue(e.records.filter(r=>r.adoptionStatus==='adopted').every(r=>e.adoptedIds.includes(r.id)),'complete adopted event IDs');
}
function vintage(a,field,target,t,assets,origins){
 return assets.projects.filter(p=>p.kind==='retrofit'&&p.target===target&&p.status==='completed'&&
  p.completedAt<=t&&p.targetIds.includes(a.id)).reduce((v,p)=>v*p.multiplier,origins.get(a.id)[field]);
}
function historicalAllowed(s,c,time,hardware){
 const conditions=eventConditions(s.eventState,time,c);
 const active=[...s.policyArchive,s.policyState].map(p=>p.actions.find(a=>a.effective_from!==null&&
  a.effective_from<=time&&(a.expiresAt===null||time<a.expiresAt))).filter(Boolean);
 const cap=conditions.authorized?Math.min(Infinity,...active.filter(a=>a.type==='cap').map(a=>a.cap)):Infinity;
 const residual=conditions.authorized?Math.min(1,...active.filter(a=>a.type==='shutdown').map(a=>a.residual)):1;
 return Math.max(0,(1-conditions.coverage)*hardware+Math.min(conditions.coverage*hardware,cap)*residual);
}
function historicalInfrastructure(s,c,l,old,active,rated,availability,replay,effectiveHardware,hardware){
 const allowed=historicalAllowed(s,c,l.start,hardware);
 const factor=hardware>0?effectiveHardware/hardware:1;
 const task=c.ai.demandSchedule.filter(row=>row.time<=l.start).at(-1),requested=task?.utilisation??c.ai.utilisation;
 const utilisation=c.ai.workloadMode==='fixed-work'?Math.min(1,requested/Math.max(Number.MIN_VALUE,factor)):requested;
 const hardwareNeed=allowed*energyPerBlock(utilisation,c.ai.idleFraction);
 const power=owner=>sum(active.filter(a=>a.kind==='power'&&a.owner===owner),rated)*availability;
 const view=infrastructureView(replay,l.start,c,{H:old.H,humanPower:power('human'),aiPower:power('ai'),
  humanNeed:old.H*(criticalIntensity(l.start,c.human)+c.human.flexEnergy*old.flexibleDemand),
  // [TH-N5] Offer the installed discharge power; the engine schedules exact
  // depletion using actual dispatch. Inventory is debited by the paid interval.
  operationNeed:hardwareNeed,interval:Number.MIN_VALUE});
 const operationNeed=Math.min(hardwareNeed,view.coolingOperationLimit,view.accessibleAiPower);
 return {...view,allowed,utilisation,operationNeed,hardwareNeed,
  priorityProcessing:allowed*utilisation*factor*(hardwareNeed>0?Math.min(1,operationNeed/hardwareNeed):0)};
}
function validatePriority(s,c,l,old,view){
 const processing=view.priorityProcessing;
 const usage=old.ledger?(old.ledger.humanCritical+old.ledger.humanFlexible)/old.ledger.h:
  old.H*(criticalIntensity(l.start,c.human)+c.human.flexEnergy*old.flexibleDemand);
 const aiScore=c.priority.aiWeight*(processing/c.priority.processingReference);
 const humanScore=c.priority.humanWeight*(usage/c.priority.humanUsageReference);
 const winner=c.priority.mode==='static'||aiScore===humanScore?c.priority.tieBreak:aiScore>humanScore?'ai':'human';
 close(l.priorityProcessing,processing,'available processing for priority');close(l.utilisation,view.utilisation,'hardware workload utilisation');
 close(l.aiPriorityScore,aiScore,'available processing priority score');close(l.humanPriorityScore,humanScore,'delivered usage priority score');
 requireValue(l.priorityWinner===(winner==='ai'?1:0),'weighted action-priority winner');
 if(l.end===s.t){
  keys(s.last.priority,['aiScore','humanScore','winner'],'last priority');
  close(s.last.priority.aiScore,aiScore,'last AI priority score');close(s.last.priority.humanScore,humanScore,'last human priority score');
  requireValue(s.last.priority.winner===winner,'last action-priority winner');
 }
}
function replayMarginal(c,old,view,algorithm,lead){
 // [DOM-MARGINAL] Rebuild positive-value logs independently of the operating
 // helper: rounded zero values can still retain a meaningful log-domain ratio.
 const electricity=old.ledger?old.perCapitaElectricity:
  1000*(criticalIntensity(old.t,c.human)+c.human.flexEnergy*old.flexibleDemand);
 const research=view.priorityProcessing*algorithm*c.ai.researchFraction;
 const hp=c.human.qolMaximum>0,ap=c.aiEnabled&&c.priority.lambda>0&&c.ai.growth>0&&research>0&&view.operationNeed>0;
 const lh=hp?Math.log(c.human.qolMaximum)-Math.log(c.human.qolScale)-electricity/c.human.qolScale:-Infinity;
 const la=ap?Math.log(c.priority.lambda)+Math.log(c.ai.researchElasticity)+Math.log(c.ai.growth)+
  c.ai.researchElasticity*(Math.log(research)-Math.log(c.ai.researchReference))+
  (1-c.ai.difficulty)*Math.log(old.q)-Math.log(view.operationNeed):-Infinity;
 const ratio=hp?(ap?lh-la:Infinity):(ap?-Infinity:0),x=c.priority.sharpness*ratio;
 const share=!hp&&!ap?.5:!ap?1:!hp?0:c.priority.sharpness===0?.5:
  x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
 return {humanValue:Math.exp(lh),aiValue:Math.exp(la),ratio,share,
  leader:ratio>c.priority.hysteresis?'human':ratio<-c.priority.hysteresis?'ai':lead??c.priority.tieBreak};
}
function pendingAt(p,time,endpoint){
 const admitted=p.start<time||p.start===time&&(!endpoint||p.kind==='demolition'||p.eventId!==null);
 return admitted&&(p.expiresAt===null||time<p.expiresAt)&&
  (p.completedAt==null||time<p.completedAt);
}
function validateCompetition(s,c,l,old,view,algorithm,lead){
 const critical=old.H*criticalIntensity(l.start,c.human)*l.h;
 const humanNeed=critical+old.H*c.human.flexEnergy*old.flexibleDemand*l.h;
 const reserve=Math.min(view.sourcePower,view.accessibleHumanPower,humanNeed/l.h,
  c.alignment*c.human.memEnergy*Math.max(old.H,c.initial.H))*l.h;
 const pool=Math.max(0,view.sourcePower*l.h-reserve-l.maintenance-l.extraction-l.policy-l.construction);
 const humanResidual=Math.min(Math.max(0,view.accessibleHumanPower*l.h-reserve),Math.max(0,humanNeed-reserve));
 const aiNeed=view.operationNeed*l.h,marginal=replayMarginal(c,old,view,algorithm,lead);
 const total=humanResidual+c.ai.competitionWeight*aiNeed,isMarginal=c.priority.operatingMode==='marginal';
 const target=isMarginal?1-marginal.share:total>0?c.ai.competitionWeight*aiNeed/total:.5;
 const proposed=isMarginal?marginal.leader:target>.5?'ai':target<.5?'human':lead??c.priority.tieBreak;
 const nextLead=pool>0?proposed:lead;
 let human=Math.min(humanResidual,isMarginal?pool*marginal.share:total>0?pool*humanResidual/total:0);
 const ai=total===0&&!isMarginal?0:Math.min(aiNeed,Math.max(0,pool-human));
 human+=Math.min(Math.max(0,humanResidual-human),Math.max(0,pool-human-ai));
 const delivered=reserve+human;
 const expected={competitionMode:isMarginal?1:0,competitionHumanValue:marginal.humanValue,competitionAiValue:marginal.aiValue,
  competitionLogRatio:Math.max(-700,Math.min(700,marginal.ratio)),competitionTargetAiShare:target,
  competitionActualAiShare:pool>0?ai/pool:0,competitionObserved:pool>0?1:0,competitionLeader:nextLead==='ai'?1:0,
  competitionFlip:pool>0&&lead!==null&&lead!==nextLead?1:0,competitionPool:pool,protectedReserve:reserve,
  competitionHumanAtFloor:old.H>0&&Math.abs(delivered-reserve)<=1e-9*Math.max(1,delivered,reserve)?1:0,
  queuePendingCount:s.assetState.projects.filter(p=>pendingAt(p,l.start,false)).length};
 for(const key of COMPETITION){
  if(['competitionMode','competitionObserved','competitionLeader','competitionFlip','competitionHumanAtFloor','queuePendingCount'].includes(key))
   requireValue(l[key]===expected[key],`competition ${key}`);
  else identity(l[key],expected[key],`competition ${key}`);
 }
 close(l.operation,ai,'competition operating allocation');close(l.humanCritical+l.humanFlexible,delivered,'competition human allocation');
 close(l.humanCritical,Math.min(critical,reserve)+Math.min(Math.max(0,critical-reserve),human),'protected critical allocation');
 return nextLead;
}
function validateHistoryMeasurements(s,c,p,origins,availability,lead){
 // [DOM-WIDE] Saved endpoints precede the next planning admission. Demolition
 // and exogenous adoption requests created by endpoint preparation are included.
 const active=s.assetState.assets.filter(a=>a.birth<=p.t&&p.t<a.birth+c.assets[a.kind].life&&p.t-a.birth<c.assets[a.kind].life);
 const rated=a=>a.rated*(1-(1-c.assets[a.kind].endPerformance)*(p.t-a.birth)/c.assets[a.kind].life);
 const humanPower=sum(active.filter(a=>a.kind==='power'&&a.owner==='human'),rated)*availability;
 const autonomous=sum(active.filter(a=>a.kind==='factory'&&a.owner==='ai'),a=>rated(a)*c.assets.factoryProductivity*
  vintage(a,'manufacturingEfficiency','manufacturing',p.t,s.assetState,origins))*availability*c.ai.autonomy;
 close(p.humanOwnedPower,humanPower,'history human-owned power');close(p.autonomousWork,autonomous,'history autonomous work');
 requireValue(p.queuePendingCount===(p.t===0?0:s.assetState.projects.filter(a=>pendingAt(a,p.t,true)).length),'history pending queue');
 requireValue(p.competitionLead===lead,'history chronological competition leader');
}
function infrastructureInterval(replay,c,l,view){
 // [TH-N4/N5/N6] Recreate every paid extraction and storage/cooling transition;
 // aggregate conservation alone would permit invented but balanced inflows.
 close(l.sourcePower,view.generatedPower+l.storageDischarge/l.h,'actually supplied source power');
 requireValue(l.sourcePower<=view.sourcePower+1e-7,'installed accessible source power');
 close(l.generatedEnergy,view.generatedPower*l.h,'reliability/grid-derived generation');
 close(l.serviceAdequacy,view.serviceAdequacy,'explicit human service adequacy');
 const extraction=extractMaterials(replay,l.start,l.h,{energyBudget:l.extraction,workBudget:l.extractionWork},c);
 close(extraction.materials,l.primaryMaterials,'paid primary material extraction');
 close(extraction.energyUsed,l.extraction,'paid extraction energy');close(extraction.workUsed,l.extractionWork,'paid extraction work');
 const spent=sum(['humanCritical','humanFlexible','operation','maintenance','construction','policy','extraction'],key=>l[key]);
 const discharge=Math.max(0,spent-l.generatedEnergy,
  l.humanCritical+l.humanFlexible-(view.accessibleHumanPower-view.storageDischargePower)*l.h,
  l.operation-(view.accessibleAiPower-view.storageDischargePower)*l.h);
 close(l.storageDischarge,discharge,'actual storage discharge');
 requireValue(l.storageDischarge<=view.storageDischargePower*l.h+1e-7,'available stored discharge');
 const st=c.infrastructure.storage;
 const charge=st.enabled&&discharge===0?Math.min(Math.max(0,l.generatedEnergy-spent),st.chargePower*l.h,
  Math.max(0,st.capacity-extraction.state.storage)/st.chargeEfficiency):0;
 close(l.storageCharge,charge,'actual surplus storage charge');
 requireValue(l.humanCritical+l.humanFlexible<=view.accessibleHumanPower*l.h+1e-7,'human grid accessibility');
 requireValue(l.operation<=view.operationNeed*l.h+1e-7,'AI grid/cooling accessibility');
 return settleInfrastructure(extraction.state,{h:l.h,dischargeEnergy:l.storageDischarge,
  chargeEnergy:l.storageCharge,operationEnergy:l.operation},c);
}
function historicalPolicyAccess(s,c,time){
 if(eventConditions(s.eventState,time,c).authorized)return false;
 return [...s.policyArchive,s.policyState].some(p=>p.actions.some(a=>{
  if(a.createdAt>time||a.eligibleAt>time||(a.expiresAt!==null&&time>=a.expiresAt)||
   (a.effective_from!==null&&a.effective_from<=time)||(a.attempted&&a.attemptedAt<=time))return false;
  const receipts=p.receipts.filter(r=>r.kind==='policy-funding'&&r.requestId===a.id&&r.time<=time);
  return sum(receipts,r=>r.energy)>=a.energyRequired&&sum(receipts,r=>r.work)>=a.workRequired;
 }));
}
function validateDiagnostics(s,c,l,old,view,people,land,replay,maintenanceNeed){
 // [TH-DIAGNOSTICS] These are derived interval observations, not free-form
 // output annotations. Reconstruct material stocks before this interval's extraction.
 const recovered=sum(s.assetState.assets.filter(a=>a.cleared&&a.clearedAt<=l.start),a=>a.materials*c.resources.recycling);
 const committed=sum(s.assetState.projects.filter(p=>p.start<=l.start),p=>p.materials);
 const materialFree=c.resources.materials+replay.primarySupplied+recovered-committed;
 const humanNeed=old.H*(criticalIntensity(l.start,c.human)+c.human.flexEnergy*old.flexibleDemand);
 const usedWork=l.maintenanceWork+l.constructionWork+l.policyWork+l.extractionWork;
 const expected={minimumPopulation:people.minPopulation,maximumPopulation:people.maxPopulation,landAdequacy:land,materialFree,
  policyAccess:historicalPolicyAccess(s,c,l.start)?1:0,
  regionalPowerLimited:c.infrastructure.grid.enabled&&(view.accessibleHumanPower<humanNeed||view.accessibleAiPower<view.hardwareNeed)?1:0,
  storageLimited:c.infrastructure.storage.enabled&&replay.storage<=1e-9?1:0,
  coolingWaterLimited:view.coolingWaterOperationLimit<view.hardwareNeed?1:0,
  heatLimited:view.heatOperationLimit<view.hardwareNeed?1:0,
  refiningLimited:c.infrastructure.extraction.enabled&&c.infrastructure.extraction.capacity<c.infrastructure.extraction.extractionRate?1:0,
  workLimited:l.workAvailable>0?(usedWork>0&&l.workAvailable-usedWork<=1e-9?1:0):(maintenanceNeed>0?1:0),
  energyLimited:l.humanCritical<old.H*criticalIntensity(l.start,c.human)*l.h-1e-9||l.operation<view.hardwareNeed*l.h-1e-9?1:0};
 for(const key of DIAGNOSTICS){
  if(key.endsWith('Limited')||key==='policyAccess')requireValue(l[key]===expected[key],`physical diagnostic ${key}`);
  else close(l[key],expected[key],`physical diagnostic ${key}`);
 }
}
function validateHistory(s,c,origins){
 requireValue(Array.isArray(s.history)&&s.history.length>=1&&s.history.length<=100001,'history');
 let previous=0;const totals={availableEnergy:0,humanEnergy:0,operationEnergy:0,maintenanceEnergy:0,unusedEnergy:0};
 let assetEnergy=0,policyEnergy=0,assetWork=0,policyWork=0,availability=1;
 const demographic={births:0,extraDeaths:0,personYears:0,shortagePersonYears:0,qolPersonYears:0};
 // [DOM-MEM-01 / THO-OUTPUT-V1] Recompute all reported welfare, extrema and
 // starvation statistics from the paid interval ledger, including within-step extrema.
 const outcomes={minPopulation:c.initial.H,maxPopulation:c.initial.H,minAdequacy:1,
  shortageYears:0,shortageEpisodes:0,energyShortfall:0,landShortfallPersonYears:0};
 let previousDeficit=0,infrastructure=initialInfrastructure(c),competitionLead=null;
 for(let i=0;i<s.history.length;i++){
  const p=s.history[i];num(p.t,'history time',previous,s.t);num(p.H,'history population',Number.MIN_VALUE);num(p.q,'history capability',Number.MIN_VALUE);
  keys(p,['t','H','q','exposure','power','hardware','factoryWork','criticalAdequacy','extraDeaths','shortagePersonYears',
   'policyCost','landUsed','materialStock','effectiveCompute','qualityOfLife','perCapitaElectricity',
   'qolPersonYears','flexibleDemand','ledger','queuePendingCount','autonomousWork','humanOwnedPower','competitionLead'],'history point');
  num(p.exposure,'history exposure',0,1);num(p.criticalAdequacy,'critical adequacy',0,1);
  // [CORE-01] Stored physical/output observations must retain nonnegative domains.
  for(const key of ['power','hardware','factoryWork','policyCost','landUsed','materialStock'])num(p[key],`history ${key}`);
  num(p.qualityOfLife,'history quality of life',0,c.human.qolMaximum);num(p.perCapitaElectricity,'history per-capita electricity');
  num(p.flexibleDemand,'history flexible demand',c.human.minimumFlexible,c.human.maximumFlexible);
  if(i===0){
   requireValue(p.t===0&&p.ledger===null,'initial history');close(p.H,c.initial.H,'initial population');
   identity(p.q,c.initial.q,'initial capability');requireValue(p.exposure===0,'initial exposure');
   close(p.criticalAdequacy,1,'initial critical adequacy');close(p.effectiveCompute,0,'initial unmeasured compute');
   close(p.qualityOfLife,0,'initial unmeasured quality of life');close(p.perCapitaElectricity,0,'initial unmeasured electricity');
   close(p.flexibleDemand,1,'initial flexible demand');
  }
  else {
   const l=p.ledger;requireValue(plain(l),'interval ledger');close(l.start,previous,'ledger start');close(l.end,p.t,'ledger endpoint');
   keys(l,['start','end','h','available','humanCritical','humanFlexible','operation','maintenance','construction','policy','unused',
    'workAvailable','maintenanceWork','constructionWork','policyWork','sourcePower','maintenanceAvailability','poweredBlocks',
    'utilisation','assetEnergyBefore','assetEnergyAfter','policyEnergyBefore','policyEnergyAfter',
    'aiPriorityScore','humanPriorityScore','priorityWinner','priorityProcessing','serviceAdequacy',
    'extraction','extractionWork','primaryMaterials','generatedEnergy','storageDischarge','storageCharge',...DIAGNOSTICS,...COMPETITION],'interval ledger');
   num(l.h,'positive interval',Number.MIN_VALUE);close(l.h,l.end-l.start,'interval duration');
   for(const key of ['available','humanCritical','humanFlexible','operation','maintenance','construction','policy','unused',
    'workAvailable','maintenanceWork','constructionWork','policyWork','extraction','extractionWork','primaryMaterials',
    'generatedEnergy','storageDischarge','storageCharge','priorityProcessing',...DIAGNOSTICS,...COMPETITION.filter(k=>k!=='competitionLogRatio')])num(l[key],`ledger ${key}`);
   num(l.competitionLogRatio,'competition log ratio',-700,700);
   close(l.available,sum(['humanCritical','humanFlexible','operation','maintenance','construction','policy','extraction','storageCharge','unused'],k=>l[k]),'energy conservation');
   close(l.available,l.sourcePower*l.h,'source-derived energy');
   num(l.maintenanceAvailability,'maintenance availability',0,1);close(l.maintenanceAvailability,availability,'maintenance continuity');
   num(l.poweredBlocks,'powered blocks');num(l.utilisation,'utilisation',0,1);
   // prepareAssets retires at birth+life, while physical performance uses the
   // computed age. At an adjacent floating-point boundary either can reach
   // life first, so the physical replay must honor both independent conditions.
   const active=s.assetState.assets.filter(a=>a.birth<=l.start&&l.start<a.birth+c.assets[a.kind].life&&
    l.start-a.birth<c.assets[a.kind].life);
   const rated=a=>a.rated*(1-(1-c.assets[a.kind].endPerformance)*(l.start-a.birth)/c.assets[a.kind].life);
   const old=s.history[i-1],needEnergy=old.H*criticalIntensity(l.start,c.human)*l.h;
   const hardware=active.filter(a=>a.kind==='hardware'),blocks=c.aiEnabled?sum(hardware,a=>a.rated):0;
   const hardwareEffective=sum(hardware,a=>rated(a)*vintage(a,'hardwareEfficiency','hardware',l.start,s.assetState,origins));
   const view=historicalInfrastructure(s,c,l,old,active,rated,availability,infrastructure,hardwareEffective,blocks);
   const previousInfrastructure=infrastructure;
   infrastructure=infrastructureInterval(infrastructure,c,l,view);
   const occupied=sum(s.assetState.assets.filter(a=>a.birth<=l.start&&(!a.cleared||a.clearedAt>l.start)),a=>a.footprint);
   const committed=sum(s.assetState.projects.filter(p=>PHYSICAL.includes(p.kind)&&p.start<=l.start&&
    (p.status==='pending'||p.completedAt>l.start)),p=>p.footprint);
   const humanLand=old.H*c.human.landPerMillion;
   const land=humanLand>0?Math.min(1,Math.max(0,c.resources.land-occupied-committed)/humanLand):1;
   const adequacy=Math.min(1,l.humanCritical/needEnergy,land,view.serviceAdequacy),people=humanStep(old,1-adequacy,l.h,demographicParameters(l.start,c.human));
   validateDiagnostics(s,c,l,old,view,people,land,previousInfrastructure,sum(active,a=>a.rated*c.assets[a.kind].maintenance));
   close(p.criticalAdequacy,adequacy,'physical critical adequacy');close(p.H,people.H,'population interval replay');close(p.exposure,people.exposure,'exposure interval replay');
   const electricity=(l.humanCritical+l.humanFlexible)/(l.h*old.H)*1000;
   const qualityOfLife=c.human.qolMaximum*(-Math.expm1(-electricity/c.human.qolScale));
   close(p.perCapitaElectricity,electricity,'delivered per-capita electricity');close(p.qualityOfLife,qualityOfLife,'MEM quality of life');
   for(const key of ['births','extraDeaths','personYears','shortagePersonYears'])demographic[key]+=people[key];
   demographic.qolPersonYears+=qualityOfLife*people.personYears;
   outcomes.minPopulation=Math.min(outcomes.minPopulation,people.minPopulation);
   outcomes.maxPopulation=Math.max(outcomes.maxPopulation,people.maxPopulation);
   outcomes.minAdequacy=Math.min(outcomes.minAdequacy,adequacy);
   const deficit=1-adequacy;
   outcomes.shortageYears+=deficit>1e-3?l.h:0;
   outcomes.shortageEpisodes+=deficit>1e-3&&previousDeficit<=1e-3?1:0;previousDeficit=deficit;
   outcomes.energyShortfall+=Math.max(0,needEnergy-l.humanCritical);
   outcomes.landShortfallPersonYears+=(1-land)*people.personYears;
   close(p.flexibleDemand,demandStep(old.flexibleDemand,adequacy,l.h,c.human,l.unused),'flexible demand interval replay');
   const factories=active.filter(a=>a.kind==='factory');
   const factory=a=>rated(a)*c.assets.factoryProductivity*vintage(a,'manufacturingEfficiency','manufacturing',l.start,s.assetState,origins)*availability;
   const factoryWork=sum(factories,factory),autonomous=sum(factories.filter(a=>a.owner==='ai'),factory)*c.ai.autonomy;
   const service=c.human.serviceBaseline*support(s.history[i-1].H,c.initial.H,c.human.supportHalfPopulation);
   close(l.workAvailable,Math.min(factoryWork,service+autonomous)*l.h,'physical work capacity');
   requireValue(l.poweredBlocks<=blocks+1e-7,'installed powered blocks');
   const effective=blocks>0?hardwareEffective*l.poweredBlocks/blocks*l.utilisation:0;
   validatePriority(s,c,l,old,view);
   const eventFactor=s.eventState.records.filter(e=>e.type==='algorithm'&&e.adoptionStatus==='adopted'&&e.adoptedAt<=l.start&&
    (e.expiresAt===null||l.start<e.expiresAt)).reduce((v,e)=>v*e.magnitude,1);
   competitionLead=validateCompetition(s,c,l,old,view,intrinsic(s.assetState,'algorithm',l.start)*eventFactor,competitionLead);
   const research=effective*intrinsic(s.assetState,'algorithm',l.start)*eventFactor*c.ai.researchFraction;
   if(i===s.history.length-1&&s.last!==null){
    close(s.last.criticalAdequacy,adequacy,'last critical adequacy');close(s.last.deficit,1-adequacy,'last actual deficit');
    close(s.last.energyAdequacy,Math.min(1,l.humanCritical/needEnergy),'last energy adequacy');close(s.last.landAdequacy,land,'last land adequacy');
    close(s.last.researchCapacity,research,'last actual research');close(s.last.effectiveCompute,effective,'last actual effective compute');
    close(s.last.poweredBlocks,l.poweredBlocks,'last powered blocks');close(s.last.utilisation,l.utilisation,'last utilization');
    close(s.last.qualityOfLife,qualityOfLife,'last quality of life');close(s.last.perCapitaElectricity,electricity,'last per-capita electricity');
   }
   close(p.q,c.aiEnabled?capabilityStep(s.history[i-1].q,research,l.h,c.ai):s.history[i-1].q,'capability replay');
   close(p.effectiveCompute,effective,'history effective compute');
   close(l.operation,l.poweredBlocks*energyPerBlock(l.utilisation,c.ai.idleFraction)*l.h,'physical operating energy');
   requireValue(l.maintenanceWork+l.constructionWork+l.policyWork+l.extractionWork<=l.workAvailable+1e-7,'work overcommitment');
   assetWork+=l.constructionWork;policyWork+=l.policyWork;
   const need=sum(active,a=>a.rated*c.assets[a.kind].maintenance);
   const target=need>0?Math.min(1,l.maintenanceWork/(l.h*need)):1;
   availability=target+(availability-target)*Math.exp(-l.h/c.assets.maintenanceTime);
   close(l.assetEnergyBefore,assetEnergy,'asset ledger continuity');close(l.assetEnergyAfter-l.assetEnergyBefore,l.construction,'construction ledger debit');assetEnergy=l.assetEnergyAfter;
   close(l.policyEnergyBefore,policyEnergy,'policy ledger continuity');close(l.policyEnergyAfter-l.policyEnergyBefore,l.policy,'policy ledger debit');policyEnergy=l.policyEnergyAfter;
   totals.availableEnergy+=l.available;totals.humanEnergy+=l.humanCritical+l.humanFlexible;totals.operationEnergy+=l.operation;
   totals.maintenanceEnergy+=l.maintenance;totals.unusedEnergy+=l.unused;
  }
  validateHistoryMeasurements(s,c,p,origins,availability,competitionLead);
  for(const key of ['extraDeaths','shortagePersonYears','qolPersonYears'])close(p[key],demographic[key],`history cumulative ${key}`);
  previous=p.t;
 }
 const last=s.history.at(-1);close(last.t,s.t,'history current time');close(last.H,s.H,'history current population');close(last.q,s.q,'history current capability');
 close(last.exposure,s.exposure,'history current exposure');close(last.flexibleDemand,s.flexibleDemand,'history current flexible demand');
 requireValue(s.competitionLead===competitionLead,'current chronological competition leader');
 for(const [k,v] of Object.entries(totals))close(s.accounts[k],v,`cumulative ${k}`);
 for(const [k,v] of Object.entries(demographic))close(s.accounts[k],v,`cumulative demographic ${k}`);
 for(const [k,v] of Object.entries(outcomes))close(s.accounts[k],v,`replayed outcome ${k}`);
 validateInfrastructureState(s.infrastructure,c);
 for(const key of Object.keys(infrastructure))close(s.infrastructure[key],infrastructure[key],`replayed infrastructure ${key}`);
 close(s.assetState.accounts.primarySupplied,infrastructure.primarySupplied,'paid primary materials account');
 close(s.assetState.accounts.energySpent,assetEnergy,'final construction ledger');
 close(s.assetState.accounts.workDone,assetWork,'final construction work ledger');
 close(sum([...s.policyArchive,s.policyState],p=>p.workSpent),policyWork,'final policy work ledger');
 close(s.maintenanceFactor,availability,'current maintenance availability');
 close(sum([...s.policyArchive,s.policyState],p=>p.energySpent),policyEnergy,'final policy ledger');
 if(s.last!==null)requireValue(canonical(s.last.ledger)===canonical(last.ledger),'last interval ledger');
}
export function validateRun(run){
 finiteTree(run);keys(run,['schema','version','sourceDigest','configId','config','branchOf','state'],'root');
 requireValue(run.schema===SCHEMA&&run.version===VERSION&&run.sourceDigest===SOURCE_DIGEST,'source/schema/version');
 const c=makeConfig(run.config);requireValue(canonical(c)===canonical(run.config)&&configurationId(c)===run.configId,'normalized configuration binding');
 const s=run.state;
 keys(s,['t','H','q','exposure','flexibleDemand','maintenanceFactor','assetState','technology','policyState','policyArchive',
  'policyRng','eventState','nextDecision','accounts','last','planning','infrastructure','history','competitionLead'],'world state');
 requireValue(s.competitionLead===null||['human','ai'].includes(s.competitionLead),'world competition leader');
 num(s.t,'world time',0,c.horizon);num(s.H,'population',Number.MIN_VALUE,1e100);num(s.q,'capability',c.initial.q,1e100);
 num(s.exposure,'exposure',0,1);num(s.maintenanceFactor,'maintenance factor',0,1);
 num(s.flexibleDemand,'flexible demand',c.human.minimumFlexible,c.human.maximumFlexible);num(s.nextDecision,'decision time');
 requireValue(s.nextDecision===(s.t===0?0:Math.ceil(s.t)),'annual planning decision boundary');
 keys(s.technology,TECH,'technology');for(const k of TECH)num(s.technology[k],`technology ${k}`,Number.MIN_VALUE);
 keys(s.accounts,['births','extraDeaths','personYears','shortagePersonYears','humanEnergy','operationEnergy',
  'maintenanceEnergy','availableEnergy','unusedEnergy','minPopulation','maxPopulation','minAdequacy','shortageYears','shortageEpisodes',
  'energyShortfall','landShortfallPersonYears','qolPersonYears'],'world accounts');
 // [TH-N3] The historical births key is the signed baseline net population
 // change; explicit shortage deaths and every other cumulative account stay nonnegative.
 for(const [k,v] of Object.entries(s.accounts))num(v,`world account ${k}`,k==='births'?-Infinity:0);
 if(s.t===0)requireValue(s.last===null,'initial last observation');
 else {
  keys(s.last,['deficit','criticalAdequacy','energyAdequacy','landAdequacy','researchCapacity','effectiveCompute',
   'poweredBlocks','utilisation','qualityOfLife','perCapitaElectricity','priority','ledger','dependencies'],'last physical measurements');
  for(const key of ['deficit','criticalAdequacy','energyAdequacy','landAdequacy','utilisation'])num(s.last[key],`last ${key}`,0,1);
  for(const key of ['researchCapacity','effectiveCompute','poweredBlocks'])num(s.last[key],`last ${key}`);
  num(s.last.qualityOfLife,'last quality of life',0,c.human.qolMaximum);num(s.last.perCapitaElectricity,'last per-capita electricity');
 }
 close(s.H,c.initial.H+s.accounts.births-s.accounts.extraDeaths,'population births/deaths identity');
 requireValue(s.accounts.minPopulation<=s.H+1e-7&&s.accounts.minPopulation<=c.initial.H,'population minimum');
 num(s.accounts.minAdequacy,'minimum adequacy',0,1);
 if(run.branchOf!==null){keys(run.branchOf,['configId','t'],'branch provenance');num(run.branchOf.t,'branch time',0,s.t);requireValue(typeof run.branchOf.configId==='string','parent config ID');}
 validateAssets(s.assetState,c,s.t);
 const origins=validateContracts(s.assetState,c,s.t,s.eventState);
 validatePolicies(s,c);validateEvents(s.eventState,c,s.t,s.assetState);validateHistory(s,c,origins);
 for(const target of TECH)close(s.technology[target],intrinsic(s.assetState,target,s.t),'paid intrinsic technology');
 for(const p of s.assetState.projects.filter(p=>p.requestId.startsWith('capability:'))){
  const point=s.history.find(row=>row.t===p.start);requireValue(Boolean(point),'capability discovery history');
  const maximum=c.ai[`${p.target}Maximum`];close(p.multiplier,efficiency(point.q,maximum,c.ai.efficiencyExponent),'capability frontier discovery');
 }
 const view=physicalView(s,c);
 for(const key of ['sourcePower','serviceCapacity','workCapacity','factoryWork','autonomousWork','hardware','utilisation','allowed','operationNeed','landAvailable','landAdequacy'])num(view[key],`derived ${key}`);
 for(const key of ['power','humanPower','aiPower','factoryWork','hardware','hardwareEffective','landOccupied','landCommitted','maintenanceWork'])num(view.assets[key],`derived assets ${key}`);
 return true;
}
