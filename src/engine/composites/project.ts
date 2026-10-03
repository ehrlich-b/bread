import { getBehavioral } from '../behavioral/registry';
import type { CircuitJSON } from '../ir';
import { getPrimitive } from '../primitives/registry';
import { getComposite } from './registry';

// A library belongs to one file, never to a process-wide mutable registry.
export function projectComposites(json: CircuitJSON): Map<string, CircuitJSON> {
  const definitions = new Map<string, CircuitJSON>();
  for (const def of json.definitions ?? []) {
    if (def.version !== 1 || def.kind !== 'composite') {
      throw new Error(`chip ${def.name}: expected version 1 composite`);
    }
    if (!/^user\.[A-Za-z][A-Za-z0-9_-]*$/.test(def.name)) {
      throw new Error(`chip name "${def.name}" must be user.<name>, starting with a letter`);
    }
    if (definitions.has(def.name) || getComposite(def.name) || getPrimitive(def.name) || getBehavioral(def.name)) {
      throw new Error(`duplicate or reserved chip name: ${def.name}`);
    }
    if (def.definitions?.length) throw new Error(`chip ${def.name}: libraries belong to the project root`);
    if (!def.ports?.length) throw new Error(`chip ${def.name}: add at least one port`);
    const names = new Set<string>();
    const nets = new Set<string>();
    for (const port of def.ports) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(port.name)) {
        throw new Error(`chip ${def.name}: port "${port.name}" must use letters, numbers or underscores`);
      }
      if (names.has(port.name)) throw new Error(`chip ${def.name}: duplicate port "${port.name}"`);
      if (!['in', 'out', 'inout'].includes(port.dir)) throw new Error(`chip ${def.name}: invalid port direction`);
      if (!def.nets.some((n) => n.id === port.internalNet)) {
        throw new Error(`chip ${def.name}: port "${port.name}" references missing net "${port.internalNet}"`);
      }
      if (nets.has(port.internalNet)) {
        throw new Error(`chip ${def.name}: tied pins share one port; net "${port.internalNet}" already has a port`);
      }
      names.add(port.name);
      nets.add(port.internalNet);
    }
    definitions.set(def.name, def);
  }
  return definitions;
}
