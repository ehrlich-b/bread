import { describe, expect, it } from 'vitest';
import type { DriverValue, NetState } from '../ir';
import { getPrimitive } from './index';

describe('prim.MUX2', () => {
  it('width=1: pin spec is A0, B0, S, Y0', () => {
    const prim = getPrimitive('prim.MUX2')!;
    const pins = prim.pins({ width: 1 });
    expect(pins.map((p) => p.name)).toEqual(['A0', 'B0', 'S', 'Y0']);
    expect(pins.map((p) => p.dir)).toEqual(['in', 'in', 'in', 'out']);
  });

  it('width=4: pin spec lists all four index pairs', () => {
    const prim = getPrimitive('prim.MUX2')!;
    const pins = prim.pins({ width: 4 });
    expect(pins.map((p) => p.name)).toEqual([
      'A0', 'A1', 'A2', 'A3',
      'B0', 'B1', 'B2', 'B3',
      'S',
      'Y0', 'Y1', 'Y2', 'Y3',
    ]);
  });

  it('rejects width < 1', () => {
    const prim = getPrimitive('prim.MUX2')!;
    expect(() => prim.pins({ width: 0 })).toThrow();
  });

  const mux = (a: NetState, b: NetState, s: NetState): DriverValue => {
    const prim = getPrimitive('prim.MUX2')!;
    return prim.evaluate([a, b, s], undefined, { width: 1 }).outputs[0]!;
  };

  it('selects A when S=0, B when S=1', () => {
    expect(mux(0, 1, 0)).toBe(0);
    expect(mux(0, 1, 1)).toBe(1);
    expect(mux(1, 0, 0)).toBe(1);
    expect(mux(1, 0, 1)).toBe(0);
  });

  it('returns X when S=X and A != B', () => {
    expect(mux(0, 1, 'X')).toBe('X');
    expect(mux(1, 0, 'X')).toBe('X');
  });

  it('returns the agreed value when S=X and A == B', () => {
    expect(mux(1, 1, 'X')).toBe(1);
    expect(mux(0, 0, 'X')).toBe(0);
  });

  it('width=4: routes each bit independently', () => {
    const prim = getPrimitive('prim.MUX2')!;
    const inputs: NetState[] = [
      1, 0, 1, 0, // A bus
      0, 1, 0, 1, // B bus
      1, // S
    ];
    const result = prim.evaluate(inputs, undefined, { width: 4 });
    expect(result.outputs).toEqual([0, 1, 0, 1]);
  });
});

describe('prim.DEMUX2', () => {
  it('width=1: pin spec is A0, S, Y0_0, Y1_0', () => {
    const prim = getPrimitive('prim.DEMUX2')!;
    const pins = prim.pins({ width: 1 });
    expect(pins.map((p) => p.name)).toEqual(['A0', 'S', 'Y0_0', 'Y1_0']);
    expect(pins.map((p) => p.dir)).toEqual(['in', 'in', 'out', 'out']);
  });

  const demux = (a: NetState, s: NetState): [DriverValue, DriverValue] => {
    const prim = getPrimitive('prim.DEMUX2')!;
    const r = prim.evaluate([a, s], undefined, { width: 1 });
    return [r.outputs[0]!, r.outputs[1]!];
  };

  it('routes A to Y0 with Y1=0 when S=0', () => {
    expect(demux(1, 0)).toEqual([1, 0]);
    expect(demux(0, 0)).toEqual([0, 0]);
  });

  it('routes A to Y1 with Y0=0 when S=1', () => {
    expect(demux(1, 1)).toEqual([0, 1]);
    expect(demux(0, 1)).toEqual([0, 0]);
  });

  it('with S=X and A=0, both outputs are 0', () => {
    expect(demux(0, 'X')).toEqual([0, 0]);
  });

  it('with S=X and A=1, both outputs are X', () => {
    expect(demux(1, 'X')).toEqual(['X', 'X']);
  });

  it('width=4: spreads the input bus to one channel', () => {
    const prim = getPrimitive('prim.DEMUX2')!;
    const inputs: NetState[] = [
      1, 0, 1, 1, // A
      1, // S=1 → goes to channel 1
    ];
    const r = prim.evaluate(inputs, undefined, { width: 4 });
    expect(r.outputs).toEqual([0, 0, 0, 0, 1, 0, 1, 1]);
  });
});
