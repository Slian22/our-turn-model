/** M09: frozen scenario experiments, not an empirical probability model of the future. */
import { PARAMETERS, makeConfig } from './config.mjs';
import { seedStreams, uniform, canonical, hashText } from './rng.mjs';
import * as engineAPI from './engine.mjs';

export const EXPERIMENT_VERSION = 'M09-v1';
export const INTERVAL_NOTE = '95% Monte Carlo uncertainty conditional on the declared scenario law; excludes model, calibration and real-world probability uncertainty.';
const ranges = {
  kappa: [.02, .06, .12], hardwareGrowth: [.15, .35, .65],
  automationRate: [.005, .025, .06], shortfall: [.03, .08, .16],
  powerDelay: [2, 4, 10], humanEnergy: [1, 2, 4], dependencyReserve: [0, .25, .5],
};
export const SCENARIO_RANGES = Object.freeze(Object.fromEntries(Object.entries(ranges).map(([key, [low, mode, high]]) =>
  [key, Object.freeze({ low, mode, high, unit: PARAMETERS[key].unit, classification: 'scenario assumption',
    rationale: 'Analyst-declared illustrative range; triangular mode equals the frozen reference scenario. No empirical future prior; independent product sampling.' })])));
const OUTCOMES = ['extinction', 'marginal', 'non-marginal'];
const adverse = r => r?.status === 'ok' ? Number(r.summary.outcome !== 'non-marginal') : null;
const clip = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

export function sampleDraws({ runs = 1000, seed = 20261015, distribution = 'uniform' } = {}) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 10000) throw new RangeError('runs must be an integer in 1..10000');
  if (!['uniform', 'triangular'].includes(distribution)) throw new RangeError('Unknown scenario distribution');
  let state = seedStreams(seed).parameters;
  return Array.from({ length: runs }, (_, id) => {
    const parameterStateBefore = state;
    const parameters = Object.fromEntries(Object.entries(SCENARIO_RANGES).map(([key, { low, mode, high }]) => {
      const draw = uniform(state); state = draw.state;
      const u = draw.value, width = high - low;
      const value = distribution === 'uniform' ? low + u * width : u < (mode - low) / width
        ? low + Math.sqrt(u * width * (mode - low)) : high - Math.sqrt((1 - u) * width * (high - mode));
      return [key, value];
    }));
    // A separate bijective seed schedule: parameter-consumption changes cannot move environment/policy seeds.
    const runSeed = (seed ^ Math.imul(id + 1, 0x9e3779b9)) >>> 0;
    return { id, distribution, seed: runSeed, parameters, parameterStateBefore, parameterStateAfter: state,
      streamSeeds: seedStreams(runSeed) };
  });
}

export function policyArms() {
  return [{ id: 'baseline', policies: [] }, ...[5, 30, 60].flatMap(start => [
    { id: `cap-${start}`, policies: [{ type: 'cap', start, delay: 2, capBlocks: 500, cost: 5 }] },
    { id: `shutdown-${start}`, policies: [{ type: 'shutdown', start, delay: 2, success: .8, residual: .05, cost: 5 }] },
  ])];
}

export function fixedReferenceDraws({ runs = 128, seed = 20261015 } = {}) {
  return sampleDraws({ runs, seed }).map(({ id, seed: runSeed, streamSeeds }) =>
    ({ id, seed: runSeed, streamSeeds, parameters: {}, distribution: 'fixed-reference' }));
}

export function wilson(k, n, z = 1.959963984540054) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n || !Number.isFinite(z) || z <= 0)
    throw new RangeError('Wilson requires integer 0 <= k <= n and positive finite z');
  if (!n) return { estimate: null, lower: 0, upper: 1, n: 0 };
  const p = k / n, ratio = z / Math.sqrt(n);
  // Scale by n, then use the reciprocal above unity so no square can overflow.
  const squared = (ratio <= 1 ? ratio : 1 / ratio) ** 2, denominator = 1 + squared;
  const centre = ratio <= 1 ? (p + squared / 2) / denominator : (p * squared + .5) / denominator;
  const radius = ratio <= 1 ? ratio * Math.sqrt(p * (1 - p) + squared / 4) / denominator
    : Math.sqrt(p * (1 - p) * squared + .25) / denominator;
  return { estimate: p, lower: k === 0 ? 0 : clip(centre - radius), upper: k === n ? 1 : clip(centre + radius), n };
}

export function aggregateAttempts(attempts) {
  for (const r of attempts) if (!['ok', 'failed'].includes(r.status) || (r.status === 'ok' && !OUTCOMES.includes(r.summary?.outcome)))
    throw new TypeError('Unrecognized attempt status/outcome');
  const n = attempts.length, failed = attempts.filter(r => r.status === 'failed').length;
  const outcomes = Object.fromEntries(OUTCOMES.map(name => {
    const count = attempts.filter(r => r.status === 'ok' && r.summary.outcome === name).length;
    return [name, { count, confirmedRate: n ? count / n : null,
      identificationBounds: n ? [count / n, (count + failed) / n] : [0, 1],
      lower: wilson(count, n).lower, upper: wilson(count + failed, n).upper }];
  }));
  const count = outcomes.extinction.count + outcomes.marginal.count;
  return { attempted: n, completed: n - failed, failed, failureFrequency: wilson(failed, n), outcomes,
    adverse: { count, estimate: failed || !n ? null : count / n, confirmedRate: n ? count / n : null,
      identificationBounds: n ? [count / n, (count + failed) / n] : [0, 1],
      lower: wilson(count, n).lower, upper: wilson(count + failed, n).upper },
    uncertainty: INTERVAL_NOTE, denominator: 'All attempted runs. Failed outcomes are unknown; intervals envelope all possible failure classifications.' };
}

export function pairedComparison(attempts, baselineId, treatmentId) {
  const relevant = attempts.filter(r => [baselineId, treatmentId].includes(r.armId));
  const byDraw = new Map();
  for (const record of relevant) {
    const pair = byDraw.get(record.drawId) ?? new Map();
    if (pair.has(record.armId)) throw new Error('Duplicate paired draw');
    pair.set(record.armId, record); byDraw.set(record.drawId, pair);
  }
  const pairs = [...byDraw.values()].map(pair => {
    const b = pair.get(baselineId), t = pair.get(treatmentId);
    if (b && t && (b.seed !== t.seed || canonical(b.parameters) !== canonical(t.parameters))) throw new Error('Unmatched pair seed/parameters');
    return [b, t];
  });
  const bounds = pairs.map(([b, t]) => {
    const bv = adverse(b), tv = adverse(t);
    return [(tv ?? 0) - (bv ?? 1), (tv ?? 1) - (bv ?? 0)];
  });
  const n = pairs.length, completePairs = pairs.filter(p => p.every(r => r?.status === 'ok')).length;
  const identificationBounds = n ? [0, 1].map(i => bounds.reduce((sum, b) => sum + b[i], 0) / n) : [-1, 1];
  const radius = n ? Math.sqrt(2 * Math.log(40) / n) : 2;
  const pairedOutcomes = Object.fromEntries([...OUTCOMES, 'failure'].flatMap(b => [...OUTCOMES, 'failure'].map(t => [b + '|' + t, 0])));
  for (const [b, t] of pairs) pairedOutcomes[(b?.summary?.outcome ?? 'failure') + '|' + (t?.summary?.outcome ?? 'failure')]++;
  return { baselineId, treatmentId, attemptedPairs: n, completePairs, incompletePairs: n - completePairs,
    estimate: n && completePairs === n ? identificationBounds[0] : null, identificationBounds,
    interval: [clip(identificationBounds[0] - radius, -1, 1), clip(identificationBounds[1] + radius, -1, 1)],
    pairedOutcomes, quantity: 'Treatment minus baseline adverse-outcome frequency; negative favours treatment.',
    method: 'Conservative two-sided 95% Hoeffding interval for bounded paired differences in [-1,1]; unknown pairs bounded using available outcomes.',
    uncertainty: INTERVAL_NOTE };
}

export function attemptRun({ draw, arm, overrides = {}, engine = engineAPI, retainRun = false }) {
  let config = { ...draw.parameters, ...overrides, ...arm.overrides, seed: draw.seed, policies: structuredClone(arm.policies) };
  let run;
  const identity = { drawId: draw.id, armId: arm.id, seed: draw.seed, parameters: draw.parameters };
  try {
    config = makeConfig(config);
    run = engine.createRun(config); config = run.config;
    run = engine.simulate(run, retainRun ? {} : { traceProjects: false, recordTrajectory: false });
    const summary = engine.summarize(run);
    if (!OUTCOMES.includes(summary.outcome) || ['finalH', 'finalB', 'finalQ', 'minPopulation', 'minAdequacy', 'shortageYears', 'meanAdequacy', 'meanPopulation']
      .some(k => !Number.isFinite(summary[k]))) throw new Error('Invalid/nonfinite summary');
    return { ...identity, status: 'ok', config, configId: run.configId, engineVersion: run.engineVersion,
      sourceDigest: run.sourceDigest, summary, policyLog: run.state.policyLog ?? [],
      shockLog: (run.state.events ?? []).filter(e => e.type === 'supply-shock'),
      finalRng: run.state.rng ?? null, finalLedger: run.state.ledger ?? null, ...(retainRun ? { run } : {}) };
  } catch (error) {
    return { ...identity, status: 'failed', config, configId: run?.configId ?? hashText(canonical(config)),
      engineVersion: run?.engineVersion ?? engine.ENGINE_VERSION, sourceDigest: run?.sourceDigest ?? engine.SOURCE_DIGEST,
      error: { name: error.name, message: error.message, stack: error.stack } };
  }
}

export function runEnsemble({ draws, arms = policyArms(), overrides = {}, engine = engineAPI, onProgress }) {
  if (!Array.isArray(draws) || !arms.length || new Set(draws.map(d => d.id)).size !== draws.length
    || new Set(arms.map(a => a.id)).size !== arms.length) throw new Error('Unique draw and arm IDs required');
  const attempts = draws.flatMap((draw, i) => {
    const matched = arms.map(arm => attemptRun({ draw, arm, overrides, engine }));
    if (onProgress && ((i + 1) % 50 === 0 || i + 1 === draws.length))
      onProgress({ completedDraws: i + 1, totalDraws: draws.length, completedAttempts: (i + 1) * arms.length });
    return matched;
  });
  return { attempts, failures: attempts.filter(r => r.status === 'failed'),
    groups: arms.map(arm => ({ armId: arm.id, ...aggregateAttempts(attempts.filter(r => r.armId === arm.id)) })),
    comparisons: arms.slice(1).map(a => pairedComparison(attempts, arms[0].id, a.id)) };
}

/** Intervals connect adjacent sampled grid points only: no claim about unsampled alignments. */
export function safeSet(points, tolerance = .05, field = 'upper', maxGap = .020000001) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new RangeError('Risk tolerance must be in [0,1]');
  const ordered = [...points].sort((a, b) => a.alignment - b.alignment);
  return ordered.reduce((sets, p, i) => {
    if (!Number.isFinite(p[field]) || p[field] > tolerance) return sets;
    const previous = ordered[i - 1], contiguous = previous && previous[field] <= tolerance && p.alignment - previous.alignment <= maxGap;
    return contiguous ? [...sets.slice(0, -1), [sets.at(-1)[0], p.alignment]] : [...sets, [p.alignment, p.alignment]];
  }, []);
}

export function alignmentScan({ draws, overrides = {}, engine = engineAPI, tolerance = .05,
  grid = Array.from({ length: 51 }, (_, i) => i / 50), onProgress }) {
  if (!grid.length || new Set(grid).size !== grid.length || grid.some(a => !Number.isFinite(a) || a < 0 || a > 1)) throw new RangeError('Invalid alignment grid');
  const results = grid.map((alignment, i) => {
    const result = runEnsemble({ draws, arms: [policyArms()[0]], overrides: { ...overrides, alignment }, engine });
    if (onProgress && ((i + 1) % 5 === 0 || i + 1 === grid.length))
      onProgress({ completedPoints: i + 1, totalPoints: grid.length, alignment });
    return { alignment, result };
  });
  const points = results.map(({ alignment, result }) => ({ alignment, ...result.groups[0].adverse,
    attempted: result.attempts.length, failed: result.failures.length }));
  const certifiedSafeSet = safeSet(points, tolerance);
  const observedSafeSet = safeSet(points.map(p => ({ ...p, observed: p.identificationBounds[1] })), tolerance, 'observed');
  return { points, attempts: results.flatMap(r => r.result.attempts), tolerance, certifiedSafeSet, observedSafeSet,
    status: certifiedSafeSet.length ? 'resolved-safe-grid-points' : points.every(p => p.lower > tolerance) ? 'no-feasible-grid-point' : 'unresolved',
    uncertainty: INTERVAL_NOTE + ` Pointwise intervals, not a simultaneous confidence band. No certification between grid points. n=${draws.length}; zero-event Wilson upper=${wilson(0, draws.length).upper}.`,
    monotonicityAssumed: false, resolution: 'Sampled points only; no bisection or interpolation.' };
}

export function robustnessCases() {
  return [
    { id: 'reference', overrides: {} }, { id: 'convex-reserve', overrides: { reserveRule: 'convex' } },
    { id: 'factory-demand-linked', overrides: { factoryRule: 'demand-linked' },
      provenance: 'Post-pilot mechanism stress-test of unnecessary factory expansion; frozen persistent reference unchanged. Not a tuned fit.' },
    ...[0, 2].map(supportTime => ({ id: `supportTime-${supportTime}`, overrides: { supportTime },
      provenance: 'Scenario sensitivity of explicit human-support response time in years; zero is the former instantaneous-target rule.' })),
    { id: 'improvement-none', overrides: { improvement: 'none' } },
    { id: 'improvement-exponential', overrides: { improvement: 'exponential' } },
    ...[50, 200].map(horizon => ({ id: `horizon-${horizon}`, overrides: { horizon } })),
    { id: 'demography-lower', overrides: { birth: .012, death: .018 } },
    { id: 'demography-higher', overrides: { birth: .025, death: .015 } },
    ...['none', 'exponential'].flatMap(improvement => [
      { id: `${improvement}-demography-lower`, overrides: { improvement, birth: .012, death: .018 } },
      { id: `${improvement}-demography-higher`, overrides: { improvement, birth: .025, death: .015 } },
    ]),
    ...Object.entries({ extinctionPopulation: [.001, .1], extinctionWindow: [1, 10], marginalPopulation: [.25, .75],
      marginalAdequacy: [.6, .95], outcomeWindow: [5, 20] }).flatMap(([key, levels]) => levels.map((value, i) =>
      ({ id: `threshold-${key}-${i ? 'high' : 'low'}`, overrides: { [key]: value } }))),
  ];
}

export function oatCases() {
  return Object.entries(SCENARIO_RANGES).flatMap(([key, r]) => ['low', 'high'].map(level => ({
    id: `${key}-${level}`, parameter: key, level, overrides: { [key]: r[level] },
    limitation: 'One-at-a-time endpoints around the frozen reference; omits interactions and joint uncertainty. This is not a value-of-information analysis or proof of measurement priority.',
  })));
}

export function convergenceCheck({ overrides = {}, engine = engineAPI, tolerance = .01,
  dts = [.25, .125, .0625, .03125, .015625] } = {}) {
  if (dts.length < 2 || new Set(dts).size !== dts.length || dts.some((dt, i) => !Number.isFinite(dt) || dt <= 0 || (i && dt >= dts[i - 1])))
    throw new RangeError('Convergence steps must strictly decrease');
  const draw = { id: 0, seed: overrides.seed ?? 20261015, parameters: {} };
  const arm = { id: 'baseline', policies: overrides.policies ?? [] };
  const steps = dts.map(dt => attemptRun({ draw, arm, overrides: { ...overrides, dt }, engine }));
  const comparisons = steps.slice(0, -1).map((coarse, i) => {
    const fine = steps[i + 1];
    if ([coarse, fine].some(r => r.status === 'failed')) return { coarseDt: dts[i], fineDt: dts[i + 1], pass: false, failure: true };
    const metrics = Object.fromEntries(['finalH', 'finalQ', 'finalB', 'minPopulation', 'minAdequacy', 'shortageYears', 'meanAdequacy', 'meanPopulation'].map(key => {
      const a = coarse.summary[key], b = fine.summary[key], absoluteDifference = Math.abs(a - b);
      const relativeDifference = absoluteDifference / Math.max(Math.abs(b), 1e-12);
      const duration = key === 'shortageYears';
      return [key, { coarse: a, fine: b, absoluteDifference, relativeDifference,
        rule: duration ? 'Absolute time-resolution tolerance <= coarseDt years; raw relative error retained.' : 'Strict relative tolerance.',
        tolerance: duration ? dts[i] : tolerance,
        pass: duration ? absoluteDifference <= dts[i] + 1e-10 : relativeDifference <= tolerance }];
    }));
    return { coarseDt: dts[i], fineDt: dts[i + 1], metrics, outcomeChanged: coarse.summary.outcome !== fine.summary.outcome,
      pass: Object.values(metrics).every(m => m.pass) && coarse.summary.outcome === fine.summary.outcome };
  });
  return { tolerance, relativeDenominator: 'max(abs(finer metric),1e-12); zero-scale metrics may fail under small absolute deviations.',
    steps, comparisons, failures: steps.filter(s => s.status === 'failed'), pass: comparisons.every(c => c.pass),
    finestPairPass: comparisons.at(-1).pass, scope: 'Adjacent-step numerical diagnostic for the specified scenario only; not model validation or an ensemble-wide guarantee.' };
}
