import { describe, expect, it } from 'vitest';
import type { DriverValue, NetState } from '../ir';
import { getPrimitive } from './index';

const evalDecoder = (
  bits: number,
  activeLow: boolean,
  inputs: NetState[],
): DriverValue[] => {
  const prim = getPrimitive('prim.DECODER')!;
  const out: DriverValue[] = new Array<DriverValue>(1 << bits).fill('Z');
  prim.evaluate(inputs, out, undefined, { bits, activeLow });
  return out;
};

describe('prim.DECODER', () => {
  it('bits=2 active-high: 4 outputs, one-hot', () => {
    expect(evalDecoder(2, false, [0, 0])).toEqual([1, 0, 0, 0]);
    expect(evalDecoder(2, false, [1, 0])).toEqual([0, 1, 0, 0]);
    expect(evalDecoder(2, false, [0, 1])).toEqual([0, 0, 1, 0]);
    expect(evalDecoder(2, false, [1, 1])).toEqual([0, 0, 0, 1]);
  });

  it('bits=3 active-low (74LS138-style): selected = 0', () => {
    expect(evalDecoder(3, true, [0, 0, 0])).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
    expect(evalDecoder(3, true, [1, 0, 1])).toEqual([1, 1, 1, 1, 1, 0, 1, 1]);
    expect(evalDecoder(3, true, [1, 1, 1])).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
  });

  it('with any address bit X, every output is X', () => {
    expect(evalDecoder(2, false, ['X', 0])).toEqual(['X', 'X', 'X', 'X']);
    expect(evalDecoder(2, false, [1, 'X'])).toEqual(['X', 'X', 'X', 'X']);
    expect(evalDecoder(3, true, [0, 'X', 1])).toEqual([
      'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X',
    ]);
  });

  it('pin spec: A inputs then Y outputs, activeLow flag set on outputs', () => {
    const prim = getPrimitive('prim.DECODER')!;
    const pins = prim.pins({ bits: 2, activeLow: true });
    expect(pins.map((p) => p.name)).toEqual(['A0', 'A1', 'Y0', 'Y1', 'Y2', 'Y3']);
    expect(pins.slice(2).every((p) => p.activeLow === true)).toBe(true);
  });

  it('rejects bits < 1 or bits > 8', () => {
    const prim = getPrimitive('prim.DECODER')!;
    expect(() => prim.pins({ bits: 0, activeLow: false })).toThrow();
    expect(() => prim.pins({ bits: 9, activeLow: false })).toThrow();
  });
});
