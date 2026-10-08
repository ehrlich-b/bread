import { describe, expect, it } from 'vitest';
import type { CircuitJSON } from './ir';
import { flattenCircuit, loadCircuit } from './loader';
import './primitives/index';

const minimal = (overrides: Partial<CircuitJSON> = {}): CircuitJSON => ({
  version: 1,
  kind: 'circuit',
  name: 't',
  components: [],
  nets: [],
  ...overrides,
});

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

describe('loadCircuit (happy path)', () => {
  it('produces a runtime graph with components, nets, and indexes', () => {
    const g = loadCircuit(nandLatch);
    expect(g.components).toHaveLength(2);
    expect(g.nets).toHaveLength(4);
    expect(g.componentById.get('g1')).toBe(0);
    expect(g.componentById.get('g2')).toBe(1);
    expect(g.netById.get('n_Q')).toBeDefined();
  });

  it('classifies pins into inputPinIdx and outputPinIdx by direction', () => {
    const g = loadCircuit(nandLatch);
    const g1 = g.components[0]!;
    expect(g1.pins.map((p) => p.name)).toEqual(['A', 'B', 'Y']);
    expect(g1.inputPinIdx).toEqual([0, 1]);
    expect(g1.outputPinIdx).toEqual([2]);
  });

  it('records each net driver and listener exactly once', () => {
    const g = loadCircuit(nandLatch);
    const nQ = g.nets[g.netById.get('n_Q')!]!;
    expect(nQ.drivers).toEqual([{ comp: 0, outIdx: 0 }]);
    expect(nQ.listenerComps).toEqual([1]);

    const nS = g.nets[g.netById.get('n_S')!]!;
    expect(nS.drivers).toEqual([]);
    expect(nS.listenerComps).toEqual([0]);
  });

  it('sets initial outputBuf to Z and net.value to X', () => {
    const g = loadCircuit(nandLatch);
    expect(g.components[0]!.outputBuf).toEqual(['Z']);
    expect(g.nets.every((n) => n.value === 'X')).toBe(true);
    expect(g.nets.every((n) => n.forced === 'Z')).toBe(true);
  });

  it('keeps the public net values and byte storage as a single four-state view', () => {
    const g = loadCircuit(nandLatch);
    expect(g.netValues).toBeInstanceOf(Uint8Array);
    expect([...g.netValues]).toEqual([3, 3, 3, 3]);
    const net = g.nets[0]!;
    const values = [0, 1, 'Z', 'X'] as const;
    for (let byte = 0; byte < values.length; byte++) {
      net.value = values[byte]!;
      expect(g.netValues[0]).toBe(byte);
      g.netValues[0] = (byte + 1) % values.length;
      expect(net.value).toBe(values[(byte + 1) % values.length]);
    }
  });
});

describe('loadCircuit (errors)', () => {
  it('rejects unsupported version', () => {
    expect(() => loadCircuit({ ...minimal(), version: 99 })).toThrow(/unsupported circuit version/);
  });

  it('rejects kind=composite at the top level', () => {
    expect(() => loadCircuit({ ...minimal(), kind: 'composite' })).toThrow(/loadCircuit requires kind="circuit"/);
  });

  it('rejects unknown component types', () => {
    expect(() =>
      loadCircuit(
        minimal({
          components: [{ id: 'u1', type: 'prim.NOPE' }],
          nets: [],
        }),
      ),
    ).toThrow(/unknown component type/);
  });

  it('rejects duplicate component ids', () => {
    expect(() =>
      loadCircuit(
        minimal({
          components: [
            { id: 'u1', type: 'prim.NOT' },
            { id: 'u1', type: 'prim.NOT' },
          ],
          nets: [],
        }),
      ),
    ).toThrow(/duplicate component id/);
  });

  it('rejects net endpoints referencing missing pins', () => {
    expect(() =>
      loadCircuit(
        minimal({
          components: [{ id: 'u1', type: 'prim.NOT' }],
          nets: [{ id: 'n1', endpoints: ['u1.NOPE'] }],
        }),
      ),
    ).toThrow(/has no pin "NOPE"/);
  });

  it('rejects pins on multiple nets', () => {
    expect(() =>
      loadCircuit(
        minimal({
          components: [{ id: 'u1', type: 'prim.NOT' }],
          nets: [
            { id: 'n1', endpoints: ['u1.A'] },
            { id: 'n2', endpoints: ['u1.A'] },
            { id: 'n3', endpoints: ['u1.Y'] },
          ],
        }),
      ),
    ).toThrow(/multiple nets/);
  });

  it('rejects unconnected pins in strict mode', () => {
    expect(() =>
      loadCircuit(
        minimal({
          components: [{ id: 'u1', type: 'prim.NOT' }],
          nets: [{ id: 'n1', endpoints: ['u1.A'] }],
        }),
        { strict: true },
      ),
    ).toThrow(/not connected/);
  });

  it('synthesizes floating nets for unconnected pins by default', () => {
    const graph = loadCircuit(
      minimal({
        components: [{ id: 'u1', type: 'prim.NOT' }],
        nets: [{ id: 'n1', endpoints: ['u1.A'] }],
      }),
    );
    // Expect a floating net for the unwired Y pin.
    expect(graph.netById.has('__floating__u1__Y')).toBe(true);
    // Every pin should now resolve to a real net index.
    for (const comp of graph.components) {
      for (const idx of comp.pinNetIdx) expect(idx).not.toBe(-1);
    }
  });

  it('rejects zero-endpoint nets', () => {
    expect(() =>
      loadCircuit(
        minimal({
          components: [],
          nets: [{ id: 'n1', endpoints: [] }],
        }),
      ),
    ).toThrow(/zero endpoints/);
  });
});

describe('circuit layout validation', () => {
  it.each([{}, null, 'bad', [], [0], [0, 0, 0], ['bad', 0], [0, null], [NaN, 0], [0, Infinity]].map(position => ({ position })))('rejects malformed position $position', ({ position }) => {
    const circuit = minimal({ components: [{ id: 'buf', type: 'prim.BUF', position }] } as unknown as Partial<CircuitJSON>);
    expect(() => loadCircuit(circuit)).toThrow('component buf position: expected [x, y] with finite numbers');
    expect(() => flattenCircuit(circuit)).toThrow('component buf position');
  });

  it.each([null, '90', {}, [], NaN, Infinity].map(rotation => ({ rotation })))('rejects malformed rotation $rotation', ({ rotation }) => {
    const circuit = minimal({ components: [{ id: 'buf', type: 'prim.BUF', rotation }] } as unknown as Partial<CircuitJSON>);
    expect(() => loadCircuit(circuit)).toThrow('component buf rotation: expected a finite number');
  });

  it.each([null, {}, [null], [[0]], [[0, 'bad']], [[0, Infinity]]].map(waypoints => ({ waypoints })))('rejects malformed waypoints $waypoints', ({ waypoints }) => {
    const circuit = minimal({ components: [{ id: 'buf', type: 'prim.BUF' }], nets: [{ id: 'wire', endpoints: ['buf.Y'], waypoints }] } as unknown as Partial<CircuitJSON>);
    expect(() => loadCircuit(circuit)).toThrow('net wire waypoints: expected an array of [x, y] with finite numbers');
  });

  it('accepts omitted layout, finite fractional coordinates and existing rotation normalization', () => {
    const circuit = minimal({
      components: [{ id: 'buf', type: 'prim.BUF', position: [-0.25, 12.5], rotation: -90 }, { id: 'plain', type: 'prim.BUF' }],
      nets: [{ id: 'wire', endpoints: ['buf.Y'], waypoints: [[-5.5, 0.25]] }],
    });
    expect(loadCircuit(circuit).components).toHaveLength(2);
    expect(flattenCircuit(circuit).components).toEqual(circuit.components);
  });
});
