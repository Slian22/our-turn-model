/** Positive finite-rate submodels, with exact constant-input endpoints. */
import {finite} from './config.mjs';
export const energyPerBlock=(u,idle)=>{
 finite(u,'utilisation',0,1);finite(idle,'idle fraction',0,1);
 return .00876*(idle+(1-idle)*u);
};
export function efficiency(q,maximum,exponent){
 finite(q,'relative capability',1,1e100);finite(maximum,'efficiency maximum',1,1e6);finite(exponent,'efficiency exponent',Number.MIN_VALUE,100);
 return 1+(maximum-1)*(-Math.expm1(-exponent*Math.log(q)));
}
export function support(H,H0,K){
 finite(H,'population',0,1e100);finite(H0,'reference population',Number.MIN_VALUE,1e100);finite(K,'half population',Number.MIN_VALUE,1e100);
 return (H/(K+H))/(H0/(K+H0));
}
export function capabilityStep(q,research,h,ai){
 finite(q,'capability',Number.MIN_VALUE,1e100);finite(research,'research capacity',0,1e100);finite(h,'interval',0,1e6);
 finite(ai.difficulty,'research difficulty',0,10);finite(ai.growth,'research growth',0,10);
 finite(ai.researchReference,'reference research',Number.MIN_VALUE,1e100);
 finite(ai.researchElasticity,'research elasticity',Number.MIN_VALUE,10);
 if(h===0||research===0||ai.growth===0)return q;
 if(ai.difficulty===0){
  const next=q*Math.exp(ai.growth*(research/ai.researchReference)**ai.researchElasticity*h);
  if(!Number.isFinite(next))throw new RangeError('Capability update exceeds its numerical domain');
  return next;
 }
 const logDose=Math.log(ai.difficulty)+Math.log(ai.growth)+ai.researchElasticity*
  (Math.log(research)-Math.log(ai.researchReference))+Math.log(h);
 const relativeLog=logDose-ai.difficulty*Math.log(q);
 const increment=(relativeLog>0?relativeLog+Math.log1p(Math.exp(-relativeLog)):
  Math.log1p(Math.exp(relativeLog)))/ai.difficulty;
 // Anchor negligible increments on q: an inverse power can round below its
 // original base even though the exact research increment is nonnegative.
 const next=increment<700?q*Math.exp(increment):Math.exp(Math.log(q)+increment);
 if(!Number.isFinite(next)||next<q)throw new RangeError('Capability update exceeds its numerical domain');
 return next;
}
// Eight-point Gauss-Legendre quadrature is applied on subintervals no longer
// than exposureTime/2, preserving accurate births/deaths even for oracle h=8.
const nodes=[-.9602898564975363,-.7966664774136267,-.525532409916329,-.1834346424956498,
 .1834346424956498,.525532409916329,.7966664774136267,.9602898564975363];
const weights=[.1012285362903763,.2223810344533745,.3137066458778873,.362683783378362,
 .362683783378362,.3137066458778873,.2223810344533745,.1012285362903763];
export function humanStep({H,exposure},deficit,h,human){
 finite(H,'population',0,1e100);finite(exposure,'exposure',0,1);finite(deficit,'deficit',0,1);finite(h,'interval',0,1e6);
 const tau=human.exposureTime,mu=human.maximumMortality,growth=human.growth;
 if(!(tau>0)||![tau,mu,growth].every(Number.isFinite)||mu<0)throw new RangeError('Invalid demographic rate');
 const xAt=s=>deficit+(exposure-deficit)*Math.exp(-s/tau);
 const integratedX=s=>deficit*s+(exposure-deficit)*tau*(-Math.expm1(-s/tau));
 const populationAt=s=>H*Math.exp(growth*s-mu*integratedX(s));
 const next=populationAt(h),n=Math.max(1,Math.ceil(h/Math.min(1,tau/2)));
 let minPopulation=Math.min(H,next),maxPopulation=Math.max(H,next);
 // The net rate can change sign as exposure recovers. Include its stationary
 // point so a coarse interval cannot hide a population minimum between samples.
 if(mu>0&&exposure!==deficit){
  const ratio=(growth/mu-deficit)/(exposure-deficit);
  const stationary=ratio>0?-tau*Math.log(ratio):-1;
  if(stationary>0&&stationary<h){
   const value=populationAt(stationary);
   minPopulation=Math.min(minPopulation,value);maxPopulation=Math.max(maxPopulation,value);
  }
 }
 if(n>100000)throw new RangeError('Demographic integral budget exceeded');
 let personYears=0,extraDeaths=0;
 for(let j=0;j<n;j++){
  const left=j*h/n,right=(j+1)*h/n,mid=(left+right)/2,half=(right-left)/2;
  for(let i=0;i<nodes.length;i++){
   const s=mid+half*nodes[i],population=populationAt(s),weight=half*weights[i];
   personYears+=weight*population;extraDeaths+=weight*mu*xAt(s)*population;
  }
 }
 if(![next,personYears,extraDeaths].every(Number.isFinite))throw new RangeError('Nonfinite demographic result');
 return {H:next,minPopulation,maxPopulation,exposure:Math.min(1,Math.max(0,xAt(h))),births:growth*personYears,extraDeaths,
  personYears,shortagePersonYears:deficit*personYears};
}
export function criticalIntensity(t,human){
 return human.criticalFloor+(human.criticalEnergy-human.criticalFloor)*Math.exp(-human.technologyRate*t);
}
// [TH-N3] Evaluated only at scheduler boundaries, with a declared net baseline.
export function demographicParameters(t,human){
 const known=(human.growthSchedule??[]).filter(row=>row.time<=t).at(-1);
 return known?{...human,growth:known.growth}:human;
}
export function demandStep(z,adequacy,h,human,spare=0){
 finite(z,'flexible demand',human.minimumFlexible,human.maximumFlexible);finite(adequacy,'adequacy',0,1);finite(h,'interval',0,1e6);
 finite(human.demandTime,'human demand time',Number.MIN_VALUE,Number.MAX_VALUE);
 finite(spare,'spare energy',0,Number.MAX_VALUE);
 const target=adequacy<1-1e-12?human.minimumFlexible:spare>0?human.maximumFlexible:1;
 // Anchor at the old multiplier so zero/tiny intervals cannot cancel its value.
 const next=z+(target-z)*(-Math.expm1(-h/human.demandTime));
 return Math.min(human.maximumFlexible,Math.max(human.minimumFlexible,next));
}
