import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './gen_555';

const wrap = (freqHz: number): CircuitJSON => ({
  version: 1,
  kind: 'circuit',
  name: 'timer_only',
  components: [{ id: 'u1', type: 'gen.555', params: { freqHz } }],
  nets: [{ id: 'out', endpoints: ['u1.OUT'] }],
});

const collect = (sim: Simulator, ticks: number): NetState[] => {
  const trace: NetState[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.tick();
    trace.push(sim.readNet('out'));
  }
  return trace;
};

describe('gen.555', () => {
  it('produces a 50% duty square wave at the requested frequency', () => {
    // rateHz=4, freqHz=1 → halfPeriod=2 → 2 ticks low, 2 high.
    const sim = new Simulator(loadCircuit(wrap(1)), { rateHz: 4 });
    expect(collect(sim, 8)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it('honors a faster freqHz / rateHz ratio', () => {
    const sim = new Simulator(loadCircuit(wrap(5)), { rateHz: 10 });
    expect(collect(sim, 6)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('clamps halfPeriod to 1 when freqHz exceeds rateHz/2', () => {
    const sim = new Simulator(loadCircuit(wrap(10)), { rateHz: 1 });
    expect(collect(sim, 4)).toEqual([0, 1, 0, 1]);
  });

  it('rejects non-positive freqHz', () => {
    expect(() => new Simulator(loadCircuit(wrap(0)))).toThrow(/freqHz must be positive/);
    expect(() => new Simulator(loadCircuit(wrap(-1)))).toThrow(/freqHz must be positive/);
  });

  it('does not toggle when settle() is called without tick()', () => {
    const sim = new Simulator(loadCircuit(wrap(1)), { rateHz: 4 });
    sim.tick(); sim.tick(); sim.tick();
    expect(sim.readNet('out')).toBe(1);
    for (let i = 0; i < 100; i++) sim.settle();
    expect(sim.readNet('out')).toBe(1);
  });

  it('ignores paused settling when counting the next half-period', () => {
    const sim = new Simulator(loadCircuit(wrap(1)), { rateHz: 1000 });
    sim.settle();
    for (let i = 0; i < 500; i++) sim.settle();
    expect(collect(sim, 499).every(value => value === 0)).toBe(true);
    sim.tick();
    expect(sim.readNet('out')).toBe(1);
  });
});
