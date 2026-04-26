import { describe, expect, it } from 'vitest';
import { readAsLogic, resolveNet } from './nets';

describe('resolveNet', () => {
  it('returns Z when there are no drivers', () => {
    expect(resolveNet([])).toEqual({ value: 'Z', contention: false });
  });

  it('returns Z when every driver is Z', () => {
    expect(resolveNet(['Z'])).toEqual({ value: 'Z', contention: false });
    expect(resolveNet(['Z', 'Z', 'Z'])).toEqual({ value: 'Z', contention: false });
  });

  it('returns the strong value when one strong + Zs', () => {
    expect(resolveNet([0])).toEqual({ value: 0, contention: false });
    expect(resolveNet([1])).toEqual({ value: 1, contention: false });
    expect(resolveNet(['Z', 0, 'Z'])).toEqual({ value: 0, contention: false });
    expect(resolveNet([1, 'Z'])).toEqual({ value: 1, contention: false });
  });

  it('returns the agreed value when multiple strong drivers all match', () => {
    expect(resolveNet([0, 0, 0])).toEqual({ value: 0, contention: false });
    expect(resolveNet([1, 1])).toEqual({ value: 1, contention: false });
    expect(resolveNet(['Z', 1, 1, 'Z'])).toEqual({ value: 1, contention: false });
  });

  it('returns X with contention=true for conflicting strong drivers', () => {
    expect(resolveNet([0, 1])).toEqual({ value: 'X', contention: true });
    expect(resolveNet([1, 0, 1])).toEqual({ value: 'X', contention: true });
    expect(resolveNet(['Z', 0, 'Z', 1])).toEqual({ value: 'X', contention: true });
  });

  it('returns X with contention=false when X poisons a non-conflicting net', () => {
    expect(resolveNet(['X'])).toEqual({ value: 'X', contention: false });
    expect(resolveNet(['X', 'Z'])).toEqual({ value: 'X', contention: false });
    expect(resolveNet([1, 'X'])).toEqual({ value: 'X', contention: false });
    expect(resolveNet([0, 'X'])).toEqual({ value: 'X', contention: false });
  });

  it('reports contention even if X is also present (strong conflict wins)', () => {
    expect(resolveNet([0, 1, 'X'])).toEqual({ value: 'X', contention: true });
  });

  it('strong drivers override weak drivers', () => {
    expect(resolveNet([0, 'H'])).toEqual({ value: 0, contention: false });
    expect(resolveNet([1, 'L'])).toEqual({ value: 1, contention: false });
    expect(resolveNet(['L', 'L', 1])).toEqual({ value: 1, contention: false });
  });

  it('weak drivers resolve to their strong equivalent when no strong present', () => {
    expect(resolveNet(['H'])).toEqual({ value: 1, contention: false });
    expect(resolveNet(['L'])).toEqual({ value: 0, contention: false });
    expect(resolveNet(['Z', 'H', 'Z'])).toEqual({ value: 1, contention: false });
    expect(resolveNet(['H', 'H'])).toEqual({ value: 1, contention: false });
    expect(resolveNet(['L', 'L', 'L'])).toEqual({ value: 0, contention: false });
  });

  it('conflicting weaks resolve to X without flagging contention', () => {
    expect(resolveNet(['H', 'L'])).toEqual({ value: 'X', contention: false });
  });
});

describe('readAsLogic', () => {
  it('passes 0/1/X through', () => {
    expect(readAsLogic(0)).toBe(0);
    expect(readAsLogic(1)).toBe(1);
    expect(readAsLogic('X')).toBe('X');
  });

  it('translates Z into X', () => {
    expect(readAsLogic('Z')).toBe('X');
  });
});
