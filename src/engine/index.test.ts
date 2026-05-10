import { describe, expect, it } from 'vitest';
import { getPinsForType, listAllTypes } from './index';

describe('getPinsForType', () => {
  it('returns pins for primitives with required params', () => {
    const pins = getPinsForType('prim.AND', { inputs: 3 });
    expect(pins?.map((p) => p.name)).toEqual(['A', 'B', 'C', 'Y']);
    expect(pins?.[0]?.dir).toBe('in');
    expect(pins?.[3]?.dir).toBe('out');
  });

  it('returns pins for primitives without params', () => {
    const pins = getPinsForType('prim.NOT');
    expect(pins?.map((p) => p.name)).toEqual(['A', 'Y']);
  });

  it('returns pins for source primitives', () => {
    expect(getPinsForType('prim.PULLUP')?.map((p) => p.name)).toEqual(['Y']);
    expect(getPinsForType('prim.CONST_0')?.map((p) => p.name)).toEqual(['Y']);
  });

  it('honors optional DFF flags via params', () => {
    const plain = getPinsForType('prim.DFF');
    expect(plain?.map((p) => p.name)).toEqual(['D', 'CLK', 'Q', 'Qn']);
    const withClr = getPinsForType('prim.DFF', { clrActiveLow: true });
    expect(withClr?.map((p) => p.name)).toEqual(['D', 'CLK', '/CLR', 'Q', 'Qn']);
  });

  it('returns pins for behavioral chips', () => {
    const ls189 = getPinsForType('mem.74LS189');
    expect(ls189?.length).toBe(14); // A0..A3, D0..D3, /Y0../Y3, /CS, /WE
    const names = ls189?.map((p) => p.name) ?? [];
    expect(names).toContain('/CS');
    expect(names).toContain('/WE');
    expect(names).toContain('/Y0');
  });

  it('returns ports for composites, normalized to PinSpec shape', () => {
    const pins = getPinsForType('ttl.74LS00');
    expect(pins).not.toBeNull();
    // 74LS00 quad NAND: 4 NANDs * 3 pins = 12 ports.
    expect(pins?.length).toBe(12);
    const names = pins?.map((p) => p.name) ?? [];
    expect(names).toContain('1A');
    expect(names).toContain('1Y');
    // No internalNet leakage.
    for (const p of pins ?? []) {
      expect(p).not.toHaveProperty('internalNet');
    }
  });

  it('returns null for unknown types', () => {
    expect(getPinsForType('not.a.real.chip')).toBeNull();
  });

  it('throws when required primitive params are missing', () => {
    expect(() => getPinsForType('prim.AND')).toThrow();
  });
});

describe('listAllTypes', () => {
  it('exposes every shipped registry', () => {
    const t = listAllTypes();
    expect(t.primitives).toContain('prim.AND');
    expect(t.primitives).toContain('prim.PULLUP');
    expect(t.behaviorals).toContain('mem.74LS189');
    expect(t.behaviorals).toContain('gen.clock');
    expect(t.composites).toContain('ttl.74LS00');
    expect(t.composites).toContain('ttl.74LS283');
  });
});
