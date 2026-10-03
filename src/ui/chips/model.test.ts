import { describe, expect, it } from 'vitest';
import '../../engine/index';
import type { CircuitJSON } from '../../engine/ir';
import { loadCircuit } from '../../engine/loader';
import { chipSelection, createChip } from './model';

const circuit: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'build', components: [{ id: 'sw', type: 'io.switch' }, { id: 'n', type: 'prim.NAND', params: { inputs: 2 }, position: [200, 100] }, { id: 'led', type: 'io.led' }],
  nets: [{ id: 'input', endpoints: ['sw.Y', 'n.A', 'n.B'] }, { id: 'output', endpoints: ['n.Y', 'led.A'] }],
};
describe('selection to chip', () => {
  it('keeps test apparatus outside, preserves tied inputs and boundary wires, and reuses the result', () => {
    const selection = chipSelection(circuit, new Set(['n']));
    expect(selection.body.ports).toEqual([{ name: 'A', dir: 'in', internalNet: 'input' }, { name: 'Y', dir: 'out', internalNet: 'output' }]);
    const next = createChip(circuit, selection.ids, 'Not', selection.body.ports!);
    expect(next.components.map((c) => c.type)).toEqual(['io.switch', 'io.led', 'user.Not']);
    expect(next.definitions![0]!.components.map((c) => c.id)).toEqual(['n']);
    expect(next.nets.map((n) => n.endpoints)).toEqual([['sw.Y', 'not1.A'], ['led.A', 'not1.Y']]);
    expect(loadCircuit(next).components).toHaveLength(3);
    expect(circuit.components).toHaveLength(3);
  });
  it('exposes free pins and leaves internal wires inside the chip', () => {
    const json: CircuitJSON = { version: 1, kind: 'circuit', name: 'and', components: [{ id: 'a', type: 'prim.NAND', params: { inputs: 2 } }, { id: 'b', type: 'prim.NAND', params: { inputs: 2 } }], nets: [{ id: 'middle', endpoints: ['a.Y', 'b.A', 'b.B'] }] };
    const fragment = chipSelection(json, new Set(['a', 'b']));
    expect(fragment.body.ports!.map((p) => p.name)).toEqual(['A', 'B', 'Y']);
    const next = createChip(json, fragment.ids, 'And', fragment.body.ports!);
    expect(next.nets).toEqual([]);
    expect(next.definitions![0]!.nets.find((n) => n.id === 'middle')!.endpoints).toHaveLength(3);
    expect(loadCircuit(next).components).toHaveLength(2);
  });
  it('preserves draft ports when a whole inner fragment becomes a nested chip', () => {
    const draft: CircuitJSON = { ...circuit, components: [circuit.components[1]!], nets: [{ id: 'input', endpoints: ['n.A', 'n.B'] }, { id: 'output', endpoints: ['n.Y'] }], ports: [{ name: 'A', dir: 'in', internalNet: 'input' }, { name: 'Y', dir: 'out', internalNet: 'output' }] };
    const fragment = chipSelection(draft, new Set(['n']));
    const next = createChip(draft, fragment.ids, 'Inner', fragment.body.ports!);
    expect(next.nets).toEqual([{ id: 'input', endpoints: ['inner1.A'] }, { id: 'output', endpoints: ['inner1.Y'] }]);
    expect(next.ports).toEqual(draft.ports);
    expect(() => loadCircuit(next)).not.toThrow();
  });
});
