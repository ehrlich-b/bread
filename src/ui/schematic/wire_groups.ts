import type { CircuitJSON, NetJSON } from '../../engine/ir';

export interface WireBranch { endpoints: string[]; lanes: number[] }
export interface WireGroup { id: string; nets: NetJSON[]; branches: WireBranch[] }

const numbered = (endpoint: string): { family: string; component: string; bit: number } | null => {
  const dot = endpoint.indexOf('.');
  const match = /^(.*?)(\d+)$/.exec(endpoint.slice(dot + 1));
  if (dot < 1 || !match) return null;
  return { family: `${endpoint.slice(0, dot)}.${match[1]}`, component: endpoint.slice(0, dot), bit: Number(match[2]) };
};

const branchesFor = (nets: NetJSON[]): WireBranch[] => {
  const families = new Map<string, Array<{ endpoint: string; lane: number }>>();
  nets.forEach((net, lane) => {
    for (const endpoint of net.endpoints) {
      const pin = numbered(endpoint);
      const key = pin ? JSON.stringify([pin.family, pin.bit - lane]) : JSON.stringify([endpoint]);
      const entries = families.get(key) ?? [];
      entries.push({ endpoint, lane }); families.set(key, entries);
    }
  });
  const branches: WireBranch[] = [];
  for (const [, entries] of [...families].sort(([a], [b]) => a.localeCompare(b))) {
    let branch: WireBranch | undefined;
    for (const entry of entries) {
      if (!branch || entry.lane !== branch.lanes.at(-1)! + 1) {
        branch = { endpoints: [], lanes: [] }; branches.push(branch);
      }
      branch.endpoints.push(entry.endpoint); branch.lanes.push(entry.lane);
    }
  }
  return branches;
};

// Infer bundles from consecutive numbered pins on the same two components.
// Connect bus emits these same ordinary nets; no persistent grouping metadata
// or simulation changes are needed. Extra fan-out may cover only some lanes.
export function groupWires(circuit: CircuitJSON): { groups: WireGroup[]; singles: NetJSON[] } {
  const pairs = new Map<string, Array<{ bit: number; net: NetJSON }>>();
  for (const net of circuit.nets) {
    if (net.waypoints?.length) continue;
    const pins = net.endpoints.map(numbered).filter(pin => pin !== null);
    // A short between two pins of one family is not an independent bus lane.
    const unique = pins.filter(pin => pins.filter(other => other.family === pin.family).length === 1)
      .sort((a, b) => a.family.localeCompare(b.family));
    for (let a = 0; a < unique.length; a++) for (let b = a + 1; b < unique.length; b++) {
      const from = unique[a]!; const to = unique[b]!;
      if (from.component === to.component) continue;
      const key = JSON.stringify([from.family, to.family, to.bit - from.bit]);
      const entries = pairs.get(key) ?? [];
      entries.push({ bit: from.bit, net }); pairs.set(key, entries);
    }
  }
  const candidates: Array<{ key: string; entries: Array<{ bit: number; net: NetJSON }> }> = [];
  for (const [key, entries] of pairs) {
    entries.sort((a, b) => a.bit - b.bit || a.net.id.localeCompare(b.net.id));
    let run: typeof entries = [];
    for (const entry of entries) {
      if (run.length && entry.bit !== run.at(-1)!.bit + 1) {
        if (run.length > 1) candidates.push({ key, entries: run });
        run = [];
      }
      run.push(entry);
    }
    if (run.length > 1) candidates.push({ key, entries: run });
  }
  candidates.sort((a, b) => b.entries.length - a.entries.length || a.key.localeCompare(b.key)
    || a.entries[0]!.bit - b.entries[0]!.bit);
  const grouped = new Set<NetJSON>(); const groups: WireGroup[] = [];
  const add = (nets: NetJSON[]): void => {
    if (nets.length < 2) return;
    nets.forEach(net => grouped.add(net));
    groups.push({ id: JSON.stringify(nets.map(net => net.id)), nets, branches: branchesFor(nets) });
  };
  for (const candidate of candidates) {
    let run: NetJSON[] = [];
    for (const { net } of candidate.entries) {
      if (grouped.has(net)) { add(run); run = []; }
      else run.push(net);
    }
    add(run);
  }
  groups.sort((a, b) => a.id.localeCompare(b.id));
  return { groups, singles: circuit.nets.filter(net => !grouped.has(net)) };
}
