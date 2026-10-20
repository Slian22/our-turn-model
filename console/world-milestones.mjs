/**
 * Read-only observations of a full spatial world (createWorld/restoreWorld).
 * Returns fresh {id, t, regionId, regionName, title, detail} objects, ascending
 * by t then ASCII id. t is years since contact; global rows use null / 'World'.
 * Detail numbers use at most four significant digits, with scientific notation
 * below 0.001 or at/above 10000 after rounding. Numeric t and comparisons retain
 * full precision. Formatting is locale independent and omits padded zeros.
 *
 * IDs: world:first-shortage, world:first-recovery, and <regionId> followed by
 * :first-commissioned, :q-doubled, or :automation-proxy. IDs identify categories,
 * not immutable dated events: endpoint rows move to the next saved endpoint.
 *
 * Only aggregate history has historical adequacy. Q and aE/aF have no regional
 * trajectory, so their crossing times cannot be reconstructed. Commissioning
 * logs may be absent (traceProjects=false); cumulative amounts prove service,
 * but cannot date its first occurrence. Initial proxies are initial conditions.
 * No interpolation, observer memory, model writes, RNG, or version assumptions.
 * A worldView lacks regional config/counters and cannot supply regional rows.
 * The kernel appends history after every canonical/substep, each <= config.dt.
 * Coverage checks origin, endpoint and this cadence; it assumes intact kernel
 * history and cannot detect removed substeps whose remaining gap is still <=dt.
 */

const UNITS = Object.freeze({
 hardware:'standard hardware blocks', power:'TWh/year of power capacity',
 factory:'blocks/year of fabrication capacity',
 powerAutomation:'dimensionless fraction of power automation',
 fabAutomation:'dimensionless fraction of fabrication automation',
});
const positive = value => Number.isFinite(value) && value > 0;
const fraction = value => Number.isFinite(value) && value >= 0 && value <= 1;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const time = (value, end) => Number.isFinite(value) && value >= 0 && value <= end;
function displayNumber(value) {
 const [coefficient, exponent] = value.toExponential(3).split('e');
 const power = Number(exponent);
 // Format the coefficient separately so rounding MAX_VALUE cannot overflow.
 return power < -3 || power >= 4 ? `${Number(coefficient)}e${power}` : String(Number(value.toPrecision(4)));
}
const quantity = (kind, amount) => `${displayNumber(amount)} ${UNITS[kind]}`;
const atEndpoint = t => `Observed at the saved endpoint, year ${displayNumber(t)} (years since contact).`;
const crossingLimit = 'First threshold crossing time is unavailable without regional history.';
const proxyLimit = 'Modeled automation proxy only; this does not establish real-world autonomy or self-sufficiency.';
const regionalRow = (region, suffix, t, title, detail) => ({
 id:`${region.id}:${suffix}`, t, regionId:region.id, regionName:region.name ?? region.id, title, detail,
});

function commissionedRow(region, t) {
 if (t === 0) return null;
 const state = region.state;
 const records = (Array.isArray(state.events) ? state.events : []).filter(event =>
  event?.type === 'commissioned' && Object.hasOwn(UNITS, event.kind) &&
  positive(event.amount) && positive(event.t) && time(event.t, t));
 const first = records.sort((a, b) => a.t-b.t || compare(a.kind, b.kind) || a.amount-b.amount)[0];
 if (first) return regionalRow(region, 'first-commissioned', first.t, 'First recorded commissioning',
  `${quantity(first.kind, first.amount)} recorded commissioned at year ${displayNumber(first.t)} (years since contact). ` +
  'First retained commissioning record; earlier unrecorded commissioning cannot be excluded.');
 const totals = Object.keys(UNITS).filter(kind => positive(state.commissionedAmounts?.[kind]));
 if (!totals.length) return null;
 return regionalRow(region, 'first-commissioned', t, 'Commissioned assets observed',
  `${atEndpoint(t)} Recorded cumulative commissioned amounts: ` +
  totals.map(kind => quantity(kind, state.commissionedAmounts[kind])).join('; ') +
  '. First commissioning time is unavailable without a commissioning record; these totals are not new orders.');
}

function capabilityRow(region, t) {
 const Q = region.state.Q, Q0 = region.config?.Q0;
 if (t === 0 || !positive(Q) || !positive(Q0) || Q/2 < Q0) return null;
 return regionalRow(region, 'q-doubled', t, 'Q at least twice initial reference observed',
  `Regional Q=${displayNumber(Q)}; explicit initial reference config.Q0=${displayNumber(Q0)} (both dimensionless). ` +
  `${atEndpoint(t)} ${crossingLimit}`);
}

function automationRow(region, t) {
 const {aE, aF} = region.state, {aE0, aF0} = region.config ?? {};
 if (!fraction(aE) || !fraction(aF) || aE < .5 || aF < .5) return null;
 if (fraction(aE0) && fraction(aF0) && aE0 >= .5 && aF0 >= .5)
  return regionalRow(region, 'automation-proxy', 0, 'Initial modeled automation proxy at least 50%',
   `Initial condition at year 0 (years since contact): aE0=${displayNumber(aE0)}, aF0=${displayNumber(aF0)}, dimensionless fractions, both >=0.5. ${proxyLimit}`);
 if (t === 0) return null;
 return regionalRow(region, 'automation-proxy', t, 'Modeled automation proxy at least 50% observed',
  `aE=${displayNumber(aE)}, aF=${displayNumber(aF)}, dimensionless fractions, both >=0.5. ${atEndpoint(t)} ${crossingLimit} ${proxyLimit}`);
}

function adequacyPoint(point, end) {
 return point && time(point.t, end) && Number.isFinite(point.H) && point.H >= 0 && fraction(point.minAdequacy);
}

function aggregateRows(world) {
 const source = Array.isArray(world.history) ? world.history : [];
 const history = source.filter(point => adequacyPoint(point, world.t));
 const dt = world.config?.dt;
 const complete = history.length === source.length && history[0]?.t === 0 && history.at(-1)?.t === world.t &&
  positive(dt) && history.every((point, i) => i === 0 ||
   point.t > history[i-1].t && point.t-history[i-1].t <= dt+1e-8);
 const coverage = complete ? 'Complete aggregate history from year 0 to the saved endpoint.' :
  'Aggregate history incomplete or cadence unverified: history gaps may hide earlier shortage or recovery.';
 // Sort only the local copy; the validated kernel normally supplies chronological history.
 const observed = history.filter(point => point.t > 0 && point.H > 0).sort((a, b) =>
  a.t-b.t || a.minAdequacy-b.minAdequacy);
 const shortage = observed.find(point => point.minAdequacy < .999);
 if (!shortage) return [];
 const recovery = observed.find(point => point.t > shortage.t && point.minAdequacy >= .999);
 const make = (point, recovered) => ({
  id:recovered ? 'world:first-recovery' : 'world:first-shortage', t:point.t, regionId:null, regionName:'World',
  title:recovered ? 'First observed adequacy recovery' : 'First observed essential-resource shortage',
  detail:`Year ${displayNumber(point.t)} (years since contact): global minAdequacy≈${displayNumber(point.minAdequacy)}, ` +
   `a dimensionless minimum across regions; unrounded value ${recovered ? '>=' : '<'}0.999. ${coverage} ` +
   'Earliest retained observation; exact onset or crossing between observations is unavailable. ' +
   'Initial adequacy at year 0 is unmeasured and excluded.' +
   (recovered ? ' This does not establish population recovery; global population remains positive.' : ''),
 });
 return recovery ? [make(shortage, false), make(recovery, true)] : [make(shortage, false)];
}

export function observeWorldMilestones(world) {
 if (!world || !Array.isArray(world.regions) || !time(world.t, Number.MAX_VALUE)) return [];
 const regional = world.regions.filter(region => typeof region?.id === 'string' && region.state).flatMap(region =>
  [commissionedRow(region, world.t), capabilityRow(region, world.t), automationRow(region, world.t)].filter(Boolean));
 return [...aggregateRows(world), ...regional].sort((a, b) => a.t-b.t || compare(a.id, b.id));
}
