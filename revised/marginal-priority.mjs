/** Pure marginal operating-electricity competition. Caller state is never mutated. */

function finite(value,name,min=0,max=Number.MAX_VALUE){
 if(!Number.isFinite(value)||value<min||value>max)
  throw new RangeError(`${name} must be finite in [${min}, ${max}]`);
 return value;
}

function settings(c){
 const h=c.human,a=c.ai,p=c.priority;
 finite(h.qolMaximum,'QoL maximum',0,1);finite(h.qolScale,'QoL scale',Number.MIN_VALUE);
 finite(a.growth,'capability growth',0,10);finite(a.difficulty,'research difficulty',0,10);
 finite(a.researchElasticity,'research elasticity',Number.MIN_VALUE,10);
 finite(a.researchReference,'research reference',Number.MIN_VALUE,1e100);
 finite(p.lambda,'priority exchange rate');finite(p.sharpness,'priority sharpness');
 finite(p.hysteresis,'priority hysteresis');
 if(!['human','ai'].includes(p.tieBreak))throw new TypeError('Invalid priority tie break');
 return {h,a,p};
}

function logistic(value){
 // Both branches avoid overflowing exp for extreme k or a very unequal ratio.
 if(value>=0)return 1/(1+Math.exp(-value));
 const exp=Math.exp(value);return exp/(1+exp);
}

// [DOM-MARGINAL] AI value is the derivative of a research-supported CAPABILITY
// GROWTH proxy qdot=g*(R/Rref)^eta*q^(1-d), not paid physical hardware growth.
// R and P are frozen current feasible research and operating-power capacities.
// R scales linearly with power below that capacity; the derivative is evaluated
// from the left at positive capacity: lambda*eta*qdot(P)/P. Zero capacity has
// value zero, avoiding the singular zero-power derivative for eta<1.
// Human value is the per-person QoL slope at preceding delivered kWh/person/year.
// Lambda declares the exchange between those unlike marginal quantities.
export function operatingPriority({q,researchAtCapacity,operationPower,perCapitaElectricity,
 previousLeader=null},c){
 finite(q,'capability',1,1e100);finite(researchAtCapacity,'research at capacity',0,1e100);
 finite(operationPower,'feasible operating power',0,1e100);
 finite(perCapitaElectricity,'preceding delivered electricity');
 if(previousLeader!==null&&!['human','ai'].includes(previousLeader))
  throw new TypeError('Invalid previous operating-priority leader');
 const {h,a,p}=settings(c);
 const humanPositive=h.qolMaximum>0;
 const aiPositive=c.aiEnabled!==false&&p.lambda>0&&a.growth>0&&researchAtCapacity>0&&operationPower>0;
 const logHuman=humanPositive?Math.log(h.qolMaximum)-Math.log(h.qolScale)-perCapitaElectricity/h.qolScale:-Infinity;
 const logAi=aiPositive?Math.log(p.lambda)+Math.log(a.researchElasticity)+Math.log(a.growth)
  +a.researchElasticity*(Math.log(researchAtCapacity)-Math.log(a.researchReference))
  +(1-a.difficulty)*Math.log(q)-Math.log(operationPower):-Infinity;
 // Evaluate the combined expression before exponentiation: neither qdot nor
 // its factors need be representable independently. Returned marginal values
 // must remain finite. Underflow to zero preserves the log-domain share.
 const humanValue=finite(Math.exp(logHuman),'human marginal value');
 const aiValue=finite(Math.exp(logAi),'AI marginal value');
 const logRatio=humanPositive?(aiPositive?logHuman-logAi:Infinity):(aiPositive?-Infinity:0);
 const humanShare=!humanPositive&&!aiPositive?.5:!aiPositive?1:!humanPositive?0:
  p.sharpness===0?.5:logistic(p.sharpness*logRatio);
 // [DOM-MARGINAL] Hysteresis holds only the diagnostic leader. It does not
 // distort the requested smooth allocation share. Equality at either margin
 // retains the previous leader; a fresh state uses the explicit tie rule.
 const leader=logRatio>p.hysteresis?'human':logRatio<-p.hysteresis?'ai':previousLeader??p.tieBreak;
 return {humanValue,aiValue,logRatio,humanShare,leader};
}

// [DOM-MARGINAL] Allocate only the caller's nonnegative contested pool. Reserve,
// infrastructure, construction and policy debits are settled by the executor.
// Cap each share at need, pass surplus to the other unmet need, retain unused.
export function cappedContestedAllocation(pool,humanNeed,aiNeed,humanShare){
 finite(pool,'contested pool');finite(humanNeed,'contested human need');
 finite(aiNeed,'contested AI need');finite(humanShare,'desired human share',0,1);
 let human=Math.min(humanNeed,pool*humanShare);
 const ai=Math.min(aiNeed,Math.max(0,pool-human));
 human=Math.min(humanNeed,human+Math.max(0,pool-human-ai));
 return {human,ai,unused:Math.max(0,pool-human-ai)};
}
