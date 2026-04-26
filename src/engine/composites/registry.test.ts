import { describe, expect, it } from 'vitest';
import type { CircuitJSON } from '../ir';
import { listComposites, registerComposite } from './registry';

const counter = { n: 0 };
const fresh = (): string => `test.unique${counter.n++}`;

const compositeJson = (overrides: Partial<CircuitJSON> = {}): CircuitJSON => ({
  version: 1,
  kind: 'composite',
  name: 'test.fixture',
  components: [{ id: 'g1', type: 'prim.NOT' }],
  nets: [
    { id: 'n_in', endpoints: ['g1.A'] },
    { id: 'n_out', endpoints: ['g1.Y'] },
  ],
  ports: [
    { name: 'A', dir: 'in', internalNet: 'n_in' },
    { name: 'Y', dir: 'out', internalNet: 'n_out' },
  ],
  ...overrides,
});

describe('composite registry', () => {
  it('registers a valid composite and looks it up', () => {
    const id = fresh();
    registerComposite(id, compositeJson());
    expect(listComposites()).toContain(id);
  });

  it('rejects double registration of the same id', () => {
    const id = fresh();
    registerComposite(id, compositeJson());
    expect(() => registerComposite(id, compositeJson())).toThrow(/already registered/);
  });

  it('rejects kind="circuit" (must be composite)', () => {
    expect(() =>
      registerComposite(fresh(), compositeJson({ kind: 'circuit' })),
    ).toThrow(/expected kind="composite"/);
  });

  it('rejects missing or empty ports[]', () => {
    expect(() =>
      registerComposite(fresh(), compositeJson({ ports: undefined })),
    ).toThrow(/missing ports/);
    expect(() =>
      registerComposite(fresh(), compositeJson({ ports: [] })),
    ).toThrow(/missing ports/);
  });

  it('rejects duplicate port names', () => {
    expect(() =>
      registerComposite(
        fresh(),
        compositeJson({
          ports: [
            { name: 'A', dir: 'in', internalNet: 'n_in' },
            { name: 'A', dir: 'out', internalNet: 'n_out' },
          ],
        }),
      ),
    ).toThrow(/duplicate port "A"/);
  });
});
