// Compare only compiled READ work on the real SAP-1 layout. No scheduler,
// storage, resolution, events or UI: these figures are not CPU clock rates.
// Build wasm_read_probe.c with installed clang, then run this script with tsx.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../src/engine/behavioral/index';
import '../src/stdlib/index';
import { compileTables } from '../src/engine/__fixtures__/truth-table-compiled';
import { comparisonGraph } from '../src/engine/__fixtures__/truth-table-adapter';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';

const graph = loadCircuit(JSON.parse(readFileSync(new URL('../examples/ben_eater_8bit.json', import.meta.url), 'utf8')) as CircuitJSON);
const sim = new Simulator(graph);
sim.settle(); sim.setComponentInput('sw_reset', 'Y', 1); sim.settle();
for (let i = 0; i < 5_000; i++) sim.tick();
const plan = compileTables(comparisonGraph(graph));
// This probe deliberately excludes stateful DFF table addressing.
plan.offsets.forEach((_, c) => { if (plan.kinds[c] === 9) plan.offsets[c] = 0; });
const clockNet = graph.components.find(c => c.typeId === 'gen.clock')!.outputNetIdx[0]!;
const wasm = await WebAssembly.instantiate(readFileSync(process.argv[2] ?? '.scratch/wasm-read.wasm'));
const memory = wasm.instance.exports.memory as WebAssembly.Memory;
const readBatch = wasm.instance.exports.read_batch as (...args: number[]) => number;
let cursor = 65_536;
function copy<T extends Uint8Array | Uint32Array>(source: T): { pointer: number; view: T } {
  cursor = Math.ceil(cursor / 8) * 8;
  const pointer = cursor;
  const view = (source instanceof Uint8Array ? new Uint8Array(memory.buffer, cursor, source.length) : new Uint32Array(memory.buffer, cursor, source.length)) as T;
  view.set(source); cursor += source.byteLength;
  return { pointer, view };
}
const values = copy(graph.netValues);
const offsets = copy(plan.offsets);
const inputs = copy(plan.inputs);
const counts = copy(plan.inputCounts);
const words = copy(plan.words);
const proposed = copy(plan.proposed);
const jsValues = graph.netValues.slice();
const jsProposed = plan.proposed.slice();
function jsRead(iterations: number): number {
  let checksum = 0;
  for (let step = 0; step < iterations; step++) {
    jsValues[clockNet]! ^= 1;
    for (let c = 0; c < graph.components.length; c++) {
      const offset = plan.offsets[c]!;
      if (!offset) continue;
      const base = c * 5, count = plan.inputCounts[c]!;
      const vector = (count > 0 ? jsValues[plan.inputs[base]!]! : 0)
        | (count > 1 ? jsValues[plan.inputs[base + 1]!]! << 2 : 0)
        | (count > 2 ? jsValues[plan.inputs[base + 2]!]! << 4 : 0)
        | (count > 3 ? jsValues[plan.inputs[base + 3]!]! << 6 : 0);
      const word = plan.words[offset + vector]!;
      jsProposed[c] = word;
      checksum = (checksum + word) >>> 0;
    }
  }
  return checksum;
}
const wasmRead = (iterations: number) => readBatch(values.pointer, offsets.pointer, inputs.pointer, counts.pointer, words.pointer, proposed.pointer, graph.components.length, iterations, clockNet) >>> 0;
const run = [jsRead, wasmRead];
const samples: number[][] = [[], []];
const iterations = 20_000;
for (let trial = 0; trial < 5; trial++) {
  jsValues.set(graph.netValues); values.view.set(graph.netValues);
  assert.equal(jsRead(2_000), wasmRead(2_000));
  const checksum = [0, 0];
  const elapsed = [0, 0];
  for (let block = 0; block < iterations / 2_000; block++) {
    for (let turn = 0; turn < 2; turn++) {
      const version = (trial + block + turn) & 1;
      const t0 = performance.now();
      checksum[version] = run[version]!(2_000);
      elapsed[version]! += performance.now() - t0;
    }
    assert.equal(checksum[0], checksum[1]);
    assert.deepEqual(jsProposed, proposed.view);
    assert.deepEqual(jsValues, values.view);
  }
  const rates = elapsed.map(ms => iterations * 1000 / ms);
  rates.forEach((rate, version) => samples[version]!.push(rate));
  console.log(`trial ${trial + 1}: JS ${rates[0]!.toFixed(0)}, WASM ${rates[1]!.toFixed(0)} READ batches/s, ${(rates[1]! / rates[0]!).toFixed(3)}x`);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2]!;
console.log(`median: JS ${median(samples[0]!).toFixed(0)}, WASM ${median(samples[1]!).toFixed(0)} READ batches/s, ${(median(samples[1]!) / median(samples[0]!)).toFixed(3)}x; ${plan.offsets.filter(n => n !== 0).length} compiled components per batch`);
