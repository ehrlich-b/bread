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

export interface EditorState {
  circuit: CircuitJSON;
  snapshot: LoadSnapshot;
  selection: ReadonlySet<string>;
}

export class EditorModel {
  private circuit: CircuitJSON;
  private snapshot: LoadSnapshot;
  private selection: Set<string> = new Set();
  private subs: Set<(s: EditorState) => void> = new Set();
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    public readonly bus: WorkerBus,
    circuit: CircuitJSON,
    snapshot: LoadSnapshot,
  ) {
    this.circuit = circuit;
    this.snapshot = snapshot;
  }

  get state(): EditorState {
    return { circuit: this.circuit, snapshot: this.snapshot, selection: this.selection };
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
    return this.applyMutate({
      ...this.circuit,
      components: [...this.circuit.components, inst],
    });
  }

  removeComponent(id: string): Promise<void> {
    return this.applyMutate({
      ...this.circuit,
      components: this.circuit.components.filter((c) => c.id !== id),
      nets: this.circuit.nets
        .map((n) => ({
          ...n,
          endpoints: n.endpoints.filter((ep) => ep.split('.', 1)[0] !== id),
        }))
        .filter((n) => n.endpoints.length >= 1),
    });
  }

  updateComponent(id: string, patch: Partial<ComponentInstanceJSON>): Promise<void> {
    return this.applyMutate({
      ...this.circuit,
      components: this.circuit.components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  }

  addNet(net: NetJSON): Promise<void> {
    return this.applyMutate({
      ...this.circuit,
      nets: [...this.circuit.nets, net],
    });
  }

  removeNet(id: string): Promise<void> {
    return this.applyMutate({
      ...this.circuit,
      nets: this.circuit.nets.filter((n) => n.id !== id),
    });
  }

  updateNet(id: string, patch: Partial<NetJSON>): Promise<void> {
    return this.applyMutate({
      ...this.circuit,
      nets: this.circuit.nets.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });
  }

  replaceCircuit(circuit: CircuitJSON): Promise<void> {
    return this.applyMutate(circuit);
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

  // ---- Internal ---------------------------------------------------------

  private async applyMutate(newCircuit: CircuitJSON): Promise<void> {
    const prev = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      const snapshot = await this.bus.mutate(newCircuit);
      const ids = new Set(newCircuit.components.map((c) => c.id));
      let pruned = false;
      const nextSel = new Set<string>();
      for (const sid of this.selection) {
        if (ids.has(sid)) nextSel.add(sid);
        else pruned = true;
      }
      if (pruned) this.selection = nextSel;
      this.circuit = newCircuit;
      this.snapshot = snapshot;
      this.notify();
    } finally {
      release();
    }
  }
}
