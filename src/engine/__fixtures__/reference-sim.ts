// Frozen f6c3595 scheduler for differential tests and paired benchmarks.
// Keep this evaluation path independent of subsequent scheduler optimizations.
import type { DriverValue, EvalCtx, NetState, RuntimeGraph, RuntimeNet } from '../ir';
import { LOGIC_NET_STATES, NET_STATES, netStateByte, resolveNetInto, type ResolveResult } from '../nets';
import {
  evaluateAnd, evaluateOr, evaluateNand, evaluateNor, evaluateXor, evaluateXnor,
  evaluateNot, evaluateBuf, evaluateDff, evaluateLatch, evaluateTristate, evaluateMux2,
  evaluateDemux2, evaluateDecoder, evaluateAdder, evaluateConst0, evaluateConst1, evaluatePullup, evaluatePulldown,
} from '../primitives/dispatch';

// Default oscillation cap. Combinational chains of depth d settle in d
// iterations; ring oscillators run forever.
export const DEFAULT_MAX_ITERATIONS = 10_000;
const MAX_RETAINED_EVENTS = 1024;

export interface SimEvent {
  kind: 'oscillation' | 'contention';
  detail: string;
  step: number;
}

export interface SimulatorOptions {
  maxIterations?: number;
  rateHz?: number;
  onEvent?: (event: SimEvent) => void;
}

export class ReferenceSimulator {
  readonly graph: RuntimeGraph;
  // Recent diagnostic history. Observers receive every emitted event.
  readonly events: SimEvent[] = [];
  eventsEmitted = 0;
  step = 0;
  // Clock time advances only on tick(), independently of input settling.
  private tickStep = 0;
  // Worker-controlled tick rate handed to evaluate() via EvalCtx. Defaults to
  // 1 Hz so unit tests that never set it get sensible numbers.
  rateHz: number;

  private readonly maxIterations: number;
  private readonly onEvent?: (event: SimEvent) => void;
  // Two dirty queues, swapped per iteration. Insertion order is iteration order.
  private dirtyA: number[] = [];
  private dirtyB: number[] = [];
  // Bitmap: 1 if component is currently in either dirty queue.
  private readonly inDirty: Uint8Array;
  // Reusable scratch buffer for resolving each net's drivers without allocation.
  private readonly resolveScratch: DriverValue[] = [];
  // Nets that already emitted a contention event during the current settle().
  // Cleared at the start of each settle so repeats during one step don't spam.
  private readonly contendedThisSettle: Set<number> = new Set();
  // Components flagged tickActive in their def — re-dirtied at every tick().
  private readonly tickActive: number[] = [];
  // Net-changed mark + commit-order queue, replacing a per-iteration Set.
  private readonly netChanged: Uint8Array;
  private readonly changedNetsQueue: number[] = [];
  // Reusable result struct for resolveNetInto — avoids per-call allocation.
  private readonly resolveResult: ResolveResult = { value: 'Z', contention: false };

  private initialResolution = true;

  constructor(graph: RuntimeGraph, opts: SimulatorOptions = {}) {
    this.graph = graph;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.onEvent = opts.onEvent;
    this.rateHz = opts.rateHz ?? 1;
    this.inDirty = new Uint8Array(graph.components.length);
    this.netChanged = new Uint8Array(graph.nets.length);
    // Initial state per SIMULATION.md: every component dirty, every net X.
    // Keep the initial X snapshot until the first READ phase. Its COMMIT
    // resolves every net, including drivers which remain at their initial Z.
    for (let i = 0; i < graph.components.length; i++) {
      this.dirtyA.push(i);
      this.inDirty[i] = 1;
      if (graph.components[i]!.primitive.tickActive) this.tickActive.push(i);
    }
  }

  // Force a net's value. Models an external driver (test harness, switch, etc.)
  // and schedules listeners for re-evaluation. Pass 'Z' to release the force.
  setInput(netId: string, value: DriverValue): void {
    const idx = this.graph.netById.get(netId);
    if (idx === undefined) throw new Error(`unknown net: ${netId}`);
    const net = this.graph.nets[idx]!;
    if (net.forced === value) return;
    net.forced = value;
    const newValue = netStateByte(this.computeNetValue(net, idx));
    if (newValue === this.graph.netValues[idx]) return;
    this.graph.netValues[idx] = newValue;
    for (const comp of net.listenerComps) this.markDirty(comp);
  }

  readNet(netId: string): NetState {
    const idx = this.graph.netById.get(netId);
    if (idx === undefined) throw new Error(`unknown net: ${netId}`);
    return NET_STATES[this.graph.netValues[idx]!]!;
  }

  // Update a behavioral component's pin-keyed state slot. Used for io.switch
  // (UI toggles its output) and analogous user-driven inputs. The component's
  // evaluate() reads its state via the same key. Marks the component dirty.
  setComponentInput(compId: string, pin: string, value: NetState): void {
    const idx = this.graph.componentById.get(compId);
    if (idx === undefined) throw new Error(`unknown component: ${compId}`);
    const comp = this.graph.components[idx]!;
    const state = (comp.state ?? {}) as Record<string, NetState>;
    if (state[pin] === value) return;
    comp.state = { ...state, [pin]: value };
    this.markDirty(idx);
  }

  // One simulator tick: re-mark every tickActive component dirty (clocks, etc.)
  // and settle. Workers call this at their target rate; pure combinational
  // tests can use settle() directly without advancing tickActive components.
  tick(): void {
    // A fresh graph's first tick also resolves its power-on state at time 0.
    if (!this.initialResolution) this.tickStep++;
    for (const compIdx of this.tickActive) this.markDirty(compIdx);
    this.settle();
  }

  // Run iterations until the dirty queue empties or MAX_ITERATIONS trips.
  // One settle = one user-visible step.
  settle(): void {
    let iter = 0;
    let now = this.dirtyA;
    let next = this.dirtyB;
    this.contendedThisSettle.clear();
    // Stable for this settle. Diagnostic step numbers count all settlements;
    // evaluator time counts only simulation ticks.
    const ctx: EvalCtx = { step: this.tickStep, rateHz: this.rateHz };

    while (now.length > 0) {
      if (iter++ >= this.maxIterations) {
        this.recordOscillation(now, next);
        this.step++;
        return;
      }

      // ---- READ phase ---------------------------------------------------
      // Evaluate every dirty component using the current net state. Each
      // primitive writes into its own pre-allocated proposedBuf; outputBuf
      // (the values currently being driven onto each net) only updates in
      // COMMIT, so no peer sees this iteration's outputs while it evaluates.
      const components = this.graph.components;
      const nets = this.graph.nets;
      const netValues = this.graph.netValues;
      for (let i = 0; i < now.length; i++) {
        const compIdx = now[i]!;
        const comp = components[compIdx]!;
        const inputBuf = comp.inputBuf;
        const inputNetIdx = comp.inputNetIdx;
        const inputIsLogic = comp.inputIsLogic;
        const inputCount = inputBuf.length;
        for (let j = 0; j < inputCount; j++) {
          const netVal = netValues[inputNetIdx[j]!]!;
          // Pure 'in' pins translate Z → X. 'inout' pins see Z directly.
          inputBuf[j] = (inputIsLogic[j] === 1 ? LOGIC_NET_STATES : NET_STATES)[netVal]!;
        }
        let ns: unknown;
        // Literal EvalKind tags give a jump table and stable call targets.
        switch (comp.evalKind) {
          case 1: ns = evaluateAnd(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 2: ns = evaluateOr(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 3: ns = evaluateNand(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 4: ns = evaluateNor(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 5: ns = evaluateXor(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 6: ns = evaluateXnor(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 7: ns = evaluateNot(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 8: ns = evaluateBuf(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 9: ns = evaluateDff(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 10: ns = evaluateLatch(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 11: ns = evaluateTristate(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 12: ns = evaluateMux2(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 13: ns = evaluateDemux2(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 14: ns = evaluateDecoder(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 15: ns = evaluateAdder(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 16: ns = evaluateConst0(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 17: ns = evaluateConst1(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 18: ns = evaluatePullup(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          case 19: ns = evaluatePulldown(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
          default: ns = comp.primitive.evaluate(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx); break;
        }
        // State updates are local to each component's evaluate(); no peer
        // reads them from outside, so we apply immediately rather than
        // deferring through a parallel array.
        if (ns !== undefined) comp.state = ns;
      }

      // ---- COMMIT phase -------------------------------------------------
      // Compare each component's proposedBuf against its outputBuf; on change,
      // copy through and queue the affected net for re-resolution. The
      // Uint8Array mark + queue replaces a per-iteration Set; queue order is
      // commit order, which keeps the scheduling deterministic.
      const netChanged = this.netChanged;
      const changedQueue = this.changedNetsQueue;
      changedQueue.length = 0;
      if (this.initialResolution) {
        for (let n = 0; n < nets.length; n++) { netChanged[n] = 1; changedQueue.push(n); }
        this.initialResolution = false;
      }
      for (let i = 0; i < now.length; i++) {
        const compIdx = now[i]!;
        const comp = components[compIdx]!;
        const proposedBuf = comp.proposedBuf;
        const outputBuf = comp.outputBuf;
        const outputNetIdx = comp.outputNetIdx;
        for (let j = 0; j < proposedBuf.length; j++) {
          const newVal = proposedBuf[j]!;
          if (outputBuf[j] !== newVal) {
            outputBuf[j] = newVal;
            const netIdx = outputNetIdx[j]!;
            if (!netChanged[netIdx]) {
              netChanged[netIdx] = 1;
              changedQueue.push(netIdx);
            }
          }
        }
        this.inDirty[compIdx] = 0;
      }
      now.length = 0;

      // Re-resolve every changed net; if the resolved value moved, wake its
      // listeners for the next iteration.
      for (let q = 0; q < changedQueue.length; q++) {
        const netIdx = changedQueue[q]!;
        netChanged[netIdx] = 0;
        const net = nets[netIdx]!;
        const newValue = netStateByte(this.computeNetValue(net, netIdx));
        if (newValue === netValues[netIdx]) continue;
        netValues[netIdx] = newValue;
        const listeners = net.listenerComps;
        for (let k = 0; k < listeners.length; k++) {
          const comp = listeners[k]!;
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

  private computeNetValue(net: RuntimeNet, netIdx: number): NetState {
    const drivers = net.drivers;
    const components = this.graph.components;
    // Most nets have one driver and no external force. No scratch copy or
    // resolution pass is needed: a lone weak pull collapses to its strong
    // value, and 0/1/Z/X already are resolved. Contention needs two drivers.
    if (net.forced === 'Z' && drivers.length <= 1) {
      if (drivers.length === 0) return 'Z';
      const driver = drivers[0]!;
      const value = components[driver.comp]!.outputBuf[driver.outIdx]!;
      return value === 'H' ? 1 : value === 'L' ? 0 : value;
    }
    const scratch = this.resolveScratch;
    scratch.length = 0;
    for (let i = 0; i < drivers.length; i++) {
      const d = drivers[i]!;
      scratch.push(components[d.comp]!.outputBuf[d.outIdx]!);
    }
    if (net.forced !== 'Z') scratch.push(net.forced);
    const result = this.resolveResult;
    resolveNetInto(scratch, result);
    if (result.contention && !this.contendedThisSettle.has(netIdx)) {
      this.contendedThisSettle.add(netIdx);
      this.recordEvent({
        kind: 'contention',
        detail: `net "${net.id}" driven by conflicting strong values`,
        step: this.step,
      });
    }
    return result.value;
  }

  private recordOscillation(now: number[], next: number[]): void {
    const sample = now.slice(0, 8).map((i) => this.graph.components[i]!.id);
    this.recordEvent({
      kind: 'oscillation',
      detail: `MAX_ITERATIONS=${this.maxIterations} exceeded; ${now.length} components still dirty (sample: ${sample.join(', ')})`,
      step: this.step,
    });
    for (const c of now) this.inDirty[c] = 0;
    for (const c of next) this.inDirty[c] = 0;
    now.length = 0;
    next.length = 0;
  }

  private recordEvent(event: SimEvent): void {
    this.eventsEmitted++;
    this.events.push(event);
    if (this.events.length > MAX_RETAINED_EVENTS) this.events.shift();
    this.onEvent?.(event);
  }
}
