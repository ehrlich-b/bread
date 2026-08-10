import { readFileSync } from 'node:fs';
const prof = JSON.parse(readFileSync(process.argv[2] ?? 'cpu.cpuprofile','utf8'));
const nodes = prof.nodes;
const byId = new Map(nodes.map(n=>[n.id,n]));
const selfTime = new Map();
const totalTime = new Map();
const samples = prof.samples;
const delta = prof.timeDeltas ?? [];
for (let i=0;i<samples.length;i++){
  const id = samples[i];
  selfTime.set(id,(selfTime.get(id)||0)+(delta[i]??0));
}
// total = self + children (recursive)
function nameOf(id){ const n = byId.get(id); if(!n) return `?${id}`; const f=n.callFrame; return `${f.functionName||'(anon)'} ${f.url.replace(/^file:\/\//,'')}:${f.lineNumber}`; }
const aggSelf = new Map();
for (const [id,t] of selfTime){
  const nm = nameOf(id);
  aggSelf.set(nm,(aggSelf.get(nm)||0)+t);
}
const total = samples.reduce((a,b)=>a+(delta[b]??0),0)|| samples.length;
const sum = [...aggSelf.values()].reduce((a,b)=>a+b,0);
console.log('delta total', total, 'sampled', samples.length);
const sorted=[...aggSelf.entries()].sort((a,b)=>b[1]-a[1]);
for(const [nm,t] of sorted.slice(0,40)) console.log((t/sum*100).toFixed(1)+'%', (t/1000).toFixed(1)+'ms', nm);
