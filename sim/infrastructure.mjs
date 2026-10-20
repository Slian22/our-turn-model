/** M03/M06: physical stocks and prepaid construction queues. */
export function supportFactor(autonomy,humanSupport) {
 if(![autonomy,humanSupport].every(x=>Number.isFinite(x)&&x>=0&&x<=1))throw new RangeError('Support and autonomy must be in [0,1]');
 return autonomy+(1-autonomy)*humanSupport;
}
export function landUsed(state,c) {
 return state.B*c.landBlock+state.G*c.landPower+state.F*c.landFab+state.queue.reduce((s,p)=>s+p.land,0);
}
export function settleProjects(state) {
 const due=state.queue.filter(p=>p.due<=state.t+1e-10);
 const totals=kind=>due.filter(p=>p.kind===kind).reduce((s,p)=>s+p.amount,0);
 return {...state,B:state.B+totals('hardware'),G:state.G+totals('power'),F:state.F+totals('factory'),
  aE:Math.min(1,state.aE+totals('powerAutomation')),aF:Math.min(1,state.aF+totals('fabAutomation')),
  queue:state.queue.filter(p=>p.due>state.t+1e-10),
  events:state.traceProjects===false?state.events:[...state.events,...due.map(p=>({t:state.t,type:'commissioned',project:p.id,kind:p.kind,amount:p.amount}))]};
}
