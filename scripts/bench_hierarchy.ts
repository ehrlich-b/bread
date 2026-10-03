// Synthetic headless benchmark, separate from genuine editor construction.
// Hierarchy is flattened at load; this compares authoring/load cost and the
// same resulting leaf graph. It is not a hierarchical execution backend.
import * as os from 'node:os';
import '../src/engine/index';
import type { CircuitJSON } from '../src/engine/ir';
import { flattenCircuit, loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';

const depth = Number(process.argv[2] ?? 7);
const transitions = Number(process.argv[3] ?? 20000);
if (!Number.isInteger(depth) || depth < 1 || depth > 10 || !Number.isInteger(transitions) || transitions < 1) throw new Error('Usage: bench_hierarchy.ts depth(1..10) positiveTransitions');
const definitions: CircuitJSON[] = [{ version: 1, kind: 'composite', name: 'user.Invert', components: [{ id: 'g', type: 'prim.NAND', params: { inputs: 2 } }], nets: [{ id: 'a', endpoints: ['g.A', 'g.B'] }, { id: 'y', endpoints: ['g.Y'] }], ports: [{ name: 'A', dir: 'in', internalNet: 'a' }, { name: 'Y', dir: 'out', internalNet: 'y' }] }];
for (let level = 1; level <= depth; level++) {
  const child = definitions.at(-1)!.name;
  definitions.push({ version: 1, kind: 'composite', name: `user.Level${level}`, components: [{ id: 'p', type: child }, { id: 'q', type: child }], nets: [{ id: 'a', endpoints: ['p.A'] }, { id: 'm', endpoints: ['p.Y', 'q.A'] }, { id: 'y', endpoints: ['q.Y'] }], ports: [{ name: 'A', dir: 'in', internalNet: 'a' }, { name: 'Y', dir: 'out', internalNet: 'y' }] });
}
const hierarchical: CircuitJSON = { version: 1, kind: 'circuit', name: 'hierarchy', definitions, components: [{ id: 'chain', type: definitions.at(-1)!.name }], nets: [{ id: 'input', endpoints: ['chain.A'] }, { id: 'output', endpoints: ['chain.Y'] }] };
const flat = flattenCircuit(hierarchical);
function run(json: CircuitJSON) {
  const started = performance.now(); const graph = loadCircuit(json); const loadMs = performance.now() - started;
  const sim = new Simulator(graph); sim.settle();
  for (let n = 0; n < 2000; n++) { sim.setInput('input', n % 2 ? 1 : 0); sim.settle(); }
  const start = performance.now();
  for (let n = 0; n < transitions; n++) {
    const input = n % 2 ? 1 : 0; sim.setInput('input', input); sim.settle();
    if (sim.readNet('output') !== input) throw new Error(`Incorrect output at transition ${n}`);
  }
  const elapsedMs = performance.now() - start;
  if (sim.events.length) throw new Error(`Unexpected simulator diagnostics: ${sim.events.length}`);
  return { loadMs, elapsedMs, checkedTransitions: transitions, transitionsPerSecond: transitions / elapsedMs * 1000, components: graph.components.length, nets: graph.nets.length };
}
console.log(JSON.stringify({ label: 'Synthetic correctness-gated NAND chain; both inputs execute as flattened leaves', host: { cpu: os.cpus()[0]?.model, os: os.platform(), arch: os.arch(), node: process.version }, depth, warmupTransitions: 2000, hierarchy: run(hierarchical), flat: run(flat) }, null, 2));
