import { getPinsForType } from '../engine';
import type { CircuitJSON, ProbeJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import { runtimeSignalNet } from './inspector/signals';
import { numberedPins } from './signals';

export function pinProbe(circuit: CircuitJSON, endpoint: string, bus: boolean): Omit<ProbeJSON, 'id'> {
  const dot = endpoint.indexOf('.');
  const inst = circuit.components.find(c => c.id === endpoint.slice(0, dot));
  const pin = endpoint.slice(dot + 1);
  if (!inst || !getPinsForType(inst.type, inst.params, circuit.definitions)?.some(p => p.name === pin)) throw new Error(`Unknown pin ${endpoint}`);
  const bundle = bus ? numberedPins(circuit, endpoint) : { endpoints: [endpoint], label: endpoint };
  return { label: bundle.label, nets: bundle.endpoints.map(ep => runtimeSignalNet(circuit, inst, ep.slice(ep.indexOf('.') + 1))) };
}

// Keep probes attached when wiring replaces a floating net or merges two
// nets. Drop a probe whose lanes were deleted; undo restores it with the edit.
export function reconcileProbes(previous: CircuitJSON, next: CircuitJSON): CircuitJSON {
  if (!next.probes?.length) return next;
  const graph = loadCircuit({ ...next, probes: undefined });
  const remapped = new Map<string, string>();
  for (const inst of previous.components) {
    const replacement = next.components.find(c => c.id === inst.id);
    if (!replacement) continue;
    const nextPins = new Set(getPinsForType(replacement.type, replacement.params, next.definitions)?.map(p => p.name));
    for (const pin of getPinsForType(inst.type, inst.params, previous.definitions) ?? []) {
      if (nextPins.has(pin.name)) remapped.set(runtimeSignalNet(previous, inst, pin.name), runtimeSignalNet(next, replacement, pin.name));
    }
  }
  const probes = next.probes.flatMap(probe => {
    const nets = probe.nets.map(net => graph.netById.has(net) ? net : remapped.get(net) ?? net);
    return nets.every(net => graph.netById.has(net)) ? [{ ...probe, nets }] : [];
  });
  return { ...next, probes };
}
