import { getBehavioral } from './behavioral/registry';
import { getComposite } from './composites/registry';
import type {
  CircuitJSON,
  ComponentInstanceJSON,
  NetJSON,
  PrimitiveDef,
  RuntimeComponent,
  RuntimeGraph,
  RuntimeNet,
} from './ir';
import { getPrimitive } from './primitives/index';

// Resolve a component type to its leaf evaluator (primitive or behavioral).
// Composites are flattened away before this is called.
const getLeaf = (typeId: string): PrimitiveDef<unknown, unknown> | undefined =>
  getPrimitive(typeId) ?? getBehavioral(typeId);

const SUPPORTED_VERSION = 1;

export interface LoadOptions {
  // When true, throw on any pin that isn't wired to a net. When false (the
  // default), synthesize a floating per-pin net so the partial circuit can
  // still simulate. M4 made this lenient so the editor can hold half-built
  // circuits in memory; tests/headless callers pass `strict: true` if they
  // want the old behavior.
  strict?: boolean;
}

// Parse + validate a CircuitJSON and produce a RuntimeGraph the simulator can run.
//
// Composites are expanded inline before the runtime graph is built: every
// component instance whose type resolves to a composite is replaced by a
// prefixed copy of its inner graph, with port-internal nets stitched into
// the parent's nets at the call site. The simulator never sees a composite.
export function loadCircuit(json: CircuitJSON, opts: LoadOptions = {}): RuntimeGraph {
  if (json.version !== SUPPORTED_VERSION) {
    throw new Error(`unsupported circuit version: ${json.version} (expected ${SUPPORTED_VERSION})`);
  }
  if (json.kind !== 'circuit') {
    throw new Error(`loadCircuit requires kind="circuit"; got "${json.kind}" (composites register via registerComposite)`);
  }

  const flat = flattenCircuit(json);

  const components: RuntimeComponent[] = [];
  const componentById = new Map<string, number>();

  for (const inst of flat.components) {
    if (componentById.has(inst.id)) {
      throw new Error(`duplicate component id: ${inst.id}`);
    }
    const prim = getLeaf(inst.type);
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
      // Pre-allocated input scratch — written by the simulator before each
      // evaluate(). Initialized to 'X' so the first read sees a defined value.
      inputBuf: new Array<'X'>(inputPinIdx.length).fill('X'),
      // Two output buffers: proposed (filled by evaluate during READ) and
      // committed (the values currently being driven onto each net). Both
      // start at 'Z' so the first settle reconciles.
      proposedBuf: new Array<'Z'>(outputPinIdx.length).fill('Z'),
      outputBuf: new Array<'Z'>(outputPinIdx.length).fill('Z'),
    });
    componentById.set(inst.id, components.length - 1);
  }

  const nets: RuntimeNet[] = [];
  const netById = new Map<string, number>();

  for (const netDef of flat.nets) {
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

  // Unconnected pins: in strict mode (tests/headless), throw. Otherwise
  // synthesize a floating per-pin net so the editor can simulate half-built
  // circuits without state churn. Floating-input pins read 'X', floating-
  // output pins drive into the void.
  for (let compIdx = 0; compIdx < components.length; compIdx++) {
    const comp = components[compIdx]!;
    for (let i = 0; i < comp.pins.length; i++) {
      if (comp.pinNetIdx[i] !== -1) continue;
      const pin = comp.pins[i]!;
      if (opts.strict) {
        throw new Error(
          `component ${comp.id} pin ${pin.name} is not connected to any net`,
        );
      }
      const synthId = `__floating__${comp.id}__${pin.name}`;
      const drivers: Array<{ comp: number; outIdx: number }> = [];
      const listenerComps: number[] = [];
      if (pin.dir === 'out' || pin.dir === 'inout') {
        drivers.push({ comp: compIdx, outIdx: comp.outputPinIdx.indexOf(i) });
      }
      if (pin.dir === 'in' || pin.dir === 'inout') {
        listenerComps.push(compIdx);
      }
      const netIdx = nets.length;
      nets.push({
        id: synthId,
        name: synthId,
        drivers,
        listenerComps,
        forced: 'Z',
        value: 'X',
      });
      netById.set(synthId, netIdx);
      comp.pinNetIdx[i] = netIdx;
    }
  }

  return { components, nets, componentById, netById };
}

// Recursively expand composite instances into a flat CircuitJSON whose
// components are all primitives. Detects cyclic composite imports.
//
// Algorithm: deep-copy nets so we can mutate endpoints. For each component,
// pass primitives through; for each composite, recursively flatten the
// composite's body, prefix child IDs with `<instId>__`, splice port
// references in the parent's nets with the prefixed inner-net endpoints, and
// add unmerged inner nets as composite-internal (prefixed) nets.
export function flattenCircuit(json: CircuitJSON): CircuitJSON {
  return flatten(json, []);
}

function flatten(input: CircuitJSON, importChain: string[]): CircuitJSON {
  const outComponents: ComponentInstanceJSON[] = [];
  const outNets: NetJSON[] = input.nets.map((n) => ({
    id: n.id,
    name: n.name,
    endpoints: [...n.endpoints],
    waypoints: n.waypoints,
  }));

  for (const inst of input.components) {
    if (getLeaf(inst.type)) {
      outComponents.push(inst);
      continue;
    }
    const composite = getComposite(inst.type);
    if (!composite) {
      throw new Error(`unknown component type: ${inst.type} (component ${inst.id})`);
    }
    if (importChain.includes(inst.type)) {
      throw new Error(
        `cyclic composite import: ${[...importChain, inst.type].join(' -> ')}`,
      );
    }

    expandComposite(inst, composite, [...importChain, inst.type], outComponents, outNets);
  }

  return {
    version: input.version,
    kind: input.kind,
    name: input.name,
    description: input.description,
    components: outComponents,
    nets: outNets,
    ports: input.ports,
    metadata: input.metadata,
  };
}

function expandComposite(
  inst: ComponentInstanceJSON,
  composite: CircuitJSON,
  newImportChain: string[],
  outComponents: ComponentInstanceJSON[],
  outNets: NetJSON[],
): void {
  const inner = flatten(composite, newImportChain);
  const prefix = `${inst.id}__`;

  // Inner-component IDs prefixed with the parent instance id.
  for (const c of inner.components) {
    outComponents.push({ ...c, id: prefix + c.id });
  }

  // portName -> inner net (object), and reverse map for skip-list in pass 2.
  const portToInner = new Map<string, NetJSON>();
  const innerNetIdToPort = new Map<string, string>();
  for (const port of composite.ports ?? []) {
    const innerNet = inner.nets.find((n) => n.id === port.internalNet);
    if (!innerNet) {
      throw new Error(
        `composite ${composite.name}: port "${port.name}" references missing internal net "${port.internalNet}"`,
      );
    }
    portToInner.set(port.name, innerNet);
    innerNetIdToPort.set(port.internalNet, port.name);
  }

  // Pass 1: in every parent net, replace `inst.id.<portName>` endpoints with
  // the prefixed endpoints of the corresponding inner net. After this pass,
  // the parent nets no longer reference `inst.id` at all.
  const portsMerged = new Set<string>();
  for (const parentNet of outNets) {
    let i = 0;
    while (i < parentNet.endpoints.length) {
      const ep = parentNet.endpoints[i]!;
      const dot = ep.indexOf('.');
      if (dot < 0) {
        i++;
        continue;
      }
      const compId = ep.slice(0, dot);
      if (compId !== inst.id) {
        i++;
        continue;
      }
      const pinName = ep.slice(dot + 1);
      const innerNet = portToInner.get(pinName);
      if (!innerNet) {
        throw new Error(
          `composite ${inst.id} (${composite.name}): unknown port "${pinName}" referenced on net "${parentNet.id}"`,
        );
      }
      const expanded = innerNet.endpoints.map((innerEp) => prefix + innerEp);
      parentNet.endpoints.splice(i, 1, ...expanded);
      portsMerged.add(pinName);
      i += expanded.length;
    }
  }

  // Pass 2: add inner nets to outNets as composite-internal nets, prefixing
  // both the id and the endpoints. Skip nets that backed a port that was
  // merged in pass 1 — those endpoints already live in the parent net.
  // A port whose net was never referenced externally still gets added: its
  // inner pins still need a net to live on.
  for (const innerNet of inner.nets) {
    const portName = innerNetIdToPort.get(innerNet.id);
    if (portName !== undefined && portsMerged.has(portName)) continue;
    outNets.push({
      id: prefix + innerNet.id,
      name: innerNet.name,
      endpoints: innerNet.endpoints.map((ep) => prefix + ep),
      waypoints: innerNet.waypoints,
    });
  }
}
