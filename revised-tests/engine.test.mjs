import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,advanceRun,finishRun,branchRun,saveCheckpoint,restoreCheckpoint,summarize} from '../revised/engine.mjs';

test('integrated requests, physical spending and demographic accounting remain consistent',()=>{
 const initial=createRun({horizon:8,dt:.25}),frozen=saveCheckpoint(initial),run=finishRun(initial),s=summarize(run);
 assert.equal(run.state.t,8);assert.equal(saveCheckpoint(initial),frozen);
 assert.ok(s.extraDeaths>=0&&s.shortagePersonYears>=0&&s.H>0&&s.factoryWork>=0);
 assert.ok(s.landUsed<=run.config.resources.land+1e-7&&s.materialStock>=0);
 for(const row of run.state.history){
  const l=row.ledger;if(!l)continue;
  const spent=['humanCritical','humanFlexible','operation','maintenance','construction','policy','unused'].reduce((v,k)=>v+l[k],0);
  assert.ok(Math.abs(l.available-spent)<=1e-8*Math.max(1,l.available));
 }
 assert.ok(Math.abs(run.state.H-(run.config.initial.H+run.state.accounts.births-run.state.accounts.extraDeaths))<1e-6);
});
test('paid deployment is prospective and does not redraw after repeated advancement',()=>{
 let r=createRun({horizon:6,dt:.25,policy:{mode:'fixed',type:'shutdown',start:1,delay:1,cost:.1,work:.1,success:1,residual:0}});
 const before=advanceRun(r,1.5);assert.ok(before.state.policyState.actions.every(a=>!a.attempted));
 r=finishRun(before);const a=r.state.policyState.actions[0];
 assert.ok(a.attempted&&a.effective_from>=2);assert.equal(a.status,'active');
 const deployments=r.state.policyState.receipts.filter(x=>x.kind==='policy-deployment');assert.equal(deployments.length,1);
 assert.equal(finishRun(r),r);
});
test('paired immutable branch and full checkpoint preserve physical memory',()=>{
 const base=advanceRun(createRun({horizon:6}),2),same=branchRun(base,{mode:'none'});
 assert.equal(same.state.exposure,base.state.exposure);assert.deepEqual(same.state.assetState,base.state.assetState);
 const loaded=restoreCheckpoint(saveCheckpoint(base));
 assert.equal(saveCheckpoint(finishRun(loaded)),saveCheckpoint(finishRun(base)));
 const forged=JSON.parse(saveCheckpoint(base));forged.state.assetState.materials+=10;
 assert.throws(()=>restoreCheckpoint(JSON.stringify(forged)),/material/i);
});
test('efficiency discovery requires paid adoption and leaves old hardware vintages intact',()=>{
 const initial=createRun({horizon:4,dt:.25,events:[{id:'hw',type:'hardware',time:1,magnitude:2,adoptionDelay:1,adoptionEnergy:1,adoptionWork:1}]}),ids=initial.state.assetState.assets.filter(a=>a.kind==='hardware').map(a=>a.id);
 const run=finishRun(initial);
 assert.ok(run.state.eventState.adoptedIds.includes('hw'));
 for(const a of run.state.assetState.assets.filter(a=>ids.includes(a.id)))assert.equal(a.hardwareEfficiency,1);
 assert.ok(run.state.assetState.projects.some(p=>p.kind==='adoption'&&p.energySpent>0));
});
