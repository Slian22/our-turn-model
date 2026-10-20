/** Console projection only: the numerical ledger remains owned by the kernel.
 * Unknown fields remain visible without inventing a physical dimension.
 */
const label=key=>key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ');
const units=Object.freeze(Object.fromEntries([
  [['start','end','h'],'years'],
  [['available','humanCritical','humanFlexible','operation','maintenance','construction','policy','unused',
    'extraction','generatedEnergy','storageDischarge','storageCharge','competitionPool','protectedReserve',
    'assetEnergyBefore','assetEnergyAfter','policyEnergyBefore','policyEnergyAfter',
    'storage','storageCharged','storageDischarged','storageLoss','coolingEnergy','extractionEnergy'],'TWh'],
  [['sourcePower','rawGeneratedPower','generatedPower','accessibleHumanPower','accessibleAiPower',
    'storageDischargePower','transmissionLossPower','coolingOperationLimit','heatOperationLimit',
    'coolingWaterOperationLimit'],'TWh/year'],
  [['extractionWork','workAvailable','maintenanceWork','constructionWork','policyWork'], 'block-equivalent work'],
  [['primaryMaterials','materialFree','oreRemaining','primarySupplied'],'hypothetical material units'],
  [['aiPriorityScore','humanPriorityScore'],'dimensionless score'],
  [['priorityWinner','competitionLeader'],'flag (0 human; 1 AI)'],
  [['competitionMode'],'mode code (0 legacy; 1 marginal)'],
  [['competitionHumanValue'],'QoL index per (kWh/person/year)'],
  [['competitionAiValue'],'lambda × capability index/TWh'],
  [['competitionLogRatio'],'dimensionless log ratio'],
  [['competitionTargetAiShare','competitionActualAiShare','serviceAdequacy','landAdequacy',
    'maintenanceAvailability','utilisation','humanReliability','aiReliability','foodAdequacy','waterAdequacy'],'fraction'],
  [['competitionObserved','competitionFlip','competitionHumanAtFloor','policyAccess','regionalPowerLimited',
    'storageLimited','coolingWaterLimited','heatLimited','refiningLimited','workLimited','energyLimited'],'flag (0/1)'],
  [['queuePendingCount'],'projects'],
  [['priorityProcessing'],'effective processing blocks'],
  [['poweredBlocks'],'fixed 1 MW blocks'],
  [['minimumPopulation','maximumPopulation'],'million people'],
  [['waterConsumed'],'m³'],
  [['coolingWaterIntensity'],'L/kWh'],
].flatMap(([keys,unit])=>keys.map(key=>[key,unit]))));

function unitFor(key,parents){
  // The same short account name has different dimensions in these two scopes.
  // Explicit counters/fractions still use their own dictionary entry.
  if(parents.includes('work')){
    if(['available','used','maintenance','construction','policy','extraction','unused'].includes(key))return 'block-equivalent work';
    if(['capacity','rate','sourceWork'].includes(key))return 'block-equivalent work/year';
  }
  return units[key]??'Unknown unit';
}

export function ledgerRows(value,path='',parents=[]){
  if(!value||typeof value!=='object'||Array.isArray(value))return [{account:path||'Ledger',value,unit:'Unknown unit'}];
  return Object.entries(value).flatMap(([key,item])=>{
    const account=[path,label(key)].filter(Boolean).join(' / ');
    return item&&typeof item==='object'&&!Array.isArray(item)
      ?ledgerRows(item,account,[...parents,key])
      :[{account,value:item,unit:unitFor(key,parents)}];
  });
}
