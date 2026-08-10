import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/engine/behavioral/index';
import '../src/engine/primitives/index';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';
import '../src/stdlib/index';

const here = dirname(fileURLToPath(import.meta.url));
const circuit = JSON.parse(readFileSync(resolve(here,'..','examples','ben_eater_8bit.json'),'utf8')) as CircuitJSON;
const g = loadCircuit(circuit);

// Wrap unique primitive evaluate fns with timing
const times = new Map<string, number>();
const counts = new Map<string, number>();
const seen = new WeakSet<object>();
for (const comp of g.components) {
  const prim = comp.primitive as any;
  if (seen.has(prim)) continue;
  seen.add(prim);
  const typeId = comp.typeId as string;
  const orig = prim.evaluate.bind(prim);
  prim.evaluate = (inputs: any, outputs: any, state: any, params: any, ctx: any) => {
    const t = performance.now();
    const r = orig(inputs, outputs, state, params, ctx);
    const dt = performance.now() - t;
    times.set(typeId, (times.get(typeId) ?? 0) + dt);
    counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
    return r;
  };
}

const sim = new Simulator(g);
sim.settle();
sim.setComponentInput('sw_reset','Y',1);
sim.settle();

const ITERS = 100000;
for (let i=0;i<10000;i++) sim.tick();
const t0 = performance.now();
for (let i=0;i<ITERS;i++) sim.tick();
const dt = performance.now() - t0;
console.log('tick  ', (ITERS/dt*1000).toFixed(0), 'ticks/s  (with wrapped evaluate timing)');
let evalSum = 0;
for (const [k, v] of times) evalSum += v;
console.log('evaluate total ms:', evalSum.toFixed(2), 'of', dt.toFixed(2));
const sorted = [...times.entries()].sort((a,b)=>b[1]-a[1]);
for (const [k, v] of sorted) console.log(' ', k.padEnd(14), (v).toFixed(1).padStart(8), 'ms', String(counts.get(k)).padStart(9), 'calls  ', (v/ (counts.get(k)??1)*1e6).toFixed(0).padStart(7), 'ns/call avg');
