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

// Reconcile each definition against the whole updated library, independent of
// nesting depth or library order. Probe validation waits until all are repaired.
export function reconcileProbes(previous: CircuitJSON, next: CircuitJSON): CircuitJSON {
  if (next.definitions && next.definitions !== previous.definitions) {
    const definitions = next.definitions.map(definition => reconcileLocalProbes(
      { ...(previous.definitions?.find(def => def.name === definition.name) ?? definition), definitions: previous.definitions },
      { ...definition, definitions: next.definitions },
    ));
    next = { ...next, definitions: definitions.map(({ definitions: _library, ...definition }) => definition) };
  }
  return reconcileLocalProbes(previous, next);
}

// Pin-labelled probes follow their attachment even when the old net survives.
// Other probes stay on surviving nets, or follow a merge when their net vanishes.
function reconcileLocalProbes(previous: CircuitJSON, next: CircuitJSON): CircuitJSON {
  if (!next.probes?.length) return next;
  const definitions = next.definitions?.map(({ probes: _probes, ...definition }) => definition);
  const graph = loadCircuit({ ...next, kind: 'circuit', probes: undefined, definitions });
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
    const bus = /^(.*)\[(\d+):(\d+)\]$/.exec(probe.label);
    const endpoint = bus ? `${bus[1]}${bus[3]}` : probe.label;
    let attached = false;
    try {
      const signal = pinProbe(previous, endpoint, bus !== null);
      attached = signal.label === probe.label && signal.nets.length === probe.nets.length && signal.nets.every((net, bit) => net === probe.nets[bit]);
    } catch { /* A net probe need not name a pin. */ }
    if (attached) {
      try { return [{ ...probe, ...pinProbe(next, endpoint, bus !== null) }]; }
      catch { return []; } // The attached pin or bus was removed.
    }
    const nets = probe.nets.map(net => graph.netById.has(net) ? net : remapped.get(net) ?? net);
    return nets.every(net => graph.netById.has(net)) ? [{ ...probe, nets }] : [];
  });
  return { ...next, probes };
}
