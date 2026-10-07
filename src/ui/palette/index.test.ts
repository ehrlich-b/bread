import { describe, expect, it } from 'vitest';
import { getPinsForType, listAllTypes } from '../../engine';
import type { CircuitJSON } from '../../engine/ir';
import { loadCircuit } from '../../engine/loader';
import { resolveRenderer } from '../schematic/renderers';
import { PALETTE } from './index';

describe('shipped component palette', () => {
  it('offers every registered type with loadable defaults and all renderer pins', () => {
    const types = listAllTypes();
    const shipped = [...types.primitives, ...types.behaviorals, ...types.composites].sort();
    expect(PALETTE.map(entry => entry.type).sort()).toEqual(shipped);
    for (const entry of PALETTE) {
      const pins = getPinsForType(entry.type, entry.params)!;
      const circuit: CircuitJSON = {
        version: 1, kind: 'circuit', name: entry.type,
        components: [{ id: 'chip', type: entry.type, params: entry.params }],
        nets: pins.map((pin, i) => ({ id: `n${i}`, endpoints: [`chip.${pin.name}`] })),
      };
      expect(loadCircuit(circuit).components.length).toBeGreaterThan(0);
      const renderer = resolveRenderer(entry.type, entry.params);
      expect(renderer, entry.type).not.toBeNull();
      expect(Object.keys(renderer!.pins).sort(), entry.type).toEqual(pins.map(pin => pin.name).sort());
    }
  });
});
