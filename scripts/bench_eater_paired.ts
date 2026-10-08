// Interleave f6c3595 and current scheduling in one process, at identical QoS.
// Run: node --import tsx scripts/bench_eater_paired.ts [trials] [ticks]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import '../src/engine/behavioral/index';
import '../src/stdlib/index';
import { ReferenceSimulator } from '../src/engine/__fixtures__/reference-sim';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';

// Optional performance-core eligible run. Retain nice(15), remove only the
// inherited macOS background tier; both versions still share one process.
if (process.env.BREAD_BENCH_FOREGROUND === '1') {
  execFileSync('taskpolicy', ['-b', 'nice', '-n', '15', 'taskpolicy', '-B', '-p', String(process.pid)]);
  console.log('QoS: background tier removed; nice(15) retained');
}

const circuit = JSON.parse(readFileSync(new URL('../examples/ben_eater_8bit.json', import.meta.url), 'utf8')) as CircuitJSON;
const trials = Number(process.argv[2] ?? 5);
const ticks = Number(process.argv[3] ?? 200_000);
const warmup = 20_000;
const block = 2_000;
if (![trials, ticks].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Expected positive trial and tick counts');
const samples: number[][] = [[], []];
for (let trial = 0; trial < trials; trial++) {
  const sims = [new ReferenceSimulator(loadCircuit(circuit)), new Simulator(loadCircuit(circuit))];
  for (const sim of sims) {
    sim.settle();
    sim.setComponentInput('sw_reset', 'Y', 1);
    sim.settle();
  }
  const elapsed = [0, 0];
  for (let start = -warmup; start < ticks; start += block) {
    const count = Math.min(block, ticks - start);
    const first = (trial + Math.floor((start + warmup) / block)) & 1;
    for (let turn = 0; turn < 2; turn++) {
      const version = first ^ turn;
      const sim = sims[version]!;
      const t0 = performance.now();
      for (let i = 0; i < count; i++) sim.tick();
      if (start >= 0) elapsed[version]! += performance.now() - t0;
    }
    // Outside the timed region: guard against accidentally benchmarking
    // less work or a different trajectory, including diagnostic retention.
    assert.deepEqual(sims[0]!.graph.netValues, sims[1]!.graph.netValues);
    assert.equal(sims[0]!.eventsEmitted, sims[1]!.eventsEmitted);
    assert.deepEqual(sims[0]!.events, sims[1]!.events);
  }
  const rates = elapsed.map(ms => ticks * 500 / ms);
  rates.forEach((hz, i) => samples[i]!.push(hz));
  console.log(`trial ${trial + 1}: f6c3595 ${rates[0]!.toFixed(0)} Hz, current ${rates[1]!.toFixed(0)} Hz, ${(rates[1]! / rates[0]!).toFixed(3)}x`);
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length & 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const before = median(samples[0]!);
const after = median(samples[1]!);
console.log(`medians: f6c3595 ${before.toFixed(0)} Hz, current ${after.toFixed(0)} Hz, ${(after / before).toFixed(3)}x (${trials} trials, ${ticks} ticks, ${warmup} warmup, ${block}-tick alternating blocks)`);
