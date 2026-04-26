import type { NetState, RuntimeGraph, RuntimeNet } from './ir';
import { readAsLogic, resolveNet } from './nets';

// Default oscillation cap. Combinational chains of depth d settle in d
// iterations; ring oscillators run forever.
export const DEFAULT_MAX_ITERATIONS = 10_000;

export interface SimEvent {
  kind: 'oscillation' | 'contention';
  detail: string;
  step: number;
}

export interface SimulatorOptions {
  maxIterations?: number;
}

export class Simulator {
  readonly graph: RuntimeGraph;
  readonly events: SimEvent[] = [];
  step = 0;

  private readonly maxIterations: number;
  // Two dirty queues, swapped per iteration. Insertion order is iteration order.
  private dirtyA: number[] = [];
  private dirtyB: number[] = [];
  // Bitmap: 1 if component is currently in either dirty queue.
  private readonly inDirty: Uint8Array;
  // Reusable scratch buffer for resolving each net's drivers without allocation.
  private readonly resolveScratch: NetState[] = [];

  constructor(graph: RuntimeGraph, opts: SimulatorOptions = {}) {
    this.graph = graph;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.inDirty = new Uint8Array(graph.components.length);
    // Initial state per SIMULATION.md: every component dirty, every net X.
    // We deliberately skip pre-resolving nets — the loader already set every
    // net.value to 'X' and outputBuf to 'Z'. The first settle reconciles
    // them, and any listener cascade only fires for drivers that actually
    // change off 'X'.
    for (let i = 0; i < graph.components.length; i++) {
      this.dirtyA.push(i);
      this.inDirty[i] = 1;
    }
  }

  // Force a net's value. Models an external driver (test harness, switch, etc.)
  // and schedules listeners for re-evaluation. Pass 'Z' to release the force.
  setInput(netId: string, value: NetState): void {
    const idx = this.graph.netById.get(netId);
    if (idx === undefined) throw new Error(`unknown net: ${netId}`);
    const net = this.graph.nets[idx]!;
    if (net.forced === value) return;
    net.forced = value;
    const newValue = this.computeNetValue(net);
    if (newValue === net.value) return;
    net.value = newValue;
    for (const comp of net.listenerComps) this.markDirty(comp);
  }

  readNet(netId: string): NetState {
    const idx = this.graph.netById.get(netId);
    if (idx === undefined) throw new Error(`unknown net: ${netId}`);
    return this.graph.nets[idx]!.value;
  }

  // Run iterations until the dirty queue empties or MAX_ITERATIONS trips.
  // One settle = one user-visible step.
  settle(): void {
    let iter = 0;
    let now = this.dirtyA;
    let next = this.dirtyB;

    while (now.length > 0) {
      if (iter++ >= this.maxIterations) {
        this.recordOscillation(now, next);
        this.step++;
        return;
      }

      // ---- READ phase ---------------------------------------------------
      // Evaluate every dirty component using the current net state. We stash
      // proposed outputs in each component's outputBuf only during COMMIT, so
      // no component sees a peer's freshly-written value within this iteration.
      const proposedOutputs: NetState[][] = new Array<NetState[]>(now.length);
      const proposedNextStates: unknown[] = new Array<unknown>(now.length);
      for (let i = 0; i < now.length; i++) {
        const compIdx = now[i]!;
        const comp = this.graph.components[compIdx]!;
        const inputs: NetState[] = new Array<NetState>(comp.inputPinIdx.length);
        for (let j = 0; j < comp.inputPinIdx.length; j++) {
          const pinIdx = comp.inputPinIdx[j]!;
          const netIdx = comp.pinNetIdx[pinIdx]!;
          const netVal = this.graph.nets[netIdx]!.value;
          // Pure 'in' pins translate Z → X. 'inout' pins see Z directly.
          inputs[j] = comp.pins[pinIdx]!.dir === 'in' ? readAsLogic(netVal) : netVal;
        }
        const result = comp.primitive.evaluate(inputs, comp.state, comp.params);
        proposedOutputs[i] = result.outputs;
        proposedNextStates[i] = result.nextState;
      }

      // ---- COMMIT phase -------------------------------------------------
      // Write outputs into outputBuf. Track which nets had a driver change so
      // we can re-resolve them once at the end of the phase. Set is iteration-
      // ordered, which keeps the scheduling deterministic.
      const changedNets = new Set<number>();
      for (let i = 0; i < now.length; i++) {
        const compIdx = now[i]!;
        const comp = this.graph.components[compIdx]!;
        const outputs = proposedOutputs[i]!;
        for (let j = 0; j < outputs.length; j++) {
          const newVal = outputs[j]!;
          if (comp.outputBuf[j] !== newVal) {
            comp.outputBuf[j] = newVal;
            const pinIdx = comp.outputPinIdx[j]!;
            const netIdx = comp.pinNetIdx[pinIdx]!;
            changedNets.add(netIdx);
          }
        }
        const ns = proposedNextStates[i];
        if (ns !== undefined) comp.state = ns;
        this.inDirty[compIdx] = 0;
      }
      now.length = 0;

      // Re-resolve every changed net; if the resolved value moved, wake its
      // listeners for the next iteration.
      for (const netIdx of changedNets) {
        const net = this.graph.nets[netIdx]!;
        const newValue = this.computeNetValue(net);
        if (newValue === net.value) continue;
        net.value = newValue;
        for (const comp of net.listenerComps) {
          if (this.inDirty[comp]) continue;
          next.push(comp);
          this.inDirty[comp] = 1;
        }
      }

      // Swap queues.
      const tmp = now;
      now = next;
      next = tmp;
    }

    this.dirtyA = now;
    this.dirtyB = next;
    this.step++;
  }

  // -- helpers --

  private markDirty(compIdx: number): void {
    if (this.inDirty[compIdx]) return;
    this.dirtyA.push(compIdx);
    this.inDirty[compIdx] = 1;
  }

  private computeNetValue(net: RuntimeNet): NetState {
    const scratch = this.resolveScratch;
    scratch.length = 0;
    for (const d of net.drivers) {
      const comp = this.graph.components[d.comp]!;
      scratch.push(comp.outputBuf[d.outIdx]!);
    }
    if (net.forced !== 'Z') scratch.push(net.forced);
    return resolveNet(scratch);
  }

  private recordOscillation(now: number[], next: number[]): void {
    const sample = now.slice(0, 8).map((i) => this.graph.components[i]!.id);
    this.events.push({
      kind: 'oscillation',
      detail: `MAX_ITERATIONS=${this.maxIterations} exceeded; ${now.length} components still dirty (sample: ${sample.join(', ')})`,
      step: this.step,
    });
    for (const c of now) this.inDirty[c] = 0;
    for (const c of next) this.inDirty[c] = 0;
    now.length = 0;
    next.length = 0;
  }
}
