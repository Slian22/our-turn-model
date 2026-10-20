/**
 * Shared exogenous events. No world, policy decision or execution RNG is read.
 * A dedicated seeded stream consumes exactly three draws at each integer year
 * starting at year 1, even when no event occurs. Catching up missed boundaries
 * produces the same schedule as fine stepping; schedule is private to executor.
 *
 * Technology discoveries emit paid adoption requests; they never edit cohorts.
 * The parent forwards actual completion receipts by requestId. Only then do
 * eventTechnology multipliers become available. Algorithm modifies research
 * input once; hardware/manufacturing apply to future or explicitly paid retrofit
 * cohorts. Land/power are positive efficiency factors: the parent applies their
 * reciprocal to future-order land/embodied energy intensity. Existing footprint
 * and output do not change for free.
 *
 * Temporary effects use [discovery, discovery+duration). Late adoption consumes
 * its recorded paid costs but grants no effect. At expiry algorithm gains stop
 * prospectively and future-order efficiencies revert. Already commissioned
 * cohort efficiencies and immutable footprints persist. Execution-condition
 * shifts revert prospectively; simultaneous shifts multiply before clamping.
 * Observation can arrive after expiry and still reports the historical event.
 * Alignment is never modified. All state is plain JSON checkpoint data.
 */

const TECHNOLOGY = ['algorithm', 'hardware', 'manufacturing', 'land', 'power'];
const TYPES = [...TECHNOLOGY, 'coverage', 'authority', 'funding'];
const COMPLETE = new Set(['completed', 'commissioned', 'adopted']);
const FAILED = new Set(['failed', 'rejected', 'expired', 'cancelled']);

function finite(value, name, min = 0, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be finite in [${min}, ${max}]`);
  return value;
}

function seedStream(seed) {
  return [...`events:${seed ?? 1}`].reduce((hash, c) => Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
}

function draw(rngState) {
  const next = (rngState + 0x6D2B79F5) >>> 0;
  let bits = Math.imul(next ^ (next >>> 15), next | 1);
  bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
  return {rngState: next, value: ((bits ^ (bits >>> 14)) >>> 0) / 4294967296};
}

function normalizeEvent(event, index, config) {
  if (!TYPES.includes(event.type)) throw new TypeError(`Unknown event type ${event.type}`);
  if (event.target !== undefined && event.target !== event.type) throw new TypeError('Event target must equal its direct type');
  const magnitude = finite(event.magnitude, 'event magnitude');
  if (TECHNOLOGY.includes(event.type) && magnitude === 0) throw new RangeError('Technology magnitude must be positive');
  const time = finite(event.time, 'event time');
  const duration = event.duration ?? null;
  if (duration !== null) finite(duration, 'event duration', Number.MIN_VALUE);
  const expiresAt = duration === null ? null : finite(time + duration, 'event expiry');
  if (expiresAt !== null && expiresAt <= time) throw new RangeError('Event duration is below numeric resolution');
  const observationDelay = finite(event.observationDelay ?? config.eventObservationDelay ?? 0, 'event observationDelay');
  return {id: String(event.id ?? `event-${index + 1}`), type: event.type, target: event.type, time,
    magnitude, duration, expiresAt,
    observationDelay, observedAt: finite(time + observationDelay, 'event observedAt'),
    adoptionEnergy: finite(event.adoptionEnergy ?? config.assets?.adoptionEnergy ?? 0, 'adoptionEnergy'),
    adoptionWork: finite(event.adoptionWork ?? config.assets?.adoptionWork ?? 0, 'adoptionWork'),
    adoptionDelay: finite(event.adoptionDelay ?? config.assets?.adoptionDelay ?? 0, 'adoptionDelay')};
}

function ordered(events) {
  return [...events].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

export function initialEventState(config) {
  if (!['off', 'annual'].includes(config.eventMode ?? 'off')) throw new TypeError('Invalid eventMode');
  finite(config.annualProbability ?? 0, 'annualProbability', 0, 1);
  finite(config.eventMagnitude ?? 1, 'eventMagnitude', Number.MIN_VALUE);
  const schedule = ordered((config.events ?? []).map((event, i) => normalizeEvent(event, i, config)));
  if (new Set(schedule.map(e => e.id)).size !== schedule.length) throw new TypeError('Duplicate event ID');
  if (schedule.some(e => e.id.startsWith('annual:'))) throw new TypeError('Explicit event IDs cannot use reserved annual: prefix');
  return {version: 1, rngState: seedStream(config.seed), nextAnnualYear: 1,
    schedule, records: [], processedIds: [], observedIds: [], adoptedIds: []};
}

function annualSchedule(state, t, config) {
  if (config.eventMode !== 'annual') return {...state};
  let next = {...state};
  while (next.nextAnnualYear <= t) {
    const occurrence = draw(next.rngState);
    const kind = draw(occurrence.rngState);
    const direction = draw(kind.rngState);
    const year = next.nextAnnualYear;
    next = {...next, rngState: direction.rngState, nextAnnualYear: year + 1};
    if (occurrence.value >= (config.annualProbability ?? 0)) continue;
    const type = TYPES[Math.floor(kind.value * TYPES.length)];
    const magnitude = config.eventMagnitude ?? 1;
    const effect = TECHNOLOGY.includes(type) ? magnitude : type === 'authority'
      ? direction.value < 0.5 ? 0 : 1 : direction.value < 0.5 ? magnitude : 1 / magnitude;
    const event = normalizeEvent({id: `annual:${year}`, time: year, type, magnitude: effect}, year, config);
    next = {...next, schedule: [...next.schedule, event]};
  }
  return {...next, schedule: ordered(next.schedule)};
}

function adoptionRequest(event) {
  return {id: `adoption:${event.id}`, kind: 'adoption', owner: 'ai', amount: 1,
    target: event.type, multiplier: event.magnitude, energy: event.adoptionEnergy,
    work: event.adoptionWork, delay: event.adoptionDelay, eventId: event.id,
    expiresAt: event.expiresAt};
}

export function processEvents(state, t, config) {
  finite(t, 'time');
  const next = annualSchedule(state, t, config);
  const discoveries = next.schedule.filter(e => e.time <= t && !next.processedIds.includes(e.id));
  const records = ordered([...next.records, ...discoveries.map(e => ({...e,
    discoveredAt: e.time, adoptionRequestId: TECHNOLOGY.includes(e.type) ? `adoption:${e.id}` : null,
    adoptionStatus: TECHNOLOGY.includes(e.type) ? 'pending' : 'not-applicable', adoptedAt: null}))]);
  const visible = records.filter(e => e.observedAt <= t && !next.observedIds.includes(e.id));
  const adoptionRequests = discoveries.filter(e => TECHNOLOGY.includes(e.type)).map(adoptionRequest);
  const observations = visible.map(e => ({id: e.id, type: e.type, target: e.target, time: e.time,
    magnitude: e.magnitude, duration: e.duration, observedAt: e.observedAt, expiresAt: e.expiresAt,
    adoptionStatus: e.adoptionStatus, adoptedAt: e.adoptedAt}));
  const receipts = [...discoveries.map(e => ({id: `discovery:${e.id}`, eventId: e.id,
    kind: 'event-discovery', time: e.time})), ...visible.map(e => ({id: `observation:${e.id}`,
    eventId: e.id, kind: 'event-observation', time: e.observedAt}))];
  return {state: {...next, records, processedIds: [...next.processedIds, ...discoveries.map(e => e.id)].sort(),
    observedIds: [...next.observedIds, ...visible.map(e => e.id)].sort()}, adoptionRequests, observations, receipts};
}

export function recordEventAdoptions(state, receipts, t) {
  finite(t, 'time');
  let deployments = [];
  let adoptedIds = [...state.adoptedIds];
  const records = state.records.map(event => {
    if (!event.adoptionRequestId || event.adoptionStatus !== 'pending') return {...event};
    const receipt = receipts.find(r => (r.requestId ?? r.id) === event.adoptionRequestId
      && (COMPLETE.has(r.status) || FAILED.has(r.status)));
    if (!receipt) return {...event};
    if (FAILED.has(receipt.status)) return {...event, adoptionStatus: receipt.status};
    const effective = finite(receipt.effective_from ?? receipt.time ?? t, 'adoption effective_from');
    if (effective > t || effective < event.discoveredAt) throw new RangeError('Adoption receipt has inconsistent effective time');
    const expired = event.expiresAt !== null && effective >= event.expiresAt;
    const updated = {...event, adoptedAt: effective, adoptionStatus: expired ? 'expired' : 'adopted'};
    adoptedIds = [...adoptedIds, event.id];
    if (!expired) deployments = [...deployments, {eventId: event.id, requestId: event.adoptionRequestId,
      target: event.type, multiplier: event.magnitude, effective_from: effective, expiresAt: event.expiresAt}];
    return updated;
  });
  return {state: {...state, records, adoptedIds: adoptedIds.sort()}, deployments};
}

function inWindow(event, t) {
  return event.time <= t && (event.expiresAt === null || t < event.expiresAt);
}

export function eventTechnology(state, t) {
  finite(t, 'time');
  return Object.fromEntries(TECHNOLOGY.map(type => [type, state.records
    .filter(e => e.type === type && e.adoptionStatus === 'adopted' && e.adoptedAt <= t && inWindow(e, t))
    .reduce((value, e) => finite(value * e.magnitude, `${type} multiplier`, Number.MIN_VALUE), 1)]));
}

export function eventConditions(state, t, config) {
  finite(t, 'time');
  const multiplier = type => state.records.filter(e => e.type === type && inWindow(e, t))
    .reduce((value, e) => finite(value * e.magnitude, `${type} multiplier`), 1);
  const clamp = value => Math.min(1, Math.max(0, value));
  const coverage = finite(config.policy?.coverage ?? 1, 'coverage', 0, 1);
  const fundingShare = finite(config.resources?.policyEnergyShare ?? 0, 'policyEnergyShare', 0, 1);
  return {coverage: clamp(coverage * multiplier('coverage')),
    authorized: (config.policy?.authorized ?? true) && multiplier('authority') > 0,
    fundingShare: clamp(fundingShare * multiplier('funding'))};
}

export function nextEventTime(state, t, config) {
  finite(t, 'time');
  const boundaries = [
    ...(config.eventMode === 'annual' ? [Math.max(state.nextAnnualYear, Math.floor(t) + 1)] : []),
    ...state.schedule.filter(e => !state.processedIds.includes(e.id)).map(e => e.time),
    ...state.records.filter(e => !state.observedIds.includes(e.id)).map(e => e.observedAt),
    ...state.records.map(e => e.expiresAt),
  ].filter(time => time !== null && time > t);
  return Math.min(...boundaries);
}
