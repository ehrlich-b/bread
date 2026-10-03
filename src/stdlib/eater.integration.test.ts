// Whole-machine integration test for the Ben Eater 8-bit example. Loads the
// circuit JSON from disk, runs the simulator long enough to cover several
// fibonacci values, and asserts the display state matches the expected
// sequence. The unit tests in eater.test.ts cover each composite in
// isolation; this test catches wiring or microcode regressions that only
// surface when everything is bolted together.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../engine/behavioral/index';
import '../engine/primitives/index';
import type { CircuitJSON, NetState } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import { Simulator } from '../engine/sim';
import './index';

const here = dirname(fileURLToPath(import.meta.url));
const circuitJsonPath = resolve(here, '..', '..', 'examples', 'ben_eater_8bit.json');
const circuit = JSON.parse(readFileSync(circuitJsonPath, 'utf8')) as CircuitJSON;

// The 7-seg pattern → hex digit lookup. Matches the encoding in
// eater.output_display's ROM contents.
const SEG_TO_HEX: Record<string, string> = {
  '1111110': '0', '0110000': '1', '1101101': '2', '1111001': '3',
  '0110011': '4', '1011011': '5', '1011111': '6', '1110000': '7',
  '1111111': '8', '1111011': '9', '1110111': 'A', '0011111': 'b',
  '1001110': 'C', '0111101': 'd', '1001111': 'E', '1000111': 'F',
};

const decodeDigit = (state: { a: NetState; b: NetState; c: NetState; d: NetState; e: NetState; f: NetState; g: NetState }): string => {
  const segs = `${String(state.a)}${String(state.b)}${String(state.c)}${String(state.d)}${String(state.e)}${String(state.f)}${String(state.g)}`;
  return SEG_TO_HEX[segs] ?? '?';
};

describe('ben_eater_8bit (integration)', () => {
  it('runs three ordered Fibonacci cycles, including the repeated initial 1', () => {
    const sim = new Simulator(loadCircuit(circuit));
    // Initial settle with reset asserted (sw_reset defaults to 0).
    sim.settle();
    // Release reset.
    sim.setComponentInput('sw_reset', 'Y', 1);
    sim.settle();

    const displayLo = sim.graph.componentById.get('display__disp_lo');
    const displayHi = sim.graph.componentById.get('display__disp_hi');
    expect(displayLo, 'display__disp_lo not found').toBeDefined();
    expect(displayHi, 'display__disp_hi not found').toBeDefined();

    const readDisplay = (): string => {
      const lo = sim.graph.components[displayLo!]!.state as Parameters<typeof decodeDigit>[0];
      const hi = sim.graph.components[displayHi!]!.state as Parameters<typeof decodeDigit>[0];
      return `${decodeDigit(hi)}${decodeDigit(lo)}`;
    };

    const expected = ['01', '01', '02', '03', '05', '08', '0d', '15', '22', '37', '59', '90', 'E9'];
    // Sample at OUT-register load edges, preserving order and duplicate values.
    // A set of display values could pass even if instructions ran out of order.
    const observed: string[] = [];
    let previousClock = sim.readNet('gated_clk');
    for (let i = 0; i < 10000 && observed.length < expected.length * 3; i++) {
      const outputEnabled = sim.readNet('ctl_oi') === 0;
      sim.tick();
      const clock = sim.readNet('gated_clk');
      if (previousClock === 0 && clock === 1 && outputEnabled) observed.push(readDisplay());
      previousClock = clock;
    }

    // Sequence the program produces: 01, 01, 02, 03, 05, 08, 0D, 15, 22, 37, 59,
    // 90, E9. After E9 the next ADD overflows and JC restarts at 0, so the
    // display cycles back to 01 etc.
    // Note: the 7-seg ROM encodes 'd' (lowercase) and 'b' (lowercase) since
    // those digits use a different segment pattern from a 'D'/'B' that would
    // overlap with '0' and '8' respectively.
    expect(observed).toEqual([...expected, ...expected, ...expected]);
  });
});
