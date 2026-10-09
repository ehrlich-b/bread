import { describe, expect, it } from 'vitest';
import './behavioral/index';
import type { CircuitJSON } from './ir';
import { loadCircuit } from './loader';
import { Simulator } from './sim';

const observerCircuit: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'contention-observer-write',
  components: [
    { id: 'zero', type: 'prim.CONST_0' },
    { id: 'buf', type: 'prim.BUF' },
    { id: 'sw', type: 'io.switch' },
  ],
  nets: [
    { id: 'input', endpoints: ['zero.Y', 'buf.A'] },
    { id: 'fight', endpoints: ['buf.Y'] },
    { id: 'signal', endpoints: ['sw.Y'] },
  ],
};

describe('Simulator: callback scheduling', () => {
  it('retains a component change made by a contention observer during settle', () => {
    let handled = 0;
    const sim = new Simulator(loadCircuit(observerCircuit), { onEvent: event => {
      if (event.kind === 'contention') {
        handled++;
        sim.setComponentInput('sw', 'Y', 1);
      }
    } });
    sim.setInput('fight', 1);
    sim.settle();
    const first = sim.readNet('signal');
    sim.settle();
    sim.tick();
    expect({ first, final: sim.readNet('signal'), state: sim.graph.components[2]!.state, handled })
      .toEqual({ first: 1, final: 1, state: { Y: 1 }, handled: 1 });
  });

  it.each(['settle', 'tick'] as const)('defers a re-entrant %s while retaining forced-net listeners and state changes', method => {
    const circuit: CircuitJSON = {
      ...observerCircuit,
      components: [
        ...observerCircuit.components,
        { id: 'high', type: 'prim.CONST_1' },
        { id: 'a', type: 'prim.BUF' }, { id: 'b', type: 'prim.BUF' },
        { id: 'clock', type: 'gen.clock', params: { freqHz: 1 } },
      ],
      nets: [
        ...observerCircuit.nets,
        { id: 'conflict', endpoints: ['zero.Y', 'high.Y'] },
        { id: 'forced', endpoints: ['a.A', 'b.A'] },
        { id: 'a_out', endpoints: ['a.Y'] }, { id: 'b_out', endpoints: ['b.Y'] },
        { id: 'clock_out', endpoints: ['clock.Y'] },
      ],
    };
    // Each pin belongs to one net: move zero's output to the multi-driver net.
    circuit.nets[0] = { id: 'input', endpoints: ['buf.A'] };
    let handled = 0;
    const sim = new Simulator(loadCircuit(circuit), { onEvent: event => {
      if (event.kind !== 'contention') return;
      handled++;
      sim.setInput('forced', 1);
      sim.setComponentInput('sw', 'Y', 1);
      // Fill the entire next batch; repeated state changes and listeners
      // must share its marks instead of appending duplicates past capacity.
      for (const comp of circuit.components) sim.setComponentInput(comp.id, 'observerWake', 1);
      sim[method]();
      sim.setComponentInput('sw', 'Y', 0);
      sim.setComponentInput('sw', 'Y', 1);
    } });
    sim.settle();
    expect(handled).toBe(1);
    expect(sim.step).toBe(1);
    expect(sim.readNet('clock_out')).toBe(method === 'tick' ? 1 : 0);
    expect(['signal', 'a_out', 'b_out'].map(id => sim.readNet(id))).toEqual([1, 1, 1]);
    sim.settle();
    sim.tick();
    expect(['signal', 'a_out', 'b_out'].map(id => sim.readNet(id))).toEqual([1, 1, 1]);
  });

  it('retains changes made by a contention observer outside settle', () => {
    let handled = 0;
    const sim = new Simulator(loadCircuit(observerCircuit), { onEvent: event => {
      if (event.kind !== 'contention') return;
      handled++;
      if (!event.detail.includes('"fight"')) return;
      sim.setComponentInput('sw', 'Y', 1);
      sim.setInput('input', 1);
    } });
    sim.settle();
    sim.setInput('fight', 1);
    sim.settle();
    expect(handled).toBe(2);
    expect(sim.readNet('signal')).toBe(1);
    expect(sim.readNet('fight')).toBe('X');
  });

  it('retains an input queued from a custom evaluator during READ', () => {
    const graph = loadCircuit(observerCircuit);
    const sw = graph.components[2]!;
    let changed = false;
    let sim: Simulator;
    sw.primitive = {
      ...sw.primitive,
      evaluate(_inputs, outputs, state) {
        outputs[0] = (state as { Y: 0 | 1 }).Y;
        if (!changed) {
          changed = true;
          sim.setComponentInput('sw', 'Y', 1);
          sim.settle();
        }
        return undefined;
      },
    };
    sim = new Simulator(graph);
    sim.settle();
    expect(sim.readNet('signal')).toBe(1);
    expect(sim.step).toBe(1);
  });

  it('retains observer work after halting an oscillating batch', () => {
    let handled = 0;
    const sim = new Simulator(loadCircuit(observerCircuit), { maxIterations: 1, onEvent: event => {
      if (event.kind !== 'oscillation') return;
      handled++;
      sim.setComponentInput('sw', 'Y', 1);
      sim.settle();
    } });
    sim.settle();
    expect(handled).toBe(1);
    sim.settle();
    expect(sim.readNet('signal')).toBe(1);
    expect(handled).toBe(1);
  });
});
