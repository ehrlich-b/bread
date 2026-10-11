// Palette completeness test. PALETTE is a hand-written mirror of the shipped
// registries; this file guards that every shipped type the user is meant to
// drop onto the schematic actually appears there, and that every palette
// entry still points at a real registered type.
//
// Importing the engine has the side-effect of registering all primitives,
// behaviorals, and composites — same as the worker does at startup. Only the
// PALETTE constant and listAllTypes are inspected here; mountPalette is not
// called, so this runs under vitest's node environment with no DOM.

import { describe, expect, it } from 'vitest';
import { listAllTypes, listComposites } from '../../engine';
import { PALETTE } from './index';

describe('palette completeness', () => {
  it('lists every shipped primitive', () => {
    const { primitives } = listAllTypes();
    const inPalette = new Set(PALETTE.map((e) => e.type));
    const missing = primitives.filter((t) => !inPalette.has(t));
    expect(missing).toEqual([]);
  });

  it('lists every shipped behavioral', () => {
    const { behaviorals } = listAllTypes();
    const inPalette = new Set(PALETTE.map((e) => e.type));
    const missing = behaviorals.filter((t) => !inPalette.has(t));
    expect(missing).toEqual([]);
  });

  it('lists every shipped ttl. and mem. composite', () => {
    const { composites } = listAllTypes();
    const inPalette = new Set(PALETTE.map((e) => e.type));
    const shipped = composites.filter((t) => t.startsWith('ttl.') || t.startsWith('mem.'));
    const missing = shipped.filter((t) => !inPalette.has(t));
    expect(missing).toEqual([]);
  });

  it('includes all shipped eater.* composites in the palette', () => {
    const eaterComposite = (t: string): boolean => t.startsWith('eater.');
    const paletteTypes = PALETTE.map((e) => e.type);
    expect(paletteTypes.filter(eaterComposite).sort()).toEqual(listComposites().filter(eaterComposite).sort());
  });

  it('every palette entry points at a real shipped type', () => {
    const { primitives, behaviorals, composites } = listAllTypes();
    const registered = new Set([...primitives, ...behaviorals, ...composites]);
    const stale = PALETTE.filter((e) => !registered.has(e.type)).map(
      (e) => e.type,
    );
    expect(stale).toEqual([]);
  });

  it('every palette entry has a non-empty label and type', () => {
    for (const e of PALETTE) {
      expect(e.type.length, e.label).toBeGreaterThan(0);
      expect(e.label.length, e.type).toBeGreaterThan(0);
    }
  });

  it('exposes ttl.74LS374 in the TTL group', () => {
    const entry = PALETTE.find((e) => e.type === 'ttl.74LS374');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('74LS374');
    expect(entry?.group).toBe('TTL');
  });
});
