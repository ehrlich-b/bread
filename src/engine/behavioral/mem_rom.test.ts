import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import { Simulator } from '../sim';
import '../primitives/index';
import './mem_rom';
import { decodeWordContents, wordRomDimensions } from './mem_rom';

const circuit = (dataBits: number, contents: string): CircuitJSON => ({
  version: 1, kind: 'circuit', name: 'word-ROM',
  components: [{ id: 'rom', type: 'mem.ROM', params: { addressBits: 2, dataBits, contents } }],
  nets: [
    ...['A0', 'A1', 'SEL'].map((name) => ({ id: name, endpoints: [`rom.${name}`] })),
    ...Array.from({ length: dataBits }, (_, i) => ({ id: `D${i}`, endpoints: [`rom.D${i}`] })),
  ],
});
const read = (sim: Simulator, width: number): NetState[] => Array.from({ length: width }, (_, bit) => sim.readNet(`D${bit}`));
const word = (sim: Simulator, width: number): number => read(sim, width).reduce<number>((sum, bit, i) => {
  expect(bit === 0 || bit === 1).toBe(true);
  return sum + (bit === 1 ? 2 ** i : 0);
}, 0);

describe('word ROM images', () => {
  it('uses hex words, including 29-bit microcode and the unsigned 32nd bit', () => {
    expect([...decodeWordContents('v2.0 raw\n2001\n8802\n10042968', 4, 29)])
      .toEqual([0x2001, 0x8802, 0x10042968, 0]);
    expect([...decodeWordContents('80000000 FFFFFFFF', 2, 32)])
      .toEqual([0x80000000, 0xffffffff]);
  });
  it('accepts inline words, repeat counts and comments; pads unused addresses', () => {
    expect([...decodeWordContents('# image\nv2.0 raw\n2*0xAA, 01 // word2\n', 4, 8)])
      .toEqual([0xaa, 0xaa, 1, 0]);
    expect([...decodeWordContents('2 * 0Xaa, 01', 4, 8)])
      .toEqual([0xaa, 0xaa, 1, 0]);
  });
  it('rejects overflow anywhere, malformed words and invalid repeat counts', () => {
    for (const text of ['00 FF 100', 'FFFF']) expect(() => decodeWordContents(text, 3, 8)).toThrow(/data bits/);
    for (const text of ['5*00', '00 00 00 00', '0*00', '9999999999999999*00']) {
      expect(() => decodeWordContents(text, 3, 8)).toThrow(/exceeds/);
    }
    for (const text of ['v3.0 raw', 'GG', '-1', '1.5*00', '0x', '00 00 Z']) {
      expect(() => decodeWordContents(text, 3, 8)).toThrow(/Bad ROM word/);
    }
  });
  it('bounds memory dimensions and validates labels and contents', () => {
    expect(wordRomDimensions({})).toEqual({ addressBits: 2, dataBits: 1, size: 4 });
    for (const addressBits of [0, 17, 1.5]) expect(() => wordRomDimensions({ addressBits })).toThrow(/addressBits/);
    for (const dataBits of [0, 33, 1.5]) expect(() => wordRomDimensions({ dataBits })).toThrow(/dataBits/);
    expect(() => wordRomDimensions({ bitLabels: ['too', 'many'] })).toThrow(/bitLabels/);
    expect(() => wordRomDimensions({ contents: 123 } as never)).toThrow(/contents/);
  });
});

describe('mem.ROM through scalar four-state nets', () => {
  it('reads distinct full-width words by address after a JSON round trip', () => {
    const json = JSON.parse(JSON.stringify(circuit(32, '80000000 FFFFFFFF 12345678'))) as CircuitJSON;
    const sim = new Simulator(loadCircuit(json, { strict: true }));
    sim.setInput('SEL', 1);
    for (const [address, expected] of [[0, 0x80000000], [1, 0xffffffff], [2, 0x12345678], [3, 0]]) {
      sim.setInput('A0', (address! & 1) as 0 | 1);
      sim.setInput('A1', ((address! >>> 1) & 1) as 0 | 1);
      sim.settle();
      expect(word(sim, 32)).toBe(expected);
    }
  });
  it('releases data when disabled, including at cold start with floating address', () => {
    const sim = new Simulator(loadCircuit(circuit(8, 'FF')));
    sim.setInput('SEL', 0);
    sim.settle();
    expect(read(sim, 8)).toEqual(Array(8).fill('Z'));
    sim.setInput('SEL', 1);
    sim.setInput('A0', 0); sim.setInput('A1', 0); sim.settle();
    expect(word(sim, 8)).toBe(255);
    sim.setInput('SEL', 0); sim.settle();
    expect(read(sim, 8)).toEqual(Array(8).fill('Z'));
  });
  it('keeps unknown address/select deterministic and never mutates the ROM', () => {
    const sim = new Simulator(loadCircuit(circuit(29, '10042968')));
    sim.setInput('SEL', 1); sim.setInput('A1', 0);
    for (const unknown of ['X', 'Z'] as const) {
      sim.setInput('A0', unknown); sim.settle();
      expect(read(sim, 29)).toEqual(Array(29).fill('X'));
    }
    sim.setInput('A0', 0);
    for (const unknown of ['X', 'Z'] as const) {
      sim.setInput('SEL', unknown); sim.settle();
      expect(read(sim, 29)).toEqual(Array(29).fill('X'));
    }
    sim.setInput('SEL', 1); sim.settle();
    expect(word(sim, 29)).toBe(0x10042968);
    expect(sim.events).toEqual([]);
  });
});
