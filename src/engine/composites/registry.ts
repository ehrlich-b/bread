// Composite registry. Composites are netlists of primitives (and other
// composites). They register at module-load time, mirroring the primitive
// registry. Loader.ts looks here when a component's `type` doesn't resolve
// against the primitive registry.

import type { CircuitJSON } from '../ir';

const registry = new Map<string, CircuitJSON>();

export function registerComposite(typeId: string, json: CircuitJSON): void {
  if (registry.has(typeId)) {
    throw new Error(`composite already registered: ${typeId}`);
  }
  if (json.kind !== 'composite') {
    throw new Error(`composite ${typeId}: expected kind="composite", got "${json.kind}"`);
  }
  if (!json.ports || json.ports.length === 0) {
    throw new Error(`composite ${typeId}: missing ports[]`);
  }
  // Reject duplicate port names so call-site lookups are unambiguous.
  const seen = new Set<string>();
  for (const port of json.ports) {
    if (seen.has(port.name)) {
      throw new Error(`composite ${typeId}: duplicate port "${port.name}"`);
    }
    seen.add(port.name);
  }
  registry.set(typeId, json);
}

export function getComposite(typeId: string): CircuitJSON | undefined {
  return registry.get(typeId);
}

export function listComposites(): string[] {
  return [...registry.keys()].sort();
}
