// Headless smoke test of the M3 demo circuit. Mirrors what the browser worker
// does: load examples/blink_demo.json, advance ticks at the same rate the
// worker uses (rateHz=4 here for a short, deterministic trace), and verify
// that the LED follows AND(switch, clock).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/engine/behavioral/index';
import type { CircuitJSON, NetState } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import '../src/engine/primitives/index';
import { Simulator } from '../src/engine/sim';
import '../src/stdlib/index';

const here = dirname(fileURLToPath(import.meta.url));
const json = JSON.parse(
  readFileSync(resolve(here, '..', 'examples', 'blink_demo.json'), 'utf8'),
) as CircuitJSON;

const RATE = 4;
const sim = new Simulator(loadCircuit(json), { rateHz: RATE });
sim.settle();

const led = (): NetState => sim.readNet('lit');

const collect = (ticks: number): NetState[] => {
  const t: NetState[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.tick();
    t.push(led());
  }
  return t;
};

let failed = 0;
const expect = (label: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`PASS ${label}\n`);
  } else {
    process.stdout.write(`FAIL ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}\n`);
    failed++;
  }
};

// Switch starts at 0 — AND output is always 0 regardless of clock.
expect('switch=0: LED stays off for 8 ticks', collect(8), [0, 0, 0, 0, 0, 0, 0, 0]);

// Toggle switch on. Now LED should track the clock: 2 low, 2 high, repeating
// (rateHz=4, freqHz=1 → halfPeriod=2). The clock continues from whatever
// phase it reached during the switch=0 sweep, so the trace starts with two
// 1s rather than two 0s; the duty cycle and period are what matter.
sim.setComponentInput('sw', 'Y', 1);
sim.settle();
const phase2 = collect(8);
expect('switch=1: phase 2 traces a clean 50% duty cycle', phase2, [1, 1, 0, 0, 1, 1, 0, 0]);
const ones = phase2.filter((v) => v === 1).length;
expect('switch=1: 50% duty cycle over 8 ticks', ones, 4);

// Flip switch off mid-stream. AND output should drop to 0 immediately and
// stay there.
sim.setComponentInput('sw', 'Y', 0);
sim.settle();
expect('switch flipped off mid-stream: LED stays off', collect(6), [0, 0, 0, 0, 0, 0]);

if (failed > 0) {
  process.stderr.write(`\nblink_demo: ${String(failed)} FAILURE(S)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nblink_demo: OK\n`);
}
