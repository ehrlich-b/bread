import { describe, expect, it } from 'vitest';
import type { PrimitiveDef } from '../ir';
import { getBehavioral, listBehavioral, registerBehavioral } from './registry';

const stub: PrimitiveDef<undefined, undefined> = {
  pins: () => [{ name: 'Y', dir: 'out' }],
  evaluate: () => ({ outputs: [0] }),
};

let counter = 0;
const fresh = (): string => `test.behavioral.${counter++}`;

describe('behavioral registry', () => {
  it('registers and looks up by id', () => {
    const id = fresh();
    registerBehavioral(id, stub);
    expect(getBehavioral(id)).toBe(stub);
  });

  it('lists registered ids', () => {
    const id = fresh();
    registerBehavioral(id, stub);
    expect(listBehavioral()).toContain(id);
  });

  it('rejects double registration', () => {
    const id = fresh();
    registerBehavioral(id, stub);
    expect(() => registerBehavioral(id, stub)).toThrow(/already registered/);
  });

  it('returns undefined for unknown ids', () => {
    expect(getBehavioral('does.not.exist')).toBeUndefined();
  });
});
