/** Independent, serializable PRNG streams; no Math.random in the numerical engine. */
export function uniform(state) {
 const next=(Math.imul(1664525,state>>>0)+1013904223)>>>0;
 return {state:next,value:next/4294967296};
}
export function seedStreams(seed) {
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new RangeError('Seed must be a uint32');
 return {environment:(seed^0xa341316c)>>>0,policy:(seed^0xc8013ea4)>>>0,parameters:(seed^0xad90777d)>>>0};
}
export function hashText(text) {
 let h=2166136261;
 for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619)>>>0;
 return h.toString(16).padStart(8,'0');
}
export function canonical(value) {
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value!==null&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
 return JSON.stringify(value);
}
