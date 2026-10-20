/** M03/M04: the identical allocator and demographic response in history and RSI. */
export function nonnegative(value,name='value') {
 if(!Number.isFinite(value)||value<0)throw new RangeError(`${name} must be finite and nonnegative`);
 return value;
}
export const clamp01=x=>Math.max(0,Math.min(1,x));

function weightedAllocation(available,claim,total,scale,normalizedTotal) {
 const product=available*claim;
 // Preserve reference arithmetic for ordinary finite intermediates.
 if(Number.isFinite(total)&&Number.isFinite(product)&&(product>=2**-1022||available===0||claim===0))
  return total>0?product/total:0;
 if(claim===0||available===0)return 0;
 const relative=claim/scale;
 // Dividing a subnormal claim ratio first can lose a representable allocation.
 return relative<2**-1022?(available/scale)*claim/normalizedTotal:available*relative/normalizedTotal;
}

/** A reserved first claim followed by capped weighted water filling. Units are caller-defined. */
export function allocatePool({supply,needH,needA,claimH,claimA,reserve=0}) {
 for(const [k,v] of Object.entries({supply,needH,needA,claimH,claimA,reserve}))nonnegative(v,k);
 const protectedAmount=Math.min(supply,reserve);
 const h0=Math.min(needH,protectedAmount);
 // Unused protected resources remain reserved; they are never given to the competitor.
 const available=supply-protectedAmount;
 const dh=Math.max(0,needH-h0);
 const total=claimH+claimA;
 const scale=Math.max(claimH,claimA),normalizedTotal=scale>0?claimH/scale+claimA/scale:0;
 let h=Math.min(dh,weightedAllocation(available,claimH,total,scale,normalizedTotal));
 let a=Math.min(needA,weightedAllocation(available,claimA,total,scale,normalizedTotal));
 const left=available-h-a;
 if(left>0&&h>=dh&&claimA>0)a+=Math.min(left,needA-a);
 else if(left>0&&a>=needA&&claimH>0)h+=Math.min(left,dh-h);
 // Roundoff at large scales must not produce a negative unused account.
 const human=Math.min(supply,h0+h),other=Math.min(a,Math.max(0,supply-human));
 return {human,other,unused:Math.max(0,supply-human-other),protected:protectedAmount,infeasible:reserve>supply+1e-10};
}
export function adequacy(allocated,needs) {
 if(allocated.length!==needs.length||!needs.length)throw new RangeError('Mismatched resource vectors');
 return Math.min(1,...needs.map((n,i)=>{nonnegative(n);nonnegative(allocated[i]);return n===0?1:allocated[i]/n;}));
}
export function populationStep(population,s,{birth,death,shortfall},dt) {
 for(const [k,v] of Object.entries({population,birth,death,shortfall,dt}))nonnegative(v,k);
 if(!Number.isFinite(s)||s<0||s>1)throw new RangeError('Adequacy must be in [0,1]');
 return population*Math.exp((birth*s-death-shortfall*(1-s))*dt);
}
export function ledgerCheck({supply,human,operation,research,construction,industry,policy=0,unused}) {
 const values={supply,human,operation,research,construction,industry,policy,unused};
 const negativeRoundoff=32*Number.EPSILON*Math.max(1,supply);
 for(const [k,v] of Object.entries(values))if(v< -negativeRoundoff||!Number.isFinite(v))throw new Error(`Invalid energy account: ${k}`);
 const residual=supply-human-operation-research-construction-industry-policy-unused;
 if(Math.abs(residual)>1e-9*Math.max(1,supply))throw new Error(`Energy imbalance ${residual}`);
 return residual;
}
