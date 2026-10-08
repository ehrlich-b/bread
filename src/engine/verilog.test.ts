import { describe, expect, it } from 'vitest';
import fullAdder from '../../examples/full_adder.json';
import { getPinsForType, listAllTypes } from './index';
import type { CircuitJSON } from './ir';
import { loadCircuit } from './loader';
import { exportVerilog } from './verilog';

export const libraryCircuit = (): CircuitJSON => {
  const types = listAllTypes();
  return {
    version: 1, kind: 'circuit', name: 'library',
    components: [...types.primitives, ...types.behaviorals, ...types.composites].map((type, i) => ({
      id: `c${i}`, type, params: { inputs: 2, width: 2, bits: 2, activeLow: false, freqHz: 1 },
    })),
    nets: [],
  };
};

describe('Verilog exporter', () => {
  it('is deterministic, preserves the saved circuit and supplies all runtime net paths', () => {
    const circuit = structuredClone(fullAdder) as CircuitJSON;
    const saved = JSON.stringify(circuit);
    const first = exportVerilog(circuit);
    expect(exportVerilog(circuit)).toEqual(first);
    expect(JSON.stringify(circuit)).toBe(saved);
    expect(Object.keys(first.nets).sort()).toEqual(loadCircuit(circuit).nets.map(n => n.id).sort());
    expect(first.sources.map(s => [s.component, s.pin, s.kind])).toEqual([
      ['a', 'Y', 'switch'], ['b', 'Y', 'switch'], ['cin', 'Y', 'switch'],
    ]);
    expect(first.source).toContain('module top_full_adder(');
    expect(first.source).toContain('inout wire n_sum_out');
  });

  it('emits each nested or unused chip once, with independent instance paths and forwarded clocks', () => {
    const inner: CircuitJSON = {
      version: 1, kind: 'composite', name: 'user.Inner',
      components: [{ id: 'timer', type: 'gen.555', params: { freqHz: 2 } }],
      nets: [{ id: 'out', endpoints: ['timer.OUT'] }],
      ports: [{ name: 'Y', dir: 'out', internalNet: 'out' }],
    };
    const outer: CircuitJSON = {
      version: 1, kind: 'composite', name: 'user.Outer',
      components: [{ id: 'child', type: 'user.Inner' }],
      nets: [{ id: 'out', endpoints: ['child.Y'] }], ports: inner.ports,
    };
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'nested', definitions: [inner, outer],
      components: [{ id: 'one', type: 'user.Outer' }, { id: 'two', type: 'user.Outer' }],
      nets: [{ id: 'one', endpoints: ['one.Y'] }, { id: 'two', endpoints: ['two.Y'] }],
    };
    const exported = exportVerilog(circuit);
    expect(exported.source.match(/^module /gm)).toHaveLength(3);
    expect(exported.source.match(/chip_user_Outer u_/g)).toHaveLength(2);
    expect(exported.sources.map(s => s.component)).toEqual(['one__child__timer', 'two__child__timer']);
    expect(exported.nets.one).toBe('u_one.u_child.n_out');
    expect(exported.nets.two).toBe('u_two.u_child.n_out');
    expect(exported.source).toContain('555 analog timing');
    const unused = exportVerilog({ ...circuit, components: [], nets: [] });
    expect(Object.keys(unused.modules).sort()).toEqual(['user.Inner', 'user.Outer']);
  });

  it('uses safe, collision-free identifiers and comments for hostile IDs', () => {
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'module;\nendmodule',
      components: [{ id: 'a-b', type: 'prim.CONST_0' }, { id: 'a_b', type: 'prim.CONST_1' }, { id: '9/λ', type: 'prim.BUF' }],
      nets: [{ id: 'a-b', endpoints: ['a-b.Y', '9/λ.A'] }, { id: 'a_b', endpoints: ['a_b.Y'] }, { id: 'module', endpoints: ['9/λ.Y'] }],
    };
    const exported = exportVerilog(circuit);
    expect(exported.topModule).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(exported.nets['a-b']).toBe('n_a_b');
    expect(exported.nets.a_b).toBe('n_a_b_2');
    expect(exported.source.match(/^endmodule$/gm)).toHaveLength(1);
    expect(exported.source).toContain('"module;\\nendmodule"');
  });

  it('covers every shipped leaf and composite, including floating pins', () => {
    const circuit = libraryCircuit();
    const exported = exportVerilog(circuit);
    expect(exported.source).not.toContain('Unsupported:');
    expect(Object.keys(exported.modules).sort()).toEqual(listAllTypes().composites);
    for (const comp of circuit.components) expect(getPinsForType(comp.type, comp.params)?.length).toBeGreaterThan(0);
    expect(Object.values(exported.nets).every(Boolean)).toBe(true);
    expect(Object.keys(exported.nets).sort()).toEqual(loadCircuit(circuit).nets.map(n => n.id).sort());
    expect(exported.source).toContain('Verilog weak drive strength');
    expect(exported.source).toContain('EEPROM exported as RAM');
    expect(exported.source).toContain('Omitted: visual display');
  });

  it('rejects invalid circuits and cyclic project libraries through engine validation', () => {
    const circuit = structuredClone(fullAdder) as CircuitJSON;
    circuit.components[0]!.type = 'unknown';
    expect(() => exportVerilog(circuit)).toThrow('unknown component type');
    const recursive: CircuitJSON = {
      version: 1, kind: 'composite', name: 'user.Recursive',
      components: [{ id: 'self', type: 'user.Recursive' }],
      nets: [{ id: 'out', endpoints: ['self.Y'] }], ports: [{ name: 'Y', dir: 'out', internalNet: 'out' }],
    };
    expect(() => exportVerilog({ ...fullAdder, definitions: [recursive] } as CircuitJSON)).toThrow('cyclic composite import');
  });
});
