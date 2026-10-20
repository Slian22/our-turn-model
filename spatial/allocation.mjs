import {allocatePool,nonnegative} from '../sim/resources.mjs';
const MIN_NORMAL=2.2250738585072014e-308;
/** Preserve the baseline bit-for-bit except unsafe finite claim arithmetic. */
export function safeAllocatePool(options) {
 const {claimH,claimA,supply,needH,needA,reserve=0}=options;
 for(const [key,value] of Object.entries({claimH,claimA,supply,needH,needA,reserve}))nonnegative(value,key);
 const available=supply-Math.min(supply,reserve);
 const unsafeProduct=claim=>claim>0&&available>0&&available*claim<MIN_NORMAL;
 if(!Number.isFinite(claimH+claimA)||!Number.isFinite(supply*claimH)||!Number.isFinite(supply*claimA)||
  unsafeProduct(claimH)||unsafeProduct(claimA)){
  return extremeAllocation({claimH,claimA,supply,needH,needA,reserve});
 }
 const result=allocatePool(options);
 // The baseline's final S-human subtraction can erase a representable small
 // competing share. Its uncapped initial share is a lower bound after filling.
 const initialOther=claimH+claimA>0?Math.min(needA,available*claimA/(claimH+claimA)):0;
 return result.other<initialOther?extremeAllocation({claimH,claimA,supply,needH,needA,reserve}):result;
}

function extremeAllocation({claimH,claimA,supply,needH,needA,reserve}) {
 const scale=Math.max(claimH,claimA),total=claimH/scale+claimA/scale;
 const protectedAmount=Math.min(supply,reserve),h0=Math.min(needH,protectedAmount),available=supply-protectedAmount;
 const share=claim=>{
  if(claim===0||available===0)return 0;
  const ratio=claim/scale;
  // A subnormal normalized weight can lose digits although its final allocation
  // is representable after multiplication by a very large supply.
  return ratio>=MIN_NORMAL?available*ratio/total:
   Math.exp(Math.log(available)-Math.log(scale)+Math.log(claim)-Math.log(total));
 };
 const dh=Math.max(0,needH-h0);let h=Math.min(dh,share(claimH)),a=Math.min(needA,share(claimA));
 const left=available-h-a;
 // Eligibility uses the ORIGINAL claim: scaling must never turn a positive
 // claimant into a zero claimant during demand-cap redistribution.
 if(left>0&&h>=dh&&claimA>0)a+=Math.min(left,needA-a);
 else if(left>0&&a>=needA&&claimH>0)h+=Math.min(left,dh-h);
 const human=Math.min(supply,h0+h),headroom=Math.max(0,supply-human);
 // A tiny representable other allocation can coexist with a human allocation
 // rounded to S. Do not erase it solely through catastrophic subtraction;
 // the discrepancy is bounded by machine-scale budget roundoff.
 const tolerance=8*Number.EPSILON*Math.max(1,supply);
 const other=a-headroom<=tolerance?a:Math.min(a,headroom);
 return {human,other,unused:Math.max(0,supply-human-other),protected:protectedAmount,infeasible:reserve>supply+1e-10};
}
