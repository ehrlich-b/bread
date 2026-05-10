// Public engine surface for any caller that wants type introspection (the UI's
// palette, the schematic's pin lookup, future tooling). Importing this module
// has the side effect of registering every shipped primitive, behavioral, and
// composite — same population pass the worker performs — and exposes helpers
// that don't require a Simulator instance.
//
// The registries are per-thread (each module-load gets its own Map), which is
// fine because they're immutable after registration and consultation is
// O(1) hash. The UI doesn't need to round-trip pin layouts through the
// worker; placement and pin-handle rendering stay synchronous.

import './primitives/index';
import './behavioral/index';
import '../stdlib/index';

import { getBehavioral, listBehavioral } from './behavioral/registry';
import { getComposite, listComposites } from './composites/registry';
import type { PinSpec } from './ir';
import { getPrimitive, listPrimitives } from './primitives/registry';

export { listBehavioral, listComposites, listPrimitives };

// Return the pin layout for a chip type without instantiating a Simulator.
// Returns null if the type is unknown. Throws if the type is parameterized
// and required params are missing — that's a caller bug (the palette/instance
// must declare the params it needs).
export const getPinsForType = (
  typeId: string,
  params?: Record<string, unknown>,
): PinSpec[] | null => {
  const prim = getPrimitive(typeId);
  if (prim) return prim.pins(params ?? {});
  const beh = getBehavioral(typeId);
  if (beh) return beh.pins(params ?? {});
  const comp = getComposite(typeId);
  if (comp?.ports) return comp.ports.map((p) => ({ name: p.name, dir: p.dir }));
  return null;
};

// Categorized list of every shipped chip type. Useful for building palette
// groupings and "what's available" probes.
export const listAllTypes = (): {
  primitives: string[];
  behaviorals: string[];
  composites: string[];
} => ({
  primitives: listPrimitives(),
  behaviorals: listBehavioral(),
  composites: listComposites(),
});
