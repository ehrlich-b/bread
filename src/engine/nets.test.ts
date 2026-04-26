import { describe, expect, it } from 'vitest';
import { readAsLogic, resolveNet } from './nets';

describe('resolveNet', () => {
  it('returns Z when there are no drivers', () => {
    expect(resolveNet([])).toBe('Z');
  });

  it('returns Z when every driver is Z', () => {
    expect(resolveNet(['Z'])).toBe('Z');
    expect(resolveNet(['Z', 'Z', 'Z'])).toBe('Z');
  });

  it('returns the strong value when one strong + Zs', () => {
    expect(resolveNet([0])).toBe(0);
    expect(resolveNet([1])).toBe(1);
    expect(resolveNet(['Z', 0, 'Z'])).toBe(0);
    expect(resolveNet([1, 'Z'])).toBe(1);
  });

  it('returns the agreed value when multiple strong drivers all match', () => {
    expect(resolveNet([0, 0, 0])).toBe(0);
    expect(resolveNet([1, 1])).toBe(1);
    expect(resolveNet(['Z', 1, 1, 'Z'])).toBe(1);
  });

  it('returns X for conflicting strong drivers', () => {
    expect(resolveNet([0, 1])).toBe('X');
    expect(resolveNet([1, 0, 1])).toBe('X');
    expect(resolveNet(['Z', 0, 'Z', 1])).toBe('X');
  });

  it('returns X when any driver is X', () => {
    expect(resolveNet(['X'])).toBe('X');
    expect(resolveNet(['X', 'Z'])).toBe('X');
    expect(resolveNet([1, 'X'])).toBe('X');
    expect(resolveNet([0, 'X'])).toBe('X');
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
