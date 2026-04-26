import { describe, expect, it } from 'vitest';
import type { CircuitJSON } from '../ir';
import { loadCircuit } from '../loader';
import { Simulator } from '../sim';
import { getPrimitive } from './index';

const evalSource = (id: string) => {
  const prim = getPrimitive(id);
  if (!prim) throw new Error(`missing primitive ${id}`);
  return prim.evaluate([], undefined, undefined).outputs[0]!;
};

describe('prim.CONST_0 / prim.CONST_1', () => {
  it('drives a constant strong value', () => {
    expect(evalSource('prim.CONST_0')).toBe(0);
    expect(evalSource('prim.CONST_1')).toBe(1);
  });

  it('exposes a single output pin Y', () => {
    const k0 = getPrimitive('prim.CONST_0')!;
    const pins = k0.pins(undefined);
    expect(pins).toEqual([{ name: 'Y', dir: 'out' }]);
  });

  it('settles a circuit immediately', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'const_drive',
      components: [
        { id: 'k1', type: 'prim.CONST_1' },
        { id: 'inv', type: 'prim.NOT' },
      ],
      nets: [
        { id: 'a', endpoints: ['k1.Y', 'inv.A'] },
        { id: 'y', endpoints: ['inv.Y'] },
      ],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.settle();
    expect(sim.readNet('a')).toBe(1);
    expect(sim.readNet('y')).toBe(0);
    expect(sim.events).toEqual([]);
  });
});

describe('prim.PULLUP / prim.PULLDOWN', () => {
  it('drives the weak value H/L', () => {
    expect(evalSource('prim.PULLUP')).toBe('H');
    expect(evalSource('prim.PULLDOWN')).toBe('L');
  });

  it('a pullup alone resolves a net to 1 (logic high)', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'pullup_only',
      components: [
        { id: 'pu', type: 'prim.PULLUP' },
        { id: 'inv', type: 'prim.NOT' },
      ],
      nets: [
        { id: 'a', endpoints: ['pu.Y', 'inv.A'] },
        { id: 'y', endpoints: ['inv.Y'] },
      ],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.settle();
    expect(sim.readNet('a')).toBe(1);
    expect(sim.readNet('y')).toBe(0);
  });

  it('a strong driver overrides a pullup with no contention', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'strong_beats_weak',
      components: [
        { id: 'pu', type: 'prim.PULLUP' },
        { id: 'k0', type: 'prim.CONST_0' },
      ],
      nets: [{ id: 'a', endpoints: ['pu.Y', 'k0.Y'] }],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.settle();
    expect(sim.readNet('a')).toBe(0);
    expect(sim.events).toEqual([]);
  });

  it('a pullup and pulldown together resolve to X without flagging contention', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'weak_fight',
      components: [
        { id: 'pu', type: 'prim.PULLUP' },
        { id: 'pd', type: 'prim.PULLDOWN' },
      ],
      nets: [{ id: 'a', endpoints: ['pu.Y', 'pd.Y'] }],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.settle();
    expect(sim.readNet('a')).toBe('X');
    expect(sim.events.filter((e) => e.kind === 'contention')).toEqual([]);
  });
});

describe('contention reporting', () => {
  it('flags contention when two strong drivers fight', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'strong_fight',
      components: [
        { id: 'k0', type: 'prim.CONST_0' },
        { id: 'k1', type: 'prim.CONST_1' },
      ],
      nets: [{ id: 'bus', endpoints: ['k0.Y', 'k1.Y'] }],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.settle();
    expect(sim.readNet('bus')).toBe('X');
    const contentions = sim.events.filter((e) => e.kind === 'contention');
    expect(contentions.length).toBeGreaterThan(0);
    expect(contentions[0]!.detail).toContain('bus');
  });

  it('does not double-report contention within a single settle', () => {
    const circuit: CircuitJSON = {
      version: 1,
      kind: 'circuit',
      name: 'persistent_contention',
      components: [
        { id: 'k0', type: 'prim.CONST_0' },
        { id: 'k1', type: 'prim.CONST_1' },
      ],
      nets: [{ id: 'bus', endpoints: ['k0.Y', 'k1.Y'] }],
    };
    const sim = new Simulator(loadCircuit(circuit));
    sim.settle();
    const firstCount = sim.events.filter((e) => e.kind === 'contention').length;
    expect(firstCount).toBe(1);
  });
});
