// UI-side editor model. Owns the editable copy of CircuitJSON, the selection,
// and the channel for pushing structural changes into the worker. Views
// (schematic, controls, inspector) subscribe and re-render on state changes.
//
// Mutations go through applyMutate(): the new circuit is shipped to the worker
// via bus.mutate(), the returned LoadSnapshot replaces our snapshot handle,
// and subscribers fire. We serialize in-flight mutations so a fast click-spam
// can't race the worker's `load_res` ordering.
//
// Selection is local-only (the worker doesn't care). Selected component IDs
// referencing instances that disappear after a mutation are pruned silently.

import type { CircuitJSON, ComponentInstanceJSON, NetJSON } from '../engine/ir';
import type { LoadSnapshot, WorkerBus } from './bus';

export interface Placement {
  type: string;
  params?: Record<string, unknown>;
}

export interface EditorState {
  circuit: CircuitJSON;
  snapshot: LoadSnapshot;
  selection: ReadonlySet<string>;
  placement: Placement | null;
}

const MAX_UNDO_DEPTH = 200;

export class EditorModel {
  private circuit: CircuitJSON;
  private snapshot: LoadSnapshot;
  private selection: Set<string> = new Set();
  private placement: Placement | null = null;
  private subs: Set<(s: EditorState) => void> = new Set();
  private inflight: Promise<void> = Promise.resolve();
  private pendingComponentIds: Set<string> = new Set();
  // Each entry is the circuit *before* a user-initiated mutation; pop one to
  // undo. redoStack mirrors it for forward replays. Bounded so very long
  // sessions don't grow without bound.
  private undoStack: CircuitJSON[] = [];
  private redoStack: CircuitJSON[] = [];

  constructor(
    public readonly bus: WorkerBus,
    circuit: CircuitJSON,
    snapshot: LoadSnapshot,
  ) {
    this.circuit = circuit;
    this.snapshot = snapshot;
  }

  get state(): EditorState {
    return {
      circuit: this.circuit,
      snapshot: this.snapshot,
      selection: this.selection,
      placement: this.placement,
    };
  }

  // Generate a non-colliding ID for a new instance of `type`. Convention:
  // lowercase short name + 1-based counter. e.g. "and1", "and2", "switch1".
  generateId(type: string): string {
    const base = type.split('.').pop()?.toLowerCase() ?? 'comp';
    const existing = new Set([...this.pendingComponentIds, ...this.circuit.components.map((c) => c.id)]);
    let i = 1;
    while (existing.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  generateNetId(): string {
    const existing = new Set(this.circuit.nets.map((n) => n.id));
    let i = 1;
    while (existing.has(`n${i}`)) i++;
    return `n${i}`;
  }

  // Connect two pin endpoints. Resolves to one of:
  //   - both pins free: create a new 2-endpoint net
  //   - one pin already on a net: extend that net with the other endpoint
  //   - pins on different nets: merge the second into the first
  //   - same net or same pin: no-op
  connect(fromEp: string, toEp: string): Promise<void> {
    return this.applyMutate((circuit) => {
      if (fromEp === toEp) return null;
      const fromNet = circuit.nets.find((n) => n.endpoints.includes(fromEp));
      const toNet = circuit.nets.find((n) => n.endpoints.includes(toEp));
      if (fromNet && toNet && fromNet.id === toNet.id) return null;

      let nets = circuit.nets;
      if (!fromNet && !toNet) {
        const id = this.generateNetId();
        nets = [...nets, { id, endpoints: [fromEp, toEp] }];
      } else if (fromNet && !toNet) {
        nets = nets.map((n) =>
          n.id === fromNet.id ? { ...n, endpoints: [...n.endpoints, toEp] } : n,
        );
      } else if (!fromNet && toNet) {
        nets = nets.map((n) =>
          n.id === toNet.id ? { ...n, endpoints: [...n.endpoints, fromEp] } : n,
        );
      } else if (fromNet && toNet) {
        const merged = [...fromNet.endpoints, ...toNet.endpoints];
        nets = nets
          .filter((n) => n.id !== toNet.id)
          .map((n) => (n.id === fromNet.id ? { ...n, endpoints: merged } : n));
      }
      return { ...circuit, nets };
    });
  }

  // ---- Placement ---------------------------------------------------------

  setPlacement(type: string, params?: Record<string, unknown>): void {
    this.placement = { type, params };
    this.notify();
  }

  clearPlacement(): void {
    if (this.placement === null) return;
    this.placement = null;
    this.notify();
  }

  subscribe(fn: (s: EditorState) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  private notify(): void {
    const state = this.state;
    for (const fn of this.subs) fn(state);
  }

  // ---- Mutations ---------------------------------------------------------

  addComponent(inst: ComponentInstanceJSON): Promise<void> {
    this.pendingComponentIds.add(inst.id);
    return this.applyMutate((circuit) => ({
      ...circuit,
      components: [...circuit.components, inst],
    })).finally(() => this.pendingComponentIds.delete(inst.id));
  }

  removeComponent(id: string): Promise<void> {
    return this.applyMutate((circuit) => ({
      ...circuit,
      components: circuit.components.filter((c) => c.id !== id),
      nets: circuit.nets
        .map((n) => ({
          ...n,
          endpoints: n.endpoints.filter((ep) => ep.split('.', 1)[0] !== id),
        }))
        .filter((n) => n.endpoints.length >= 1),
    }));
  }

  updateComponent(id: string, patch: Partial<ComponentInstanceJSON>): Promise<void> {
    return this.applyMutate((circuit) => ({
      ...circuit,
      components: circuit.components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  }

  rotateComponent(id: string): Promise<void> {
    return this.applyMutate((circuit) => ({
      ...circuit,
      components: circuit.components.map((c) => c.id === id
        ? { ...c, rotation: ((c.rotation ?? 0) + 90) % 360 }
        : c),
    }));
  }

  addNet(net: NetJSON): Promise<void> {
    return this.applyMutate((circuit) => ({
      ...circuit,
      nets: [...circuit.nets, net],
    }));
  }

  removeNet(id: string): Promise<void> {
    return this.applyMutate((circuit) => ({
      ...circuit,
      nets: circuit.nets.filter((n) => n.id !== id),
    }));
  }

  updateNet(id: string, patch: Partial<NetJSON>): Promise<void> {
    return this.applyMutate((circuit) => ({
      ...circuit,
      nets: circuit.nets.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
  }

  replaceCircuit(circuit: CircuitJSON): Promise<void> {
    return this.applyMutate(() => circuit);
  }

  // ---- Selection ---------------------------------------------------------

  select(id: string, mode: 'replace' | 'add' = 'replace'): void {
    if (mode === 'replace') {
      this.selection = new Set([id]);
    } else {
      this.selection = new Set(this.selection);
      this.selection.add(id);
    }
    this.notify();
  }

  deselect(id: string): void {
    if (!this.selection.has(id)) return;
    this.selection = new Set(this.selection);
    this.selection.delete(id);
    this.notify();
  }

  clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection = new Set();
    this.notify();
  }

  // ---- Undo / redo -----------------------------------------------------

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  async undo(): Promise<void> {
    await this.applyTransition(() => this.undoStack[this.undoStack.length - 1] ?? null, (old) => {
      // Pop only after the transition commits, so a race-then-failure
      // doesn't drain the stack.
      this.undoStack.pop();
      this.redoStack.push(old);
    });
  }

  async redo(): Promise<void> {
    await this.applyTransition(() => this.redoStack[this.redoStack.length - 1] ?? null, (old) => {
      this.redoStack.pop();
      this.undoStack.push(old);
    });
  }

  // ---- Internal ---------------------------------------------------------

  private applyMutate(build: (circuit: CircuitJSON) => CircuitJSON | null): Promise<void> {
    return this.applyTransition(build, (old) => {
      this.undoStack.push(old);
      if (this.undoStack.length > MAX_UNDO_DEPTH) this.undoStack.shift();
      this.redoStack = [];
    });
  }

  // Resolve the action against committed state only after prior actions finish.
  // Serializing just the worker request would allow stale copies of the circuit
  // (or stale undo targets) to overwrite earlier queued actions. A null result
  // is a no-op and leaves the worker and history untouched.
  // The history callback runs after the worker
  // confirms the new graph but before we update local state — `old` is the
  // current circuit at that moment.
  private async applyTransition(
    build: (circuit: CircuitJSON) => CircuitJSON | null,
    onCommit: (old: CircuitJSON) => void,
  ): Promise<void> {
    const prev = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      const newCircuit = build(this.circuit);
      if (newCircuit === null) return;
      const snapshot = await this.bus.mutate(newCircuit);
      const ids = new Set(newCircuit.components.map((c) => c.id));
      let pruned = false;
      const nextSel = new Set<string>();
      for (const sid of this.selection) {
        if (ids.has(sid)) nextSel.add(sid);
        else pruned = true;
      }
      if (pruned) this.selection = nextSel;
      onCommit(this.circuit);
      this.circuit = newCircuit;
      this.snapshot = snapshot;
      this.notify();
    } finally {
      release();
    }
  }
}
