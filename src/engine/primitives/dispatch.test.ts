import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import { Simulator } from '../sim';
import { EvalKind } from './dispatch';
import { registerPrimitive } from './registry';

const cases: Array<{ type: string; params: Record<string, unknown> }> = [
  ...['AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR'].map((gate) => ({ type: `prim.${gate}`, params: { inputs: 3 } })),
  ...['NOT', 'BUF', 'LATCH', 'CONST_0', 'CONST_1', 'PULLUP', 'PULLDOWN'].map((gate) => ({ type: `prim.${gate}`, params: {} })),
  { type: 'prim.DFF', params: {} },
  { type: 'prim.DFF', params: { clrActiveLow: true, preActiveLow: true } },
  { type: 'prim.DFF', params: { initialQ: 0, clrActiveLow: true } },
  { type: 'prim.DFF', params: { initialQ: 1, preActiveLow: true } },
  { type: 'prim.TRISTATE', params: {} },
  { type: 'prim.TRISTATE', params: { oeActiveLow: true } },
  { type: 'prim.MUX2', params: { width: 2 } },
  { type: 'prim.DEMUX2', params: { width: 2 } },
  { type: 'prim.DECODER', params: { bits: 3, activeLow: false } },
  { type: 'prim.DECODER', params: { bits: 3, activeLow: true } },
  { type: 'prim.ADDER', params: { width: 2 } },
];

describe('primitive dispatch through the two-phase scheduler', () => {
  it.each(cases)('$type $params matches registry dispatch for every four-state input vector', ({ type, params }) => {
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'dispatch',
      components: [{ id: 'dut', type, params }], nets: [],
    };
    const sim = new Simulator(loadCircuit(circuit));
    const reference = new Simulator(loadCircuit(circuit));
    const comp = sim.graph.components[0]!;
    const referenceComp = reference.graph.components[0]!;
    expect(comp.evalKind).not.toBe(EvalKind.Generic);
    // This graph uses the original PrimitiveDef.evaluate call site, with
    // identical initial state, input translation, scheduling and resolution.
    referenceComp.evalKind = EvalKind.Generic;
    sim.settle();
    reference.settle();
    const values: NetState[] = [0, 1, 'Z', 'X'];
    for (let vector = 0; vector < 4 ** comp.inputBuf.length; vector++) {
      for (let pin = 0; pin < comp.inputBuf.length; pin++) {
        const net = sim.graph.nets[comp.inputNetIdx[pin]!]!.id;
        const value = values[(vector >> (pin * 2)) & 3]!;
        sim.setInput(net, value);
        reference.setInput(net, value);
      }
      sim.settle();
      reference.settle();
      expect(comp.outputBuf).toEqual(referenceComp.outputBuf);
      expect(comp.state).toEqual(referenceComp.state);
      expect(sim.graph.netValues).toEqual(reference.graph.netValues);
      expect(sim.events).toEqual(reference.events);
    }
  });

  it('uses the registered evaluator and context for custom primitives', () => {
    registerPrimitive('prim.DISPATCH_TEST', {
      pins: () => [{ name: 'Y', dir: 'out' }],
      tickActive: true,
      init: () => ({ calls: 0 }),
      evaluate(_inputs, outputs, state, _params, ctx) {
        outputs[0] = (ctx!.step & 1) === 0 ? 0 : 1;
        return { calls: state.calls + 1 };
      },
    });
    const sim = new Simulator(loadCircuit({
      version: 1, kind: 'circuit', name: 'custom',
      components: [{ id: 'dut', type: 'prim.DISPATCH_TEST' }],
      nets: [{ id: 'out', endpoints: ['dut.Y'] }],
    }));
    expect(sim.graph.components[0]!.evalKind).toBe(EvalKind.Generic);
    for (let step = 0; step < 4; step++) {
      sim.tick();
      expect(sim.readNet('out')).toBe(step & 1);
      expect(sim.graph.components[0]!.state).toEqual({ calls: step + 1 });
    }
  });
});
