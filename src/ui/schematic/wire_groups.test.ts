import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetJSON } from '../../engine/ir';
import sap1 from '../../../examples/ben_eater_8bit.json';
import { groupWires } from './wire_groups';

const circuit = (nets: NetJSON[]): CircuitJSON => ({ version: 1, kind: 'circuit', name: 'bundles', components: [], nets });
const byte = (width = 8, start = 0): NetJSON[] => Array.from({ length: width }, (_, bit) => ({
  id: `bit${bit + start}`, endpoints: [`source.D${bit + start}`, `target.A${bit + start}`],
}));
const ids = (nets: NetJSON[]) => nets.map(net => net.id);

describe('visual wire groups', () => {
  it('groups consecutive bit wires in low-to-high order, including offset pin numbering', () => {
    const nets = byte(4).map((net, bit) => ({ ...net, endpoints: [`source.Q${bit + 1}`, `target.D${bit}`] }));
    const result = groupWires(circuit(nets));
    expect(result.singles).toEqual([]);
    expect(result.groups).toHaveLength(1);
    expect(ids(result.groups[0]!.nets)).toEqual(['bit0', 'bit1', 'bit2', 'bit3']);
    expect(result.groups[0]!.branches).toEqual([
      { endpoints: ['source.Q1', 'source.Q2', 'source.Q3', 'source.Q4'], lanes: [0, 1, 2, 3] },
      { endpoints: ['target.D0', 'target.D1', 'target.D2', 'target.D3'], lanes: [0, 1, 2, 3] },
    ]);
  });

  it('does not group scalar controls, different components or families, reversed bits, shorts or explicit routes', () => {
    for (const nets of [
      [{ id: 'clk', endpoints: ['source.CLK', 'target.CLK'] }, { id: 'reset', endpoints: ['source.RESET', 'target.RESET'] }],
      [{ id: 'a', endpoints: ['source.D0', 'target.A0'] }, { id: 'b', endpoints: ['source.D1', 'other.A1'] }],
      [{ id: 'a', endpoints: ['source.D0', 'target.A0'] }, { id: 'b', endpoints: ['source.Q1', 'target.A1'] }],
      [{ id: 'a', endpoints: ['source.D0', 'target.A1'] }, { id: 'b', endpoints: ['source.D1', 'target.A0'] }],
      [{ id: 'a', endpoints: ['source.D0', 'source.D1', 'target.A0'] }, { id: 'b', endpoints: ['source.D2', 'target.A1'] }],
      byte(2).map(net => ({ ...net, waypoints: [[100, 50] as [number, number]] })),
      [{ id: 'a', endpoints: ['source.D0', 'source.A0'] }, { id: 'b', endpoints: ['source.D1', 'source.A1'] }],
    ]) {
      expect(groupWires(circuit(nets)).groups).toEqual([]);
      expect(groupWires(circuit(nets)).singles).toEqual(nets);
    }
  });

  it('splits at missing bits and leaves isolated bits as individual wires', () => {
    const nets = byte().filter((_, bit) => bit !== 2 && bit !== 6);
    const result = groupWires(circuit(nets));
    expect(result.groups.map(group => ids(group.nets))).toEqual([['bit0', 'bit1'], ['bit3', 'bit4', 'bit5']]);
    expect(ids(result.singles)).toEqual(['bit7']);
  });

  it('keeps a shared byte together with narrower and single-bit fan-out', () => {
    const nets = byte().map((net, bit) => ({ ...net, endpoints: [
      ...net.endpoints, ...(bit < 4 ? [`address.D${bit + 1}`] : []), ...(bit === 3 ? ['led.A'] : []),
    ] }));
    const result = groupWires(circuit(nets));
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.nets).toEqual(nets);
    expect(result.groups[0]!.branches).toContainEqual({ endpoints: ['address.D1', 'address.D2', 'address.D3', 'address.D4'], lanes: [0, 1, 2, 3] });
    expect(result.groups[0]!.branches).toContainEqual({ endpoints: ['led.A'], lanes: [3] });
  });

  it('splits sparse fan-out rather than labelling nonconsecutive taps as a bus', () => {
    const nets = byte(4).map((net, bit) => ({ ...net, endpoints: [...net.endpoints, ...(bit % 2 === 0 ? [`tap.Q${bit}`] : [])] }));
    const branches = groupWires(circuit(nets)).groups[0]!.branches;
    expect(branches).toContainEqual({ endpoints: ['tap.Q0'], lanes: [0] });
    expect(branches).toContainEqual({ endpoints: ['tap.Q2'], lanes: [2] });
  });

  it('is deterministic across net/endpoint reorder, movement, rotation and unrelated edits without mutating JSON', () => {
    const original = circuit(byte());
    const before = structuredClone(original);
    const expected = groupWires(original);
    const reordered = { ...original, components: [{ id: 'source', type: 'prim.COUNTER', position: [200, 100] as [number, number], rotation: 90 }],
      nets: [...original.nets].reverse().map(net => ({ ...net, endpoints: [...net.endpoints].reverse() })) };
    const actual = groupWires(reordered);
    expect(actual.groups.map(group => group.id)).toEqual(expected.groups.map(group => group.id));
    expect(actual.groups.map(group => group.branches)).toEqual(expected.groups.map(group => group.branches));
    const edited = circuit([...original.nets.map((net, bit) => ({ ...net, endpoints: [...net.endpoints, ...(bit === 0 ? ['led.A'] : [])] })),
      { id: 'clock', endpoints: ['clock.Y', 'target.CLK'] }]);
    expect(groupWires(edited).groups[0]!.id).toBe(expected.groups[0]!.id);
    expect(original).toEqual(before);
  });

  it('recomputes splits after wiring edits and restores the same group on undo/reopen', () => {
    const original = circuit(byte());
    const before = groupWires(original);
    const changed = circuit(original.nets.filter(net => net.id !== 'bit4'));
    expect(groupWires(changed).groups.map(group => ids(group.nets))).toEqual([
      ['bit0', 'bit1', 'bit2', 'bit3'], ['bit5', 'bit6', 'bit7'],
    ]);
    expect(groupWires(JSON.parse(JSON.stringify(original)))).toEqual(before);
  });

  it('groups the SAP-1 shared byte, two operand bytes, address and opcode without losing or duplicating nets', () => {
    const result = groupWires(sap1 as CircuitJSON);
    expect(result.groups.map(group => group.nets.length).sort((a, b) => a - b)).toEqual([4, 4, 8, 8, 8]);
    const bus = result.groups.find(group => group.nets[0]!.id === 'bus0')!;
    expect(bus.branches.map(branch => branch.endpoints.length).sort((a, b) => a - b)).toEqual([4, 4, 8, 8, 8, 8, 8, 8]);
    const nets = [...result.singles, ...result.groups.flatMap(group => group.nets)];
    expect(nets).toHaveLength(sap1.nets.length);
    expect(new Set(nets).size).toBe(sap1.nets.length);
    expect(new Set(ids(nets))).toEqual(new Set(ids(sap1.nets)));
  });
});
