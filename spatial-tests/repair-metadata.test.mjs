import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,saveWorld,restoreWorld,configurationId} from '../spatial/world.mjs';

const fields=[['q','invalid'],['r',null],['q',101],['r',.5],['name',{}],['name','x'.repeat(101)],
  ['terrain',[]],['terrain','x'.repeat(65)]];
for(const [key,value] of fields)test(`restored regions enforce constructor metadata boundary: ${key}=${JSON.stringify(value)}`,()=>{
  const data=JSON.parse(saveWorld(createWorld()));
  data.regions[0][key]=value;
  data.configId=configurationId(data);
  assert.throws(()=>restoreWorld(JSON.stringify(data)),/region|position|metadata/i);
});

test('valid custom metadata remains unchanged through save and restore',()=>{
  const world=createWorld({regions:[{id:'custom',name:'A < B & C',q:100,r:-100,terrain:'custom terrain'}],links:[]});
  assert.deepEqual(restoreWorld(saveWorld(world)),world);
});
