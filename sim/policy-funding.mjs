/** Policy electricity is expended on deployment work over time, never stored as free energy. */
import {processPolicies} from './policies.mjs';
const tolerance=1e-10;
// Roundoff may finish paid work; it must never turn an unpaid positive cost free.
export const deploymentFunded=(paid,cost)=>cost===0||(paid>0&&cost-paid<=8*Number.EPSILON*Math.max(cost,paid));
function pending(state,c) {
 const attempted=new Set(state.policyLog.map(p=>p.index));
 return c.policies.map((policy,index)=>({policy,index})).filter(({policy:p,index})=>
  !attempted.has(index)&&state.t+tolerance>=p.start+p.delay&&
  (p.type!=='cap'||state.t<p.start+p.delay+p.duration-tolerance));
}
export function applyFundedPolicies(state,c) {
 const policies=c.policies.map((p,index)=>({...p,cost:deploymentFunded(state.policyFunding[index],p.cost)?0:Infinity}));
 return processPolicies(state,{...c,policies},0);
}
export function fundingDuration(state,c,availableFlow) {
 if(availableFlow<=0)return Infinity;
 if(!Number.isFinite(state.t)||state.t<0)throw new RangeError('Invalid deployment interval origin');
 const next=pending(state,c).find(({policy,index})=>!deploymentFunded(state.policyFunding[index],policy.cost));
 if(!next)return Infinity;
 const duration=(next.policy.cost-state.policyFunding[next.index])/availableFlow;
 if(state.t+duration>state.t)return duration;
 // A positive payment can be smaller than one representable clock increment.
 // The executor still caps paid energy at the actual remaining cost and keeps
 // its ordinary dt/horizon bound; only an otherwise stationary clock is raised.
 return Math.max(Number.MIN_VALUE,state.t*Number.EPSILON);
}
export function fundDeployment(state,c,energy) {
 let remaining=energy;
 const allocation=pending(state,c).reduce((result,{policy,index})=>{
  const paid=Math.min(Math.max(0,policy.cost-state.policyFunding[index]),remaining);
  remaining-=paid;return {...result,[index]:paid};
 },{});
 return {cost:energy-remaining,state:{...state,policyFunding:state.policyFunding.map((value,index)=>value+(allocation[index]??0))}};
}
