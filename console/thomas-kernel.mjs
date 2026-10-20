/**
 * Thomas Continuous 5D ODE Kernel (Browser & Node.js ES Module).
 *
 * Implements Thomas's continuous consumer-resource physics with:
 * - Infrastructure depreciation (delta_P = 2%/yr, delta_F = 8%/yr)
 * - Explicit repair flows (E_M, C_M)
 * - Tri-resource Leontief expansion bottleneck scaling
 * - Non-singular logistic human carrying capacity
 */

export const DEFAULT_THOMAS_PARAMS = Object.freeze({
  initial_humans: 1.0,
  initial_hardware: 1.0,
  initial_capability: 1.0,
  initial_power: 1.0,
  initial_fabrication: 0.30,
  total_land: 1.0,
  protected_humans: 1.0,

  human_power_per_person: 0.80,
  human_land_per_person: 0.80,
  human_growth_per_year: 0.012,
  human_max_decline_per_year: 0.08,

  hardware_power: 0.02,
  hardware_land: 0.002,
  power_land: 0.05,
  fabrication_land: 0.01,

  hardware_depreciation: 0.15,
  power_depreciation: 0.02,
  fabrication_depreciation: 0.08,

  hardware_build_energy: 0.02,
  power_build_energy: 1.50,
  fabrication_build_energy: 0.30,
  power_build_chips: 0.05,
  fabrication_build_chips: 0.20,

  max_replication_per_year: 1.20,
  replication_half_capability: 1.0,
  power_expansion_per_year: 0.03,
  fabrication_expansion_per_year: 0.08,
  land_adjustment_years: 1.0,

  industrial_activity_scale: 1.0,
  operation_budget_fraction: 0.65,
  ai_claim_weight: 0.10,
  claim_capability_exponent: 1.0,
  research_fraction: 0.30,
  research_rate: 0.20,
  capability_law: 'diminishing',
  capability_diminishing_scale: 20.0,
  capability_ceiling: 100.0,

  power_efficiency_floor: 0.10,
  power_efficiency_exponent: 0.0,
  human_support_half: 0.10,
  autonomy_maximum: 1.0,
  power_autonomy_scale: 5.0,
  fabrication_autonomy_scale: 10.0,

  extinction_threshold: 0.001,
  marginal_threshold: 0.50,
  hardware_persistence_threshold: 0.001,
});

// The same omitted-policy semantics as the original Python Policy dataclass.
export const DEFAULT_THOMAS_POLICY = Object.freeze({alignment:0,compute_cap:null,
  cap_start_year:0,shutdown_year:null,shutdown_succeeds:true});
const positiveParameters = new Set(['total_land','protected_humans','human_power_per_person','human_land_per_person',
  'human_growth_per_year','human_max_decline_per_year','hardware_power','hardware_land','power_land','fabrication_land',
  'hardware_build_energy','power_build_energy','fabrication_build_energy','power_build_chips','fabrication_build_chips',
  'replication_half_capability','land_adjustment_years','industrial_activity_scale','capability_diminishing_scale',
  'capability_ceiling','human_support_half','power_autonomy_scale','fabrication_autonomy_scale','extinction_threshold',
  'marginal_threshold','hardware_persistence_threshold']);
function finite(value,name,min=0,strict=false) {
  if(typeof value!=='number'||!Number.isFinite(value)||(strict?value<=min:value<min))throw new RangeError(`Invalid finite ${name}`);
}
function object(value,name) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`Invalid ${name}`);
}
function parameters(input) {
  object(input,'parameters');
  if(Object.keys(input).some(key=>!Object.hasOwn(DEFAULT_THOMAS_PARAMS,key)))throw new RangeError('Unknown Thomas parameter');
  const p={...DEFAULT_THOMAS_PARAMS,...input};
  for(const [key,value] of Object.entries(p))if(key!=='capability_law')finite(value,key,0,positiveParameters.has(key));
  for(const key of ['research_fraction','operation_budget_fraction','autonomy_maximum','power_efficiency_floor'])
    if(p[key]>1)throw new RangeError(`Invalid ${key} fraction`);
  if(p.power_efficiency_floor<=0||p.initial_capability<1||!['diminishing','exponential','bounded'].includes(p.capability_law)||
      p.capability_law==='bounded'&&p.initial_capability>p.capability_ceiling||p.extinction_threshold>=p.marginal_threshold)
    throw new RangeError('Invalid capability law, threshold or efficiency');
  const state=[p.initial_humans,p.initial_hardware,p.initial_capability,p.initial_power,p.initial_fabrication];
  if(occupiedLand(state,p)+p.human_land_per_person*Math.max(p.initial_humans,p.protected_humans)>p.total_land)
    throw new RangeError('Initial state cannot support full-alignment land reservation');
  return p;
}
function policyOptions(input) {
  object(input,'policy');
  if(Object.keys(input).some(key=>!Object.hasOwn(DEFAULT_THOMAS_POLICY,key)))throw new RangeError('Unknown Thomas policy field');
  const policy={...DEFAULT_THOMAS_POLICY,...input};
  finite(policy.alignment,'policy alignment');if(policy.alignment>1)throw new RangeError('Invalid policy alignment');
  finite(policy.cap_start_year,'policy cap start');
  if(policy.compute_cap!==null)finite(policy.compute_cap,'policy compute cap');
  if(policy.shutdown_year!==null)finite(policy.shutdown_year,'policy shutdown year');
  if(typeof policy.shutdown_succeeds!=='boolean')throw new TypeError('Invalid policy shutdown_succeeds');
  return policy;
}
function validateState(time,state) {
  finite(time,'time');
  if(!Array.isArray(state)||state.length!==5)throw new TypeError('Expected five Thomas state variables');
  for(const value of state)finite(value,'state');
}

export function autonomy(capability, scale, p = DEFAULT_THOMAS_PARAMS) {
  const diff = Math.max(0, capability - 1.0);
  return p.autonomy_maximum * (1.0 - Math.exp(-diff / scale));
}

export function occupiedLand(state, p = DEFAULT_THOMAS_PARAMS) {
  const [, hardware, , power, fabrication] = state;
  return p.hardware_land * Math.max(0, hardware) +
         p.power_land * Math.max(0, power) +
         p.fabrication_land * Math.max(0, fabrication);
}

export function limitedFlow(request, energy, chips, energyCost, chipCost) {
  return Math.max(0, Math.min(request, energy / energyCost, chips / chipCost));
}

export function allocateResourcesThomas(time, state, p = DEFAULT_THOMAS_PARAMS, policy = DEFAULT_THOMAS_POLICY) {
  validateState(time,state);
  const result=allocateUnchecked(time,state,parameters(p),policyOptions(policy));
  for(const value of Object.values(result))finite(value,'allocation');
  return result;
}

function allocateUnchecked(time, state, p, policy) {
  let [humans, hardware, capability, power, fabrication] = state.map(v => Math.max(0, v));
  capability = Math.max(1.0, capability);

  const h = Math.min(1.0, (humans * (1.0 + p.human_support_half)) / (humans + p.human_support_half));
  const autoP = autonomy(capability, p.power_autonomy_scale, p);
  const autoF = autonomy(capability, p.fabrication_autonomy_scale, p);
  const supportP = autoP + (1.0 - autoP) * h;
  const supportF = autoF + (1.0 - autoF) * h;
  const supplyPower = supportP * power;
  const supplyChips = supportF * fabrication;

  const needPop = Math.max(humans, p.protected_humans);
  const humanNeed = p.human_power_per_person * needPop;
  const humanReserve = Math.min(supplyPower, (policy.alignment ?? 0) * humanNeed);
  let available = Math.max(0, supplyPower - humanReserve);
  let chipsLeft = supplyChips;

  // Step 1: Pre-emptive Repairs for Power and Fabs
  const repairPower = limitedFlow(
    p.power_depreciation * power * supportP,
    available, chipsLeft,
    p.power_build_energy, p.power_build_chips
  );
  available = Math.max(0, available - p.power_build_energy * repairPower);
  chipsLeft = Math.max(0, chipsLeft - p.power_build_chips * repairPower);

  const repairFab = limitedFlow(
    p.fabrication_depreciation * fabrication * supportF,
    available, chipsLeft,
    p.fabrication_build_energy, p.fabrication_build_chips
  );
  const maintenanceEnergy = p.power_build_energy * repairPower + p.fabrication_build_energy * repairFab;
  available = Math.max(0, available - p.fabrication_build_energy * repairFab);
  chipsLeft = Math.max(0, chipsLeft - p.fabrication_build_chips * repairFab);

  // Step 2: Industrial Allocation
  const aiWeight = p.ai_claim_weight * hardware * Math.pow(capability, p.claim_capability_exponent);
  const share = (humans + aiWeight) > 0 ? aiWeight / (humans + aiWeight) : 0;
  const unalignedClaim = share * Math.max(0, supplyPower - maintenanceEnergy);
  const industrialBudget = Math.min(unalignedClaim, available);

  const powerPerHw = p.hardware_power * Math.max(p.power_efficiency_floor, Math.pow(capability, -p.power_efficiency_exponent));
  let run = Math.min(hardware, (p.operation_budget_fraction * industrialBudget) / powerPerHw);

  if (policy.compute_cap != null && time >= (policy.cap_start_year ?? 0)) {
    run = Math.min(run, policy.compute_cap);
  }
  if (policy.shutdown_succeeds && policy.shutdown_year != null && time >= policy.shutdown_year) {
    run = 0.0;
  }

  const operatingEnergy = powerPerHw * run;
  const buildEnergyBudget = Math.max(0, industrialBudget - operatingEnergy);

  // Step 3: Tri-Resource Leontief Scaling
  const replication = (p.max_replication_per_year * capability) / (capability + p.replication_half_capability);
  const activity = Math.min(1.0, (capability * run) / p.industrial_activity_scale);

  const desiredHw = replication * (1.0 - p.research_fraction) * run;
  const desiredPower = p.power_expansion_per_year * power * supportP * activity;
  const desiredFab = p.fabrication_expansion_per_year * fabrication * supportF * activity;

  const energyReq = p.hardware_build_energy * desiredHw + p.power_build_energy * desiredPower + p.fabrication_build_energy * desiredFab;
  const chipReq = desiredHw + p.power_build_chips * desiredPower + p.fabrication_build_chips * desiredFab;
  const landReq = p.hardware_land * desiredHw + p.power_land * desiredPower + p.fabrication_land * desiredFab;

  const land = occupiedLand(state, p);
  const protectedLand = (policy.alignment ?? 0) * p.human_land_per_person * needPop;
  const industrialLandLimit = Math.max(0, p.total_land - protectedLand);
  const depLand = p.hardware_land * p.hardware_depreciation * hardware +
                  p.power_land * p.power_depreciation * power +
                  p.fabrication_land * p.fabrication_depreciation * fabrication;
  const landBudget = Math.max(0, (industrialLandLimit - land) / p.land_adjustment_years + depLand - p.power_land * repairPower - p.fabrication_land * repairFab);

  let scale = 1.0;
  if (energyReq > 0) scale = Math.min(scale, buildEnergyBudget / energyReq);
  if (chipReq > 0) scale = Math.min(scale, chipsLeft / chipReq);
  if (landReq > 0) scale = Math.min(scale, landBudget / landReq);
  scale = Math.max(0, scale);

  const buildHw = desiredHw * scale;
  const growPower = desiredPower * scale;
  const growFab = desiredFab * scale;
  const buildPower = repairPower + growPower;
  const buildFab = repairFab + growFab;
  const growthEnergy = p.hardware_build_energy * buildHw + p.power_build_energy * growPower + p.fabrication_build_energy * growFab;

  const humanEnergy = Math.max(0, supplyPower - maintenanceEnergy - operatingEnergy - growthEnergy);
  const humanLand = Math.max(0, p.total_land - land);
  const carryingCapacity = Math.min(humanEnergy / p.human_power_per_person, humanLand / p.human_land_per_person);

  return {
    carryingCapacity,
    operatingHardware: run,
    buildHardware: buildHw,
    buildPower,
    buildFab,
    repairPower,
    repairFab,
    humanPower: humanEnergy,
    humanLand,
    occupiedLand: land,
    supportP,
    supportF,
  };
}

export function rsiRhsThomas(time, state, p = DEFAULT_THOMAS_PARAMS, policy = DEFAULT_THOMAS_POLICY) {
  validateState(time,state);
  const result=rhsUnchecked(time,state,parameters(p),policyOptions(policy));
  if(result.some(value=>!Number.isFinite(value)))throw new RangeError('Nonfinite Thomas derivative');
  return result;
}

function rhsUnchecked(time, state, p, policy, researchCoordinate = false) {
  const [humans, hardware, capability, power, fabrication] = state.map(v => Math.max(0, v));
  const alloc = allocateUnchecked(time, state, p, policy);
  const capacity = alloc.carryingCapacity;
  const theta = p.human_growth_per_year / p.human_max_decline_per_year;
  const denom = capacity + theta * humans;
  const dH = denom > 0 ? (p.human_growth_per_year * humans * (capacity - humans)) / denom : 0;

  let dC = p.research_rate * p.research_fraction * alloc.operatingHardware;
  if (!researchCoordinate) {
    dC *= capability;
    if (p.capability_law === 'diminishing') {
      dC /= (1.0 + capability / p.capability_diminishing_scale);
    } else if (p.capability_law === 'bounded') {
      dC *= Math.max(0, 1.0 - capability / p.capability_ceiling);
    }
  }

  const dA = alloc.buildHardware - p.hardware_depreciation * hardware;
  const dP = alloc.buildPower - p.power_depreciation * power;
  const dF = alloc.buildFab - p.fabrication_depreciation * fabrication;

  return [dH, dA, dC, dP, dF];
}

function boundedCapabilityAtDose(capability, dose, ceiling) {
  if (!Number.isFinite(dose) || dose < 0) throw new RangeError('Nonfinite bounded research dose; refine dt');
  if (dose === 0 || capability === ceiling) return capability;
  // Exact logistic flow for s=integral(research_rate*research_fraction*run dt).
  // Evaluate its positive increment with expm1, avoiding cancellation for tiny
  // doses and overflow from exp(s). Both factors of the remaining gap are <=1.
  const gap = ceiling - capability;
  const ratio = gap / capability;
  if (!Number.isFinite(ratio)) throw new RangeError('Unrepresentable bounded capability ratio');
  const fraction = -Math.expm1(-dose) / (1 + ratio * Math.exp(-dose));
  const next = capability + gap * fraction;
  if (!Number.isFinite(next) || next > ceiling) throw new RangeError('Bounded capability exceeds numeric precision');
  return next;
}

/**
 * Fixed-step RK4, with exact policy boundaries and frozen regimes within each
 * segment. For bounded growth, RK4 integrates the research coordinate and
 * evaluates capability through its exact logistic flow at every stage.
 * Finite-scenario refinement/reference tests do not imply global convergence
 * or empirical validity. Invalid/unstable steps fail explicitly.
 */
export function simulateThomasTrajectory(p = DEFAULT_THOMAS_PARAMS, policy = DEFAULT_THOMAS_POLICY, horizon = 30.0, dt = 0.05) {
  p=parameters(p);policy=policyOptions(policy);
  finite(horizon,'horizon',0,true);finite(dt,'dt',0,true);
  if(!Number.isFinite(horizon/dt)||Math.ceil(horizon/dt)>1_000_000)throw new RangeError('Thomas integration exceeds one million steps');
  let state = [p.initial_humans, p.initial_hardware, p.initial_capability, p.initial_power, p.initial_fabrication];
  let t = 0.0;
  const trajectory = [{ t: 0, H: state[0], A: state[1], C: state[2], P: state[3], F: state[4] }];

  const breaks=[0,horizon,...[policy.compute_cap!==null?policy.cap_start_year:null,policy.shutdown_year]
    .filter(value=>value!==null&&value>0&&value<horizon)].sort((a,b)=>a-b).filter((value,i,all)=>!i||value!==all[i-1]);
  let steps=0;
  for(let segment=0;segment<breaks.length-1;segment++) {
   const left=breaks[segment],right=breaks[segment+1];
   const frozen={...policy,compute_cap:left>=policy.cap_start_year?policy.compute_cap:null,cap_start_year:0,
     shutdown_year:policy.shutdown_year!==null&&left>=policy.shutdown_year?0:null};
   const nSteps=Math.max(1,Math.ceil((right-left)/dt));
   for(let step=0;step<nSteps&&t<right;step++) {
    const next=step===nSteps-1?right:Math.min(right,left+(step+1)*dt),h=next-t;
    if(!(h>0)||++steps>1_000_002)throw new RangeError('Thomas integration cannot advance at this precision');

    const bounded=p.capability_law==='bounded';
    const stage=(rates,interval)=>state.map((v,i)=>bounded&&i===2
      ? boundedCapabilityAtDose(v,interval*rates[i],p.capability_ceiling)
      : Math.max(0,v+interval*rates[i]));
    const k1 = rhsUnchecked(t, state, p, frozen, bounded);
    const k2 = rhsUnchecked(t + 0.5 * h, stage(k1,0.5*h), p, frozen, bounded);
    const k3 = rhsUnchecked(t + 0.5 * h, stage(k2,0.5*h), p, frozen, bounded);
    const k4 = rhsUnchecked(t + h, stage(k3,h), p, frozen, bounded);

    const increment=k1.map((v,i)=>(h/6)*(v+2*k2[i]+2*k3[i]+k4[i]));
    const updated=state.map((v,i)=>bounded&&i===2
      ? boundedCapabilityAtDose(v,increment[i],p.capability_ceiling) : v+increment[i]);
    if(updated.some(value=>!Number.isFinite(value)||value< -1e-8))throw new RangeError('Thomas step violates finite/nonnegative state; refine dt');
    state=updated.map(value=>Math.max(0,value));
    t=next;

    if (step % Math.max(1, Math.floor(0.25 / dt)) === 0 || t===right) {
      trajectory.push({ t, H: state[0], A: state[1], C: state[2], P: state[3], F: state[4] });
    }
   }
  }

  return trajectory;
}
