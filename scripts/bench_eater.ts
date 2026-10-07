// Throughput benchmark for the Ben Eater 8-bit machine. Loads the bundled
// example, releases reset, runs a warm-up burst, then measures sim ticks per
// real-time second over a fixed budget. The ROADMAP M6 target is 100 kHz
// simulated clock in JS; with two ticks per gen.clock half-period that is
// 200_000 ticks/s. The bench reports sim ticks/s so the headroom against the
// target is direct.
//
// Run: `npx tsx scripts/bench_eater.ts [iters]`

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
const path = resolve(here, '..', 'examples', 'ben_eater_8bit.json');
const circuit = JSON.parse(readFileSync(path, 'utf8')) as CircuitJSON;

const ITERS = Number(process.argv[2] ?? 200_000);
const WARMUP = 20_000;

const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset', 'Y', 1);
sim.settle();

console.log(`graph: ${String(sim.graph.components.length)} components, ${String(sim.graph.nets.length)} nets`);

for (let i = 0; i < WARMUP; i++) sim.tick();

const t0 = performance.now();
for (let i = 0; i < ITERS; i++) sim.tick();
const dt = performance.now() - t0;

const tickRate = (ITERS / dt) * 1000;
const usPerTick = (dt * 1000) / ITERS;
const simulatedClockHz = tickRate / 2; // 2 ticks per gen.clock half-period

console.log(`ticks: ${String(ITERS)} (warmup ${String(WARMUP)})`);
console.log(`wall:  ${dt.toFixed(2)} ms`);
console.log(`rate:  ${tickRate.toFixed(0).padStart(8)} ticks/s`);
console.log(`cost:  ${usPerTick.toFixed(2).padStart(8)} us/tick`);
console.log(`clock: ${simulatedClockHz.toFixed(0).padStart(8)} simulated Hz (target: 100_000)`);
console.log(`events emitted: ${String(sim.eventsEmitted)}`);
