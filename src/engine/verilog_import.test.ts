import { describe, expect, it } from 'vitest';
import { importVerilog } from './verilog_import';
import { exportVerilog } from './verilog';
import { loadCircuit } from './loader';
import { Simulator } from './sim';
import type { NetState } from './ir';

const simulate = (source: string): Simulator => new Simulator(loadCircuit(importVerilog(source).circuit));
const set = (sim: Simulator, values: Record<string, NetState>): void => {
  for (const [net, value] of Object.entries(values)) sim.setInput(net, value);
  sim.settle();
};

describe('structural Verilog import', () => {
  it('imports primitive gates, named/positional hierarchy, classic ports and ANSI vectors', () => {
    const source = `module nand2(a,b,y); input a,b; output y; nand gate(y,a,b); endmodule
      module main(input [1:0] a, output [1:0] y);
        nand2 first(.a(a[0]),.b(a[1]),.y(y[0])); nand2 second(a[0], a[1], y[1]); endmodule`;
    const imported = importVerilog(source);
    expect(imported.topModule).toBe('main'); expect(imported.circuit.definitions).toHaveLength(1);
    expect(imported.circuit.definitions![0]!.ports!.map(p => p.name)).toEqual(['a', 'b', 'y']);
    const sim = new Simulator(loadCircuit(imported.circuit));
    set(sim, { 'a[0]': 1, 'a[1]': 1 }); expect(sim.readNet('y[0]')).toBe(0); expect(sim.readNet('y[1]')).toBe(0);
    set(sim, { 'a[0]': 0, 'a[1]': 'X' }); expect(sim.readNet('y[0]')).toBe(1);
    for (const json of [imported.circuit, ...imported.circuit.definitions!]) for (const c of json.components) expect(c.position!.every(Number.isFinite)).toBe(true);
  });
  it('preserves four-state wire assignment, bitwise gates, conditional Z and contention', () => {
    const sim = simulate(`module main(input a,b,en, output raw,y, inout bus);
      assign raw = a; assign y = (a & b) | (~a ^ b); assign bus = en ? a : 1'bz; endmodule`);
    set(sim, { a: 'Z', b: 0, en: 0 }); expect(sim.readNet('raw')).toBe('Z'); expect(sim.readNet('y')).toBe('X'); expect(sim.readNet('bus')).toBe('Z');
    set(sim, { a: 1, b: 0, en: 1, bus: 0 }); expect(sim.readNet('bus')).toBe('X');
    set(sim, { a: 'Z', en: 'X', bus: 'Z' }); expect(sim.readNet('bus')).toBe('Z');
  });
  it('handles concat, both vector directions, slices, constants, width context and reductions', () => {
    const source = `module main(input [0:3] a, output [7:0] y, output parity, output [4:0] sum);
      assign y = {4'hA, a[0:3]}; assign parity = ^a; assign sum = 4'hF + 4'h1; endmodule`;
    const sim = simulate(source); set(sim, { 'a[0]': 1, 'a[1]': 0, 'a[2]': 1, 'a[3]': 0 });
    expect(Array.from({ length: 8 }, (_, i) => sim.readNet(`y[${7 - i}]`)).join('')).toBe('10101010');
    expect(sim.readNet('parity')).toBe(0); expect(sim.readNet('sum[4]')).toBe(1);
  });
  it('maps registers, conditional hold, synchronous reset and Z data to DFFs', () => {
    const imported = importVerilog(`module main(input clk,en,reset, input [1:0] d, output reg [1:0] q = 2'b01);
      always @(posedge clk) begin if (reset) q <= 2'b00; else if (en) q <= d; end endmodule`);
    expect(imported.circuit.components.filter(c => c.type === 'prim.DFF')).toHaveLength(2);
    const sim = new Simulator(loadCircuit(imported.circuit));
    set(sim, { clk: 0, en: 1, reset: 0, 'd[0]': 0, 'd[1]': 'Z' }); set(sim, { clk: 1 });
    expect(sim.readNet('q[1]')).toBe('Z'); expect(sim.readNet('q[0]')).toBe(0);
    set(sim, { clk: 0, en: 'X', 'd[0]': 1 }); set(sim, { clk: 1 }); expect(sim.readNet('q[0]')).toBe(0);
    set(sim, { clk: 0, reset: 1 }); set(sim, { clk: 1 }); expect(sim.readNet('q[1]')).toBe(0);
  });
  it('requires a top for independent modules and validates unused definitions', () => {
    const source = 'module a(input x,output y); assign y=x; endmodule module b(input x,output y); assign y=x; endmodule';
    expect(() => importVerilog(source)).toThrow('ambiguous top'); expect(importVerilog(source, { topModule: 'b' }).topModule).toBe('b');
    expect(() => importVerilog(source, { topModule: 'missing' })).toThrow('unknown top');
    expect(() => importVerilog(source + ' module bad(input x); mystery g(x); endmodule', { topModule: 'a' })).toThrow('unknown module');
  });
  it.each([
    ['parameter N=4;', 'parameter'], ['generate endgenerate', 'generate'], ['initial begin end', 'initial'],
    ['always @* y = a;', '*'], ['always @(negedge a) y <= a;', 'negedge'], ['assign y = a * a;', '*'],
    ['assign #1 y = a;', '#'], ['wire signed [3:0] b;', 'signed'], ['reg [3:0] mem [0:15];', '['],
    ['assign y = missing;', 'undeclared'], ['assign y = a[2];', 'out-of-range'], ['unknown g(y,a);', 'unknown'],
    ['and g(y);', 'port count'], ['always @(posedge a) y <= a;', 'declared reg'],
    ['wire a;', 'duplicate'], ['assign y = f(a);', '('],
  ])('rejects %s with a construct and source position', (body, construct) => {
    expect(() => importVerilog(`module main(input a,output y);\n ${body}\nendmodule`)).toThrow(new RegExp(`Line 2, column \\d+:.*${construct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
  it('rejects macro expansion, malformed comments and excess nesting', () => {
    expect(() => importVerilog('`include "other.v"')).toThrow('Line 1, column 1: unsupported directive');
    expect(() => importVerilog('/*')).toThrow('unterminated block comment');
    expect(() => importVerilog(`module m(output y); assign y=${'('.repeat(70)}1'b0${')'.repeat(70)}; endmodule`)).toThrow('nesting');
    expect(() => importVerilog(`module m(input a,output y); assign y=${Array.from({ length: 70 }, () => 'a').join('+')}; endmodule`)).toThrow('nesting');
    expect(() => importVerilog('module m(output [63:0] y); assign y=2147483648; endmodule')).toThrow('sized unsigned literal');
  });
  it('avoids generated instance/net names and preserves singleton vector lane names', () => {
    const imported = importVerilog(`module m(input [3:3] a, output [3:3] y); wire __expr0; not v0(y[3], ~a[3]); endmodule`);
    expect(new Set(imported.circuit.components.map(c => c.id)).size).toBe(imported.circuit.components.length);
    expect(imported.circuit.ports!.map(p => p.name)).toEqual(['a_3', 'y_3']);
    const sim = new Simulator(loadCircuit(imported.circuit)); set(sim, { 'a[3]': 1 }); expect(sim.readNet('y[3]')).toBe(1);
    expect(() => importVerilog('module m(input a,output y,z); not gate_1(y,a), (z,a); endmodule')).not.toThrow();
  });
  it('checks annotations against every body token and validates recovered pins', () => {
    const source = exportVerilog({ version: 1, kind: 'circuit', name: 'test', components: [{ id: 'zero', type: 'prim.CONST_0' }], nets: [{ id: 'q', endpoints: ['zero.Y'] }] }).source;
    expect(importVerilog(source).circuit.components[0]!.type).toBe('prim.CONST_0');
    expect(() => importVerilog(source.replace("assign n_q = 1'b0;", "assign n_q = 1'b1;"))).toThrow('modified/unsupported bread:cell');
    expect(() => importVerilog(source.replace('// bread:endcell', "assign n_q = 1'b1;\n// bread:endcell"))).toThrow('modified/unsupported bread:cell');
    expect(() => importVerilog(source.replace('"bindings":{"Y":"n_q"}', '"bindings":{"bogus":"n_q"}'))).toThrow('pin bindings');
    expect(() => importVerilog(source.replace('// bread:sources []', '// bread:sources ["n_q"]'))).toThrow('bread:sources');
    const restored = importVerilog(source); expect(restored.nets.n_q).toBe('n_q');
    expect(importVerilog(exportVerilog(restored.circuit).source).circuit.components[0]!.type).toBe('prim.CONST_0');
  });
});
