// Offline comparison of the integrated main backend and frozen 9d17e93 tables.
// node --expose-gc --import tsx scripts/bench_simulators.ts [trials=7] [ticks=100000]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import '../src/engine/index';
import { TruthTableSimulator } from '../src/engine/__fixtures__/truth-table-sim';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { ProbeCapture } from '../src/engine/probes';
import { Simulator } from '../src/engine/sim';

type Sim = Simulator | TruthTableSimulator;
type Backend = 'main' | 'truth-table';
interface Workload {
  name: string;
  circuit: CircuitJSON;
  probes?: number;
  rateHz?: number;
  setup(sim: Sim): void;
  advance(sim: Sim, operation: number): void;
  divisor?: number;
}
const read = (name: string): CircuitJSON => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8')) as CircuitJSON;
function workloads(): Workload[] {
  const eater = read('ben_eater_8bit');
  const original = read('original_digital_cpu_generated');
  original.components.find(comp => comp.id === 'v82')!.params!.contents = '02 01 04 01 06 1e 08 04';
  const definitions: CircuitJSON[] = [{
    version: 1, kind: 'composite', name: 'user.Invert',
    components: [{ id: 'g', type: 'prim.NAND', params: { inputs: 2 } }],
    nets: [{ id: 'a', endpoints: ['g.A', 'g.B'] }, { id: 'y', endpoints: ['g.Y'] }],
    ports: [{ name: 'A', dir: 'in', internalNet: 'a' }, { name: 'Y', dir: 'out', internalNet: 'y' }],
  }];
  for (let depth = 1; depth <= 7; depth++) {
    const child = definitions.at(-1)!.name;
    definitions.push({
      version: 1, kind: 'composite', name: `user.Level${depth}`,
      components: [{ id: 'p', type: child }, { id: 'q', type: child }],
      nets: [{ id: 'a', endpoints: ['p.A'] }, { id: 'm', endpoints: ['p.Y', 'q.A'] }, { id: 'y', endpoints: ['q.Y'] }],
      ports: [{ name: 'A', dir: 'in', internalNet: 'a' }, { name: 'Y', dir: 'out', internalNet: 'y' }],
    });
  }
  return [
    ...[0, 8].map(probes => ({
      name: `eater-${probes}-probes`, circuit: eater, probes,
      setup(sim: Sim) { sim.settle(); sim.setComponentInput('sw_reset', 'Y', 1); sim.settle(); },
      advance(sim: Sim) { sim.tick(); },
    })),
    { name: 'original-cpu-active-loop', circuit: original, rateHz: 100,
      setup(sim) { sim.settle(); }, advance(sim) { sim.tick(); } },
    { name: 'hierarchy-128-nand', divisor: 20,
      circuit: { version: 1, kind: 'circuit', name: 'hierarchy', definitions,
        components: [{ id: 'chain', type: definitions.at(-1)!.name }],
        nets: [{ id: 'input', endpoints: ['chain.A'] }, { id: 'output', endpoints: ['chain.Y'] }] },
      setup(sim) { sim.settle(); },
      advance(sim, operation) { sim.setInput('input', (operation & 1) as 0 | 1); sim.settle(); },
    },
  ];
}
function create(workload: Workload, backend: Backend) {
  const Constructor = backend === 'main' ? Simulator : TruthTableSimulator;
  const sim = new Constructor(loadCircuit(workload.circuit), { rateHz: workload.rateHz ?? 1 });
  workload.setup(sim);
  const probes = Array.from({ length: workload.probes ?? 0 }, (_, bit) => ({
    id: `p${bit}`, label: `OUT${bit}`, nets: [`display__${bit < 4 ? 'nlo' : 'nhi'}${bit % 4}`],
  }));
  return { sim, capture: probes.length ? new ProbeCapture(probes, sim.graph) : null };
}
function advance(workload: Workload, run: ReturnType<typeof create>, operation: number) {
  workload.advance(run.sim, operation);
  run.capture?.record(operation, run.sim.graph.netValues);
}
function compare(a: ReturnType<typeof create>, b: ReturnType<typeof create>) {
  assert.deepEqual(a.sim.graph.netValues, b.sim.graph.netValues);
  assert.deepEqual(a.sim.graph.components.map(comp => comp.state), b.sim.graph.components.map(comp => comp.state));
  assert.deepEqual(a.sim.graph.components.map(comp => Array.from(comp.outputBuf)), b.sim.graph.components.map(comp => Array.from(comp.outputBuf)));
  assert.deepEqual(a.sim.events, b.sim.events);
  assert.equal(a.sim.eventsEmitted, b.sim.eventsEmitted);
  assert.equal(a.sim.step, b.sim.step);
  if (a.capture) assert.deepEqual(a.capture.snapshot(), b.capture!.snapshot());
}
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const cases = workloads();
if (process.argv[2] === '--memory') {
  const workload = cases.find(item => item.name === process.argv[3])!;
  assert(workload && global.gc);
  global.gc(); global.gc();
  const before = process.memoryUsage();
  const started = performance.now();
  const run = create(workload, process.argv[4] as Backend);
  const constructionMs = performance.now() - started;
  for (let i = 0; i < 1000; i++) advance(workload, run, i);
  global.gc(); global.gc();
  const after = process.memoryUsage();
  console.log(JSON.stringify({ constructionMs, heapBytes: after.heapUsed - before.heapUsed,
    arrayBufferBytes: after.arrayBuffers - before.arrayBuffers, rssBytes: after.rss,
    peakRssKiB: process.resourceUsage().maxRSS, components: run.sim.graph.components.length,
    nets: run.sim.graph.nets.length }));
} else {
  const trials = Number(process.argv[2] ?? 7);
  const ticks = Number(process.argv[3] ?? 100_000);
  assert(Number.isSafeInteger(trials) && trials > 0 && Number.isSafeInteger(ticks) && ticks >= 1000);
  const results = [];
  for (const workload of cases) {
    const operations = Math.floor(ticks / (workload.divisor ?? 1));
    const warmup = Math.floor(10_000 / (workload.divisor ?? 1));
    const block = Math.min(1000, operations);
    // Correctness before timing: inspect every full-net/state/driver snapshot.
    const check = [create(workload, 'main'), create(workload, 'truth-table')];
    compare(check[0]!, check[1]!);
    for (let op = 0; op < 2048; op++) {
      for (const run of check) advance(workload, run, op);
      compare(check[0]!, check[1]!);
    }
    const samples: number[][] = [[], []];
    for (let trial = 0; trial < trials; trial++) {
      const runs = [create(workload, 'main'), create(workload, 'truth-table')];
      const elapsed = [0, 0];
      for (let start = -warmup; start < operations;) {
        const count = Math.min(block, operations - start, start < 0 ? -start : operations);
        for (let turn = 0; turn < 2; turn++) {
          const version = ((trial + Math.floor((start + warmup) / block)) & 1) ^ turn;
          const run = runs[version]!;
          const begin = performance.now();
          for (let i = 0; i < count; i++) advance(workload, run, warmup + start + i);
          if (start >= 0) elapsed[version]! += performance.now() - begin;
        }
        compare(runs[0]!, runs[1]!); // excluded from timing
        start += count;
      }
      elapsed.forEach((ms, backend) => samples[backend]!.push(operations * 1000 / ms));
    }
    const memory: Record<string, unknown> = {};
    for (const backend of ['main', 'truth-table'] as const) {
      const observations = Array.from({ length: 3 }, () => JSON.parse(execFileSync(process.execPath,
        ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--memory', workload.name, backend],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as Record<string, number>);
      memory[backend] = Object.fromEntries(Object.keys(observations[0]!).map(key => [key, median(observations.map(item => item[key]!))]));
    }
    const mainRate = median(samples[0]!); const truthRate = median(samples[1]!);
    const result = { workload: workload.name, unit: workload.divisor ? 'transitions/s' : 'ticks/s',
      operations, warmup, trials, block, checkedSnapshots: 2049, mainRate, truthRate,
      ratio: truthRate / mainRate, samples, memory };
    results.push(result);
    console.error(`${workload.name}: main ${mainRate.toFixed(0)}, tables ${truthRate.toFixed(0)}, ${(truthRate / mainRate).toFixed(3)}x`);
  }
  console.log(JSON.stringify({ host: { cpu: cpus()[0]?.model, platform: platform(), arch: arch(), node: process.version }, results }, null, 2));
}
