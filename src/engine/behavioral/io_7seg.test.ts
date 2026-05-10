import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './io_7seg';
import './io_switch';

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;
type SegState = Record<typeof SEGMENTS[number], NetState>;

const segCircuit = (): CircuitJSON => ({
  version: 1,
  kind: 'circuit',
  name: 'switches_to_7seg',
  components: [
    ...SEGMENTS.map((s) => ({ id: `sw_${s}`, type: 'io.switch' })),
    { id: 'disp', type: 'io.7seg' },
  ],
  nets: SEGMENTS.map((s) => ({
    id: `n_${s}`,
    endpoints: [`sw_${s}.Y`, `disp.${s}`],
  })),
});

const segState = (sim: Simulator): SegState => {
  const idx = sim.graph.componentById.get('disp')!;
  return sim.graph.components[idx]!.state as SegState;
};

const setAll = (sim: Simulator, value: NetState) => {
  for (const s of SEGMENTS) sim.setComponentInput(`sw_${s}`, 'Y', value);
};

describe('io.7seg', () => {
  it('records each segment input into component state', () => {
    const sim = new Simulator(loadCircuit(segCircuit()));
    sim.settle();
    // All switches default to 0 → every segment 0.
    expect(segState(sim)).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, dp: 0 });

    setAll(sim, 1);
    sim.settle();
    expect(segState(sim)).toEqual({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, dp: 1 });
  });

  it('latches a digit pattern (digit "3": a,b,c,d,g on; e,f,dp off)', () => {
    const sim = new Simulator(loadCircuit(segCircuit()));
    sim.settle();
    for (const s of ['a', 'b', 'c', 'd', 'g'] as const) sim.setComponentInput(`sw_${s}`, 'Y', 1);
    sim.settle();
    expect(segState(sim)).toEqual({ a: 1, b: 1, c: 1, d: 1, e: 0, f: 0, g: 1, dp: 0 });
  });

  it('drives no outputs onto the circuit', () => {
    const sim = new Simulator(loadCircuit(segCircuit()));
    sim.settle();
    setAll(sim, 1);
    sim.settle();
    // After settle the queue should be empty — display is a sink.
    expect(sim.events).toEqual([]);
  });
});
