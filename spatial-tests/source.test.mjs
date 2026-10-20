import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SOURCE_DIGEST,SPATIAL_VERSION} from '../spatial/world.mjs';

test('regional source pin independently binds regional modules and baseline dependencies',()=>{
 const root=new URL('../',import.meta.url),manifest=JSON.parse(readFileSync(new URL('spatial/source-manifest.json',root),'utf8'));
 const paths=['spatial','sim'].flatMap(dir=>readdirSync(new URL(dir+'/',root))
  .filter(f=>f.endsWith('.mjs')&&!(dir==='spatial'&&f==='version.mjs')).map(f=>dir+'/'+f)).sort();
 assert.deepEqual(manifest.files.map(f=>f.path),paths);assert.equal(manifest.spatialVersion,SPATIAL_VERSION);
 const hash=createHash('sha256');
 for(const file of manifest.files){
  const data=readFileSync(new URL(file.path,root));
  assert.equal(createHash('sha256').update(data).digest('hex'),file.sha256,file.path);
  hash.update(file.path+'\0').update(data).update('\0');
 }
 assert.equal(hash.digest('hex'),SOURCE_DIGEST);assert.equal(SOURCE_DIGEST,manifest.digest);
 assert.notEqual(SOURCE_DIGEST,'0'.repeat(64));
});
