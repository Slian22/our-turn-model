/** M01: every numeric input has units, a declared range, and provenance. */
const scenario='Scenario assumption; not identified by supplied papers. See research/reading-synthesis.json.';
const p=(value,unit,min,max,rationale= scenario,classification='scenario')=>({value,unit,range:[min,max],classification,rationale});
export const PARAMETERS=Object.freeze({
 horizon:p(100,'year',1,1000),dt:p(.03125,'year',.005,1),seed:p(20261015,'uint32',0,4294967295),
 alignment:p(.5,'fraction',0,1,'External setting: problem p2. Intermediate reserve rule is a model assumption.'),
 H0:p(8000,'million people',0,20000),B0:p(1000,'standard hardware block',0,1e8),
 G0:p(28000,'TWh/year usable final electricity',0,1e7,'Illustrative global-scale scenario;415/0.015 is only a rounded scale reference, IEA pp14,49.'),
 F0:p(1000,'blocks/year installed fabrication',0,1e8),Q0:p(1,'dimensionless',.001,1e6),
 aE0:p(.05,'fraction',0,1),aF0:p(.02,'fraction',0,1),land:p(1e8,'km^2 accessible land',1,1.5e8),
 humanEnergy:p(2,'TWh/(million people year)',.01,20,'2000kWh/person/year essential-electricity scenario; not metabolic diet or an empirical survival threshold.'),
 humanLand:p(10000,'km^2/million people',1,1e6,'Composite food/habitat/services land footprint; not independently measured in supplied papers.'),
 birth:p(.018,'1/year',0,.1),death:p(.017,'1/year',0,.1),shortfall:p(.08,'1/year',0,1),
 energyBlock:p(.00876,'TWh/(block year) at rated full load',.00876,.00876,'1MW times8760h=0.00876TWh. A conventional-year unit definition, not observed RSI consumption.','derived'),
 utilization:p(.7,'fraction useful utilization',.01,1),idleFraction:p(.35,'fraction rated electricity',0,1,'Illustrative modern-server idle/rated ratio; IEA p54. Applying it to fixed facility blocks is a scenario approximation.'),
 landBlock:p(.03,'km^2/block installed',.001,2),landPower:p(.1,'km^2/(TWh/year)',.001,100),landFab:p(.005,'km^2/(blocks/year)',0,2),
 embodiedBlock:p(.003,'TWh/block delivered',.00001,.1),embodiedPower:p(.5,'TWh/(TWh/year added)',.01,10),embodiedFab:p(.02,'TWh/(blocks/year added)',.0001,5),
 lifetime:p(6,'year characteristic retirement',1,30,'Exponential retirement scenario; IEA p223 discusses4–6year IT obsolescence, which is not a measured exponential failure rate.'),
 hardwareGrowth:p(.35,'1/year desired orders',0,2),fabGrowth:p(.2,'1/year maximum factory expansion',0,1),powerGrowth:p(.01,'1/year maximum power expansion',0,.2),
 materials:p(200000,'blocks/year material-equivalent throughput',0,1e8),
 hardwareDelay:p(2,'year',.25,20),powerDelay:p(4,'year',.25,30,'Scenario within indicative grid connection3–7+years (IEA p79), with additional delays possible; not a probability law.'),
 fabDelay:p(4,'year',.25,30),automationDelay:p(3,'year',.25,30),
 automationRate:p(.025,'autonomy fraction/year maximum',0,.2),automationEnergy:p(200,'TWh/autonomy fraction',0,20000),
 rdShare:p(.2,'fraction powered compute to R&D',0,.9),kappa:p(.06,'1/year capability feedback',0,.5),rdReference:p(140,'standard useful R&D blocks',.01,1e6),
 qSaturation:p(100,'dimensionless',1,1e6),rdExponent:p(.5,'dimensionless',0,1),competition:p(.75,'dimensionless capability access exponent',0,3),
 supportExponent:p(2,'dimensionless human-support adequacy exponent',.1,5),dependencyReserve:p(.25,'fraction of human needs reserved for dependent industry',0,1),
 supportTime:p(.5,'year industrial-support response time',0,10,'Uncalibrated physical response-time scenario. Zero gives the instantaneous-target limit; a positive time prevents integration intervals from defining infrastructure response latency.'),
 industryEnergy:p(.01,'fraction of supported power for RSI fabrication/services',0,.2),
 shockProbability:p(.1,'probability/calendar year within scenario',0,1),shockMagnitude:p(.15,'fraction usable supply lost during shock year',0,.95),
 extinctionPopulation:p(.01,'million people functional threshold',0,1000),extinctionWindow:p(5,'year below threshold',.25,50),
 marginalPopulation:p(.5,'fraction H0',0,1),marginalAdequacy:p(.8,'fraction essential resources',0,1),outcomeWindow:p(10,'year trailing average',.25,100),
});
export const ENUMS={reserveRule:['linear','convex'],improvement:['saturating','exponential','none'],factoryRule:['persistent','demand-linked']};
export function makeConfig(overrides={}) {
 if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw new TypeError('Configuration must be an object');
 const defaults={...Object.fromEntries(Object.entries(PARAMETERS).map(([k,v])=>[k,v.value])),reserveRule:'linear',improvement:'saturating',factoryRule:'persistent',policies:[]};
 for(const k of Object.keys(overrides))if(!Object.hasOwn(defaults,k))throw new RangeError(`Unknown configuration key: ${k}`);
 const c={...defaults,...structuredClone(overrides)};
 for(const [k,p] of Object.entries(PARAMETERS))if(!Number.isFinite(c[k])||c[k]<p.range[0]||c[k]>p.range[1])throw new RangeError(`Invalid ${k}; expected ${p.range.join('..')} ${p.unit}`);
 if(!Number.isInteger(c.seed))throw new RangeError('Seed must be an integer');
 for(const [k,v] of Object.entries(ENUMS))if(!v.includes(c[k]))throw new RangeError(`Invalid ${k}`);
 if(c.outcomeWindow>c.horizon)c.outcomeWindow=c.horizon;
 if(c.land<c.B0*c.landBlock+c.G0*c.landPower+c.F0*c.landFab)throw new RangeError('Initial facilities exceed available land');
 return c;
}
export function parameterTable(c) {
 return Object.entries(PARAMETERS).map(([name,meta])=>({name,...meta,value:c[name]}));
}
