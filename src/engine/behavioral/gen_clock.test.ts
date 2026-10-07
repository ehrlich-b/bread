import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './gen_clock';
import './io_switch';

const wrap = (freqHz: number): CircuitJSON => ({
  version: 1,
  kind: 'circuit',
  name: 'clock_only',
  components: [{ id: 'clk', type: 'gen.clock', params: { freqHz } }],
  nets: [{ id: 'out', endpoints: ['clk.Y'] }],
});

const collect = (sim: Simulator, ticks: number): NetState[] => {
  const trace: NetState[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.tick();
    trace.push(sim.readNet('out'));
  }
  return trace;
};

describe('gen.clock', () => {
  it('produces a 50% duty square wave with halfPeriod = round(rateHz / freqHz / 2)', () => {
    // rateHz=4, freqHz=1 → halfPeriod=2 → 2 ticks low, 2 high, repeating.
    const sim = new Simulator(loadCircuit(wrap(1)), { rateHz: 4 });
    expect(collect(sim, 8)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it('honors a faster freqHz / rateHz ratio', () => {
    // rateHz=10, freqHz=5 → halfPeriod=1 → toggles every tick.
    const sim = new Simulator(loadCircuit(wrap(5)), { rateHz: 10 });
    expect(collect(sim, 6)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('clamps halfPeriod to 1 when freqHz exceeds rateHz/2', () => {
    // rateHz=1, freqHz=10 → raw halfPeriod = 0 → clamp to 1.
    const sim = new Simulator(loadCircuit(wrap(10)), { rateHz: 1 });
    expect(collect(sim, 4)).toEqual([0, 1, 0, 1]);
  });

  it('rejects non-positive freqHz', () => {
    expect(() => new Simulator(loadCircuit(wrap(0)))).toThrow(/freqHz must be positive/);
    expect(() => new Simulator(loadCircuit(wrap(-1)))).toThrow(/freqHz must be positive/);
  });

  it('does not toggle when settle() is called without tick()', () => {
    const sim = new Simulator(loadCircuit(wrap(1)), { rateHz: 4 });
    sim.tick(); sim.tick(); sim.tick();   // halfPeriod boundary -> Y=1
    expect(sim.readNet('out')).toBe(1);
    for (let i = 0; i < 100; i++) sim.settle();
    expect(sim.readNet('out')).toBe(1);
  });

  it('does not consume clock time when unrelated inputs settle while paused', () => {
    const circuit = wrap(1);
    circuit.components.push({ id: 'sw', type: 'io.switch' });
    circuit.nets.push({ id: 'switch', endpoints: ['sw.Y'] });
    const sim = new Simulator(loadCircuit(circuit), { rateHz: 1000 });
    sim.settle();
    for (let i = 0; i < 500; i++) {
      sim.setComponentInput('sw', 'Y', (i % 2) as NetState);
      sim.settle();
    }
    sim.tick();
    expect(sim.readNet('out')).toBe(0);
    expect(collect(sim, 498).every(value => value === 0)).toBe(true);
    sim.tick();
    expect(sim.readNet('out')).toBe(1);
    for (let i = 0; i < 500; i++) sim.settle();
    expect(collect(sim, 499).every(value => value === 1)).toBe(true);
    sim.tick();
    expect(sim.readNet('out')).toBe(0);
  });
});
