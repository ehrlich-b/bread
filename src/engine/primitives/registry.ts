import type { PrimitiveDef } from '../ir';

const registry = new Map<string, PrimitiveDef<unknown, unknown>>();

export function registerPrimitive<S, P>(id: string, def: PrimitiveDef<S, P>): void {
  if (registry.has(id)) {
    throw new Error(`primitive already registered: ${id}`);
  }
  registry.set(id, def as PrimitiveDef<unknown, unknown>);
}

export function getPrimitive(id: string): PrimitiveDef<unknown, unknown> | undefined {
  return registry.get(id);
}

export function listPrimitives(): string[] {
  return [...registry.keys()].sort();
}
