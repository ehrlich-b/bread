import { describe, expect, it } from 'vitest';
import type { DriverValue, NetState } from '../ir';
import { getPrimitive } from './index';

interface DffState {
  q: NetState;
  prevClk: NetState;
}

const dff = (params: { clrActiveLow?: boolean; preActiveLow?: boolean; initialQ?: 0 | 1 } = {}) => {
  const prim = getPrimitive('prim.DFF')!;
  let state = prim.init!(params) as DffState;
  return {
    pins: prim.pins(params),
    tick(inputs: NetState[]): DriverValue[] {
      const out: DriverValue[] = ['Z', 'Z'];
      const next = prim.evaluate(inputs, out, state, params);
      if (next !== undefined) state = next as DffState;
      return out;
    },
    state: () => state,
  };
};

describe('prim.DFF (basic)', () => {
  it('initializes Q = X', () => {
    const f = dff();
    expect(f.state().q).toBe('X');
  });

  it('captures D on rising clock edge', () => {
    const f = dff();
    // [D, CLK]
    expect(f.tick([1, 0])).toEqual(['X', 'X']); // no edge yet, Q=X stays
    expect(f.tick([1, 1])[0]).toBe(1);          // rising edge, Q := D = 1
    expect(f.tick([0, 1])[0]).toBe(1);          // CLK held high, no edge, Q holds
    expect(f.tick([0, 0])[0]).toBe(1);          // falling edge, Q holds
    expect(f.tick([0, 1])[0]).toBe(0);          // rising edge, Q := 0
  });

  it('drives Qn as the inverse of Q', () => {
    const f = dff();
    f.tick([1, 0]);
    const out = f.tick([1, 1]);
    expect(out).toEqual([1, 0]);
  });

  it('emits X on Qn while Q is X', () => {
    const f = dff();
    const out = f.tick([1, 0]);
    expect(out).toEqual(['X', 'X']);
  });
});

describe('prim.DFF (explicit power-on state)', () => {
  it('preserves unknown startup unless a known value is requested', () => {
    const unknown = dff();
    expect(unknown.tick([1, 1])).toEqual(['X', 'X']);
    expect(dff({ initialQ: 0 }).tick([1, 0])).toEqual([0, 1]);
    expect(dff({ initialQ: 1 }).tick([0, 0])).toEqual([1, 0]);
  });
  it('starts the previous clock LOW for an initialized source-simulator DFF', () => {
    const f = dff({ initialQ: 0 });
    expect(f.tick([1, 1])).toEqual([1, 0]);
    expect(f.tick([0, 1])).toEqual([1, 0]);
    f.tick([0, 0]);
    expect(f.tick([0, 1])).toEqual([0, 1]);
  });
  it('rejects invalid initialization without changing the existing pin layout', () => {
    expect(() => dff({ initialQ: 'X' } as never)).toThrow(/initialQ/);
    expect(dff({ initialQ: 0 }).pins.map((p) => p.name)).toEqual(['D', 'CLK', 'Q', 'Qn']);
  });
});

describe('prim.DFF (async /CLR)', () => {
  it('clears Q immediately when /CLR drops, regardless of clock', () => {
    const f = dff({ clrActiveLow: true });
    expect(f.pins.map((p) => p.name)).toEqual(['D', 'CLK', '/CLR', 'Q', 'Qn']);
    // load Q := 1
    f.tick([1, 0, 1]);
    f.tick([1, 1, 1]);
    expect(f.state().q).toBe(1);
    // assert /CLR
    const out = f.tick([1, 1, 0]);
    expect(out).toEqual([0, 1]);
  });
});

describe('prim.DFF (async /PRE)', () => {
  it('presets Q immediately when /PRE drops', () => {
    const f = dff({ preActiveLow: true });
    expect(f.pins.map((p) => p.name)).toEqual(['D', 'CLK', '/PRE', 'Q', 'Qn']);
    f.tick([0, 0, 1]);
    f.tick([0, 1, 1]);
    expect(f.state().q).toBe(0);
    const out = f.tick([0, 1, 0]);
    expect(out).toEqual([1, 0]);
  });
});

describe('prim.DFF (/CLR beats /PRE)', () => {
  it('treats /CLR as having priority when both are asserted', () => {
    const f = dff({ clrActiveLow: true, preActiveLow: true });
    // [D, CLK, /CLR, /PRE]
    const out = f.tick([1, 0, 0, 0]);
    expect(out).toEqual([0, 1]);
  });
});
