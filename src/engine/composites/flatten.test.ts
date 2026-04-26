import { describe, expect, it } from 'vitest';
import type { CircuitJSON } from '../ir';
import { flattenCircuit, loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import { registerComposite } from './registry';

// Test fixtures register one-time at module load. Use unique type ids so
// repeated test runs / reordering don't collide with the global registry.

// `test.flatten.buf2`: a non-inverting buffer built from two NOTs in series.
const buf2: CircuitJSON = {
  version: 1,
  kind: 'composite',
  name: 'test.flatten.buf2',
  components: [
    { id: 'g1', type: 'prim.NOT' },
    { id: 'g2', type: 'prim.NOT' },
  ],
  nets: [
    { id: 'n_in', endpoints: ['g1.A'] },
    { id: 'n_mid', endpoints: ['g1.Y', 'g2.A'] },
    { id: 'n_out', endpoints: ['g2.Y'] },
  ],
  ports: [
    { name: 'IN', dir: 'in', internalNet: 'n_in' },
    { name: 'OUT', dir: 'out', internalNet: 'n_out' },
  ],
};
registerComposite('test.flatten.buf2', buf2);

// `test.flatten.outerBuf`: wraps test.flatten.buf2 to test nesting.
const outerBuf: CircuitJSON = {
  version: 1,
  kind: 'composite',
  name: 'test.flatten.outerBuf',
  components: [{ id: 'inner', type: 'test.flatten.buf2' }],
  nets: [
    { id: 'n_a', endpoints: ['inner.IN'] },
    { id: 'n_y', endpoints: ['inner.OUT'] },
  ],
  ports: [
    { name: 'A', dir: 'in', internalNet: 'n_a' },
    { name: 'Y', dir: 'out', internalNet: 'n_y' },
  ],
};
registerComposite('test.flatten.outerBuf', outerBuf);

// Cyclic pair: A imports B, B imports A.
const cyclicA: CircuitJSON = {
  version: 1,
  kind: 'composite',
  name: 'test.flatten.cyclicA',
  components: [{ id: 'b', type: 'test.flatten.cyclicB' }],
  nets: [
    { id: 'n_in', endpoints: ['b.IN'] },
    { id: 'n_out', endpoints: ['b.OUT'] },
  ],
  ports: [
    { name: 'IN', dir: 'in', internalNet: 'n_in' },
    { name: 'OUT', dir: 'out', internalNet: 'n_out' },
  ],
};
const cyclicB: CircuitJSON = {
  version: 1,
  kind: 'composite',
  name: 'test.flatten.cyclicB',
  components: [{ id: 'a', type: 'test.flatten.cyclicA' }],
  nets: [
    { id: 'n_in', endpoints: ['a.IN'] },
    { id: 'n_out', endpoints: ['a.OUT'] },
  ],
  ports: [
    { name: 'IN', dir: 'in', internalNet: 'n_in' },
    { name: 'OUT', dir: 'out', internalNet: 'n_out' },
  ],
};
registerComposite('test.flatten.cyclicA', cyclicA);
registerComposite('test.flatten.cyclicB', cyclicB);

describe('flattenCircuit', () => {
  it('expands a single composite instance into prefixed primitives', () => {
    const top: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'top',
      components: [
        { id: 'src', type: 'prim.CONST_1' },
        { id: 'U1', type: 'test.flatten.buf2' },
      ],
      nets: [
        { id: 'drive', endpoints: ['src.Y', 'U1.IN'] },
        { id: 'out', endpoints: ['U1.OUT'] },
      ],
    };

    const flat = flattenCircuit(top);
    const ids = flat.components.map((c) => c.id).sort();
    expect(ids).toEqual(['U1__g1', 'U1__g2', 'src']);

    const drive = flat.nets.find((n) => n.id === 'drive')!;
    expect(drive.endpoints).toEqual(['src.Y', 'U1__g1.A']);
    const out = flat.nets.find((n) => n.id === 'out')!;
    expect(out.endpoints).toEqual(['U1__g2.Y']);
    const mid = flat.nets.find((n) => n.id === 'U1__n_mid')!;
    expect(mid.endpoints.sort()).toEqual(['U1__g1.Y', 'U1__g2.A']);
    // Port-internal nets should not appear as separate entries when they
    // were merged into a parent net.
    expect(flat.nets.find((n) => n.id === 'U1__n_in')).toBeUndefined();
    expect(flat.nets.find((n) => n.id === 'U1__n_out')).toBeUndefined();
  });

  it('preserves an unconnected composite output as a composite-internal net', () => {
    const top: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'top',
      components: [
        { id: 'src', type: 'prim.CONST_0' },
        { id: 'U1', type: 'test.flatten.buf2' },
      ],
      // OUT not wired up externally.
      nets: [{ id: 'drive', endpoints: ['src.Y', 'U1.IN'] }],
    };
    const flat = flattenCircuit(top);
    const out = flat.nets.find((n) => n.id === 'U1__n_out')!;
    expect(out).toBeDefined();
    expect(out.endpoints).toEqual(['U1__g2.Y']);
  });

  it('flattens nested composites with double-prefix', () => {
    const top: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'top',
      components: [
        { id: 'src', type: 'prim.CONST_1' },
        { id: 'U1', type: 'test.flatten.outerBuf' },
      ],
      nets: [
        { id: 'drive', endpoints: ['src.Y', 'U1.A'] },
        { id: 'out', endpoints: ['U1.Y'] },
      ],
    };
    const flat = flattenCircuit(top);
    const ids = flat.components.map((c) => c.id).sort();
    expect(ids).toEqual(['U1__inner__g1', 'U1__inner__g2', 'src']);

    const drive = flat.nets.find((n) => n.id === 'drive')!;
    expect(drive.endpoints).toEqual(['src.Y', 'U1__inner__g1.A']);
    const out = flat.nets.find((n) => n.id === 'out')!;
    expect(out.endpoints).toEqual(['U1__inner__g2.Y']);
  });

  it('rejects cyclic composite imports', () => {
    const top: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'top',
      components: [{ id: 'U1', type: 'test.flatten.cyclicA' }],
      nets: [
        { id: 'a', endpoints: ['U1.IN'] },
        { id: 'b', endpoints: ['U1.OUT'] },
      ],
    };
    expect(() => flattenCircuit(top)).toThrow(/cyclic composite import/);
  });

  it('rejects an endpoint referencing an unknown port of the composite', () => {
    const top: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'top',
      components: [{ id: 'U1', type: 'test.flatten.buf2' }],
      nets: [{ id: 'bad', endpoints: ['U1.NOPE'] }],
    };
    expect(() => flattenCircuit(top)).toThrow(/unknown port "NOPE"/);
  });

  it('rejects an unknown component type that is neither primitive nor composite', () => {
    const top: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'top',
      components: [{ id: 'U1', type: 'ttl.bogus_chip' }],
      nets: [],
    };
    expect(() => flattenCircuit(top)).toThrow(/unknown component type: ttl.bogus_chip/);
  });
});

describe('loadCircuit + Simulator (with composite)', () => {
  it('settles a buffer-via-composite to the driven value', () => {
    const top: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'buf_through_composite',
      components: [{ id: 'U1', type: 'test.flatten.buf2' }],
      nets: [
        { id: 'in', endpoints: ['U1.IN'] },
        { id: 'out', endpoints: ['U1.OUT'] },
      ],
    };
    const graph = loadCircuit(top);
    const sim = new Simulator(graph);
    sim.setInput('in', 1);
    sim.settle();
    expect(sim.readNet('out')).toBe(1);
    sim.setInput('in', 0);
    sim.settle();
    expect(sim.readNet('out')).toBe(0);
  });
});
