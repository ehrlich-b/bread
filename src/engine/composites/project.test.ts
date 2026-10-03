import { describe, expect, it } from 'vitest';
import '../index';
import { getPinsForType } from '../index';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import { Simulator } from '../sim';

export const nand: CircuitJSON = {
  version: 1, kind: 'composite', name: 'user.Nand',
  components: [{ id: 'g', type: 'prim.NAND', params: { inputs: 2 } }],
  nets: [{ id: 'a', endpoints: ['g.A'] }, { id: 'b', endpoints: ['g.B'] }, { id: 'y', endpoints: ['g.Y'] }],
  ports: [{ name: 'A', dir: 'in', internalNet: 'a' }, { name: 'B', dir: 'in', internalNet: 'b' }, { name: 'Y', dir: 'out', internalNet: 'y' }],
};
const project = (definitions: CircuitJSON[] = [nand]): CircuitJSON => ({
  version: 1, kind: 'circuit', name: 'project', definitions,
  components: [{ id: 'n', type: 'user.Nand' }],
  nets: [{ id: 'a', endpoints: ['n.A'] }, { id: 'b', endpoints: ['n.B'] }, { id: 'y', endpoints: ['n.Y'] }],
});
const drive = (sim: Simulator, values: Record<string, NetState>): void => {
  for (const [net, value] of Object.entries(values)) sim.setInput(net, value);
  sim.settle();
};

describe('self-contained project chips', () => {
  it('reopens with identical pins and NAND four-state semantics without global registration', () => {
    const saved = JSON.parse(JSON.stringify(project())) as CircuitJSON;
    const graph = loadCircuit(saved); const sim = new Simulator(graph);
    expect(getPinsForType('user.Nand', {}, saved.definitions)).toEqual([{ name: 'A', dir: 'in' }, { name: 'B', dir: 'in' }, { name: 'Y', dir: 'out' }]);
    for (const [a, b, result] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0], ['Z', 1, 'X'], ['X', 0, 1]] as NetState[][]) {
      drive(sim, { a: a!, b: b! }); expect(sim.readNet('y')).toBe(result);
    }
    expect(getPinsForType('user.Nand')).toBeNull();
    expect(() => loadCircuit({ ...saved, definitions: [] })).toThrow('unknown component type');
    expect(graph.components.map((c) => c.typeId)).toEqual(['prim.NAND']);
  });

  it('handles nested reuse and tied input pins with one port', () => {
    const inv: CircuitJSON = { version: 1, kind: 'composite', name: 'user.Not', components: [{ id: 'n', type: 'user.Nand' }], nets: [{ id: 'input', endpoints: ['n.A', 'n.B'] }, { id: 'output', endpoints: ['n.Y'] }], ports: [{ name: 'A', dir: 'in', internalNet: 'input' }, { name: 'Y', dir: 'out', internalNet: 'output' }] };
    const json: CircuitJSON = { ...project([nand, inv]), components: [{ id: 'n', type: 'user.Not' }], nets: [{ id: 'a', endpoints: ['n.A'] }, { id: 'y', endpoints: ['n.Y'] }] };
    const graph = loadCircuit(json); const sim = new Simulator(graph);
    drive(sim, { a: 0 }); expect(sim.readNet('y')).toBe(1);
    drive(sim, { a: 1 }); expect(sim.readNet('y')).toBe(0);
    expect(graph.components[0]!.id).toBe('n__n__g');
  });

  it('preserves clock edges, hold and asynchronous clear through a user chip', () => {
    const pins = ['D', 'CLK', '/CLR', 'Q', 'Qn'];
    const dff: CircuitJSON = { version: 1, kind: 'composite', name: 'user.Register', components: [{ id: 'f', type: 'prim.DFF', params: { clrActiveLow: true } }], nets: pins.map((p, i) => ({ id: `n${i}`, endpoints: [`f.${p}`] })), ports: pins.map((p, i) => ({ name: p === '/CLR' ? 'CLR' : p, dir: i < 3 ? 'in' : 'out', internalNet: `n${i}` })) };
    const json: CircuitJSON = { version: 1, kind: 'circuit', name: 'storage', definitions: [dff], components: [{ id: 'r', type: dff.name }], nets: dff.ports!.map((p) => ({ id: p.name, endpoints: [`r.${p.name}`] })) };
    const sim = new Simulator(loadCircuit(json));
    drive(sim, { D: 1, CLK: 0, CLR: 0 }); expect(sim.readNet('Q')).toBe(0);
    drive(sim, { CLR: 1, CLK: 1 }); expect(sim.readNet('Q')).toBe(1);
    drive(sim, { D: 0 }); expect(sim.readNet('Q')).toBe(1);
    drive(sim, { CLK: 0 }); drive(sim, { CLK: 1 }); expect(sim.readNet('Q')).toBe(0);
    drive(sim, { CLR: 0 }); expect(sim.readNet('Qn')).toBe(1);
    expect(sim.events.some((e) => e.kind === 'oscillation')).toBe(false);
  });

  it('preserves released, driven and contending tri-state buses', () => {
    const tri: CircuitJSON = { ...nand, name: 'user.Tri', components: [{ id: 'g', type: 'prim.TRISTATE' }], nets: [{ id: 'a', endpoints: ['g.A'] }, { id: 'b', endpoints: ['g.OE'] }, { id: 'y', endpoints: ['g.Y'] }] };
    const json: CircuitJSON = { version: 1, kind: 'circuit', name: 'bus', definitions: [tri], components: [{ id: 'p', type: tri.name }, { id: 'q', type: tri.name }], nets: [{ id: 'pa', endpoints: ['p.A'] }, { id: 'pb', endpoints: ['p.B'] }, { id: 'qa', endpoints: ['q.A'] }, { id: 'qb', endpoints: ['q.B'] }, { id: 'bus', endpoints: ['p.Y', 'q.Y'] }] };
    const sim = new Simulator(loadCircuit(json));
    drive(sim, { pa: 0, qa: 1, pb: 0, qb: 0 }); expect(sim.readNet('bus')).toBe('Z');
    drive(sim, { pb: 1 }); expect(sim.readNet('bus')).toBe(0);
    drive(sim, { qb: 1 }); expect(sim.readNet('bus')).toBe('X');
    drive(sim, { pb: 0 }); expect(sim.readNet('bus')).toBe(1);
  });

  it('rejects duplicate authoring IDs before flattening can hide them', () => {
    const duplicated = { ...project(), components: [{ id: 'same', type: nand.name }, { id: 'same', type: 'prim.BUF' }], nets: [] };
    expect(() => loadCircuit(duplicated)).toThrow('duplicate component id');
    const unused: CircuitJSON = { ...nand, name: 'user.Duplicate', components: [{ id: 'g', type: nand.name }, { id: 'g', type: 'prim.BUF' }] };
    expect(() => loadCircuit(project([nand, unused]))).toThrow('duplicate component id');
  });

  it('rejects duplicate names, broken ports, aliases, cycles and incompatible versions even in unused chips', () => {
    expect(() => loadCircuit(project([nand, nand]))).toThrow('duplicate');
    expect(() => loadCircuit(project([{ ...nand, name: 'ttl.override' }]))).toThrow('user.<name>');
    expect(() => loadCircuit(project([{ ...nand, version: 2 }]))).toThrow('version 1');
    expect(() => loadCircuit(project([{ ...nand, ports: [...nand.ports!, nand.ports![0]!] }]))).toThrow('duplicate port');
    expect(() => loadCircuit(project([{ ...nand, ports: [{ name: 'A', dir: 'in', internalNet: 'absent' }] }]))).toThrow('missing net');
    expect(() => loadCircuit(project([{ ...nand, ports: [{ name: 'A', dir: 'in', internalNet: 'a' }, { name: 'B', dir: 'in', internalNet: 'a' }] }]))).toThrow('share one port');
    const cycle: CircuitJSON = { ...nand, name: 'user.Cycle', components: [{ id: 'g', type: 'user.Cycle' }] };
    expect(() => loadCircuit(project([nand, cycle]))).toThrow('cyclic');
    const broken: CircuitJSON = { ...nand, name: 'user.Broken', nets: [{ id: 'a', endpoints: ['g.UNKNOWN'] }, ...nand.nets.slice(1)] };
    expect(() => loadCircuit(project([nand, broken]))).toThrow('has no pin');
  });
});
