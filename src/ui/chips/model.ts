import { getPinsForType } from '../../engine';
import type { CircuitJSON, NetJSON, PinDir, PortJSON } from '../../engine/ir';

export interface ChipSelection {
  body: CircuitJSON;
  // Each external wire maps to one internal port net.
  boundaries: Map<string, string>;
  ids: ReadonlySet<string>;
}

export function chipTypeName(name: string): string {
  const type = name.trim().startsWith('user.') ? name.trim() : `user.${name.trim()}`;
  if (!/^user\.[A-Za-z][A-Za-z0-9_-]*$/.test(type)) {
    throw new Error('Use a chip name starting with a letter, with letters, numbers, underscores or hyphens.');
  }
  return type;
}

// Expose boundary wires and unwired pins, while preserving tied-input nets.
export function chipSelection(circuit: CircuitJSON, selected: ReadonlySet<string>): ChipSelection {
  const components = circuit.components.filter((c) => selected.has(c.id));
  if (!components.length) throw new Error('Select the components to put inside your chip.');
  const ids = new Set(components.map((c) => c.id));
  const inside = (ep: string): boolean => ids.has(ep.split('.', 1)[0]!);
  const nets: NetJSON[] = [];
  const ports: PortJSON[] = [];
  const boundaries = new Map<string, string>();
  const names = new Set<string>();
  const pins = new Map<string, PinDir>();
  for (const c of components) {
    const spec = getPinsForType(c.type, c.params, circuit.definitions);
    if (!spec) throw new Error(`Unknown chip ${c.type}`);
    for (const pin of spec) pins.set(`${c.id}.${pin.name}`, pin.dir);
  }
  const expose = (net: NetJSON): void => {
    const dirs = net.endpoints.map((ep) => pins.get(ep));
    const dir = dirs.every((d) => d === 'in') ? 'in'
      : dirs.every((d) => d === 'out') ? 'out' : 'inout';
    let base = (net.name ?? net.endpoints[0]!.split('.').slice(1).join('_')).replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_]/.test(base)) base = `P_${base}`;
    let name = base;
    let count = 2;
    while (names.has(name)) name = `${base}_${count++}`;
    names.add(name);
    ports.push({ name, dir, internalNet: net.id });
  };
  for (const net of circuit.nets) {
    const endpoints = net.endpoints.filter(inside);
    if (!endpoints.length) continue;
    const inner = { id: net.id, name: net.name, endpoints };
    nets.push(inner);
    const dirs = endpoints.map((ep) => pins.get(ep));
    const terminal = dirs.every((d) => d === 'in') || dirs.every((d) => d === 'out') || endpoints.length === 1;
    if (endpoints.length !== net.endpoints.length || terminal || circuit.ports?.some((p) => p.internalNet === net.id)) {
      boundaries.set(net.id, net.id);
      expose(inner);
    }
  }
  const wired = new Set(nets.flatMap((n) => n.endpoints));
  let n = 1;
  for (const ep of pins.keys()) {
    if (wired.has(ep)) continue;
    while (nets.some((net) => net.id === `port${n}`)) n++;
    const net = { id: `port${n++}`, endpoints: [ep] };
    nets.push(net);
    expose(net);
  }
  const x = Math.min(...components.map((c) => c.position?.[0] ?? 0));
  const y = Math.min(...components.map((c) => c.position?.[1] ?? 0));
  return {
    ids, boundaries,
    body: {
      version: 1, kind: 'composite', name: '',
      components: components.map((c) => ({ ...c, position: [(c.position?.[0] ?? 0) - x + 60, (c.position?.[1] ?? 0) - y + 60] })),
      nets, ports, metadata: { revision: 1 },
    },
  };
}

export function createChip(circuit: CircuitJSON, selected: ReadonlySet<string>, name: string, ports: PortJSON[]): CircuitJSON {
  const type = chipTypeName(name);
  if (circuit.definitions?.some((d) => d.name === type)) throw new Error(`Chip ${type} already exists; edit it from My chips.`);
  const fragment = chipSelection(circuit, selected);
  const expected = fragment.body.ports ?? [];
  if (ports.length !== expected.length || expected.some((p) => !ports.some((q) => q.internalNet === p.internalNet))) {
    throw new Error('The selected circuit changed. Close and reopen Create chip.');
  }
  const definition = { ...fragment.body, name: type, ports };
  let n = 1;
  const base = type.slice(5).toLowerCase();
  while (circuit.components.some((c) => c.id === `${base}${n}`)) n++;
  const id = `${base}${n}`;
  const first = circuit.components.find((c) => fragment.ids.has(c.id))!;
  const nets: NetJSON[] = [];
  for (const net of circuit.nets) {
    const endpoints = net.endpoints.filter((ep) => !fragment.ids.has(ep.split('.', 1)[0]!));
    const boundary = fragment.boundaries.get(net.id);
    if (boundary) {
      const port = ports.find((p) => p.internalNet === boundary)!;
      endpoints.push(`${id}.${port.name}`);
    }
    if (endpoints.length) nets.push({ ...net, endpoints });
  }
  return {
    ...circuit,
    definitions: [...(circuit.definitions ?? []), definition],
    components: [...circuit.components.filter((c) => !fragment.ids.has(c.id)), { id, type, position: first.position }],
    nets,
  };
}

export function chipBody(definition: CircuitJSON, definitions: CircuitJSON[]): CircuitJSON {
  return { ...definition, kind: 'circuit', definitions };
}
