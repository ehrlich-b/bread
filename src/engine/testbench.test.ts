import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fullAdder from '../../examples/full_adder.json';
import fullBench from '../../examples/testbenches/full_adder.json';
import type { CircuitJSON } from './ir';
import { parseTestbench, runTestbench, type TestbenchJSON } from './testbench';

const buffer: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'buffer',
  components: [{ id: 'buf', type: 'prim.BUF' }],
  nets: [{ id: 'in', endpoints: ['buf.A'] }, { id: 'out', endpoints: ['buf.Y'] }],
};
const bench = (vectors: TestbenchJSON['vectors']): TestbenchJSON => ({
  version: 1, name: 'Buffer', inputs: { IN: ['in'] }, outputs: { OUT: ['out'], IN: ['in'] }, vectors,
});

describe('testbench schema', () => {
  it('accepts the documented corpus and four-state values, clocks and loops', () => {
    expect(parseTestbench(fullBench).name).toBe('Full adder exhaustive');
    expect(parseTestbench(bench([
      { drive: { IN: 'Z' }, expect: { OUT: '-' }, clock: 'IN' },
      { for: { i: [0, 1] }, vectors: [{ drive: { IN: { var: 'i' } }, expect: { OUT: { table: ['X', 'Z'], index: 'i' } } }] },
      { ticks: 2 }, { wait: { rising: 'OUT', when: { IN: 0 }, maxTicks: 3 } },
    ])).version).toBe(1);
  });

  it.each([
    null,
    { ...bench([{ expect: { OUT: 0 } }]), version: 2 },
    { ...bench([]) },
    { ...bench([{ expect: { OUT: 0 } }]), extra: true },
    { ...bench([{ expect: { OUT: 0 } }]), inputs: { IN: [] } },
    { ...bench([{ expect: { OUT: 0 } }]), outputs: {} },
    bench([{ drive: { IN: '-' }, expect: { OUT: 0 } }]),
    bench([{ expect: { OUT: 'Q' } }]),
    bench([{ ticks: 1.5 }]),
    bench([{ wait: { rising: 'OUT', maxTicks: 0 } }]),
    bench([{ for: { i: { from: -1, to: 2 } }, vectors: [{}] }]),
    bench([{ drive: { IN: { var: 'i', bit: 53 } } }]),
    { ...bench([{ expect: { OUT: 0 } }]), rateHz: 0 },
    { ...bench([{ expect: { OUT: 0 } }]), inputs: { IN: { component: 'buf', pin: 'A' } } },
    { ...bench([{ expect: { OUT: 0 } }]), inputs: { IN: ['in'], BAD: ['in', 3] } },
  ])('rejects malformed files (%#)', value => {
    expect(() => parseTestbench(value)).toThrow();
  });
});

describe('testbench runner', () => {
  it('retains omitted inputs, distinguishes X/Z, and treats only - as don’t-care', () => {
    const result = runTestbench(buffer, bench([
      { drive: { IN: 1 }, expect: { OUT: 1 } },
      { expect: { OUT: 1 } },
      { drive: { IN: 'X' }, expect: { IN: 'X', OUT: 'X' } },
      { drive: { IN: 'Z' }, expect: { IN: 'Z', OUT: 'X' } },
      { expect: { OUT: '-' } },
      { expect: { OUT: 'Z' } },
    ]));
    expect(result.passed).toBe(5);
    expect(result.results[5]).toMatchObject({ vector: 6, passed: false, expected: { OUT: 'Z' }, actual: { OUT: 'X' }, mismatches: ['OUT'] });
  });

  it('uses nested Cartesian ranges with scoped variables and table expectations', () => {
    const result = runTestbench(fullAdder as CircuitJSON, fullBench);
    expect(result.passed).toBe(8);
    expect(result.results.map(result => result.drive)).toEqual([
      { A: '0', B: '0', Cin: '0' }, { A: '1', B: '0', Cin: '0' },
      { A: '0', B: '1', Cin: '0' }, { A: '1', B: '1', Cin: '0' },
      { A: '0', B: '0', Cin: '1' }, { A: '1', B: '0', Cin: '1' },
      { A: '0', B: '1', Cin: '1' }, { A: '1', B: '1', Cin: '1' },
    ]);
    const nested = runTestbench(buffer, bench([{ for: { outer: [0, 1], inner: { from: 0, to: 1 } }, vectors: [
      { drive: { IN: { var: 'inner' } }, expect: { OUT: { var: 'inner' } } },
    ] }]));
    expect(nested.results.map(result => result.actual.OUT)).toEqual(['0', '1', '0', '1']);
    expect(nested.results[3]!.label).toContain('outer=1, inner=1');
  });

  it('pulses 0→1→0 only after the data has settled, and captures the failing settlement', () => {
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'DFF',
      components: [{ id: 'ff', type: 'prim.DFF', params: { clrActiveLow: true, preActiveLow: true } }],
      nets: ['D', 'CLK', '/CLR', '/PRE', 'Q', 'Qn'].map(pin => ({ id: pin, endpoints: [`ff.${pin}`] })),
      probes: [{ id: 'q', label: 'Q', nets: ['Q'] }],
    };
    const input: TestbenchJSON = {
      version: 1, name: 'DFF', inputs: { D: ['D'], CLK: ['CLK'], CLR: ['/CLR'], PRE: ['/PRE'] }, outputs: { Q: ['Q'], CLK: ['CLK'] },
      vectors: [
        { drive: { D: 0, CLK: 0, CLR: 0, PRE: 1 }, expect: { Q: 0 } },
        { drive: { CLR: 1, D: 1 }, clock: 'CLK', expect: { Q: 1, CLK: 0 } },
        { drive: { D: 0 }, expect: { Q: 1 } },
        { clock: 'CLK', expect: { Q: 0 } },
        { expect: { Q: 1 } },
      ],
    };
    const result = runTestbench(circuit, input, { capture: true });
    expect(result.passed).toBe(4);
    expect(result.results[4]).toMatchObject({ vector: 5, passed: false, actual: { Q: '0' } });
    expect(result.waveform!.ticks.at(-1)).toBe(result.results[4]!.step);
    expect(result.waveform!.values.at(-1)).toBe(0);
    expect(result.waveform!.ticks).toHaveLength(12);
  });

  it('advances autonomous clocks only on ticks and finds qualified rising edges with a bounded timeout', () => {
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'Clock', components: [{ id: 'clock', type: 'gen.clock', params: { freqHz: 1 } }],
      nets: [{ id: 'clock', endpoints: ['clock.Y'] }],
    };
    const result = runTestbench(circuit, {
      version: 1, name: 'Clock', rateHz: 4, inputs: {}, outputs: { CLK: ['clock'] }, vectors: [
        { expect: { CLK: 0 } }, { expect: { CLK: 0 } }, { ticks: 1, expect: { CLK: 0 } },
        { wait: { rising: 'CLK', maxTicks: 2 }, expect: { CLK: 1 } },
        { wait: { rising: 'CLK', when: { CLK: 1 }, maxTicks: 8 }, expect: { CLK: '-' } },
      ],
    });
    expect(result.passed).toBe(4);
    expect(result.results[4]!.reason).toBe('No rising CLK edge within 8 ticks');
  });

  it('reports the first wrong vector of a deliberately broken full adder and can continue', () => {
    const broken = structuredClone(fullAdder) as CircuitJSON;
    broken.components.find(component => component.id === 'xor1')!.type = 'prim.OR';
    const result = runTestbench(broken, fullBench);
    expect(result.results).toHaveLength(4);
    expect(result.results[3]).toMatchObject({ vector: 4, drive: { A: '1', B: '1', Cin: '0' }, expected: { Sum: '0', Cout: '1' }, actual: { Sum: '1', Cout: '1' }, mismatches: ['Sum'] });
    const all = runTestbench(broken, fullBench, { stopOnFailure: false });
    expect(all.results).toHaveLength(8);
    expect(all.results.filter(result => !result.passed).map(result => result.vector)).toEqual([4, 8]);
  });

  it('uses MSB-first mixed masks and LSB-first buses, including values above 32 bits', () => {
    const wide: CircuitJSON = { version: 1, kind: 'circuit', name: 'Wide', components: [], nets: [] };
    for (let bit = 0; bit < 40; bit++) {
      wide.components.push({ id: `buf${bit}`, type: 'prim.BUF' });
      wide.nets.push({ id: `in${bit}`, endpoints: [`buf${bit}.A`] }, { id: `out${bit}`, endpoints: [`buf${bit}.Y`] });
    }
    const result = runTestbench(wide, { version: 1, name: 'Wide', inputs: { IN: Array.from({ length: 40 }, (_, i) => `in${i}`) }, outputs: { OUT: Array.from({ length: 40 }, (_, i) => `out${i}`) }, vectors: [
      { drive: { IN: 2 ** 39 + 1 }, expect: { OUT: 2 ** 39 + 1 } },
      { drive: { IN: '10XZ'.repeat(10) }, expect: { OUT: '1-X-'.repeat(10) } },
    ] });
    expect(result.passed).toBe(2);
    expect(result.results[0]!.actual.OUT).toBe(`1${'0'.repeat(38)}1`);
  });

  it('replays an evicted failure into the bounded probe window with the same step and values', () => {
    const probed = { ...buffer, probes: [{ id: 'out', label: 'OUT', nets: ['out'] }] };
    const input = bench([
      { drive: { IN: 1 }, expect: { OUT: 0 } },
      { ticks: 8200, expect: { OUT: 1 } },
    ]);
    const all = runTestbench(probed, input, { capture: true, stopOnFailure: false });
    expect(all.waveform!.ticks).toHaveLength(8192);
    expect(all.waveform!.ticks[0]).toBeGreaterThan(all.results[0]!.step);
    const replay = runTestbench(probed, input, { capture: true, stopOnFailure: false, throughVector: 1 });
    expect(replay.results).toEqual([all.results[0]]);
    expect(replay.waveform!.ticks.at(-1)).toBe(all.results[0]!.step);
    expect(replay.waveform!.values.at(-1)).toBe(1);
    expect(() => runTestbench(buffer, input, { throughVector: 0 })).toThrow('Invalid replay vector');
    expect(() => runTestbench(buffer, input, { throughVector: 3 })).toThrow('Invalid replay vector');
  });

  it.each([
    bench([{ expect: { UNKNOWN: 0 } }]),
    bench([{ drive: { MISSING: 0 }, expect: { OUT: 0 } }]),
    bench([{ drive: { IN: 2 }, expect: { OUT: 0 } }]),
    bench([{ drive: { IN: '01' }, expect: { OUT: 0 } }]),
    bench([{ drive: { IN: { var: 'missing' } }, expect: { OUT: 0 } }]),
    bench([{ for: { i: [2] }, vectors: [{ expect: { OUT: { table: [0], index: 'i' } } }] }]),
    bench([{ for: { i: { from: 2, to: 1 } }, vectors: [{ expect: { OUT: 0 } }] }]),
    bench([{ for: { i: { from: 0, to: 10000 } }, vectors: [{ expect: { OUT: 0 } }] }]),
    bench([{ for: { i: [0, 1], j: { from: 0, to: 9999 } }, vectors: [{ expect: { OUT: 0 } }] }]),
    bench([{ ticks: 1, clock: 'IN', expect: { OUT: 0 } }]),
    bench([{ expect: { OUT: '-' } }]),
    { ...bench([{ expect: { OUT: 0 } }]), inputs: { IN: ['missing'] } },
    { ...bench([{ expect: { OUT: 0 } }]), inputs: { IN: ['in'], DUP: ['in'] } },
    { ...bench([{ expect: { OUT: 0 } }]), inputs: { IN: { component: 'buf', pin: 'Y' } } },
    { ...bench([{ expect: { OUT: 0 } }]), outputs: { OUT: ['missing'] } },
  ])('rejects invalid bindings, values and unbounded expansion (%#)', input => {
    expect(() => runTestbench(buffer, input)).toThrow();
  });
});

describe('bundled declarative testbench corpus', () => {
  it.each([
    ['full_adder', 8], ['register_bus_4bit', 38], ['sap1_fibonacci', 41],
  ])('%s', (name, count) => {
    const benchURL = new URL(`../../examples/testbenches/${name}.json`, import.meta.url);
    const input = parseTestbench(JSON.parse(readFileSync(benchURL, 'utf8')));
    const circuit = JSON.parse(readFileSync(new URL(input.circuit!, benchURL), 'utf8')) as CircuitJSON;
    const original = JSON.stringify(circuit);
    const result = runTestbench(circuit, input);
    expect(result.passed).toBe(count);
    expect(result.results).toHaveLength(count);
    expect(JSON.stringify(circuit)).toBe(original);
  });
});
