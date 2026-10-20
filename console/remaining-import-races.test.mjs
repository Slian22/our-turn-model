import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as spatial from '../spatial/world.mjs';
import * as thomas from './thomas-kernel.mjs';
import {observeWorldMilestones} from './world-milestones.mjs';
import {canonical} from '../sim/rng.mjs';

// Reuse the existing whole-controller fixture without running its test cases.
// It mounts the current synthesis source and uses the real numerical libraries.
function synthesis() {
 const url=new URL('./world-synthesis-app.test.mjs',import.meta.url);
 const source=readFileSync(url,'utf8').split("test('BROWSER-01:")[0]
  .replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(url.href));
 const mount=vm.runInNewContext(`${source}\nmount`,{readFileSync,vm,spatial,thomas,observeWorldMilestones,
  canonical,URL,Blob,Buffer,structuredClone,console});
 return mount();
}
function deferred() {
 let resolve,reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 return {resolve,reject,promise};
}
function pendingSynthesis(c) {
 const d=deferred();c.node('load').files=[{size:1,text:()=>d.promise}];
 return {...d,complete:c.node('load').dispatch('change')};
}
const checkpoint=()=>spatial.saveWorld(spatial.createWorld({seed:987654,eventMode:'off',horizon:2}));
for(const mode of ['native advance','API advance','autoplay advance']) {
 test(`LUI-05: pending synthesis import cannot replace newer ${mode}`,async()=>{
  const c=synthesis(),pending=pendingSynthesis(c);
  if(mode==='native advance')await c.node('next-turn').dispatch('click');
  if(mode==='API advance')c.context.window.alphaSynthesis.advance(.25);
  if(mode==='autoplay advance'){
   c.node('viewing-pace').value='1';await c.node('play').dispatch('click');await c.tick();
  }
  const accepted=c.context.window.alphaSynthesis.save();
  assert.ok(c.state().world.t>0,'the newer physical advance must execute');
  pending.resolve(checkpoint());await pending.complete;
  assert.equal(c.context.window.alphaSynthesis.save(),accepted);
 });
}
test('LUI-05: stale synthesis read failure does not stop newer playback',async()=>{
 const c=synthesis(),pending=pendingSynthesis(c);
 c.node('viewing-pace').value='1';await c.node('play').dispatch('click');await c.tick();
 pending.reject(new Error('older read failed'));await pending.complete;
 assert.equal(c.state().playing,true);assert.equal(c.node('error').hidden,true);
});

// Mount the native legacy file listener plus its actual mutation functions.
// Numerical behavior and DOM painting have their own full-controller tests;
// this fixture controls only file-read completion and accepted-state ordering.
function legacy() {
 const source=readFileSync(new URL('./app.mjs',import.meta.url),'utf8');
 const definition=name=>{
  const match=source.match(new RegExp(`function ${name}\\([^]*?\\n}`));
  assert.ok(match,`production function ${name} exists`);return match[0];
 };
 const start=source.indexOf("$('restore-file').addEventListener('change', guarded(async event => {");
 assert.ok(start>=0);
 const listener=source.slice(start,source.indexOf('\n}));',start)+5);
 const nodes=new Map(),errors=[];
 const el=id=>{
  if(!nodes.has(id))nodes.set(id,{value:'',addEventListener(_type,fn){this.listener=fn;}});
  return nodes.get(id);
 };
 const run=seed=>({config:{horizon:10,seed,policies:[]},state:{t:0},trajectory:[]});
 const context=vm.createContext({$ :el,MAX_FILE:20e6,EPS:1e-8,structuredClone,performance,number:String,
  createRun:c=>run(c.seed),makeConfig:c=>c,
  runHistory:c=>({config:c,trajectory:[],marker:c.marker}),
  validatedRun:JSON.parse,saveCheckpoint:JSON.stringify,
  restoreCheckpoint:JSON.parse,saveInTab(){},syncScenarioForm(){},announce(){},render(){},pause(){},
  branchRun:(base,policy)=>({...base,config:{...base.config,policies:[policy]}}),
  stepRun:base=>({...base,state:{t:base.state.t+.25}}),
  reportError:error=>errors.push(error.message),
 });
 vm.runInContext(`let currentRun=${JSON.stringify(run(1))}, parentRun=null, historyRun=null,
  savedCheckpoint=null, historyTime=0, level='rsi', tablePage=0, loadGeneration=0;
  ${['guarded','advanceTo','advance','newScenario','newHistory','setRun','restoreText','applyPolicy'].map(definition).join('\n')}
  ${listener}`,context);
 return {el,errors,context,state:()=>vm.runInContext('({currentRun,parentRun,historyRun,level,historyTime})',context),
  call:expression=>vm.runInContext(expression,context),
  pending(){const d=deferred(),target={files:[{size:1,text:()=>d.promise}],value:'selected'};
   // Native dispatch ignores the returned promise; guarded() reports failures.
   return {...d,complete:el('restore-file').listener({target}).catch(()=>{})};},
  checkpoint:seed=>JSON.stringify(run(seed))};
}
for(const [name,operation] of [
 ['scenario',"newScenario({seed:200})"],['history scenario',"newHistory({marker:200})"],
 ['advance','advance(1)'],['branch',"applyPolicy({start:0,delay:0},'current')"],
 ['direct restore',"restoreText(JSON.stringify({config:{horizon:10,seed:201,policies:[]},state:{t:0},trajectory:[]}))"],
])test(`LUI-06: pending legacy import cannot replace newer ${name}`,async()=>{
 const c=legacy(),pending=c.pending();c.call(operation);
 const accepted=JSON.stringify(c.state());pending.resolve(c.checkpoint(100));await pending.complete;
 assert.equal(JSON.stringify(c.state()),accepted);
});
test('LUI-06: latest selected legacy checkpoint wins out-of-order reads',async()=>{
 const c=legacy(),first=c.pending(),second=c.pending();
 second.resolve(c.checkpoint(301));await second.complete;
 const accepted=JSON.stringify(c.state());first.resolve(c.checkpoint(300));await first.complete;
 assert.equal(JSON.stringify(c.state()),accepted);assert.equal(c.state().currentRun.config.seed,301);
});
test('LUI-06: stale legacy read errors do not obscure a newer scenario',async()=>{
 const c=legacy(),pending=c.pending();c.call('newScenario({seed:401})');
 pending.reject(new Error('older read failed'));await pending.complete;
 assert.deepEqual(c.errors,[]);assert.equal(c.state().currentRun.config.seed,401);
});
test('LUI-06: current legacy import and current read errors remain visible',async()=>{
 const c=legacy(),valid=c.pending();valid.resolve(c.checkpoint(501));await valid.complete;
 assert.equal(c.state().currentRun.config.seed,501);
 const invalid=c.pending();invalid.reject(new Error('current read failed'));await invalid.complete;
 assert.deepEqual(c.errors,['current read failed']);assert.equal(c.state().currentRun.config.seed,501);
});
