import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from './ir';
import { loadCircuit } from './loader';
import './primitives/index';
import { Simulator } from './sim';

const nandLatch: CircuitJSON = {
  version: 1,
  kind: 'circuit',
  name: 'nand_latch',
  components: [
    { id: 'g1', type: 'prim.NAND', params: { inputs: 2 } },
    { id: 'g2', type: 'prim.NAND', params: { inputs: 2 } },
  ],
  nets: [
    { id: 'n_S',  endpoints: ['g1.A'] },
    { id: 'n_R',  endpoints: ['g2.A'] },
    { id: 'n_Q',  endpoints: ['g1.Y', 'g2.B'] },
    { id: 'n_Qn', endpoints: ['g2.Y', 'g1.B'] },
  ],
};

// A gated ring oscillator: NAND(ext, node2) → NOT → NOT → back to NAND.B.
//   ext=0 → NAND output forced to 1, the ring settles to a fixed pattern.
//   ext=1 → NAND acts as NOT(node2), giving 3 inversions in a loop. Oscillates.
//
// Built like this because a pure 3-NOT ring starting from all-X stays at X
// (resolveNet poisons against X), which is *correct* simulator behavior — a
// real zero-delay symmetric ring needs an asymmetry to start oscillating.
const gatedRing: CircuitJSON = {
  version: 1,
  kind: 'circuit',
  name: 'gated-ring',
  components: [
    { id: 'g',  type: 'prim.NAND', params: { inputs: 2 } },
    { id: 'i1', type: 'prim.NOT' },
    { id: 'i2', type: 'prim.NOT' },
  ],
  nets: [
    { id: 'ext',   endpoints: ['g.A'] },
    { id: 'node0', endpoints: ['g.Y',  'i1.A'] },
    { id: 'node1', endpoints: ['i1.Y', 'i2.A'] },
    { id: 'node2', endpoints: ['i2.Y', 'g.B'] },
  ],
};

const driveAndCapture = (
  sim: Simulator,
  graph: ReturnType<typeof loadCircuit>,
  drives: Array<Array<readonly [string, NetState]>>,
  watch: string[],
): string[] => {
  const trace: string[] = [];
  for (const drive of drives) {
    for (const [net, value] of drive) sim.setInput(net, value);
    sim.settle();
    trace.push(watch.map((id) => `${id}=${String(sim.readNet(id))}`).join(' '));
  }
  return trace;
};

describe('Simulator: NAND latch', () => {
  it('starts with all nets X and components dirty', () => {
    const g = loadCircuit(nandLatch);
    const sim = new Simulator(g);
    expect(sim.readNet('n_Q')).toBe('X');
    expect(sim.readNet('n_Qn')).toBe('X');
  });

  it('matches the canonical S/R latch waveform', () => {
    const g = loadCircuit(nandLatch);
    const sim = new Simulator(g);
    const trace = driveAndCapture(
      sim,
      g,
      [
        [],                                            // init
        [['n_S', 1], ['n_R', 1]],                      // idle (metastable X)
        [['n_S', 0]],                                  // set: Q=1
        [['n_S', 1]],                                  // hold
        [['n_R', 0]],                                  // reset: Q=0
        [['n_R', 1]],                                  // hold
      ],
      ['n_S', 'n_R', 'n_Q', 'n_Qn'],
    );
    expect(trace).toEqual([
      'n_S=Z n_R=Z n_Q=X n_Qn=X',
      'n_S=1 n_R=1 n_Q=X n_Qn=X',
      'n_S=0 n_R=1 n_Q=1 n_Qn=0',
      'n_S=1 n_R=1 n_Q=1 n_Qn=0',
      'n_S=1 n_R=0 n_Q=0 n_Qn=1',
      'n_S=1 n_R=1 n_Q=0 n_Qn=1',
    ]);
  });

  it('records no oscillation events for the latch sequence', () => {
    const g = loadCircuit(nandLatch);
    const sim = new Simulator(g);
    sim.settle();
    sim.setInput('n_S', 1);
    sim.setInput('n_R', 1);
    sim.settle();
    sim.setInput('n_S', 0);
    sim.settle();
    expect(sim.events).toEqual([]);
  });
});

describe('Simulator: oscillation detection', () => {
  it('settles cleanly when the ring is gated off (ext=0)', () => {
    const g = loadCircuit(gatedRing);
    const sim = new Simulator(g);
    sim.setInput('ext', 0);
    sim.settle();
    expect(sim.events).toEqual([]);
    expect(sim.readNet('node0')).toBe(1);
    expect(sim.readNet('node1')).toBe(0);
    expect(sim.readNet('node2')).toBe(1);
  });

  it('emits an oscillation event when the ring is enabled (ext=1)', () => {
    const g = loadCircuit(gatedRing);
    const sim = new Simulator(g, { maxIterations: 50 });
    sim.setInput('ext', 0);
    sim.settle();
    sim.setInput('ext', 1);
    sim.settle();
    expect(sim.events.some((e) => e.kind === 'oscillation')).toBe(true);
  });

  it('halts the offending step and does not re-emit on the next', () => {
    const g = loadCircuit(gatedRing);
    const sim = new Simulator(g, { maxIterations: 50 });
    sim.setInput('ext', 0);
    sim.settle();
    sim.setInput('ext', 1);
    sim.settle();
    const eventCount = sim.events.length;
    expect(eventCount).toBeGreaterThan(0);
    sim.settle();
    expect(sim.events.length).toBe(eventCount);
  });
});

describe('Simulator: determinism', () => {
  it('produces byte-identical traces across 100 fresh runs', () => {
    const drives: Array<Array<readonly [string, NetState]>> = [
      [],
      [['n_S', 1], ['n_R', 1]],
      [['n_S', 0]],
      [['n_S', 1]],
      [['n_R', 0]],
      [['n_R', 1]],
    ];
    const watch = ['n_S', 'n_R', 'n_Q', 'n_Qn'];

    const runOnce = (): string[] => {
      const g = loadCircuit(nandLatch);
      const sim = new Simulator(g);
      return driveAndCapture(sim, g, drives, watch);
    };

    const reference = runOnce();
    for (let i = 0; i < 100; i++) {
      expect(runOnce()).toEqual(reference);
    }
  });
});
