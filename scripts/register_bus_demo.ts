import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CircuitJSON, NetState } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import '../src/engine/primitives/index';
import { Simulator } from '../src/engine/sim';
import '../src/stdlib/index';

const here = dirname(fileURLToPath(import.meta.url));
const circuitPath = resolve(here, '..', 'examples', 'register_bus_4bit.json');
const json = JSON.parse(readFileSync(circuitPath, 'utf8')) as CircuitJSON;

const graph = loadCircuit(json);
const sim = new Simulator(graph);

const setBus = (prefix: 'a' | 'b', value: number): void => {
  for (let i = 0; i < 4; i++) {
    const bit: NetState = ((value >> i) & 1) === 1 ? 1 : 0;
    sim.setInput(`${prefix}_d${i + 1}`, bit);
  }
};

const setEnables = (
  prefix: 'a' | 'b',
  loadEn: boolean,
  outputEn: boolean,
): void => {
  // Active-low: drive low to enable.
  sim.setInput(`${prefix}_g1`, loadEn ? 0 : 1);
  sim.setInput(`${prefix}_g2`, loadEn ? 0 : 1);
  sim.setInput(`${prefix}_m`,  outputEn ? 0 : 1);
  sim.setInput(`${prefix}_n`,  outputEn ? 0 : 1);
};

const tick = (): void => {
  sim.setInput('clk', 1); sim.settle();
  sim.setInput('clk', 0); sim.settle();
};

const readBus = (): number | string => {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const b = sim.readNet(`bus${i}`);
    if (b !== 0 && b !== 1) return String(b);
    v |= b << i;
  }
  return v;
};

const expect = (label: string, actual: number | string, want: number | string): void => {
  const got = typeof actual === 'number' ? `0x${actual.toString(16).toUpperCase()}` : actual;
  const exp = typeof want === 'number' ? `0x${want.toString(16).toUpperCase()}` : want;
  if (actual !== want) {
    process.stderr.write(`FAIL ${label}: got=${got} want=${exp}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS ${label}: bus=${got}\n`);
  }
};

// Initial reset. CLR is active high; pulse it to force both registers to 0.
setEnables('a', false, false);
setEnables('b', false, false);
sim.setInput('clk', 0);
sim.setInput('clr', 1);
sim.settle();
sim.setInput('clr', 0);
sim.settle();

// Step 1 — load 0xA into REG_A (REG_B output disabled).
setBus('a', 0xA);
setEnables('a', true, false);
sim.settle();
tick();
setEnables('a', false, true);   // stop loading; drive A onto bus
setEnables('b', false, false);  // keep B in Hi-Z
sim.settle();
expect('REG_A=0xA on bus', readBus(), 0xA);

// Step 2 — load 0x5 into REG_B; turn A off to avoid contention while loading B.
setEnables('a', false, false);  // A in Hi-Z
setBus('b', 0x5);
setEnables('b', true, false);
sim.settle();
tick();

// Step 3 — drive REG_B on the bus, A in Hi-Z.
setEnables('b', false, true);
sim.settle();
expect('REG_B=0x5 on bus', readBus(), 0x5);

// Step 4 — flip enables: A back on, B off.
setEnables('a', false, true);
setEnables('b', false, false);
sim.settle();
expect('REG_A=0xA on bus (after switching)', readBus(), 0xA);

// Step 5 — both disabled → bus floats to Z.
setEnables('a', false, false);
setEnables('b', false, false);
sim.settle();
expect('floating bus is Z', readBus(), 'Z');

// Step 6 — both registers driving the same value: load 0x3 into both, then enable both.
setBus('a', 0x3); setEnables('a', true, false); sim.settle(); tick();
setEnables('a', false, false);
setBus('b', 0x3); setEnables('b', true, false); sim.settle(); tick();
setEnables('a', false, true);
setEnables('b', false, true);
sim.settle();
const beforeContention = sim.events.length;
expect('matching values on shared bus = same value, no contention', readBus(), 0x3);
if (sim.events.length !== beforeContention) {
  process.stderr.write(`FAIL: matching-value drive emitted contention events\n`);
  process.exitCode = 1;
}

// Step 7 — drive different values on the same bus and confirm contention reports.
setBus('a', 0xA); setEnables('a', true, false); sim.settle(); tick();
setEnables('a', false, false);
setBus('b', 0x5); setEnables('b', true, false); sim.settle(); tick();
setEnables('a', false, true);
setEnables('b', false, true);
const beforeConflict = sim.events.length;
sim.settle();
const newEvents = sim.events.slice(beforeConflict);
const contentionEvents = newEvents.filter((e) => e.kind === 'contention');
if (contentionEvents.length === 0) {
  process.stderr.write(`FAIL: conflicting drives produced no contention events\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `PASS contention reported on ${contentionEvents.length} bus net(s) when both registers drive different values\n`,
  );
}

// Final summary.
if (process.exitCode && process.exitCode !== 0) {
  process.stderr.write(`\nregister_bus_demo: FAILURES detected\n`);
} else {
  process.stdout.write(`\nregister_bus_demo: OK\n`);
}
