import { describe, expect, it } from 'vitest';
import type { DriverValue, NetState } from '../ir';
import { getPrimitive } from './index';

const evalAdder = (
  width: number,
  a: NetState[],
  b: NetState[],
  cin: NetState,
): DriverValue[] => {
  const prim = getPrimitive('prim.ADDER')!;
  return prim.evaluate([...a, ...b, cin], undefined, { width }).outputs;
};

describe('prim.ADDER', () => {
  it('pin spec: A bus, B bus, Cin, then S bus + Cout', () => {
    const prim = getPrimitive('prim.ADDER')!;
    const pins = prim.pins({ width: 4 });
    expect(pins.map((p) => p.name)).toEqual([
      'A0', 'A1', 'A2', 'A3',
      'B0', 'B1', 'B2', 'B3',
      'Cin',
      'S0', 'S1', 'S2', 'S3',
      'Cout',
    ]);
  });

  it('rejects width < 1', () => {
    const prim = getPrimitive('prim.ADDER')!;
    expect(() => prim.pins({ width: 0 })).toThrow();
  });

  it('width=1 acts as a single full adder', () => {
    expect(evalAdder(1, [0], [0], 0)).toEqual([0, 0]);
    expect(evalAdder(1, [1], [0], 0)).toEqual([1, 0]);
    expect(evalAdder(1, [1], [1], 0)).toEqual([0, 1]);
    expect(evalAdder(1, [1], [1], 1)).toEqual([1, 1]);
    expect(evalAdder(1, [0], [0], 1)).toEqual([1, 0]);
  });

  it('width=4: 5 + 3 + 0 = 8', () => {
    // 5 = 0101 (LSB first); 3 = 0011; 8 = 1000.
    const r = evalAdder(4, [1, 0, 1, 0], [1, 1, 0, 0], 0);
    expect(r).toEqual([0, 0, 0, 1, 0]);
  });

  it('width=4: 15 + 1 = 16 (carry out)', () => {
    const r = evalAdder(4, [1, 1, 1, 1], [1, 0, 0, 0], 0);
    expect(r).toEqual([0, 0, 0, 0, 1]);
  });

  it('verifies all 256 combinations with Cin=0', () => {
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        const aBits: NetState[] = [0, 1, 2, 3].map((i) => ((a >> i) & 1) as 0 | 1);
        const bBits: NetState[] = [0, 1, 2, 3].map((i) => ((b >> i) & 1) as 0 | 1);
        const r = evalAdder(4, aBits, bBits, 0);
        const expected = a + b;
        let actual = 0;
        for (let i = 0; i < 4; i++) actual += (r[i] as number) << i;
        actual += (r[4] as number) << 4;
        expect(actual).toBe(expected);
      }
    }
  });

  it('carry can stay defined when A=B=1 even if Cin is X', () => {
    const r = evalAdder(1, [1], [1], 'X');
    // S = 1 XOR 1 XOR X = X; Cout = majority(1,1,X) = 1.
    expect(r[0]).toBe('X');
    expect(r[1]).toBe(1);
  });

  it('X bit poisons that sum bit', () => {
    const r = evalAdder(1, ['X'], [0], 0);
    expect(r[0]).toBe('X');
  });
});
