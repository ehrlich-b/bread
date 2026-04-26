import { describe, expect, it } from 'vitest';
import type { CircuitJSON } from '../ir';
import { loadCircuit } from '../loader';
import { Simulator } from '../sim';
import { getPrimitive } from './index';

describe('prim.LATCH', () => {
  it('exposes D, EN, Q, Qn pins', () => {
    const prim = getPrimitive('prim.LATCH')!;
    const pins = prim.pins(undefined);
    expect(pins.map((p) => p.name)).toEqual(['D', 'EN', 'Q', 'Qn']);
    expect(pins.map((p) => p.dir)).toEqual(['in', 'in', 'out', 'out']);
  });

  it('starts at Q=X / Qn=X', () => {
    const prim = getPrimitive('prim.LATCH')!;
    const init = prim.init?.(undefined);
    expect(init).toEqual({ q: 'X' });
  });

  const circuit: CircuitJSON = {
    version: 1,
    kind: 'circuit',
    name: 'latch_basic',
    components: [{ id: 'l', type: 'prim.LATCH' }],
    nets: [
      { id: 'd', endpoints: ['l.D'] },
      { id: 'en', endpoints: ['l.EN'] },
      { id: 'q', endpoints: ['l.Q'] },
      { id: 'qn', endpoints: ['l.Qn'] },
    ],
  };

  it('is transparent while EN=1', () => {
    const sim = new Simulator(loadCircuit(circuit));
    sim.setInput('en', 1);
    sim.setInput('d', 0);
    sim.settle();
    expect(sim.readNet('q')).toBe(0);
    expect(sim.readNet('qn')).toBe(1);

    sim.setInput('d', 1);
    sim.settle();
    expect(sim.readNet('q')).toBe(1);
    expect(sim.readNet('qn')).toBe(0);
  });

  it('holds the last value when EN drops to 0', () => {
    const sim = new Simulator(loadCircuit(circuit));
    sim.setInput('en', 1);
    sim.setInput('d', 1);
    sim.settle();
    expect(sim.readNet('q')).toBe(1);

    sim.setInput('en', 0);
    sim.setInput('d', 0); // should be ignored while held
    sim.settle();
    expect(sim.readNet('q')).toBe(1);
    expect(sim.readNet('qn')).toBe(0);
  });

  it('with EN=X and D matching stored Q, Q stays defined', () => {
    const sim = new Simulator(loadCircuit(circuit));
    sim.setInput('en', 1);
    sim.setInput('d', 1);
    sim.settle();
    expect(sim.readNet('q')).toBe(1);

    sim.setInput('en', 'X');
    sim.setInput('d', 1);
    sim.settle();
    expect(sim.readNet('q')).toBe(1);
  });

  it('with EN=X and D differing from stored Q, Q goes to X', () => {
    const sim = new Simulator(loadCircuit(circuit));
    sim.setInput('en', 1);
    sim.setInput('d', 1);
    sim.settle();

    sim.setInput('en', 'X');
    sim.setInput('d', 0);
    sim.settle();
    expect(sim.readNet('q')).toBe('X');
    expect(sim.readNet('qn')).toBe('X');
  });
});
