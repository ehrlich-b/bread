import { describe, expect, it } from 'vitest';
import type { DriverValue } from './ir';
import { loadCircuit } from './loader';
import { resolveNet } from './nets';
import { registerPrimitive } from './primitives/registry';
import { Simulator } from './sim';

registerPrimitive('test.resolution_source', {
  pins: () => [{ name: 'Y', dir: 'out' }],
  evaluate(_inputs, outputs, _state, params: { value: DriverValue }) {
    outputs[0] = params.value;
    return undefined;
  },
});

const values: DriverValue[] = [0, 1, 'Z', 'X', 'L', 'H', '0Z', '1Z'];

describe('single-driver resolution agrees with the full resolver', () => {
  it.each(values)('driver %s with every external force and release', (value) => {
    for (const forced of values) {
      const sim = new Simulator(loadCircuit({
        version: 1, kind: 'circuit', name: 'resolution',
        components: [{ id: 'source', type: 'test.resolution_source', params: { value } }],
        nets: [{ id: 'out', endpoints: ['source.Y'] }],
      }));
      expect(sim.readNet('out')).toBe('X');
      sim.settle();
      expect(sim.readNet('out')).toBe(resolveNet([value]).value);
      expect(sim.events).toEqual([]);
      sim.setInput('out', forced);
      sim.settle();
      const expected = resolveNet([value, forced]);
      expect(sim.readNet('out')).toBe(expected.value);
      expect(sim.events.map((event) => event.kind)).toEqual(expected.contention ? ['contention'] : []);
      sim.setInput('out', 'Z');
      sim.settle();
      expect(sim.readNet('out')).toBe(resolveNet([value]).value);
    }
  });
});
