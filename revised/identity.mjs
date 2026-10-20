/** Deterministic identifiers for consistency, not cryptographic authentication. */
export function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
export function configurationId(config){
 let a=2166136261,b=0x9e3779b9;
 for(const char of canonical(config)){a=Math.imul(a^char.charCodeAt(0),16777619)>>>0;b=Math.imul(b^char.charCodeAt(0),2246822519)>>>0;}
 return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
}
