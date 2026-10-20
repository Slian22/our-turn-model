import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as spatial from '../spatial/world.mjs';
import * as thomas from './thomas-kernel.mjs';
import {observeWorldMilestones} from './world-milestones.mjs';
import {canonical} from '../sim/rng.mjs';

const html = () => readFileSync(new URL('./world-synthesis.html', import.meta.url), 'utf8');
const format = (value, digits=2) => Number(value).toLocaleString('en-GB', {minimumFractionDigits:digits,maximumFractionDigits:digits});
const attrs = source => Object.fromEntries([...source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([,k,v])=>[k,v??'']));

// Small DOM fixture mounts the entire controller, including startup and native
// event handlers. Numerical calls use the real current libraries. SVG painting
// is the sole replaced view dependency; its own tests exercise reconciliation.
function mount(overrides={}) {
 const byId = new Map(), nodes=[], intervals=new Map(), windowEvents=new Map(), downloads=[], urls=new Map();
 const calls={map:[],benchmark:[],motion:[]};
 let document;
 function element(tag='div', attributes={}) {
  const listeners=new Map(), attributesCopy={...attributes}, classes=new Set((attributes.class??'').split(' ').filter(Boolean));
  const node={tagName:tag.toUpperCase(),dataset:{},style:{},children:[],parentElement:null,
   value:attributes.value??'',disabled:Object.hasOwn(attributes,'disabled'),hidden:Object.hasOwn(attributes,'hidden'),open:false,
   textContent:'',innerHTML:'',files:[],elements:{},
   classList:{contains:c=>classes.has(c),add:c=>classes.add(c),remove:c=>classes.delete(c),toggle(c,on=!classes.has(c)){if(on)classes.add(c);else classes.delete(c);return on;}},
   addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)??[]),fn]);},
   async dispatch(type,extra={}) {const event={target:node,currentTarget:node,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};for(const fn of listeners.get(type)??[])await fn(event);return event;},
   setAttribute(k,v){attributesCopy[k]=String(v);if(k==='class'){classes.clear();String(v).split(' ').forEach(c=>classes.add(c));}},
   getAttribute:k=>attributesCopy[k]??null,
   append(...children){children.forEach(child=>{child.parentElement=node;node.children.push(child);});},
   replaceChildren(...children){node.children=[];node.append(...children);},
   insertAdjacentHTML(_where,value){node.innerHTML+=value;},
   querySelectorAll(selector){return descendants(node).filter(n=>n!==node&&matches(n,selector));},
   querySelector(selector){return node.querySelectorAll(selector)[0]??null;},
   closest(selector){for(let n=node;n;n=n.parentElement)if(matches(n,selector))return n;return null;},
   showModal(){node.open=true;},close(){node.open=false;},
   focus(){document.activeElement=node;},scrollIntoView(){node.scrolled=true;},
   checkValidity(){return !node.value.trim||node.value.trim()!=='';},reportValidity(){return node.checkValidity();},
   click(){downloads.push({name:node.download,blob:urls.get(node.href)});},remove(){},
  };
  for(const [k,v] of Object.entries(attributes))if(k.startsWith('data-'))node.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;
  if(attributes.id)byId.set(attributes.id,node);
  nodes.push(node);return node;
 }
 const descendants=n=>[n,...n.children.flatMap(descendants)];
 function matches(n,selector) {
  return selector.split(',').some(raw=>{
   const s=raw.trim();
   if(s==='#hex-map [data-region]')return !!n.dataset.region;
   if(s==='dialog[open]')return n.tagName==='DIALOG'&&n.open;
   if(s==='[contenteditable]')return n.getAttribute('contenteditable')!==null;
   if(s.startsWith('#'))return n.getAttribute('id')===s.slice(1);
   if(s.startsWith('.'))return n.classList.contains(s.slice(1));
   const a=s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
   if(a)return n.getAttribute(a[1])!==null&&(a[2]===undefined||n.getAttribute(a[1])===a[2]);
   return n.tagName===s.toUpperCase();
  });
 }
 const markup=html();
 for(const [,tag,attributeText] of markup.matchAll(/<([\w-]+)\b([^>]*\bid="[^"]+"[^>]*)>/g))element(tag,attrs(attributeText));
 const body=element('body',{class:'map-focused'});
 const actionButtons=['cap','shutdown'].map(type=>element('button',{'data-action':type}));
 const overlayButtons=['adequacy','power','compute'].map(mode=>element('button',{'data-overlay':mode}));
 const closeButtons=['settings','action-dialog'].map(id=>{const b=element('button',{'data-close':id});b.parentElement=byId.get(id);return b;});
 for(const formId of ['settings-form','action-form']) {
  const form=byId.get(formId), content=markup.match(new RegExp(`<form id="${formId}">([\\s\\S]*?)</form>`))[1];
  form.parentElement=byId.get(formId==='settings-form'?'settings':'action-dialog');
  const fields=[...content.matchAll(/<(input)\b([^>]*\bname="[^"]+"[^>]*)>/g),...content.matchAll(/<(select)\b([^>]*\bname="[^"]+"[^>]*)>([\s\S]*?)<\/select>/g)];
  for(const [,tag,attributeText,optionText] of fields) {
   const attributes=attrs(attributeText), input=element(tag,attributes);
   if(tag==='select'){const opts=[...(optionText??'').matchAll(/<option\b([^>]*)>/g)].map(m=>attrs(m[1]));input.value=(opts.find(o=>Object.hasOwn(o,'selected'))??opts[0])?.value??'';}
   form.elements[attributes.name]=input;form.append(input);
  }
  form.elements.namedItem=name=>form.elements[name]??null;
 }
 const actionForm=byId.get('action-form');
 for(const [group,names] of [['cap-fields',['cap','duration']],['shutdown-fields',['success','residual']]])byId.get(group).append(...names.map(name=>actionForm.elements[name]));
 const svg=element('svg');byId.get('hex-map').append(svg);
 const query=selector=>{
  if(selector==='#hex-map svg')return svg;
  const field=selector.match(/^#([\w-]+) (?:input|select)\[name=?"?([\w-]+)"?\]$/);
  if(field)return byId.get(field[1]).elements[field[2]];
  if(selector==='.decision-section')return element('section',{class:'decision-section'});
  return nodes.find(n=>matches(n,selector))??null;
 };
 document={body,activeElement:body,hidden:false,querySelector:query,getElementById:id=>byId.get(id)??null,
  querySelectorAll(selector){if(selector==='.map-modes button'||selector==='[data-overlay]')return overlayButtons;if(selector==='[data-action]')return actionButtons;if(selector==='[data-close]'||selector==='[data-close="settings"]')return closeButtons.filter(b=>selector==='[data-close]'||b.dataset.close==='settings');return nodes.filter(n=>matches(n,selector));},
  createElement:tag=>element(tag),addEventListener(){},
 };
 class FormDataFixture {constructor(form){this.values=Object.entries(form.elements).filter(([,n])=>n&&typeof n!=='function'&&!n.disabled).map(([k,n])=>[k,String(n.value)]);}get(k){return this.values.find(([name])=>name===k)?.[1]??null;}[Symbol.iterator](){return this.values[Symbol.iterator]();}}
 const deps={...spatial,...thomas,canonical,createWorld:options=>spatial.createWorld(structuredClone(options)),branchWorld:(w,a)=>spatial.branchWorld(w,structuredClone(a)),
  observeWorldMilestones,worldChanges:()=>[],eventDescription:()=>'',mapLegend:()=>'',
  simulateThomasTrajectory(...args){calls.benchmark.push(structuredClone(args));return thomas.simulateThomasTrajectory(...args);},
  updateHexMap(root,view,options){calls.map.push({t:view.t,...options});for(const r of view.regions){let tile=nodes.find(n=>n.dataset.region===r.id);if(!tile){tile=element('g',{'data-region':r.id,role:'button',tabindex:'0'});root.append(tile);}tile.setAttribute('aria-pressed',String(options.selectedId===r.id));}return svg;},
  decorateWorldMap(_root,view,options){calls.motion.push({t:view.t,previousT:options.previousView?.t});},...overrides,
 };
 const context=vm.createContext({document,console:{log(){}},...deps,
  window:{addEventListener:(type,fn)=>windowEvents.set(type,[...(windowEvents.get(type)??[]),fn])},
  FormData:FormDataFixture,structuredClone,CSS:{escape:x=>String(x)},Blob,
  URL:{createObjectURL:blob=>{const url=`blob:${urls.size}`;urls.set(url,blob);return url;},revokeObjectURL:url=>urls.delete(url)},
  setTimeout:fn=>{fn();return 1;},setInterval:fn=>{const id=intervals.size+1;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id),
  matchMedia:()=>({matches:false,addEventListener(){}}),
  FileReader:class{readAsText(file){this.result=file.content;return this.onload();}},
 });
 const source=readFileSync(new URL('./world-synthesis-app.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.runInContext(source,context,{filename:'world-synthesis-app.mjs'});
 const node=id=>byId.get(id);
 const state=()=>vm.runInContext('({world,baseline,playing,busy,zoom,selectedId,overlay})',context);
 async function key(target,code,keyValue=code) {
  const e={target,code,key:keyValue,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};
  if(target.dataset.region)await node('hex-map').dispatch('keydown',e);
  if(!e.stopped)for(const fn of windowEvents.get('keydown')??[])await fn(e);
  if(!e.defaultPrevented&&target.tagName==='BUTTON'&&['Space','Enter'].includes(code))await target.dispatch('click');
  return e;
 }
 return {node,state,calls,downloads,intervals,body,actionButtons,overlayButtons,closeButtons,context,key,
  async scenario(values={}){await node('settings-button').dispatch('click');Object.entries(values).forEach(([k,v])=>node('settings-form').elements[k].value=String(v));await node('settings-form').dispatch('submit');},
  async action(type,values={}){await actionButtons.find(b=>b.dataset.action===type).dispatch('click');Object.entries(values).forEach(([k,v])=>actionForm.elements[k].value=String(v));await actionForm.dispatch('submit');},
  async load(content){const file={size:Buffer.byteLength(content),content,text:async()=>content};node('load').files=[file];await node('load').dispatch('change');},
  async tick(){for(const fn of [...intervals.values()])await fn();},
  tile:id=>nodes.find(n=>n.dataset.region===id),
 };
}

test('BROWSER-01: native finish renders the horizon benchmark once and stops playback', async()=>{
 const c=mount();await c.scenario({horizon:1});await c.node('play').dispatch('click');
 const before=c.calls.map.length;await c.node('finish').dispatch('click');
 assert.equal(c.state().world.t,1);assert.equal(c.state().playing,false);assert.equal(c.intervals.size,0);
 assert.equal(c.node('error').hidden,true);assert.equal(c.calls.map.length,before+1);
 const last=thomas.simulateThomasTrajectory(thomas.DEFAULT_THOMAS_PARAMS,{alignment:.5},1).at(-1);
 assert.equal(c.node('thomas-H').textContent,`${format(last.H*8)} B`);
 assert.equal(c.calls.benchmark.at(-1)[2],1);assert.equal(c.node('finish').disabled,true);
 assert.match(c.node('history-chart').innerHTML,/YEAR 1/);
});

test('BROWSER-02: comparison copy and model execution explicitly remain independent',async()=>{
 const copy=html();assert.doesNotMatch(copy,/coupled|unified dynamics|combines our turn/i);
 assert.match(copy,/independent/i);assert.match(copy,/normalized/i);assert.match(copy,/alignment/i);
 const c=mount(),initial=c.state().world;await c.node('next-turn').dispatch('click');
 assert.deepEqual(c.state().world,spatial.advanceWorld(initial,1));
 assert.deepEqual(Object.keys(c.calls.benchmark.at(-1)[1]),['alignment']);
});

test('BROWSER-03: cap button opens a selected-region dialog and creates the actual paired branch',async()=>{
 const c=mount();await c.node('next-turn').dispatch('click');await c.node('hex-map').dispatch('click',{target:c.tile('delta')});
 const before=c.state().world;await c.actionButtons[0].dispatch('click');
 assert.equal(c.node('action-dialog').open,true);assert.match(c.node('action-region').textContent,/Delta/);
 assert.equal(c.node('action-form').elements.success.disabled,true);
 Object.assign(c.node('action-form').elements.cap,{value:'0'});c.node('action-form').elements.delay.value='0';c.node('action-form').elements.cost.value='0';
 await c.node('action-form').dispatch('submit');const branched=c.state().world;
 assert.deepEqual(c.state().baseline,before);assert.equal(branched.branchOf.configId,before.configId);
 assert.equal(branched.actions.at(-1).regionId,'delta');assert.equal(c.node('action-dialog').open,false);
 await c.node('next-turn').dispatch('click');
 assert.deepEqual(c.state().world,spatial.advanceWorld(branched,1));assert.deepEqual(c.state().baseline,spatial.advanceWorld(before,1));
 assert.equal(c.state().world.t,c.state().baseline.t);assert.equal(c.node('baseline-key').hidden,false);
 assert.match(c.node('policy-record').innerHTML,/Successful/);
});

test('BROWSER-03: shutdown button submits its own fields and preserves the no-new-action parent',async()=>{
 const c=mount();await c.action('shutdown',{start:0,delay:0,cost:0,success:1,residual:0});
 assert.equal(c.state().world.actions.length,1);assert.equal(c.node('action-form').elements.cap.disabled,true);
 await c.node('next-turn').dispatch('click');
 assert.equal(c.state().world.regions[0].state.shutdown,true);assert.equal(c.state().world.regions[0].state.residual,0);
 assert.equal(c.state().baseline.regions[0].state.shutdown,false);
 assert.deepEqual(Object.keys(c.calls.benchmark.at(-1)[1]),['alignment']);
});

test('BROWSER-04: inspector shows actual normalized Thomas stocks separately from regional state',async()=>{
 const c=mount();await c.scenario({horizon:20});for(let i=0;i<13;i++)await c.node('next-turn').dispatch('click');
 assert.doesNotMatch(c.node('region-facts').innerHTML,/longevity|wear/i);
 const point=thomas.simulateThomasTrajectory(thomas.DEFAULT_THOMAS_PARAMS,{alignment:.5},13).at(-1);
 const facts=c.node('benchmark-facts');assert.ok(facts,'dedicated independent benchmark stock panel');
 assert.match(facts.innerHTML,new RegExp(format(point.P/thomas.DEFAULT_THOMAS_PARAMS.initial_power,3).replace('.','\\.')));
 assert.match(facts.innerHTML,new RegExp(format(point.F/thomas.DEFAULT_THOMAS_PARAMS.initial_fabrication,3).replace('.','\\.')));
 assert.match(facts.innerHTML,/initial/);assert.doesNotMatch(facts.innerHTML,/TWh|blocks\/yr/);
});

test('BROWSER-05: milestone feed renders observations from the complete current world',async()=>{
 const c=mount();await c.node('next-turn').dispatch('click');const rows=observeWorldMilestones(c.state().world);
 assert.ok(rows.length>0);assert.equal(c.node('milestone-count').textContent,String(rows.length));
 assert.match(c.node('milestone-list').innerHTML,new RegExp(rows[0].title));
 assert.equal(c.calls.motion.at(-1).previousT,0);assert.equal(c.calls.motion.at(-1).t,1);
});

test('BROWSER-06: native zoom and focus buttons change actual DOM presentation',async()=>{
 const c=mount();await c.node('zoom-in').dispatch('click');assert.equal(c.node('hex-map').style.transform,'scale(1.1)');
 await c.node('zoom-reset').dispatch('click');assert.equal(c.node('hex-map').style.transform,'scale(1)');
 await c.node('map-focus').dispatch('click');assert.equal(c.body.classList.contains('map-focused'),false);
 assert.equal(c.node('map-focus').getAttribute('aria-pressed'),'false');
 await c.node('map-focus').dispatch('click');assert.equal(c.body.classList.contains('map-focused'),true);
});

test('BROWSER-07: Space preserves native button activation and region Enter/Space selects without playback',async()=>{
 const c=mount();await c.key(c.node('settings-button'),'Space',' ');
 assert.equal(c.node('settings').open,true);assert.equal(c.state().playing,false);
 await c.closeButtons.find(b=>b.dataset.close==='settings').dispatch('click');
 await c.key(c.tile('delta'),'Enter','Enter');assert.equal(c.state().selectedId,'delta');
 await c.key(c.tile('coast'),'Space',' ');assert.equal(c.state().selectedId,'coast');assert.equal(c.state().playing,false);
 assert.equal(c.tile('coast').getAttribute('aria-pressed'),'true');
 await c.key(c.body,'Space',' ');assert.equal(c.state().playing,true);
 await c.key(c.body,'Space',' ');assert.equal(c.state().playing,false);
});

test('BROWSER-11: settings pauses immediately, displays draft alignment and creates a paused reset',async()=>{
 const c=mount();await c.node('zoom-in').dispatch('click');await c.node('play').dispatch('click');await c.tick();
 const t=c.state().world.t;await c.node('settings-button').dispatch('click');assert.equal(c.state().playing,false);assert.equal(c.intervals.size,0);
 await c.tick();assert.equal(c.state().world.t,t);
 const form=c.node('settings-form');form.elements.alignment.value='.75';await form.elements.alignment.dispatch('input');assert.equal(c.node('alignment-output').textContent,'75.0%');
 await c.key(c.body,'ArrowRight','ArrowRight');assert.equal(c.state().world.t,t,'shortcut is disabled in a modal');
 form.elements.horizon.value='2';await form.dispatch('submit');
 assert.equal(c.state().world.t,0);assert.equal(c.state().world.config.alignment,.75);assert.equal(c.state().playing,false);
 assert.equal(c.state().baseline,null);assert.equal(c.state().zoom,1);assert.equal(c.node('settings').open,false);
 assert.equal(c.node('hex-map').style.transform,'scale(1)');
});

test('BROWSER-01/03: synthesis save/load preserves a paired parent and raw regional files remain compatible',async()=>{
 const c=mount();await c.action('cap',{start:0,delay:0,cost:0,cap:0});await c.node('next-turn').dispatch('click');
 const savedWorld=c.state().world,savedParent=c.state().baseline;await c.node('save').dispatch('click');
 const content=await c.downloads.at(-1).blob.text(),bundle=JSON.parse(content);
 assert.equal(bundle.schema,'our-turn.synthesis-ui.v1');assert.ok(bundle.benchmark.parameters);assert.equal(bundle.benchmark.regionalInterventionsApplied,false);
 await c.node('next-turn').dispatch('click');await c.load(content);
 assert.deepEqual(c.state().world,savedWorld);assert.deepEqual(c.state().baseline,savedParent);assert.equal(c.node('load').value,'');
 const raw=spatial.saveWorld(savedWorld);await c.load(raw);assert.deepEqual(c.state().world,savedWorld);assert.equal(c.state().baseline,null);
 assert.equal(c.calls.benchmark.at(-1)[2],1);assert.equal(c.node('error').hidden,true);
});

test('BROWSER-01/03: rejecting malformed comparison imports retains the accepted run',async()=>{
 const c=mount();await c.node('next-turn').dispatch('click');const accepted=c.state().world;
 await c.load('{"schema":"our-turn.synthesis-ui.v1","world":"not JSON","baseline":null}');
 assert.deepEqual(c.state().world,accepted);assert.equal(c.node('error').hidden,false);assert.equal(c.intervals.size,0);
});

test('BROWSER-03: a failed paired advance commits neither world and releases the busy guard',async()=>{
 let failParent=false,count=0;
 const c=mount({advanceWorld:(world,years)=>{if(failParent&&++count===2)throw new Error('parent advance failed');return spatial.advanceWorld(world,years);}});
 await c.action('cap',{start:0,delay:0,cost:0,cap:0});const before=c.state();failParent=true;
 await c.node('next-turn').dispatch('click');
 assert.deepEqual(c.state().world,before.world);assert.deepEqual(c.state().baseline,before.baseline);assert.equal(c.state().busy,false);
 assert.match(c.node('error').textContent,/parent advance failed/);
 failParent=false;await c.node('next-turn').dispatch('click');assert.equal(c.state().world.t,1);assert.equal(c.state().baseline.t,1);
});

test('BROWSER-01/03: benchmark mismatch and unrelated parent imports are rejected before state replacement',async()=>{
 const c=mount();await c.action('cap',{start:0,delay:0,cost:0,cap:0});await c.node('next-turn').dispatch('click');
 await c.node('save').dispatch('click');const bundle=JSON.parse(await c.downloads.at(-1).blob.text()),accepted=c.state().world;
 const other=spatial.advanceWorld(spatial.createWorld({seed:7,eventMode:'scenario'}),1);
 await c.load(JSON.stringify({...bundle,baseline:spatial.saveWorld(other)}));assert.deepEqual(c.state().world,accepted);assert.equal(c.node('error').hidden,false);
 await c.load(JSON.stringify({...bundle,benchmark:{...bundle.benchmark,dt:1}}));assert.deepEqual(c.state().world,accepted);
 assert.match(c.node('error').textContent,/specification/);
});

test('BROWSER-01: loading a horizon checkpoint recomputes its endpoint without starting a timer',async()=>{
 const c=mount(),done=spatial.advanceWorld(spatial.createWorld({horizon:1}),1);
 await c.load(spatial.saveWorld(done));assert.equal(c.node('error').hidden,true);assert.equal(c.state().world.t,1);
 assert.equal(c.calls.benchmark.at(-1)[2],1);assert.equal(c.node('play').disabled,true);assert.equal(c.intervals.size,0);
});

test('BROWSER-11: a delayed import cannot replace a newly created scenario',async()=>{
 const c=mount(),content=spatial.saveWorld(spatial.advanceWorld(c.state().world,1));let resolve;
 c.node('load').files=[{size:content.length,text:()=>new Promise(done=>{resolve=done;})}];
 const pending=c.node('load').dispatch('change');await c.scenario({seed:19,horizon:2});resolve(content);await pending;
 assert.equal(c.state().world.t,0);assert.equal(c.state().world.config.seed,19);assert.equal(c.node('load').value,'');
});

test('BROWSER-01: an imported benchmark rendering error is reported instead of silently swallowed',async()=>{
 const c=mount({simulateThomasTrajectory:()=>{throw new Error('benchmark rendering failed');}});
 await c.load(spatial.saveWorld(spatial.advanceWorld(c.state().world,1)));
 assert.equal(c.node('error').hidden,false);assert.match(c.node('error').textContent,/benchmark rendering failed/);
 assert.equal(c.state().playing,false);assert.equal(c.intervals.size,0);
});
