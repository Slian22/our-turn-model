import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as spatial from '../spatial/world.mjs';
import {observeWorldMilestones} from './world-milestones.mjs';

const html = () => readFileSync(new URL('./world.html', import.meta.url), 'utf8');
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
 // The fixture does not parse innerHTML; retain the toast's dismiss control.
 byId.get('event-toast').append(element('button'));
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
 const deps={...spatial,createWorld:options=>spatial.createWorld(structuredClone(options)),branchWorld:(w,a)=>spatial.branchWorld(w,structuredClone(a)),
  observeWorldMilestones,worldChanges:()=>[],eventDescription:()=>'',mapLegend:()=>'',
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
 const source=readFileSync(new URL('./world-app.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.runInContext(source,context,{filename:'world-app.mjs'});
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

function pendingImport(c) {
 let resolve,reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 c.node('load').files=[{size:1,text:()=>promise}];
 const complete=c.node('load').dispatch('change');
 return {resolve,reject,complete};
}
const api=c=>c.context.window.alphaWorld;
const checkpoint=seed=>spatial.saveWorld(spatial.createWorld({seed,eventMode:'off',horizon:2}));

// LUI-04: the whole production controller is mounted. Each pending file read
// completes only after a newer user action has been accepted.
for(const [name,change] of [
 ['native scenario',async c=>c.scenario({seed:200,horizon:2,eventMode:'off'})],
 ['API scenario',async c=>api(c).createScenario({seed:201,horizon:2,eventMode:'off'})],
 ['native advance',async c=>c.node('next-turn').dispatch('click')],
 ['API advance',async c=>api(c).advance(.25)],
 ['native action branch',async c=>c.action('cap',{start:0,delay:0,cost:0,cap:0,duration:1})],
 ['API action branch',async c=>api(c).applyAction({regionId:'delta',type:'cap',start:0,delay:0,cost:0,cap:0,duration:1})],
 ['direct restore',async c=>api(c).restore(checkpoint(202))],
])test(`LUI-04: pending import cannot replace a newer ${name}`,async()=>{
 const c=mount(),pending=pendingImport(c);
 await change(c);
 const accepted=api(c).save();
 pending.resolve(checkpoint(100));await pending.complete;
 assert.equal(api(c).save(),accepted);
 assert.equal(c.node('error').hidden,true,c.node('error').textContent);
});

test('LUI-04: the latest selected checkpoint wins when reads finish out of order',async()=>{
 const c=mount(),first=pendingImport(c),second=pendingImport(c);
 second.resolve(checkpoint(301));await second.complete;
 const accepted=api(c).save();
 first.resolve(checkpoint(300));await first.complete;
 assert.equal(api(c).save(),accepted);
 assert.equal(api(c).getWorld().config.seed,301);
});

test('LUI-04: stale read errors cannot obscure an accepted scenario',async()=>{
 const c=mount(),pending=pendingImport(c);
 api(c).createScenario({seed:401,horizon:2,eventMode:'off'});
 pending.reject(new Error('older read failed'));await pending.complete;
 assert.equal(c.node('error').hidden,true,c.node('error').textContent);
 assert.equal(api(c).getWorld().config.seed,401);
});

test('LUI-04: current imports and failures keep the existing native behavior',async()=>{
 const c=mount();await c.load(checkpoint(501));
 assert.equal(api(c).getWorld().config.seed,501);
 assert.equal(c.node('load').value,'');
 const accepted=api(c).save();await c.load('{invalid JSON');
 assert.equal(c.node('error').hidden,false);
 assert.equal(api(c).save(),accepted);
});

test('LUI-04: view-only changes do not discard a pending checkpoint',async()=>{
 const c=mount(),pending=pendingImport(c);
 api(c).pause();api(c).setOverlay('compute');
 pending.resolve(checkpoint(601));await pending.complete;
 assert.equal(api(c).getWorld().config.seed,601);
});
