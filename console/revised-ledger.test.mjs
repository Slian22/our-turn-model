import test from 'node:test';
import assert from 'node:assert/strict';
import {ledgerRows} from './revised-ledger.mjs';
import {createRun,advanceRun} from '../revised/engine.mjs';

const byAccount=rows=>Object.fromEntries(rows.map(row=>[row.account,row]));

test('current numerical ledger has an explicit unit for every scalar account',()=>{
  const run=advanceRun(createRun({horizon:1}),.125);
  const rows=ledgerRows(run.state.last.ledger);
  assert.equal(rows.length,Object.keys(run.state.last.ledger).length);
  assert.deepEqual(rows.filter(row=>row.unit==='Unknown unit'),[]);
  const values=byAccount(rows);
  assert.equal(values['competition Actual Ai Share'].unit,'fraction');
  assert.equal(values['queue Pending Count'].unit,'projects');
  assert.equal(values['source Power'].unit,'TWh/year');
  assert.equal(values['primary Materials'].unit,'hypothetical material units');
});

test('fractions, scores, mode and event flags retain distinct non-energy units',()=>{
  const rows=byAccount(ledgerRows({competitionHumanValue:1,competitionAiValue:2,
    competitionLogRatio:3,competitionMode:1,competitionActualAiShare:.25,
    competitionLeader:1,coolingWaterLimited:1,minimumPopulation:8000,poweredBlocks:5}));
  assert.equal(rows['competition Human Value'].unit,'QoL index per (kWh/person/year)');
  assert.equal(rows['competition Ai Value'].unit,'lambda × capability index/TWh');
  assert.equal(rows['competition Log Ratio'].unit,'dimensionless log ratio');
  assert.equal(rows['competition Mode'].unit,'mode code (0 legacy; 1 marginal)');
  assert.equal(rows['competition Actual Ai Share'].unit,'fraction');
  assert.equal(rows['competition Leader'].unit,'flag (0 human; 1 AI)');
  assert.equal(rows['cooling Water Limited'].unit,'flag (0/1)');
  assert.equal(rows['minimum Population'].unit,'million people');
  assert.equal(rows['powered Blocks'].unit,'fixed 1 MW blocks');
});

test('nested energy and work scopes do not confuse amounts, rates or unrelated counters',()=>{
  const rows=byAccount(ledgerRows({energy:{available:2,sourcePower:3,queuePendingCount:4},
    work:{available:5,capacity:6,used:7},infrastructure:{waterConsumed:8,oreRemaining:9,
      storage:10,storageLoss:11,coolingEnergy:12}}));
  assert.equal(rows['energy / available'].unit,'TWh');
  assert.equal(rows['energy / source Power'].unit,'TWh/year');
  assert.equal(rows['energy / queue Pending Count'].unit,'projects');
  assert.equal(rows['work / available'].unit,'block-equivalent work');
  assert.equal(rows['work / capacity'].unit,'block-equivalent work/year');
  assert.equal(rows['work / used'].unit,'block-equivalent work');
  assert.equal(rows['infrastructure / water Consumed'].unit,'m³');
  assert.equal(rows['infrastructure / ore Remaining'].unit,'hypothetical material units');
  assert.equal(rows['infrastructure / storage'].unit,'TWh');
  assert.equal(rows['infrastructure / storage Loss'].unit,'TWh');
  assert.equal(rows['infrastructure / cooling Energy'].unit,'TWh');
});

test('unknown scalars and array payloads never acquire an invented energy unit',()=>{
  const input={futureEnergyMetric:2,work:{newFlag:1},newArray:[1,2],empty:null};
  const before=structuredClone(input);
  const rows=ledgerRows(input);
  assert.ok(rows.every(row=>row.unit==='Unknown unit'));
  assert.deepEqual(input,before);
  assert.deepEqual(rows.map(row=>row.value),[2,1,[1,2],null]);
});
