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

import type { CircuitJSON, ComponentInstanceJSON, NetJSON, NetState, PortJSON } from '../engine/ir';
import type { LoadSnapshot, WorkerBus } from './bus';
import { chipBody, createChip } from './chips/model';
import { busPairs, connectSignals } from './signals';

export interface Placement {
  type: string;
  params?: Record<string, unknown>;
}

export interface EditorState {
  circuit: CircuitJSON;
  snapshot: LoadSnapshot;
  selection: ReadonlySet<string>;
  placement: Placement | null;
  editingChip: string | null;
  error: string | null;
  busWiring: boolean;
}

interface EditorDocument {
  project: CircuitJSON;
  draft: CircuitJSON | null;
  editing: string | null;
}

const MAX_UNDO_DEPTH = 200;

export class EditorModel {
  private document: EditorDocument;
  private error: string | null = null;
  private portInputs = new Map<string, NetState>();
  private get circuit(): CircuitJSON { return this.document.draft ?? this.document.project; }
  get project(): CircuitJSON { return this.document.project; }
  // Export after all edits already requested by the user have committed.
  whenIdle(): Promise<void> { return this.inflight; }
  private snapshot: LoadSnapshot;
  private selection: Set<string> = new Set();
  private placement: Placement | null = null;
  private busWiring = false;
  private subs: Set<(s: EditorState) => void> = new Set();
  private inflight: Promise<void> = Promise.resolve();
  private pendingComponentIds: Set<string> = new Set();
  // Each entry is the circuit *before* a user-initiated mutation; pop one to
  // undo. redoStack mirrors it for forward replays. Bounded so very long
  // sessions don't grow without bound.
  private undoStack: EditorDocument[] = [];
  private redoStack: EditorDocument[] = [];

  constructor(
    public readonly bus: WorkerBus,
    circuit: CircuitJSON,
    snapshot: LoadSnapshot,
  ) {
    this.document = { project: circuit, draft: null, editing: null };
    this.snapshot = snapshot;
  }

  get state(): EditorState {
    return {
      circuit: this.circuit,
      snapshot: this.snapshot,
      selection: this.selection,
      placement: this.placement,
      editingChip: this.document.editing,
      error: this.error,
      busWiring: this.busWiring,
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
    return this.applyMutate((circuit) => connectSignals(circuit, fromEp, toEp));
  }

  connectBus(from: string, to: string, width: number): Promise<void> {
    return this.applyMutate((circuit) => {
      let next = circuit;
      for (const [source, target] of busPairs(circuit, from, to, width)) next = connectSignals(next, source, target) ?? next;
      return next === circuit ? null : next;
    });
  }

  setBusWiring(enabled: boolean): void {
    this.busWiring = enabled;
    if (enabled) this.placement = null;
    this.notify();
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
    return this.applyDocument(() => ({ project: circuit, draft: null, editing: null }));
  }

  newCircuit(): Promise<void> {
    return this.applyDocument((doc) => ({ project: { version: 1, kind: 'circuit', name: 'Untitled', components: [], nets: [], definitions: (doc.draft ?? doc.project).definitions ?? [] }, draft: null, editing: null }));
  }

  createChip(name: string, ports: PortJSON[], selected: ReadonlySet<string> = new Set(this.selection)): Promise<void> {
    return this.applyMutate((circuit) => createChip(circuit, selected, name, ports));
  }

  editChip(type: string): Promise<void> {
    return this.applyDocument((doc) => {
      if (doc.draft) throw new Error('Save or cancel the open chip before editing another.');
      const definition = doc.project.definitions?.find((d) => d.name === type);
      if (!definition) throw new Error(`Unknown user chip ${type}`);
      return { ...doc, editing: type, draft: chipBody(definition, doc.project.definitions ?? []) };
    });
  }

  saveChip(): Promise<void> {
    return this.applyDocument((doc) => {
      if (!doc.draft || !doc.editing) return null;
      const { definitions: library, ...body } = doc.draft;
      const previous = doc.project.definitions?.find((d) => d.name === doc.editing);
      const definition: CircuitJSON = { ...body, name: doc.editing, kind: 'composite', metadata: { ...body.metadata, revision: Number(previous?.metadata?.revision ?? 1) + 1 } };
      const definitions = (library ?? []).map((d) => d.name === doc.editing ? definition : d);
      return { project: { ...doc.project, definitions }, draft: null, editing: null };
    });
  }

  cancelChip(): Promise<void> {
    return this.applyDocument((doc) => doc.draft ? { ...doc, draft: null, editing: null } : null);
  }

  updatePorts(ports: PortJSON[]): Promise<void> {
    return this.applyMutate((circuit) => ({ ...circuit, ports }));
  }

  exposePin(endpoint: string, name: string, dir: PortJSON['dir']): Promise<void> {
    return this.applyMutate((circuit) => {
      let net = circuit.nets.find((n) => n.endpoints.includes(endpoint));
      const nets = [...circuit.nets];
      if (!net) { net = { id: this.generateNetId(), endpoints: [endpoint] }; nets.push(net); }
      if (circuit.ports?.some((p) => p.internalNet === net!.id)) throw new Error('That signal already has a port. Tied pins share one port.');
      return { ...circuit, nets, ports: [...(circuit.ports ?? []), { name, dir, internalNet: net.id }] };
    });
  }

  async setPortInput(netId: string, value: NetState): Promise<void> {
    await this.inflight;
    if (!this.document.editing || !this.circuit.ports?.some((p) => p.internalNet === netId && p.dir !== 'out')) {
      throw new Error('Only chip input and bidirectional ports can be driven.');
    }
    await this.bus.setNetInput(netId, value);
    this.portInputs.set(netId, value);
  }

  reportError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.notify();
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
    return this.applyDocument((doc) => {
      const next = build(doc.draft ?? doc.project);
      if (next === null) return null;
      return doc.draft ? { ...doc, draft: next } : { ...doc, project: next };
    });
  }

  private applyDocument(build: (doc: EditorDocument) => EditorDocument | null): Promise<void> {
    return this.applyTransition(build, (old) => {
      this.undoStack.push(old);
      if (this.undoStack.length > MAX_UNDO_DEPTH) this.undoStack.shift();
      this.redoStack = [];
    });
  }

  // Both document changes and history targets resolve after prior RPCs finish.
  private async applyTransition(
    build: (doc: EditorDocument) => EditorDocument | null,
    onCommit: (old: EditorDocument) => void,
  ): Promise<void> {
    const prev = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((res) => { release = res; });
    try {
      await prev;
      const next = build(this.document);
      if (next === null) return;
      const circuit = next.draft ?? next.project;
      const snapshot = await this.bus.mutate(circuit);
      const ids = new Set(circuit.components.map((c) => c.id));
      this.selection = new Set([...this.selection].filter((id) => ids.has(id)));
      if (next.editing !== this.document.editing) {
        this.selection.clear();
        this.placement = null;
        this.portInputs.clear();
      }
      onCommit(this.document);
      this.document = next;
      this.snapshot = snapshot;
      // Testing a chip starts with released inputs. Preserve explicit drives
      // across structural edits, and release ports which became outputs.
      for (const [netId, value] of this.portInputs) {
        if (circuit.ports?.some((p) => p.internalNet === netId && p.dir !== 'out') && snapshot.netIndex.has(netId)) {
          await this.bus.setNetInput(netId, value);
        } else this.portInputs.delete(netId);
      }
      this.error = null;
      this.notify();
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally { release(); }
  }
}
