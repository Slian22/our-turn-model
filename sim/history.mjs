/** M02. N = Neandertal adult equivalents; M = modern-human adult equivalents. */
import { allocatePool, adequacy, populationStep } from './resources.mjs';
import { seedStreams, uniform } from './rng.mjs';

export const HISTORY_VERSION = 'stage1-m02-v1';
export const ENERGY_PAIRS = Object.freeze([
  ['cold-male', 4701, 4414], ['cold-female', 3185, 3084],
  ['temperate-male', 3439, 3163], ['temperate-female', 2409, 2256], ['tropical-male', 3339, 3131],
].map(([id, N, M]) => Object.freeze({ id, N, M, units: 'kcal/adult/day', source: 'PA20090096.pdf Table 5 p13' })));
const RATES = Object.freeze({ birth: 0.025, death: 0.024, shortfall: 0.02 });
export const HISTORY_DEFAULTS = Object.freeze({
  horizon: 12000, dt: 2, outputEvery: 20, energyPair: 'cold-male', initialTotal: 100,
  initialModernFraction: 0.1, foodAccess: 1, areaKm2: 1000, landPerAdultKm2: 5,
  foodClaimN: 1, foodClaimM: 1, landClaimN: 1, landClaimM: 1, rates: RATES,
});
const LIMITS = Object.freeze([
  'Uncalibrated birth, death and shortfall rates; no calorie-to-demography law is identified by the supplied evidence.',
  'Arbitrary reference adult-equivalent scale, area, land need, initial fraction and static food productivity; no census estimate.',
  'Equal per-adult resource claims by default; matched adult sex/climate scenarios are not age/sex population diets.',
  'No migration, interbreeding, age structure, seasonality, climate history or spatial contact process in the primary model.',
  'The nine-to-tenfold archaeological period proxy is not a simultaneous initial population ratio.',
  'Local contact time and 1% share are hypothetical; regional industry/fossil overlaps measure different quantities.',
]);

function settings(defaults, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid configuration');
  for (const k of Object.keys(input)) if (!Object.hasOwn(defaults, k)) throw new RangeError(`Unknown configuration: ${k}`);
  const c = { ...defaults, ...input };
  for (const [k, v] of Object.entries(c)) {
    if (typeof defaults[k] === 'number' && (!Number.isFinite(v) || v < 0)) throw new RangeError(`${k}: finite nonnegative value required`);
  }
  for (const k of ['dt', 'outputEvery']) if (k in c && c[k] <= 0) throw new RangeError(`${k} must be positive`);
  if ('dt' in c && Math.ceil(c.horizon / c.dt) > 1e6) throw new RangeError('Invalid configuration: more than one million steps');
  return c;
}
function positive(c, keys) {
  for (const k of keys) if (!(c[k] > 0)) throw new RangeError(`${k} must be positive`);
}
function fraction(x, name) {
  if (!Number.isFinite(x) || x < 0 || x > 1) throw new RangeError(`Invalid ${name} fraction`);
}
const share = p => p.M + p.N > 0 ? p.M / (p.M + p.N) : null;
// Fractions are in [0,1]: this absolute roundoff band is 32 machine epsilons.
// It resolves numerical boundary plateaus, not a change to the scientific targets.
const THRESHOLD_TOLERANCE = 32 * Number.EPSILON;
function thresholdOffset(value, target) {
  if (value === null) return null;
  const offset = value - target;
  return Math.abs(offset) <= THRESHOLD_TOLERANCE ? 0 : offset;
}
function crossing(points, target, { last = false, interpolate = true } = {}) {
  let time = thresholdOffset(share(points[0]), target) === 0 ? points[0].t : null;
  if (time !== null && !last) return time;
  for (let i = 1; i < points.length; i++) {
    const a = thresholdOffset(share(points[i - 1]), target), b = thresholdOffset(share(points[i]), target);
    if (a !== null && b !== null && a < 0 && b >= 0) {
      time = interpolate ? points[i - 1].t + (points[i].t - points[i - 1].t) * -a / (b - a) : points[i].t;
      if (!last) return time;
    }
  }
  return time;
}

/** First 1%-N passage; last upward modern 10%/90% crossings. No finite-time ODE extinction claim. */
export function summarizeHistory(points, { interpolate = true } = {}) {
  if (!points.length) throw new RangeError('Invalid empty trajectory');
  const first = share(points[0]), end = points.at(-1), opts = { last: true, interpolate };
  const left = thresholdOffset(first, 0.99) > 0;
  const time = left ? 0 : crossing(points, 0.99, { interpolate });
  const t10 = crossing(points, 0.1, opts), t90 = crossing(points, 0.9, opts);
  const available = t10 !== null && t90 !== null && t90 >= t10;
  return {
    contactTo1Percent: { time, censored: time === null, leftCensored: left, censorTime: end.t,
      definition: 'First Neandertal share N/(N+M) <= 0.01; not absolute extinction' },
    window10to90: { t10, t90, duration: available ? t90 - t10 : null, available,
      leftCensored: thresholdOffset(first, 0.1) > 0 && t10 === null, rightCensored: t90 === null || (t10 !== null && t90 < t10),
      definition: 'Last upward crossings, linearly interpolated on integration grid unless discrete events' },
    thresholdNumerics: { absoluteShareTolerance: THRESHOLD_TOLERANCE,
      boundaryPolicy: 'Offsets within 32 machine epsilons are numerical boundary plateaus; interpolation uses those zero offsets. Raw thresholds and trajectory shares are unchanged.' },
    final: { t: end.t, N: end.N, M: end.M, modernFraction: share(end) },
  };
}
function sampled(points, every) {
  return points.filter((p, i) => i === 0 || i === points.length - 1 || Math.floor(p.t / every) > Math.floor(points[i - 1].t / every));
}

function resourcesAt(t, N, M, c, pair) {
  const foodSupply = c.initialTotal * pair.M * 365 * c.foodAccess;
  const needFoodN = N * pair.N * 365, needFoodM = M * pair.M * 365;
  const needLandN = N * c.landPerAdultKm2, needLandM = M * c.landPerAdultKm2;
  const food = allocatePool({ supply: foodSupply, needH: needFoodM, needA: needFoodN,
    claimH: M * c.foodClaimM, claimA: N * c.foodClaimN, reserve: 0 });
  const land = allocatePool({ supply: c.areaKm2, needH: needLandM, needA: needLandN,
    claimH: M * c.landClaimM, claimA: N * c.landClaimN, reserve: 0 });
  return { t, N, M, sN: adequacy([food.other, land.other], [needFoodN, needLandN]),
    sM: adequacy([food.human, land.human], [needFoodM, needLandM]), modernFraction: share({ N, M }),
    foodN: food.other, foodM: food.human, foodUnused: food.unused, foodSupply,
    landN: land.other, landM: land.human, landUnused: land.unused, landSupply: c.areaKm2,
    needFoodN, needFoodM, needLandN, needLandM };
}

/** Shared allocator + shared minimum adequacy + shared exponential demographic response. */
export function runHistory(config = {}) {
  const c = { ...settings(HISTORY_DEFAULTS, config), rates: settings(RATES, config.rates ?? {}) };
  positive(c, ['initialTotal', 'landPerAdultKm2']); fraction(c.initialModernFraction, 'initialModern');
  const pair = ENERGY_PAIRS.find(p => p.id === c.energyPair);
  if (!pair) throw new RangeError('Unknown energyPair');
  let p = resourcesAt(0, c.initialTotal * (1 - c.initialModernFraction), c.initialTotal * c.initialModernFraction, c, pair);
  const points = [p];
  for (let k = 1; k <= Math.ceil(c.horizon / c.dt); k++) {
    const t = Math.min(k * c.dt, c.horizon), dt = t - p.t;
    p = resourcesAt(t, populationStep(p.N, p.sN, c.rates, dt), populationStep(p.M, p.sM, c.rates, dt), c, pair);
    if (![p.N, p.M].every(Number.isFinite)) throw new RangeError('Invalid population overflow: reduce rates/horizon');
    points.push(p);
  }
  return { config: c, trajectory: sampled(points, c.outputEvery), summary: {
    ...summarizeHistory(points), engine: HISTORY_VERSION, role: 'primary shared-resource historical scenario',
    units: { t: 'years since hypothetical local contact', N: 'reference adult equivalents', M: 'reference adult equivalents',
      food: 'kcal/year', land: 'km2 stock', rates: '1/year', sN: 'dimensionless adequacy', sM: 'dimensionless adequacy' },
    density: { initialAdultsPerKm2: c.areaKm2 > 0 ? c.initialTotal / c.areaKm2 : null, status: 'arbitrary scenario, not archaeological census' },
    assumptions: [...LIMITS, '365 days/year; foodAccess scales a fixed annual supply relative to initialTotal all-modern adults.'],
    sources: [pair.source, 'science.1206930.pdf pp2–5 (scope limit only)', 'code/research/model-contract.md'],
  } };
}

function rk4(y, h, f) {
  const add = (v, a, scale) => v.map((x, i) => x + a[i] * scale);
  const a = f(y), b = f(add(y, a, h / 2)), c = f(add(y, b, h / 2)), d = f(add(y, c, h));
  const next = y.map((x, i) => x + h * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6);
  if (next.some(x => !Number.isFinite(x) || x < 0)) throw new RangeError('Invalid ODE state; reduce dt or horizon');
  return next;
}
function ode(c, initial, derivative, point) {
  let y = initial;
  const points = [point(0, y)];
  for (let k = 1; k <= Math.ceil(c.horizon / c.dt); k++) {
    const t = Math.min(c.horizon, k * c.dt), dt = t - points.at(-1).t;
    y = rk4(y, dt, v => derivative(v, c)); points.push(point(t, y));
  }
  return points;
}

const FLORES = Object.freeze({ N0: 90, M0: 10, alpha: 0.03, beta: 1 / 35, s: 0.99,
  delta: 0.00001, horizon: 12000, dt: 1, outputEvery: 20 });
export function floresDerivative([N, M], { alpha, delta, beta, s }) {
  return [N * (alpha - delta * (N + M) - beta), M * (alpha - delta * (N + M) - s * beta)];
}
// Log of exp(-shift*t) times the exponential integral; avoids inf/inf at equilibrium.
function scaledFloresIntegral(rate,t,shift) {
  if(rate===0)return Math.log(t)-shift*t;
  const x=rate*t;
  if(x===0)return Math.log(t)-shift*t;
  return rate>0?(rate-shift)*t+Math.log(-Math.expm1(-x))-Math.log(rate)
    :-shift*t+Math.log(-Math.expm1(x))-Math.log(-rate);
}
function floresScaled(t,c,a,b) {
  if(t===0)return {t,N:c.N0,M:c.M0};
  const shift=Math.max(0,c.N0>0?a:0,c.M0>0?b:0);
  const terms=[-shift*t];
  for(const [stock,rate] of [[c.N0,a],[c.M0,b]])if(c.delta>0&&stock>0)
    terms.push(Math.log(c.delta)+Math.log(stock)+scaledFloresIntegral(rate,t,shift));
  const largest=Math.max(...terms);
  const logDenominator=largest===-Infinity?-Infinity:largest+Math.log(terms.reduce((sum,x)=>sum+Math.exp(x-largest),0));
  const endpoint=(stock,rate)=>stock===0?0:Math.exp(Math.log(stock)+(rate-shift)*t-logDenominator);
  const N=endpoint(c.N0,a),M=endpoint(c.M0,b);
  if(![N,M].every(Number.isFinite))throw new RangeError('Invalid analytic overflow');
  return {t,N,M};
}
/** Common logistic denominator gives an independent closed-form check of both ODE stocks. */
export function floresAnalytic(t, config = {}) {
  const c = settings(FLORES, config); fraction(c.s, 's');
  if (!Number.isFinite(t) || t < 0) throw new RangeError('Invalid analytic time');
  const a = c.alpha - c.beta, b = c.alpha - c.s * c.beta;
  const integral = rate => rate === 0 ? t : Math.expm1(rate * t) / rate;
  const denominator = 1 + c.delta * (c.N0 * integral(a) + c.M0 * integral(b));
  const N = c.N0 * Math.exp(a * t) / denominator, M = c.M0 * Math.exp(b * t) / denominator;
  if (!Number.isFinite(denominator)||![N, M].every(Number.isFinite)||(c.N0>0&&N===0)||(c.M0>0&&M===0))
    return floresScaled(t,c,a,b);
  return { t, N, M };
}
export function runFlores(config = {}) {
  const c = settings(FLORES, config); fraction(c.s, 's'); positive({ total: c.N0 + c.M0 }, ['total']);
  const points = ode(c, [c.N0, c.M0], floresDerivative, (t, [N, M]) => {
    const a = floresAnalytic(t, c);
    return { t, N, M, sN: null, sM: null, analyticN: a.N, analyticM: a.M };
  });
  const advantage = c.beta * (1 - c.s), initial = c.N0 / (c.N0 + c.M0);
  const analyticTime = initial <= 0.01 ? 0 : advantage > 0 && c.M0 > 0 ? Math.log(c.N0 / c.M0 * 99) / advantage : null;
  return { config: c, trajectory: sampled(points, c.outputEvery), summary: {
    ...summarizeHistory(points), analyticContactTo1Percent: analyticTime,
    maxRelativeError: points.reduce((error, p) => Math.max(error, Math.abs(p.N - p.analyticN) / Math.max(1e-100, p.analyticN),
      Math.abs(p.M - p.analyticM) / Math.max(1e-100, p.analyticM)), 0),
    units: { t: 'illustrative years', N: 'arbitrary population units', M: 'arbitrary population units', sN: 'not modelled', sM: 'not modelled' },
    source: '9712024v1.pdf Eqs1–5 pp3–4', assumptions: ['No immigration/diffusion.',
      'Rates and starting stocks are illustrative, not fitted. Published s=0.992–0.997 was duration-inferred and is not independent evidence.',
      'Ratio e-folding time is not contact-to-1% time; positive ODE stocks never reach exact zero at finite time.'],
  } };
}

const GILPIN = Object.freeze({ N0: 10, M0: 10, zN0: 0, zM0: 12, K: 10, D: 40, threshold: 10,
  r: 1, gamma: 1, delta: 1 / 2.2, b0: 0.5, epsilon: 0.01, horizon: 100, dt: 0.02, outputEvery: 0.2 });
export function gilpinDerivative([N, M, zN, zM], c) {
  const bNM = c.b0 * (1 + c.epsilon * (zM - zN)), bMN = c.b0 * (1 + c.epsilon * (zN - zM));
  if (!(bNM > 0 && bMN > 0)) throw new RangeError('Gilpin linear feedback must remain positive; no clipping/substitution');
  const capacityN = c.K + (zN >= c.threshold ? c.D : 0), capacityM = c.K + (zM >= c.threshold ? c.D : 0);
  return [c.r * N * (1 - (N + bNM * M) / capacityN), c.r * M * (1 - (M + bMN * N) / capacityM),
    -c.gamma * zN + c.delta * N, -c.gamma * zM + c.delta * M];
}
export function runGilpin(config = {}) {
  const c = settings(GILPIN, config); positive(c, ['K', 'b0']);
  const points = ode(c, [c.N0, c.M0, c.zN0, c.zM0], gilpinDerivative, (t, [N, M, zN, zM]) => {
    gilpinDerivative([N, M, zN, zM], c); // Check positivity at returned states as well as RK stages.
    return { t, N, M, zN, zM, sN: null, sM: null,
      capacityN: c.K + (zN >= c.threshold ? c.D : 0), capacityM: c.K + (zM >= c.threshold ? c.D : 0),
      bNM: c.b0 * (1 + c.epsilon * (zM - zN)), bMN: c.b0 * (1 + c.epsilon * (zN - zM)) };
  });
  return { config: c, trajectory: sampled(points, c.outputEvery), summary: { ...summarizeHistory(points),
    units: { t: 'arbitrary model time', N: 'arbitrary population units', M: 'arbitrary population units', culture: 'arbitrary culture units' },
    source: 'pnas.201524861.pdf Eqs1–3 p2 and Eq16 p4', assumptions: ['Published step capacities, exact linear b feedback.',
      'Symmetric K,D,r,gamma,delta; illustrative culture/founder conditions, no calendar mapping.',
      'RK4 crosses discontinuous capacity thresholds; inspect dt sensitivity. Unsupplied SI ramp is not reproduced.'],
  } };
}

const NEUTRAL = Object.freeze({ capacity: 100, initialModern: 10, sourceCapacity: 100, sourceModern: 100,
  migration: 0.1, events: 20000, seed: 42, outputEvery: 100, generationYears: 25, eventsPerGeneration: 100 });
function neutralCheck({ capacity, modern, sourceCapacity, sourceModern, migration }) {
  for (const [k, v] of Object.entries({ capacity, modern, sourceCapacity, sourceModern })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${k} must be a nonnegative safe integer`);
  }
  if (capacity < 2 || sourceCapacity < 1 || modern > capacity || sourceModern > sourceCapacity) throw new RangeError('Invalid neutral capacity/count');
  fraction(migration, 'migration');
}
function probabilities({ capacity: N, modern: i, sourceCapacity: K, sourceModern: j, migration: m }) {
  const plus = (N - i) / N * ((1 - m) * i / (N - 1) + m * (j / K * (i + 1) / N + (K - j) / K * i / N));
  const minus = i / N * ((1 - m) * (N - i) / (N - 1) + m * (j / K * (N - i) / N + (K - j) / K * (N - i + 1) / N));
  return { plus, minus, stay: 1 - plus - minus };
}
/** Kolodny–Feldman one-deme Eqs1–3, conditional on one replacement event. */
export function neutralProbabilities(config) {
  const c = { capacity: 100, modern: 10, sourceCapacity: 100, sourceModern: 100, migration: 0.1, ...config };
  neutralCheck(c); return probabilities(c);
}
export function runNeutral(config = {}) {
  const c = settings(NEUTRAL, config);
  neutralCheck({ ...c, modern: c.initialModern }); positive(c, ['eventsPerGeneration', 'generationYears']);
  if (!Number.isInteger(c.events) || c.events > 1e6) throw new RangeError('Invalid integer events (maximum one million)');
  let state = seedStreams(c.seed).environment, modern = c.initialModern, absorbed = false;
  const point = t => ({ t, N: c.capacity - modern, M: modern, sN: null, sM: null, rngState: state });
  const points = [point(0)];
  for (let event = 1; event <= c.events; event++) {
    const p = probabilities({ ...c, modern });
    if (p.plus + p.minus === 0) { absorbed = true; break; }
    const draw = uniform(state); state = draw.state;
    modern += draw.value < p.plus ? 1 : draw.value < p.plus + p.minus ? -1 : 0;
    points.push(point(event));
  }
  const p = probabilities({ ...c, modern }); absorbed ||= p.plus + p.minus === 0;
  const summary = summarizeHistory(points, { interpolate: false }), yearsPerEvent = c.generationYears / c.eventsPerGeneration;
  return { config: c, trajectory: sampled(points, c.outputEvery), summary: { ...summary, absorbed, rngState: state,
    scheduledEvents: c.events, executedEvents: points.at(-1).t,
    contactTo1Percent: { ...summary.contactTo1Percent, censorReason: summary.contactTo1Percent.censored
      ? absorbed ? 'absorbing without replacement' : 'event horizon' : null },
    window10to90: { ...summary.window10to90, lastCrossingsProvisional: !absorbed,
      definition: 'Last observed upward 10%/90% crossings on integer event times; future crossings remain possible until absorption' },
    units: { t: 'replacement events', N: 'Neandertal bands', M: 'modern-human bands', adequacy: 'not modelled' },
    calendarMapping: { yearsPerEvent, generationYears: c.generationYears, eventsPerGeneration: c.eventsPerGeneration,
      contactTo1PercentYears: summary.contactTo1Percent.time === null ? null : summary.contactTo1Percent.time * yearsPerEvent,
      window10to90Years: summary.window10to90.duration === null ? null : summary.window10to90.duration * yearsPerEvent,
      status: 'uncalibrated turnover assumption' },
    source: '41467_2017_Article_1043.pdf Eqs1–3 p10; calendar discussion p11',
    assumptions: ['Fixed source reservoir; one-deme neutral band replacement only, not spatial stepping stones.',
      'Migration arrival and successful band establishment differ. Seeds/censoring retained; no conditioned-success selection.',
      '25-year generations do not identify events per generation. Calendar results require the disclosed turnover assumption.'],
  } };
}
