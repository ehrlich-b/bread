import { describe, expect, it } from 'vitest';
import type { NetState } from '../ir';
import { getPrimitive } from './index';

const eval2 = (id: string, a: NetState, b: NetState): NetState => {
  const prim = getPrimitive(id);
  if (!prim) throw new Error(`missing primitive ${id}`);
  return prim.evaluate([a, b], undefined, { inputs: 2 }).outputs[0]!;
};

const eval1 = (id: string, a: NetState): NetState => {
  const prim = getPrimitive(id);
  if (!prim) throw new Error(`missing primitive ${id}`);
  return prim.evaluate([a], undefined, undefined).outputs[0]!;
};

const evalN = (id: string, ins: NetState[]): NetState => {
  const prim = getPrimitive(id);
  if (!prim) throw new Error(`missing primitive ${id}`);
  return prim.evaluate(ins, undefined, { inputs: ins.length }).outputs[0]!;
};

describe('prim.AND', () => {
  it('matches the 2-input truth table', () => {
    expect(eval2('prim.AND', 0, 0)).toBe(0);
    expect(eval2('prim.AND', 0, 1)).toBe(0);
    expect(eval2('prim.AND', 1, 0)).toBe(0);
    expect(eval2('prim.AND', 1, 1)).toBe(1);
  });
  it('lets 0 dominate X', () => {
    expect(eval2('prim.AND', 0, 'X')).toBe(0);
    expect(eval2('prim.AND', 'X', 0)).toBe(0);
  });
  it('returns X when 1 meets X', () => {
    expect(eval2('prim.AND', 1, 'X')).toBe('X');
    expect(eval2('prim.AND', 'X', 1)).toBe('X');
  });
  it('reduces n inputs', () => {
    expect(evalN('prim.AND', [1, 1, 1, 1])).toBe(1);
    expect(evalN('prim.AND', [1, 1, 0, 1])).toBe(0);
    expect(evalN('prim.AND', [1, 'X', 1])).toBe('X');
    expect(evalN('prim.AND', [0, 'X', 1])).toBe(0);
  });
});

describe('prim.OR', () => {
  it('matches the 2-input truth table', () => {
    expect(eval2('prim.OR', 0, 0)).toBe(0);
    expect(eval2('prim.OR', 0, 1)).toBe(1);
    expect(eval2('prim.OR', 1, 0)).toBe(1);
    expect(eval2('prim.OR', 1, 1)).toBe(1);
  });
  it('lets 1 dominate X', () => {
    expect(eval2('prim.OR', 1, 'X')).toBe(1);
    expect(eval2('prim.OR', 'X', 1)).toBe(1);
  });
  it('returns X when 0 meets X', () => {
    expect(eval2('prim.OR', 0, 'X')).toBe('X');
  });
});

describe('prim.NAND', () => {
  it('matches the 2-input truth table', () => {
    expect(eval2('prim.NAND', 0, 0)).toBe(1);
    expect(eval2('prim.NAND', 0, 1)).toBe(1);
    expect(eval2('prim.NAND', 1, 0)).toBe(1);
    expect(eval2('prim.NAND', 1, 1)).toBe(0);
  });
  it('inverts 0-dominance to 1', () => {
    expect(eval2('prim.NAND', 0, 'X')).toBe(1);
    expect(eval2('prim.NAND', 'X', 0)).toBe(1);
  });
  it('returns X when 1 meets X', () => {
    expect(eval2('prim.NAND', 1, 'X')).toBe('X');
  });
});

describe('prim.XOR', () => {
  it('matches the 2-input truth table', () => {
    expect(eval2('prim.XOR', 0, 0)).toBe(0);
    expect(eval2('prim.XOR', 0, 1)).toBe(1);
    expect(eval2('prim.XOR', 1, 0)).toBe(1);
    expect(eval2('prim.XOR', 1, 1)).toBe(0);
  });
  it('returns X for any X input', () => {
    expect(eval2('prim.XOR', 0, 'X')).toBe('X');
    expect(eval2('prim.XOR', 1, 'X')).toBe('X');
  });
  it('parity-reduces n inputs', () => {
    expect(evalN('prim.XOR', [1, 1, 1])).toBe(1);
    expect(evalN('prim.XOR', [1, 1, 1, 1])).toBe(0);
  });
});

describe('prim.NOT', () => {
  it('inverts 0/1 and propagates X', () => {
    expect(eval1('prim.NOT', 0)).toBe(1);
    expect(eval1('prim.NOT', 1)).toBe(0);
    expect(eval1('prim.NOT', 'X')).toBe('X');
  });
});

describe('prim.BUF', () => {
  it('passes through 0/1/X', () => {
    expect(eval1('prim.BUF', 0)).toBe(0);
    expect(eval1('prim.BUF', 1)).toBe(1);
    expect(eval1('prim.BUF', 'X')).toBe('X');
  });
});

describe('pin spec', () => {
  it('names n-input gates A, B, C, ... with output Y', () => {
    const nand = getPrimitive('prim.NAND')!;
    const pins3 = nand.pins({ inputs: 3 });
    expect(pins3.map((p) => p.name)).toEqual(['A', 'B', 'C', 'Y']);
    expect(pins3.map((p) => p.dir)).toEqual(['in', 'in', 'in', 'out']);
  });
  it('rejects fan-in less than 1', () => {
    const nand = getPrimitive('prim.NAND')!;
    expect(() => nand.pins({ inputs: 0 })).toThrow();
  });
});
