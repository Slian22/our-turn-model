/** Read-only display projection. Stocks, last-interval flows and historical units stay distinct. */
const fmt=n=>new Intl.NumberFormat('en',{maximumSignificantDigits:4}).format(n);
const reading=(label,value,unit,note)=>({label,value,unit,note});
export function telemetryReadings({level,run,history}) {
 if(level==='history') {
  const p=history.trajectory.at(-1);
  return {
   population:reading('NEANDERTAL POPULATION',p.N,'ref. adults','N · hypothetical adult equivalents'),
   hardware:reading('MODERN-HUMAN POPULATION',p.M,'ref. adults','M · hypothetical adult equivalents'),
   capability:reading('MODERN-HUMAN SHARE',p.modernFraction*100,'%','Share threshold is not absolute extinction'),
   energy:reading('DIETARY ENERGY POOL',p.foodSupply/1e6,'M kcal/yr','Food energy · separate from electricity'),
   adequacy:reading('NEANDERTAL ADEQUACY',p.sN*100,'%','Most recent historical resource allocation'),
  };
 }
 const s=run.state,p=run.trajectory.at(-1),initial=s.t===0,delta=run.config.H0>0?(s.H/run.config.H0-1)*100:null;
 return {
  population:reading('HUMAN POPULATION',s.H>=1000?s.H/1000:s.H,s.H>=1000?'billion':'million',delta===null?'Initial H is zero':`${delta>=0?'+':''}${fmt(delta)}% from the initial population`),
  hardware:reading('INSTALLED HARDWARE',s.B,'blocks',initial?'No interval powered load measured':`${fmt(s.active)} powered blocks · last interval`),
  capability:reading('CAPABILITY',s.Q,'index','Dimensionless · separate from hardware'),
  energy:reading('INSTALLED POWER',s.G,'TWh/yr',initial?'Supply depends on human support':`Last interval supply: ${fmt(s.ledger.supply)} TWh/yr`),
  adequacy:reading('HUMAN ADEQUACY',initial?null:p.sH*100,'%',initial?'No interval measured yet':s.infeasible?'Protected resource reserve is infeasible':p.sH<.999?'Essential resource shortfall · last interval':'Essential demand supplied · last interval'),
 };
}
export function draftMatchesConfig(draft,config) {
 return Object.entries(draft).every(([key,value])=>typeof config[key]==='number'
  ?String(value).trim()!==''&&Number(value)===config[key]:value===config[key]);
}
