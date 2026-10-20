import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAllocatePool} from '../spatial/allocation.mjs';

test('positive subnormal claims retain scale-equivalent shares instead of stranding supply',()=>{
 const reference=safeAllocatePool({supply:.5,needH:1,needA:1,claimH:1,claimA:1});
 for(const scale of [Number.MIN_VALUE,1e-320,1e-308,1e-200])
  assert.deepEqual(safeAllocatePool({supply:.5,needH:1,needA:1,claimH:scale,claimA:scale}),reference);
});
test('underflow protection uses unreserved supply and preserves capped redistribution',()=>{
 const supply=1,reserve=1-2**-52,available=supply-reserve;
 const result=safeAllocatePool({supply,reserve,needH:2,needA:2,claimH:1e-310,claimA:1e-310});
 assert.equal(result.human,reserve+available/2);assert.equal(result.other,available/2);
 assert.equal(result.unused,0);
 const capped=safeAllocatePool({supply:.5,needH:.1,needA:1,claimH:Number.MIN_VALUE,claimA:Number.MIN_VALUE});
 assert.equal(capped.human,.1);assert.equal(capped.other,.4);assert.equal(capped.unused,0);
});
test('tiny physical supply remains scale-equivalent for common positive claims',()=>{
 const reference=safeAllocatePool({supply:1e-200,needH:1e-200,needA:1e-200,claimH:1,claimA:3});
 const actual=safeAllocatePool({supply:1e-200,needH:1e-200,needA:1e-200,claimH:1e-200,claimA:3e-200});
 for(const key of ['human','other'])assert.ok(Math.abs(actual[key]/reference[key]-1)<1e-14,key);
 assert.equal(actual.unused,0);
});
test('representable small competing share is not erased by rounded human headroom',()=>{
 const result=safeAllocatePool({supply:1,needH:2,needA:1,claimH:1,claimA:1e-40});
 assert.equal(result.other,1e-40);assert.equal(result.human,1);
 assert.equal(result.unused,0);
});

test('overflow repair retains eligibility of tiny positive claim after other demand caps',()=>{
 const result=safeAllocatePool({supply:1000,needH:1,needA:1000,claimH:1e308,claimA:1e-300});
 assert.equal(result.human,1);assert.equal(result.other,999);assert.equal(result.unused,0);
});
test('overflow repair retains a representable allocation when normalized claim is subnormal',()=>{
 const result=safeAllocatePool({supply:1e308,needH:1e308,needA:1,claimH:1e308,claimA:1e-15});
 assert.ok(Math.abs(result.other-1e-15)/1e-15<1e-12);
});
test('extreme redistribution preserves orientation, exact zeros and reserved idle resources',()=>{
 assert.deepEqual(safeAllocatePool({supply:1000,needH:1000,needA:1,claimH:1e-300,claimA:1e308}),
  {human:999,other:1,unused:0,protected:0,infeasible:false});
 assert.deepEqual(safeAllocatePool({supply:1000,needH:1,needA:1000,claimH:1e308,claimA:0}),
  {human:1,other:0,unused:999,protected:0,infeasible:false});
 assert.deepEqual(safeAllocatePool({supply:0,needH:1000,needA:1000,claimH:1e308,claimA:1e308}),
  {human:0,other:0,unused:0,protected:0,infeasible:false});
 assert.deepEqual(safeAllocatePool({supply:1000,needH:1,needA:1000,claimH:1e308,claimA:1e308,reserve:1000}),
  {human:1,other:0,unused:999,protected:1000,infeasible:false});
});
