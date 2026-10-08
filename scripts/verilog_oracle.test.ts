import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fullAdder from '../examples/full_adder.json';
import fullBench from '../examples/testbenches/full_adder.json';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import type { TestbenchJSON } from '../src/engine/testbench';
import { getPinsForType, listAllTypes } from '../src/engine/index';
import { exportVerilog } from '../src/engine/verilog';
import { compareVerilogOutput, generateVerilogTestbench, hasIcarusVerilog, ICARUS_SKIP, runVerilogOracle } from './verilog_oracle';

const available = hasIcarusVerilog();
if (!available) console.warn(ICARUS_SKIP);

const single = (type: string, params: Record<string, unknown> = {}): CircuitJSON => ({
  version: 1, kind: 'circuit', name: type,
  components: [{ id: 'device', type, params }],
  nets: getPinsForType(type, params)!.map(pin => ({ id: pin.name, endpoints: [`device.${pin.name}`] })),
});
const lanes = (prefix: string, width: number): string[] => Array.from({ length: width }, (_, i) => `${prefix}${i}`);

describe('Verilog testbench generation', () => {
  it('reuses exhaustive JSON vectors and compares unmasked four-state samples', () => {
    const generated = generateVerilogTestbench(fullAdder as CircuitJSON, fullBench);
    expect(generated.samples).toHaveLength(9);
    expect(generated.bread.passed).toBe(8);
    const stdout = generated.samples.map((sample, i) => `BREAD ${i} ${Object.values(sample.outputs).join(' ').toLowerCase()}`).join('\n');
    expect(compareVerilogOutput(generated, stdout).comparisons).toBe(18);
    expect(() => compareVerilogOutput(generated, stdout.replace('BREAD 2 1 0', 'BREAD 2 x 0'))).toThrow('Sum: bread=1, Verilog=X');
    expect(() => compareVerilogOutput(generated, stdout.replace('BREAD 0', 'BREAD 9'))).toThrow('Malformed');
    expect(() => compareVerilogOutput(generated, '')).toThrow('0/9 samples');
  });
});

describe.skipIf(!available)('Icarus Verilog oracle (optional iverilog/vvp)', () => {
  it.each([
    ['full_adder', 8, 9], ['register_bus_4bit', 38, 90], ['sap1_fibonacci', 41, 3527],
  ])('matches %s after every settlement and tick', (name, vectors, samples) => {
    const bench = JSON.parse(readFileSync(`examples/testbenches/${name}.json`, 'utf8')) as TestbenchJSON;
    const circuit = JSON.parse(readFileSync(`examples/testbenches/${bench.circuit}`, 'utf8')) as CircuitJSON;
    expect(runVerilogOracle(circuit, bench)).toMatchObject({ vectors, samples });
  }, 60_000);

  it('detects a fault in exported Verilog independently of the engine', () => {
    const exported = exportVerilog(fullAdder as CircuitJSON);
    const broken = exported.source.replace(/assign n_sum_out = [^;]+;/, "assign n_sum_out = 1'b0;");
    expect(broken).not.toBe(exported.source);
    expect(() => runVerilogOracle(fullAdder as CircuitJSON, fullBench, { source: broken })).toThrow('Sum: bread=1, Verilog=0');
  });

  it('exhausts all 64 four-state full-adder inputs without masking X or Z', () => {
    const values = ['0', '1', 'X', 'Z'];
    const vectors = values.flatMap(A => values.flatMap(B => values.map(Cin => ({ drive: { A, B, Cin }, expect: { Sum: '-', Cout: '-' } }))));
    const bench = { ...fullBench, vectors: [{ expect: { Sum: 0, Cout: 0 } }, ...vectors] };
    expect(runVerilogOracle(fullAdder as CircuitJSON, bench)).toMatchObject({ vectors: 65, samples: 66, comparisons: 132 });
  });

  it('compiles every shipped chip and compares floating, startup and ticking outputs', () => {
    const types = listAllTypes();
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'library',
      components: [...types.primitives, ...types.behaviorals, ...types.composites].map((type, i) => ({
        id: `c${i}`, type, params: { inputs: 2, width: 2, bits: 2, activeLow: false, freqHz: 1 },
      })), nets: [],
    };
    const graph = loadCircuit(circuit);
    const one = graph.components.find(comp => comp.typeId === 'prim.CONST_1')!;
    const oneNet = graph.nets[one.pinNetIdx[0]!]!.id;
    const outputs = Object.fromEntries(graph.nets.map((net, i) => [`N${i}`, [net.id]]));
    const bench: TestbenchJSON = {
      version: 1, name: 'Library startup', rateHz: 1, inputs: {}, outputs: { ONE: [oneNet], ...outputs },
      vectors: [{ expect: { ONE: 1 } }, { ticks: 2, expect: { ONE: 1 } }],
    };
    expect(runVerilogOracle(circuit, bench).samples).toBe(5);
  }, 60_000);

  it('preserves bidirectional drive resolution through nested chip ports and safe names', () => {
    const inner: CircuitJSON = {
      version: 1, kind: 'composite', name: 'user.Buffer',
      components: [{ id: 'tri!', type: 'prim.TRISTATE' }, { id: 'pull', type: 'prim.PULLUP' }],
      nets: [{ id: 'A', endpoints: ['tri!.A'] }, { id: 'EN', endpoints: ['tri!.OE'] }, { id: 'Y', endpoints: ['tri!.Y', 'pull.Y'] }],
      ports: [{ name: 'A', dir: 'in', internalNet: 'A' }, { name: 'EN', dir: 'in', internalNet: 'EN' }, { name: 'Y', dir: 'inout', internalNet: 'Y' }],
    };
    const outer: CircuitJSON = { ...inner, name: 'user.Outer', components: [{ id: 'b', type: 'user.Buffer' }], nets: inner.nets.map(net => ({ id: net.id, endpoints: [`b.${net.id}`] })) };
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'module', definitions: [inner, outer],
      components: [{ id: 'a-b', type: 'user.Outer' }, { id: 'a_b', type: 'user.Outer' }],
      nets: [{ id: 'a-b', endpoints: ['a-b.A'] }, { id: 'a_b', endpoints: ['a_b.A'] }, { id: 'en1', endpoints: ['a-b.EN'] }, { id: 'en2', endpoints: ['a_b.EN'] }, { id: 'bus', endpoints: ['a-b.Y', 'a_b.Y'] }],
    };
    const bench: TestbenchJSON = {
      version: 1, name: 'Nested tristates', inputs: { A: ['a-b'], B: ['a_b'], E1: ['en1'], E2: ['en2'], EXT: ['bus'] }, outputs: { BUS: ['bus'] },
      vectors: [
        { drive: { A: 0, B: 1, E1: 0, E2: 0 }, expect: { BUS: 1 } },
        { drive: { E1: 1 }, expect: { BUS: 0 } },
        { drive: { E2: 1 }, expect: { BUS: 'X' } },
        { drive: { E1: 0 }, expect: { BUS: 1 } },
        { drive: { E2: 0, EXT: 0 }, expect: { BUS: 0 } },
        { drive: { EXT: 'Z' }, expect: { BUS: 1 } },
        { drive: { E1: 'X' }, expect: { BUS: 'X' } },
      ],
    };
    expect(runVerilogOracle(circuit, bench).vectors).toBe(7);
  });

  it.each(['mem.6116', 'mem.28C16'])('matches %s initialized reads, asynchronous writes, skipped unknown writes and X/Z controls', type => {
    const circuit = single(type, { contents: '020a' });
    const data = lanes(type === 'mem.6116' ? 'DQ' : 'IO', 8);
    const bench: TestbenchJSON = {
      version: 1, name: type, inputs: { A: lanes('A', 11), D: data, CE: ['/CE'], OE: ['/OE'], WE: ['/WE'] }, outputs: { D: data },
      vectors: [
        { drive: { A: 0, D: 'Z', CE: 0, OE: 0, WE: 1 }, expect: { D: 2 } },
        { drive: { A: 1 }, expect: { D: 10 } },
        { drive: { D: 9, WE: 0 }, expect: { D: 9 } },
        { drive: { D: 'Z', WE: 1 }, expect: { D: 9 } },
        { drive: { D: 'X0000001', WE: 0 }, expect: { D: 'X0000001' } },
        { drive: { D: 'Z', WE: 1 }, expect: { D: 9 } },
        { drive: { CE: 1 }, expect: { D: 'Z' } },
        { drive: { CE: 0, OE: 1 }, expect: { D: 'Z' } },
        { drive: { A: 'X', OE: 0 }, expect: { D: 'X' } },
        { drive: { A: 1, WE: 'X' }, expect: { D: 'X' } },
        { drive: { WE: 1 }, expect: { D: 9 } },
      ],
    };
    expect(runVerilogOracle(circuit, bench).vectors).toBe(11);
  });

  it('matches 74LS189 open-collector memory writes with external pull-ups', () => {
    const circuit = single('mem.74LS189');
    for (let i = 0; i < 4; i++) {
      circuit.components.push({ id: `pull${i}`, type: 'prim.PULLUP' });
      circuit.nets.find(net => net.id === `/Y${i}`)!.endpoints.push(`pull${i}.Y`);
    }
    const bench: TestbenchJSON = {
      version: 1, name: '74LS189', inputs: { A: lanes('A', 4), D: lanes('D', 4), CS: ['/CS'], WE: ['/WE'] }, outputs: { Y: lanes('/Y', 4) },
      vectors: [
        { drive: { A: 3, D: 9, CS: 0, WE: 1 }, expect: { Y: 15 } },
        { drive: { WE: 0 }, expect: { Y: 15 } },
        { drive: { WE: 1 }, expect: { Y: 6 } },
        { drive: { WE: 0, D: 'X001' }, expect: { Y: 15 } },
        { drive: { WE: 1 }, expect: { Y: 6 } },
        { drive: { A: 'Z' }, expect: { Y: 'X' } },
        { drive: { CS: 1 }, expect: { Y: 15 } },
        { drive: { CS: 0, A: 3, WE: 'X' }, expect: { Y: 'X' } },
      ],
    };
    expect(runVerilogOracle(circuit, bench).vectors).toBe(8);
  });

  it('matches word ROM lane order, 32-bit images, select and unknown address semantics', () => {
    const circuit = single('mem.ROM', { addressBits: 2, dataBits: 32, contents: '1 ffffffff 80000000 0' });
    const bench: TestbenchJSON = {
      version: 1, name: 'Word ROM', inputs: { A: lanes('A', 2), SEL: ['SEL'] }, outputs: { D: lanes('D', 32) },
      vectors: [
        { drive: { A: 0, SEL: 1 }, expect: { D: 1 } },
        { drive: { A: 1 }, expect: { D: 2 ** 32 - 1 } },
        { drive: { A: 2 }, expect: { D: 2 ** 31 } },
        { drive: { A: 3 }, expect: { D: 0 } },
        { drive: { SEL: 0 }, expect: { D: 'Z' } },
        { drive: { SEL: 'X' }, expect: { D: 'X' } },
        { drive: { SEL: 1, A: 'X' }, expect: { D: 'X' } },
      ],
    };
    expect(runVerilogOracle(circuit, bench).vectors).toBe(7);
  });

  it('matches DFF clear/preset priority, enable, hold and sampling on known clock edges', () => {
    const circuit = single('prim.DFF', { clrActiveLow: true, preActiveLow: true, enable: true });
    const bench: TestbenchJSON = {
      version: 1, name: 'DFF', inputs: { D: ['D'], CLK: ['CLK'], EN: ['EN'], CLR: ['/CLR'], PRE: ['/PRE'] }, outputs: { Q: ['Q'], Qn: ['Qn'] },
      vectors: [
        { drive: { D: 1, CLK: 0, EN: 1, CLR: 0, PRE: 0 }, expect: { Q: 0, Qn: 1 } },
        { drive: { PRE: 1 }, expect: { Q: 0 } },
        { drive: { CLR: 1 }, clock: 'CLK', expect: { Q: 1, Qn: 0 } },
        { drive: { D: 0, EN: 0 }, clock: 'CLK', expect: { Q: 1 } },
        { drive: { EN: 'X' }, clock: 'CLK', expect: { Q: 'X' } },
        { drive: { CLR: 0 }, expect: { Q: 0 } },
        { drive: { CLR: 1 }, expect: { Q: 0 } },
        { drive: { PRE: 0 }, expect: { Q: 1 } },
        { drive: { PRE: 1, EN: 1 }, clock: 'CLK', expect: { Q: 0 } },
        { drive: { D: 'Z' }, clock: 'CLK', expect: { Q: 'X' } },
      ],
    };
    expect(runVerilogOracle(circuit, bench).vectors).toBe(10);
  });

  it('matches latch transparency, hold and agreement under an unknown enable', () => {
    const circuit = single('prim.LATCH');
    const bench: TestbenchJSON = {
      version: 1, name: 'Latch', inputs: { D: ['D'], EN: ['EN'] }, outputs: { Q: ['Q'], Qn: ['Qn'] },
      vectors: [
        { drive: { D: 0, EN: 1 }, expect: { Q: 0, Qn: 1 } },
        { drive: { D: 1 }, expect: { Q: 1, Qn: 0 } },
        { drive: { EN: 0, D: 0 }, expect: { Q: 1 } },
        { drive: { D: 1, EN: 'X' }, expect: { Q: 1 } },
        { drive: { D: 0 }, expect: { Q: 'X' } },
        { drive: { EN: 1, D: 'Z' }, expect: { Q: 'X' } },
      ],
    };
    expect(runVerilogOracle(circuit, bench).vectors).toBe(6);
  });

  it('matches counter wrap, preset/clear priority and per-bit merging for unknown direction', () => {
    const circuit = single('prim.COUNTER', { width: 3, preset: true });
    const bench: TestbenchJSON = {
      version: 1, name: 'Counter', inputs: { EN: ['EN'], CLK: ['CLK'], DIR: ['DIR'], D: lanes('D', 3), LD: ['LD'], CLR: ['CLR'] }, outputs: { Q: lanes('Q', 3) },
      vectors: [
        { drive: { EN: 1, CLK: 0, DIR: 0, D: 2, LD: 1, CLR: 0 }, clock: 'CLK', expect: { Q: 2 } },
        { drive: { DIR: 'X', LD: 0 }, clock: 'CLK', expect: { Q: '0X1' } },
        { drive: { CLR: 1 }, clock: 'CLK', expect: { Q: 0 } },
        { drive: { CLR: 0, DIR: 1 }, clock: 'CLK', expect: { Q: 7 } },
        { drive: { DIR: 0 }, clock: 'CLK', expect: { Q: 0 } },
        { drive: { D: 5, LD: 1, CLR: 1 }, clock: 'CLK', expect: { Q: 0 } },
        { drive: { CLR: 0 }, clock: 'CLK', expect: { Q: 5 } },
        { drive: { LD: 0, EN: 0 }, clock: 'CLK', expect: { Q: 5 } },
      ],
    };
    expect(runVerilogOracle(circuit, bench).vectors).toBe(8);
  });
});
