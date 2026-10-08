import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasIcarusVerilog, runVerilogImportOracle } from './verilog_oracle';
import { roundTripCorpus, roundTripTestbench } from './verilog_roundtrip';
import { loadCircuit } from '../src/engine/loader';
import { importVerilog } from '../src/engine/verilog_import';
import { exportVerilog } from '../src/engine/verilog';
import { runVerilogOracle } from './verilog_oracle';

it('round trips every bundled example and library type with identical four-state traces', () => {
  const results = roundTripCorpus();
  expect(results.length).toBeGreaterThan(50);
  expect(results.every(r => r.samples === 258 && r.comparisons > 0)).toBe(true);
}, 60_000);

it.each(['full_adder', 'register_bus_4bit', 'sap1_fibonacci', 'sap1_count_up', 'sap1_multiply'])('round trips every net at every %s testbench sample', name => {
  const bench = JSON.parse(readFileSync(`examples/testbenches/${name}.json`, 'utf8'));
  const circuit = JSON.parse(readFileSync(`examples/testbenches/${bench.circuit}`, 'utf8'));
  const result = roundTripTestbench(circuit, bench);
  expect(result.comparisons).toBe(loadCircuit(circuit).nets.length * result.samples);
});

describe.skipIf(!hasIcarusVerilog())('original hand-written Verilog vs imported Bread', () => {
  it('preserves bufif uncertain drives through resolution and re-export', () => {
    const source = `module buffers(input a,en,d, output y,z,lone,low,high,pair);
      bufif1 b(y,a,en); bufif0 c(z,a,en); assign y=d; assign z=d;
      bufif1 f(lone,a,en); bufif1 l(low,a,en); pulldown(low);
      bufif0 h(high,a,en); pullup(high);
      bufif1 p(pair,a,en); bufif0 q(pair,a,en);
    endmodule`;
    const bench = { version: 1, name: 'bufif resolution', inputs: { a: ['a'], en: ['en'], d: ['d'] },
      outputs: { y: ['y'], z: ['z'], lone: ['lone'], low: ['low'], high: ['high'], pair: ['pair'] },
      vectors: [{ drive: { a: 0, en: 'X', d: 0 }, expect: { y: 0, z: 0, lone: 'X', low: 0, high: 'X', pair: 'X' } },
        { drive: { a: 1, en: 'X', d: 1 }, expect: { y: 1, z: 1 } },
        { for: { a: [0, 1, 2, 3], en: [0, 1, 2, 3], d: [0, 1, 2, 3] }, vectors: [{ drive: {
          a: { table: [0, 1, 'X', 'Z'], index: 'a' }, en: { table: [0, 1, 'X', 'Z'], index: 'en' }, d: { table: [0, 1, 'X', 'Z'], index: 'd' },
        } }] }],
    };
    expect(runVerilogImportOracle(source, bench).vectors).toBe(66);
    const circuit = importVerilog(source).circuit;
    expect(exportVerilog(circuit).source).toContain('bufif1 (');
    expect(exportVerilog(circuit).source).toContain('bufif0 (');
    expect(runVerilogOracle(circuit, bench).vectors).toBe(66);
  });
  it.each(['full_adder', 'counter4', 'register8', 'alu4'])('matches %s in Icarus, including X/Z', name => {
    const result = runVerilogImportOracle(readFileSync(`examples/verilog/${name}.v`, 'utf8'), JSON.parse(readFileSync(`examples/verilog/${name}.testbench.json`, 'utf8')));
    expect(result.comparisons).toBeGreaterThan(100);
  });
  it('checks wire direction, X/Z extension, contexts, equality and reductions independently', () => {
    const source = `module expressions(input [3:0] a,b, input en, output [4:0] sum, output [3:0] bus, raw, output same, different, truth, reduced, self_sized, alias_reduction);
      assign sum = a + b;
      assign bus = en ? a : 1'bz;
      assign raw = a;
      assign same = a === b;
      assign different = a != b;
      assign truth = !a || (a && b);
      assign reduced = ~^a;
      assign self_sized = (4'hf + 4'h1) && 8'h1;
      assign alias_reduction = ^~a;
    endmodule`;
    const lanes = (name: string, count: number) => Array.from({ length: count }, (_, i) => `${name}[${i}]`);
    const result = runVerilogImportOracle(source, { version: 1, name: 'Expression semantics', inputs: { a: lanes('a', 4), b: lanes('b', 4), en: ['en'] },
      outputs: { sum: lanes('sum', 5), bus: lanes('bus', 4), raw: lanes('raw', 4), same: ['same'], different: ['different'], truth: ['truth'], reduced: ['reduced'], self_sized: ['self_sized'], alias_reduction: ['alias_reduction'] },
      vectors: [{ drive: { a: 0, b: 0, en: 0 }, expect: { sum: 0, bus: '000Z', raw: 0, same: 1, different: 0, truth: 1, reduced: 1, self_sized: 0, alias_reduction: 1 } }, { for: { a: [0, 1, 2, 3, 4], b: [0, 1, 2, 3, 4], en: [0, 1, 2, 3] }, vectors: [{ drive: {
        a: { table: [0, 15, 'X', 'Z', '01XZ'], index: 'a' }, b: { table: [0, 15, 'X', 'Z', '01XZ'], index: 'b' }, en: { table: [0, 1, 'X', 'Z'], index: 'en' },
      } }] }],
    });
    expect(result.vectors).toBe(101);
  });
});
