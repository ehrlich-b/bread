// Golden-trace harness. Encoding is independent of the engine's internal
// storage: one byte per net (0, 1, Z=2, X=3), in loader insertion order.
import eater from '../../../examples/ben_eater_8bit.json';
import adder from '../../../examples/full_adder.json';
import '../index';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import { Simulator, type SimEvent } from '../sim';

export const EATER_CYCLES = 2048;
export const ADDER_CYCLES = 64;

export function captureTrace(example: 'eater' | 'adder'): {
  netIds: string[];
  frames: number;
  bytes: Buffer;
  events: Simulator['events'];
} {
  const events: SimEvent[] = [];
  const sim = new Simulator(loadCircuit((example === 'eater' ? eater : adder) as CircuitJSON), { onEvent: event => events.push(event) });
  const netIds = sim.graph.nets.map((net) => net.id);
  const bytes: number[] = [];
  let frames = 0;
  const snapshot = (): void => {
    for (const id of netIds) {
      const value = sim.readNet(id);
      bytes.push(value === 'Z' ? 2 : value === 'X' ? 3 : value);
    }
    frames++;
  };

  snapshot(); // All-X power-on state, before the first READ phase.
  sim.settle();
  snapshot();
  if (example === 'eater') {
    sim.setComponentInput('sw_reset', 'Y', 1);
    sim.settle();
    snapshot();
    for (let tick = 0; tick < EATER_CYCLES * 2; tick++) {
      sim.tick();
      snapshot();
    }
  } else {
    // Exhaust all 4^3 input combinations, including floating and unknown
    // inputs, with a second settled frame to catch stale dirty-queue state.
    const values: NetState[] = [0, 1, 'Z', 'X'];
    for (let cycle = 0; cycle < ADDER_CYCLES; cycle++) {
      sim.setComponentInput('a', 'Y', values[cycle & 3]!);
      sim.setComponentInput('b', 'Y', values[(cycle >> 2) & 3]!);
      sim.setComponentInput('cin', 'Y', values[(cycle >> 4) & 3]!);
      sim.tick();
      snapshot();
      sim.tick();
      snapshot();
    }
  }
  return { netIds, frames, bytes: Buffer.from(bytes), events };
}
