// Headless bundled-reference benchmark. This is not a manually built CPU.
// Counts actual clock edges and T4 -> T0 instruction completions, checks every
// OUT against an independent Fibonacci sequence, and includes observation cost.
// Run: node --import tsx scripts/bench_eater_observed.ts [ticks]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../src/engine/index';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';

const ticks = Number(process.argv[2] ?? 200_000);
assert(Number.isSafeInteger(ticks) && ticks > 0, 'ticks must be a positive integer');
const warmup = 20_000;
const circuit = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/ben_eater_8bit.json', import.meta.url)), 'utf8')) as CircuitJSON;
const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset', 'Y', 1);
sim.settle();

const index = (id: string): number => {
  const found = sim.graph.netById.get(id);
  assert(found !== undefined, `missing net ${id}`);
  return found;
};
const clockIndex = index('gated_clk');
const outputEnableIndex = index('ctl_oi');
const tIndices = ['control__tq0', 'control__tq1', 'control__tq2'].map(index);
const outputIndices = [
  ...Array.from({ length: 4 }, (_, bit) => `display__nlo${bit}`),
  ...Array.from({ length: 4 }, (_, bit) => `display__nhi${bit}`),
].map(index);
const readBits = (indices: number[]): number => {
  let result = 0;
  for (let bit = 0; bit < indices.length; bit++) {
    const value = sim.graph.nets[indices[bit]!]!.value;
    assert(value === 0 || value === 1, 'undefined reference-machine bit');
    result |= value << bit;
  }
  return result;
};

const fibonacci: number[] = [];
for (let previous = 0, current = 1; current <= 255; [previous, current] = [current, previous + current]) fibonacci.push(current);
let outputCursor = 0;
let checkedOutputs = 0;
let cycles = 0;
let instructions = 0;
let previousClock = sim.graph.nets[clockIndex]!.value;
let previousT = readBits(tIndices);
const tickAndObserve = (): void => {
  const outputEnabled = sim.graph.nets[outputEnableIndex]!.value === 0;
  sim.tick();
  const clock = sim.graph.nets[clockIndex]!.value;
  assert(clock === 0 || clock === 1, 'undefined CPU clock');
  const nextT = readBits(tIndices);
  if (previousClock === 0 && clock === 1) {
    cycles++;
    if (outputEnabled) {
      assert.equal(readBits(outputIndices), fibonacci[outputCursor], `incorrect OUT at index ${checkedOutputs}`);
      outputCursor = (outputCursor + 1) % fibonacci.length;
      checkedOutputs++;
    }
  }
  if (previousT === 4 && nextT === 0) instructions++;
  previousClock = clock;
  previousT = nextT;
};

for (let tick = 0; tick < warmup; tick++) tickAndObserve();
assert(checkedOutputs >= fibonacci.length * 3, 'warmup did not validate three Fibonacci cycles');
cycles = 0;
instructions = 0;
const outputsBefore = checkedOutputs;
const eventsBefore = sim.events.length;
const started = performance.now();
for (let tick = 0; tick < ticks; tick++) tickAndObserve();
const elapsedMs = performance.now() - started;
assert(sim.events.every((event) => event.kind !== 'oscillation'), 'reference machine oscillated');
console.log(JSON.stringify({
  fixture: 'bundled SAP-1 reference; not manual editor evidence',
  node: process.version, platform: process.platform, arch: process.arch,
  components: sim.graph.components.length, nets: sim.graph.nets.length,
  simulationRateHz: sim.rateHz, clockFrequencyHz: 2,
  warmupTicks: warmup, timedTicks: ticks, elapsedMs,
  clockCycles: cycles, instructionCompletions: instructions,
  ticksPerSecond: ticks * 1000 / elapsedMs,
  clockCyclesPerSecond: cycles * 1000 / elapsedMs,
  instructionsPerSecond: instructions * 1000 / elapsedMs,
  checkedOutputsDuringTiming: checkedOutputs - outputsBefore,
  diagnosticsDuringTiming: sim.events.length - eventsBefore,
  oscillations: 0,
  observationCostIncluded: true,
}, null, 2));
