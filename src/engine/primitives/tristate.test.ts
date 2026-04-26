import { describe, expect, it } from 'vitest';
import type { CircuitJSON, DriverValue, NetState } from '../ir';
import { loadCircuit } from '../loader';
import { Simulator } from '../sim';
import { getPrimitive } from './index';

const evalTristate = (
  a: NetState,
  oe: NetState,
  params: { oeActiveLow?: boolean } = {},
): DriverValue => {
  const prim = getPrimitive('prim.TRISTATE')!;
  return prim.evaluate([a, oe], undefined, params).outputs[0]!;
};

describe('prim.TRISTATE', () => {
  it('pin spec defaults to active-high OE', () => {
    const prim = getPrimitive('prim.TRISTATE')!;
    const pins = prim.pins({});
    expect(pins.map((p) => p.name)).toEqual(['A', 'OE', 'Y']);
    expect(pins.map((p) => p.dir)).toEqual(['in', 'in', 'out']);
  });

  it('pin spec uses /OE when oeActiveLow is set', () => {
    const prim = getPrimitive('prim.TRISTATE')!;
    const pins = prim.pins({ oeActiveLow: true });
    expect(pins.map((p) => p.name)).toEqual(['A', '/OE', 'Y']);
  });

  it('passes A through when OE is asserted high', () => {
    expect(evalTristate(0, 1)).toBe(0);
    expect(evalTristate(1, 1)).toBe(1);
  });

  it('drives Z when OE is low (active-high mode)', () => {
    expect(evalTristate(0, 0)).toBe('Z');
    expect(evalTristate(1, 0)).toBe('Z');
  });

  it('drives X when OE is X', () => {
    expect(evalTristate(0, 'X')).toBe('X');
    expect(evalTristate(1, 'X')).toBe('X');
  });

  it('inverts the OE sense when oeActiveLow is set', () => {
    expect(evalTristate(1, 0, { oeActiveLow: true })).toBe(1);
    expect(evalTristate(1, 1, { oeActiveLow: true })).toBe('Z');
  });

  it('passes X through when OE is asserted but A is X', () => {
    expect(evalTristate('X', 1)).toBe('X');
  });

  it('two tristates on a bus: only the enabled one drives', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'two_tri',
      components: [
        { id: 't0', type: 'prim.TRISTATE' },
        { id: 't1', type: 'prim.TRISTATE' },
      ],
      nets: [
        { id: 'a0', endpoints: ['t0.A'] },
        { id: 'a1', endpoints: ['t1.A'] },
        { id: 'oe0', endpoints: ['t0.OE'] },
        { id: 'oe1', endpoints: ['t1.OE'] },
        { id: 'bus', endpoints: ['t0.Y', 't1.Y'] },
      ],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.setInput('a0', 1);
    sim.setInput('a1', 0);
    sim.setInput('oe0', 1);
    sim.setInput('oe1', 0);
    sim.settle();
    expect(sim.readNet('bus')).toBe(1);
    expect(sim.events.filter((e) => e.kind === 'contention')).toEqual([]);

    sim.setInput('oe0', 0);
    sim.setInput('oe1', 1);
    sim.settle();
    expect(sim.readNet('bus')).toBe(0);
  });

  it('two tristates both enabled with conflicting A: contention is flagged', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'tri_fight',
      components: [
        { id: 't0', type: 'prim.TRISTATE' },
        { id: 't1', type: 'prim.TRISTATE' },
      ],
      nets: [
        { id: 'a0', endpoints: ['t0.A'] },
        { id: 'a1', endpoints: ['t1.A'] },
        { id: 'oe', endpoints: ['t0.OE', 't1.OE'] },
        { id: 'bus', endpoints: ['t0.Y', 't1.Y'] },
      ],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.setInput('a0', 0);
    sim.setInput('a1', 1);
    sim.setInput('oe', 1);
    sim.settle();
    expect(sim.readNet('bus')).toBe('X');
    expect(sim.events.filter((e) => e.kind === 'contention').length).toBeGreaterThan(0);
  });
});
