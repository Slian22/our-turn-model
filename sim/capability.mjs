/** Integrate capability with powered R&D (excluding Q) frozen over one interval.
 * dQ/dt = kappa * (poweredResearch/rdReference)^nu * Q^(1+nu),
 * divided by 1+(Q/qSaturation)^2 for the saturating law.
 * The latter has no finite-time singularity for 0 <= nu <= 1.
 */
const eps=Number.EPSILON;
const logMax=Math.log(Number.MAX_VALUE);

function validate(Q,poweredResearch,c,dt) {
 if(!Number.isFinite(Q)||Q<=0||!Number.isFinite(poweredResearch)||poweredResearch<0
  ||!Number.isFinite(dt)||dt<0||!Number.isFinite(c.kappa)||c.kappa<0
  ||!Number.isFinite(c.rdReference)||c.rdReference<=0||!Number.isFinite(c.rdExponent)
  ||c.rdExponent<0||c.rdExponent>1||!Number.isFinite(c.qSaturation)||c.qSaturation<=0
  ||!['none','exponential','saturating'].includes(c.improvement))
  throw new RangeError('Invalid capability integration inputs');
}

function grow(Q,x) {
 const logQ=Math.log(Q)+x;
 if(!Number.isFinite(logQ)||logQ>logMax)throw new Error('Capability exceeds floating-point range');
 // Preserve tiny relative changes without cancellation in log(Q)+x.
 const value=x<700?Q*Math.exp(x):Math.exp(logQ);
 if(!Number.isFinite(value))throw new Error('Capability exceeds floating-point range');
 return value;
}

function unsaturated(Q,drive,nu) {
 if(nu===0)return grow(Q,drive);
 const fraction=nu*drive;
 if(fraction>=1)throw new Error('Finite-time capability singularity under unsaturated improvement law');
 return grow(Q,fraction===0?drive:-Math.log1p(-fraction)/nu);
}

// Products stay finite when a tiny weight multiplies an overflowing exponential.
function weightedExpm1(weight,logWeight,x) {
 return weight>0&&x<700?weight*Math.expm1(x):Math.exp(logWeight+x)*(1-Math.exp(-x));
}

function log1pExp(x) {
 return x>50?x+Math.log1p(Math.exp(-x)):Math.log1p(Math.exp(x));
}

function solveLogGrowth(target,nu,alpha,beta,logBeta) {
 const m=2-nu;
 // The positive saturation term alone gives a conservative upper bracket.
 let lo=0,hi=log1pExp(Math.log(m)+Math.log(target)-logBeta)/m;
 hi+=16*eps*Math.max(1,hi);
 let x=Math.min(target,hi);
 for(let i=0;i<80;i++){
  const z=nu*x;
  const first=alpha*(z===0?x:-Math.expm1(-z)/nu);
  const second=weightedExpm1(beta,logBeta,m*x)/m;
  const residual=first+second-target;
  const derivative=alpha*Math.exp(-z)+(beta>0&&m*x<700?beta*Math.exp(m*x):Math.exp(logBeta+m*x));
  if(Math.abs(residual)<=8*eps*target)return x;
  if(residual>0)hi=x;else lo=x;
  if(hi-lo<=8*eps*Math.max(1,x))return (lo+hi)/2;
  const candidate=x-residual/derivative;
  x=Number.isFinite(candidate)&&candidate>lo&&candidate<hi?candidate:(lo+hi)/2;
 }
 throw new Error('Capability integration did not converge');
}

export function capabilityStep(Q,poweredResearch,c,dt) {
 validate(Q,poweredResearch,c,dt);
 if(c.improvement==='none'||poweredResearch===0||c.kappa===0||dt===0)return Q;
 const nu=c.rdExponent,rd=poweredResearch*Q/c.rdReference;
 const logDrive=Math.log(c.kappa)+Math.log(dt)+nu*(Math.log(poweredResearch)+Math.log(Q)-Math.log(c.rdReference));
 const raw=c.kappa*dt*Math.pow(rd,nu);
 const drive=Number.isFinite(raw)&&raw>0?raw:Math.exp(logDrive);
 if(c.improvement==='exponential')return unsaturated(Q,drive,nu);
 const square=(Q/c.qSaturation)**2,logSquare=2*(Math.log(Q)-Math.log(c.qSaturation));
 const logDenominator=Number.isFinite(square)?Math.log1p(square):logSquare;
 const alpha=1/(1+square),beta=Number.isFinite(square)?square*alpha:1;
 const logBeta=beta>0?Math.log(beta):logSquare-logDenominator;
 const target=Number.isFinite(drive)&&Number.isFinite(square)?drive*alpha:Math.exp(logDrive-logDenominator);
 if(target===0)return Q;
 if(!Number.isFinite(target))throw new Error('Capability exceeds floating-point range');
 return grow(Q,solveLogGrowth(target,nu,alpha,beta,logBeta));
}
