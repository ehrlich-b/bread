import { describe, expect, it } from 'vitest';
import type { DriverValue, NetState } from '../ir';
import { counter } from './counter';

const setup = (width: number, preset = false) => {
  const params = { width, preset };
  let state = counter.init!(params);
  return (inputs: NetState[]): DriverValue[] => {
    const outputs = new Array<DriverValue>(width).fill('Z');
    state = counter.evaluate(inputs, outputs, state, params)!;
    return outputs;
  };
};

describe('prim.COUNTER', () => {
  it('wraps a one-bit count and ignores control changes while the clock stays HIGH', () => {
    const tick = setup(1);
    expect(tick([1, 1, 0])).toEqual([1]);
    expect(tick([1, 1, 1])).toEqual([1]);
    tick([1, 0, 0]);
    expect(tick([1, 1, 0])).toEqual([0]);
  });
  it('recovers from unknown preset data with synchronous clear even when other controls are unknown', () => {
    const tick = setup(2, true);
    // EN, CLK, DIR, D0, D1, LD, CLR
    expect(tick([0, 1, 0, 'X', 1, 1, 0])).toEqual(['X', 1]);
    tick(['X', 0, 'X', 'X', 'X', 'X', 1]);
    expect(tick(['X', 1, 'X', 'X', 'X', 'X', 1])).toEqual([0, 0]);
  });
  it('keeps an independent low bit defined when counting an unknown high bit', () => {
    const tick = setup(2, true);
    tick([0, 1, 0, 0, 'X', 1, 0]);
    tick([1, 0, 0, 0, 0, 0, 0]);
    expect(tick([1, 1, 0, 0, 0, 0, 0])).toEqual([1, 'X']);
  });
  it.each([0, -1, 1.5, undefined])('rejects invalid width %s', width => {
    expect(() => counter.init!({ width: width as number })).toThrow(/width/);
  });
});
