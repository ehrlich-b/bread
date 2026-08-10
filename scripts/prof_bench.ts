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

for (let i = 0; i < WARMUP; i++) sim.tick();

const t0 = process.hrtime.bigint();
for (let i = 0; i < ITERS; i++) sim.tick();
const dt = Number(process.hrtime.bigint() - t0) / 1e6;
const tickRate = (ITERS / dt) * 1000;
console.log(`ticks: ${ITERS} wall: ${dt.toFixed(2)} ms rate: ${tickRate.toFixed(0)} ticks/s clock: ${(tickRate/2).toFixed(0)} Hz events: ${sim.events.length}`);
