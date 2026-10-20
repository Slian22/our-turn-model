/** Pure, auditable welfare and action-priority rules. No state is mutated here. */

function finite(value,name,min=0,max=Number.MAX_VALUE){
 if(!Number.isFinite(value)||value<min||value>max)
  throw new RangeError(`${name} must be finite in [${min}, ${max}]`);
 return value;
}

// [QOL] Proposed HDI-like scenario curve; only the MEM threshold
// is literature-based. The exponential shape is the proposal's own fitted rule.
export function qualityOfLife(e,{maximum=.9,scale=667}={}){
 finite(e,'delivered electricity per capita');
 finite(maximum,'quality-of-life maximum',0,1);
 finite(scale,'quality-of-life electricity scale',Number.MIN_VALUE);
 return maximum*(-Math.expm1(-e/scale));
}

// [DOM-MEM] TWh / year / million people × 1000 = kWh / person / year.
// The denominator is the population at the START of the frozen-rate interval.
export function perCapitaElectricity(energyTWh,hYears,populationMillions){
 finite(energyTWh,'delivered human electricity');
 finite(hYears,'electricity interval',Number.MIN_VALUE);
 finite(populationMillions,'start population');
 if(populationMillions===0||energyTWh===0)return 0;
 let result=(energyTWh/populationMillions)/hYears*1000;
 // Recover mathematically finite ratios whose intermediate quotient overflows.
 if(!Number.isFinite(result))result=Math.exp(Math.log(energyTWh)-Math.log(populationMillions)
  -Math.log(hYears)+Math.log(1000));
 return finite(result,'electricity per capita');
}

// [DOM-MEM] Target only: the executor must cap this by actual human demand and
// available supply before debiting the shared electricity ledger. Keeping H0 in
// the reference prevents population loss from shrinking the alignment promise.
export function memTarget(H,H0,memEnergy=1,alpha=0){
 finite(H,'population');finite(H0,'reference population');
 finite(memEnergy,'MEM electricity intensity');finite(alpha,'alignment',0,1);
 if(alpha===0||memEnergy===0)return 0;
 return finite(alpha*memEnergy*Math.max(H,H0),'MEM electricity target');
}

// [DOM-QOL] humanStep supplies its exact demographic person-years. Freeze QoL
// over this interval, rather than using end population or an endpoint rectangle.
// weightedQolPersonYears is in MILLION QoL-person-years, matching H's units.
export function intervalWelfare({energyTWh,hYears,startPopulation,personYears},qolConfig={}){
 finite(personYears,'demographic person-years');
 const e=perCapitaElectricity(energyTWh,hYears,startPopulation);
 const qol=qualityOfLife(e,qolConfig);
 return {perCapitaElectricity:e,qualityOfLife:qol,personYears,
  weightedQolPersonYears:qol*personYears};
}

function prioritySettings(config){
 const result={mode:'weighted',processingReference:80000,humanUsageReference:20000,
  aiWeight:1,humanWeight:1,tieBreak:'human',...config};
 if(!['weighted','static'].includes(result.mode))throw new TypeError('Invalid action-priority mode');
 if(!['human','ai'].includes(result.tieBreak))throw new TypeError('Invalid action-priority tie break');
 finite(result.processingReference,'processing reference',Number.MIN_VALUE);
 finite(result.humanUsageReference,'human usage reference',Number.MIN_VALUE);
 finite(result.aiWeight,'AI priority weight');finite(result.humanWeight,'human priority weight');
 return result;
}

function priorityScore(value,reference,weight,name){
 if(value===0||weight===0)return 0;
 let score=weight*(value/reference);
 if(!Number.isFinite(score))score=Math.exp(Math.log(value)-Math.log(reference)+Math.log(weight));
 return finite(score,name);
}

// [TH-PRIORITY] Compare dimensionless weighted scores, rather than adding
// processing blocks to electricity. Processing must be currently available,
// powered, efficiency-adjusted useful blocks; q is NOT processing capacity.
// Human usage is the preceding actual delivered electricity rate (TWh/year).
// The first interval's explicit demand proxy is chosen by the parent executor.
export function actionPriority({processing,humanUsage},config={}){
 finite(processing,'available AI processing');finite(humanUsage,'actual human usage');
 const c=prioritySettings(config);
 const aiScore=priorityScore(processing,c.processingReference,c.aiWeight,'AI priority score');
 const humanScore=priorityScore(humanUsage,c.humanUsageReference,c.humanWeight,'human priority score');
 const winner=c.mode==='static'||aiScore===humanScore?c.tieBreak:aiScore>humanScore?'ai':'human';
 return {aiScore,humanScore,winner};
}

// [TH-PRIORITY] Weighted mode puts the winning owner's requests first, then
// preserves numeric request priority and original FIFO order for equal ranks.
// Static mode returns the existing order unchanged in a fresh array.
export function reorderRequests(requests,winner,mode='weighted'){
 if(!Array.isArray(requests))throw new TypeError('Requests must be an array');
 if(!['human','ai'].includes(winner))throw new TypeError('Invalid priority winner');
 if(!['weighted','static'].includes(mode))throw new TypeError('Invalid action-priority mode');
 const indexed=requests.map((request,index)=>{
  if(!request||typeof request!=='object')throw new TypeError('Each request must be an object');
  const priority=finite(request.priority??0,'request priority',-Number.MAX_VALUE);
  return {request,index,priority};
 });
 if(mode==='static')return [...requests];
 const rank=request=>request.owner===winner?0:['ai','human'].includes(request.owner)?1:2;
 return indexed.sort((a,b)=>rank(a.request)-rank(b.request)||a.priority-b.priority||a.index-b.index)
  .map(row=>row.request);
}
