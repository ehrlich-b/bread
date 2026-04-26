import type {
  CircuitJSON,
  RuntimeComponent,
  RuntimeGraph,
  RuntimeNet,
} from './ir';
import { getPrimitive } from './primitives/index';

const SUPPORTED_VERSION = 1;

// Parse + validate a CircuitJSON and produce a RuntimeGraph the simulator can run.
//
// M0 scope:
//   - kind: 'circuit' only (composites land in M2)
//   - all components must resolve to a registered primitive
//   - every endpoint must reference an existing component + pin
//   - every pin can sit on at most one net
//   - dangling nets (1 endpoint) are allowed; zero-endpoint nets fail load
export function loadCircuit(json: CircuitJSON): RuntimeGraph {
  if (json.version !== SUPPORTED_VERSION) {
    throw new Error(`unsupported circuit version: ${json.version} (expected ${SUPPORTED_VERSION})`);
  }
  if (json.kind !== 'circuit') {
    throw new Error(`M0 only supports kind="circuit"; got "${json.kind}"`);
  }

  const components: RuntimeComponent[] = [];
  const componentById = new Map<string, number>();

  for (const inst of json.components) {
    if (componentById.has(inst.id)) {
      throw new Error(`duplicate component id: ${inst.id}`);
    }
    const prim = getPrimitive(inst.type);
    if (!prim) throw new Error(`unknown component type: ${inst.type} (component ${inst.id})`);

    const params = inst.params ?? {};
    const pins = prim.pins(params);

    const inputPinIdx: number[] = [];
    const outputPinIdx: number[] = [];
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i]!;
      if (p.dir === 'in' || p.dir === 'inout') inputPinIdx.push(i);
      if (p.dir === 'out' || p.dir === 'inout') outputPinIdx.push(i);
    }

    const state = prim.init ? prim.init(params) : undefined;

    components.push({
      id: inst.id,
      typeId: inst.type,
      primitive: prim,
      params,
      state,
      pins,
      inputPinIdx,
      outputPinIdx,
      pinNetIdx: new Array<number>(pins.length).fill(-1),
      // Initial: not driving anything (Z). First settle reconciles.
      outputBuf: new Array<'Z'>(outputPinIdx.length).fill('Z'),
    });
    componentById.set(inst.id, components.length - 1);
  }

  const nets: RuntimeNet[] = [];
  const netById = new Map<string, number>();

  for (const netDef of json.nets) {
    if (netById.has(netDef.id)) {
      throw new Error(`duplicate net id: ${netDef.id}`);
    }
    if (netDef.endpoints.length === 0) {
      throw new Error(`net ${netDef.id} has zero endpoints`);
    }

    const drivers: Array<{ comp: number; outIdx: number }> = [];
    const listenerSet = new Set<number>();

    const netIdx = nets.length;

    for (const ep of netDef.endpoints) {
      const dot = ep.indexOf('.');
      if (dot < 0) {
        throw new Error(`bad endpoint "${ep}" on net ${netDef.id}: expected componentId.pinName`);
      }
      const compId = ep.slice(0, dot);
      const pinName = ep.slice(dot + 1);

      const compIdx = componentById.get(compId);
      if (compIdx === undefined) {
        throw new Error(`net ${netDef.id} endpoint ${ep}: unknown component ${compId}`);
      }
      const comp = components[compIdx]!;
      const pinIdx = comp.pins.findIndex((p) => p.name === pinName);
      if (pinIdx < 0) {
        throw new Error(
          `net ${netDef.id} endpoint ${ep}: ${comp.typeId} has no pin "${pinName}"`,
        );
      }

      if (comp.pinNetIdx[pinIdx] !== -1) {
        throw new Error(
          `pin ${ep} appears on multiple nets (already on net "${nets[comp.pinNetIdx[pinIdx]!]!.id}")`,
        );
      }
      comp.pinNetIdx[pinIdx] = netIdx;

      const dir = comp.pins[pinIdx]!.dir;
      if (dir === 'out' || dir === 'inout') {
        const outIdx = comp.outputPinIdx.indexOf(pinIdx);
        drivers.push({ comp: compIdx, outIdx });
      }
      if (dir === 'in' || dir === 'inout') {
        listenerSet.add(compIdx);
      }
    }

    nets.push({
      id: netDef.id,
      name: netDef.name ?? netDef.id,
      drivers,
      listenerComps: [...listenerSet],
      forced: 'Z',
      value: 'X',
    });
    netById.set(netDef.id, netIdx);
  }

  // Sanity: warn (throw for now) if any pin remains unconnected. Per docs we
  // could allow this and treat as X; M0 prefers explicit errors so user
  // mistakes surface early.
  for (const comp of components) {
    for (let i = 0; i < comp.pins.length; i++) {
      if (comp.pinNetIdx[i] === -1) {
        throw new Error(
          `component ${comp.id} pin ${comp.pins[i]!.name} is not connected to any net`,
        );
      }
    }
  }

  return { components, nets, componentById, netById };
}
