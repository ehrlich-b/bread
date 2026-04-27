// Registry for behavioral components. Same shape as PrimitiveDef — the only
// runtime distinction is intent (state-bearing chips like memory, generators,
// switches, displays) and where they live in the source tree. Both are leaves
// from the loader's perspective: the flatten pass passes them through.

import type { PrimitiveDef } from '../ir';

const registry = new Map<string, PrimitiveDef<unknown, unknown>>();

export function registerBehavioral<S, P>(id: string, def: PrimitiveDef<S, P>): void {
  if (registry.has(id)) {
    throw new Error(`behavioral already registered: ${id}`);
  }
  registry.set(id, def as PrimitiveDef<unknown, unknown>);
}

export function getBehavioral(id: string): PrimitiveDef<unknown, unknown> | undefined {
  return registry.get(id);
}

export function listBehavioral(): string[] {
  return [...registry.keys()].sort();
}
