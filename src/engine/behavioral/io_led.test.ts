import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './io_led';
import './io_switch';

const switchAndLed = (): CircuitJSON => ({
  version: 1,
  kind: 'circuit',
  name: 'switch_to_led',
  components: [
    { id: 'sw', type: 'io.switch' },
    { id: 'led', type: 'io.led' },
  ],
  nets: [{ id: 'wire', endpoints: ['sw.Y', 'led.A'] }],
});

const ledState = (sim: Simulator): NetState => {
  const idx = sim.graph.componentById.get('led')!;
  return (sim.graph.components[idx]!.state as { value: NetState }).value;
};

describe('io.led', () => {
  it('records the value on its input pin', () => {
    const sim = new Simulator(loadCircuit(switchAndLed()));
    sim.settle();
    // Switch defaults to 0 → LED reads 0.
    expect(ledState(sim)).toBe(0);

    sim.setComponentInput('sw', 'Y', 1);
    sim.settle();
    expect(ledState(sim)).toBe(1);

    sim.setComponentInput('sw', 'Y', 0);
    sim.settle();
    expect(ledState(sim)).toBe(0);
  });

  it('drives no outputs onto the circuit', () => {
    const sim = new Simulator(loadCircuit(switchAndLed()));
    sim.settle();
    sim.setComponentInput('sw', 'Y', 1);
    sim.settle();
    expect(sim.events).toEqual([]);
    expect(sim.readNet('wire')).toBe(1);
  });
});
