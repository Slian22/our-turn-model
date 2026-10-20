/** Internal consistency checks at the untrusted checkpoint-file boundary. */
const close=(a,b)=>Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b));
const projectTerms={
 hardware:['embodiedBlock','landBlock'],power:['embodiedPower','landPower'],
 factory:['embodiedFab','landFab'],powerAutomation:['automationEnergy',null],
 fabAutomation:['automationEnergy',null],
};

export function validateCheckpointConsistency(s,c) {
 if(!Number.isSafeInteger(s.nextProjectId))throw new Error('Checkpoint next project identifier must be a safe integer');
 if(typeof s.infeasible!=='boolean'||s.stepDuration<0||s.stepDuration>c.dt+1e-9||
  s.stepDuration>s.t+1e-9||(s.t>0&&s.stepDuration===0))throw new Error('Invalid completed checkpoint interval');
 if(s.shortageYears>s.t+1e-9||s.belowYears>s.t+1e-9||s.minPopulation>s.H+1e-9||
  s.minPopulation>c.H0+1e-9||s.minAdequacy>s.sH+1e-9)throw new Error('Inconsistent checkpoint path statistics');
 if(s.extinct&&(s.H!==0||s.belowYears+1e-9<c.extinctionWindow))throw new Error('Inconsistent extinct checkpoint state');
 if(!s.extinct&&s.belowYears+1e-9>=c.extinctionWindow)throw new Error('Checkpoint omits completed functional extinction');
 const delays={hardware:c.hardwareDelay,power:c.powerDelay,factory:c.fabDelay,
  powerAutomation:c.automationDelay,fabAutomation:c.automationDelay};
 for(const p of s.queue){
  const [energyKey,landKey]=projectTerms[p.kind];
  if(!close(p.energy,p.amount*c[energyKey])||!close(p.land,landKey?p.amount*c[landKey]:0))
   throw new Error('Checkpoint project costs disagree with amount');
  if(!Number.isFinite(p.requestedDue)||p.requestedDue<0)throw new Error('Invalid checkpoint project delivery date');
  const orderedAt=p.requestedDue-delays[p.kind];
  const tolerance=8*Number.EPSILON*Math.max(1,s.t,p.requestedDue);
  if(orderedAt< -tolerance||orderedAt>s.t+tolerance)throw new Error('Invalid checkpoint project order time');
  // REAUDIT-GLOBAL-01: import the same commissioning grid used when booking all five kinds.
  const due=Math.ceil(p.requestedDue/c.dt-1e-8)*c.dt;
  if(Math.abs(p.due-due)>8*Number.EPSILON*Math.max(1,due))throw new Error('Invalid checkpoint project commissioning date');
 }
 for(const event of s.events)if(!event||!Number.isFinite(event.t)||event.t<0||event.t>s.t+1e-9||
  !['supply-shock','ordered','commissioned','policy'].includes(event.type))throw new Error('Invalid checkpoint event history');
 if(s.window.some(p=>p.t-p.dt< -1e-9))throw new Error('Checkpoint outcome interval predates its origin');
}

export function validateCheckpointTrajectory(trajectory,state,c) {
 const numeric=['t','H','B','Q','active','G','F','aE','aF','sH','support','landUsed','energyResidual',
  'queued','supply','human','operation','research','construction','industry','policy','unused'];
 if(!Array.isArray(trajectory)||!trajectory.length)throw new Error('Invalid trajectory');
 for(let i=0;i<trajectory.length;i++){
  const p=trajectory[i];
  if(!p||numeric.some(k=>!Number.isFinite(p[k]))||typeof p.infeasible!=='boolean'||
   p.t<0||p.t>state.t+1e-9||(i>0&&p.t<=trajectory[i-1].t))throw new Error('Invalid/nonmonotone checkpoint trajectory');
  if(numeric.some(k=>k!=='energyResidual'&&p[k]<0)||p.Q===0||!Number.isInteger(p.queued)||
   ['aE','aF','sH','support'].some(k=>p[k]>1))throw new Error('Trajectory contains invalid stock, resource or fraction');
 }
 const origin={t:0,H:c.H0,B:c.B0,Q:c.Q0,G:c.G0,F:c.F0,aE:c.aE0,aF:c.aF0,active:0,
  support:c.H0>0?1:0,sH:1,queued:0,energyResidual:0,infeasible:false,
  landUsed:c.B0*c.landBlock+c.G0*c.landPower+c.F0*c.landFab,
  supply:0,human:0,operation:0,research:0,construction:0,industry:0,policy:0,unused:0};
 if(Object.entries(origin).some(([k,v])=>trajectory[0][k]!==v))throw new Error('Trajectory does not start at the configured origin');
 const last=trajectory.at(-1);
 for(const k of numeric){
  const expected=k==='queued'?state.queue.length:Object.hasOwn(state.ledger,k)?state.ledger[k]:state[k];
  if(last[k]!==expected)throw new Error(`Trajectory endpoint disagrees with state: ${k}`);
 }
 if(last.infeasible!==state.infeasible)throw new Error('Trajectory infeasibility flag disagrees with state');
}
