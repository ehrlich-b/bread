import { describe, expect, it } from 'vitest';
import type { CircuitJSON } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './io_switch';

const wrap = (): CircuitJSON => ({
  version: 1,
  kind: 'circuit',
  name: 'switch_only',
  components: [{ id: 'sw', type: 'io.switch' }],
  nets: [{ id: 'out', endpoints: ['sw.Y'] }],
});

describe('io.switch', () => {
  it('starts driving 0', () => {
    const sim = new Simulator(loadCircuit(wrap()));
    sim.settle();
    expect(sim.readNet('out')).toBe(0);
  });

  it('drives the value last written via setComponentInput', () => {
    const sim = new Simulator(loadCircuit(wrap()));
    sim.settle();
    sim.setComponentInput('sw', 'Y', 1);
    sim.settle();
    expect(sim.readNet('out')).toBe(1);
    sim.setComponentInput('sw', 'Y', 0);
    sim.settle();
    expect(sim.readNet('out')).toBe(0);
  });

  it('is idempotent: repeating the current value does not re-dirty', () => {
    const sim = new Simulator(loadCircuit(wrap()));
    sim.settle();
    sim.setComponentInput('sw', 'Y', 1);
    sim.settle();
    const stepBefore = sim.step;
    sim.setComponentInput('sw', 'Y', 1);
    sim.settle();
    // settle still increments step exactly once; the point is it shouldn't
    // produce contention or oscillation events.
    expect(sim.step).toBe(stepBefore + 1);
    expect(sim.events).toEqual([]);
  });
});
