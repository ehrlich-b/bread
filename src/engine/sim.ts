import { bindDriverViews, compileTables, driverByte, DRIVER_STATES, RESOLVED_DRIVERS, RESOLVED_MASKS } from './compiled';
import type { DriverValue, EvalCtx, NetState, RuntimeComponent, RuntimeGraph } from './ir';
import { LOGIC_NET_STATES, NET_STATES } from './nets';
import {
  evaluateAnd, evaluateOr, evaluateNand, evaluateNor, evaluateXor, evaluateXnor,
  evaluateNot, evaluateBuf, evaluateDff, evaluateLatch, evaluateTristate, evaluateMux2,
  evaluateDemux2, evaluateDecoder, evaluateAdder, evaluateConst0, evaluateConst1, evaluatePullup, evaluatePulldown,
} from './primitives/dispatch';

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

export class Simulator {
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
  // Generation marks bound each FIFO queue to the component count. Keep
  // fixed storage and swap counts instead of truncating/growing JS arrays.
  private dirtyA: Uint32Array;
  private dirtyB: Uint32Array;
  private dirtyCount = 0;
  // A component is queued if its mark equals dirtyGeneration. Advancing
  // the generation clears a whole READ batch without scanning its members.
  private readonly inDirty: Uint32Array;
  private dirtyGeneration = 1;
  // Nets that already emitted a contention event during the current settle().
  // A fresh generation at each settle prevents repeats within that step.
  private readonly contendedThisSettle: Uint32Array;
  private contentionGeneration = 1;
  // Components flagged tickActive in their def — re-dirtied at every tick().
  private readonly tickActive: number[] = [];
  // Net-changed mark + commit-order queue, replacing a per-iteration Set.
  private readonly netChanged: Uint8Array;
  private readonly changedNetsQueue: number[] = [];
  private readonly commitQueue: number[] = [];

  private readonly tables: ReturnType<typeof compileTables>;

  private initialResolution = true;

  constructor(graph: RuntimeGraph, opts: SimulatorOptions = {}) {
    this.graph = graph;
    this.tables = compileTables(graph);
    bindDriverViews(graph, this.tables);
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.onEvent = opts.onEvent;
    this.rateHz = opts.rateHz ?? 1;
    this.dirtyA = new Uint32Array(graph.components.length);
    this.dirtyB = new Uint32Array(graph.components.length);
    this.inDirty = new Uint32Array(graph.components.length);
    this.contendedThisSettle = new Uint32Array(graph.nets.length);
    this.netChanged = new Uint8Array(graph.nets.length);
    // Initial state per SIMULATION.md: every component dirty, every net X.
    // Keep the initial X snapshot until the first READ phase. Its COMMIT
    // resolves every net, including drivers which remain at their initial Z.
    for (let i = 0; i < graph.components.length; i++) {
      this.dirtyA[this.dirtyCount++] = i;
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
    const newValue = this.computeNetByte(idx);
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
    for (let i = 0; i < this.tickActive.length; i++) this.markDirty(this.tickActive[i]!);
    this.settle();
  }

  // Run iterations until the dirty queue empties or MAX_ITERATIONS trips.
  // One settle = one user-visible step.
  settle(): void {
    let iter = 0;
    let now = this.dirtyA;
    let next = this.dirtyB;
    let nowCount = this.dirtyCount;
    let nextCount = 0;
    this.contentionGeneration = (this.contentionGeneration + 1) >>> 0;
    if (this.contentionGeneration === 0) {
      this.contendedThisSettle.fill(0);
      this.contentionGeneration = 1;
    }
    // Stable for this settle. Diagnostic step numbers count all settlements;
    // evaluator time counts only simulation ticks.
    const ctx: EvalCtx = { step: this.tickStep, rateHz: this.rateHz };

    while (nowCount > 0) {
      if (iter++ >= this.maxIterations) {
        this.recordOscillation(now, nowCount);
        this.step++;
        return;
      }

      // ---- READ phase ---------------------------------------------------
      // Evaluate every dirty component using the current net state. Each
      // primitive uses proposedBuf or a packed table word; driver storage
      // (also viewed through outputBuf) only updates in
      // COMMIT, so no peer sees this iteration's outputs while it evaluates.
      const components = this.graph.components;
      const nets = this.graph.nets;
      const netValues = this.graph.netValues;
      const tables = this.tables;
      const commitQueue = this.commitQueue;
      let commitCount = 0;
      for (let i = 0; i < nowCount; i++) {
        const compIdx = now[i]!;
        const comp = components[compIdx]!;
        const tableOffset = tables.offsets[compIdx]!;
        if (tableOffset && comp.evalKind === tables.kinds[compIdx]) {
          const base = compIdx * 5;
          const count = tables.inputCounts[compIdx]!;
          let vector = (count > 0 ? netValues[tables.inputs[base]!]! : 0)
            | (count > 1 ? netValues[tables.inputs[base + 1]!]! << 2 : 0)
            | (count > 2 ? netValues[tables.inputs[base + 2]!]! << 4 : 0)
            | (count > 3 ? netValues[tables.inputs[base + 3]!]! << 6 : 0)
            | (count > 4 ? netValues[tables.inputs[base + 4]!]! << 8 : 0);
          if (tables.kinds[compIdx] === 9) {
            const state = comp.state as { q: NetState; prevClk: NetState };
            const q = state.q;
            const prevClk = state.prevClk;
            vector |= (typeof q === 'number' ? q : q === 'Z' ? 2 : 3) << (count * 2);
            vector |= (typeof prevClk === 'number' ? prevClk : prevClk === 'Z' ? 2 : 3) << ((count + 1) * 2);
          }
          const word = tables.words[tableOffset + vector]!;
          if (tables.kinds[compIdx] === 9) comp.state = {
            q: NET_STATES[word & 15]!,
            prevClk: LOGIC_NET_STATES[netValues[tables.inputs[base + 1]!]!]!,
          };
          tables.proposed[compIdx] = word;
          if (word !== tables.current[compIdx]) commitQueue[commitCount++] = compIdx;
          continue;
        }
        if (tables.arithmetic[compIdx] && comp.evalKind === 15) {
          const width = tables.outputOffsets[compIdx + 1]! - tables.outputOffsets[compIdx]! - 1;
          const inputs = comp.inputNetIdx;
          let carry = netValues[inputs[width * 2]!]!;
          if (carry >= 2) carry = 3;
          let word = 0;
          for (let pin = 0; pin < width; pin++) {
            const a = netValues[inputs[pin]!]!;
            const b = netValues[inputs[width + pin]!]!;
            const sum = a < 2 && b < 2 && carry < 2 ? a ^ b ^ carry : 3;
            word |= sum << (pin * 4);
            // Four-state majority: two agreeing known votes dominate X/Z.
            if (a === b && a < 2) carry = a;
            else if (carry === 0) carry = a === 0 || b === 0 ? 0 : 3;
            else if (carry === 1) carry = a === 1 || b === 1 ? 1 : 3;
            else carry = 3;
          }
          word |= carry << (width * 4);
          tables.proposed[compIdx] = word;
          if (word !== tables.current[compIdx]) commitQueue[commitCount++] = compIdx;
          continue;
        }
        this.evaluate(comp, netValues, ctx);
        if (comp.proposedBuf.length) commitQueue[commitCount++] = compIdx;
      }

      // ---- COMMIT phase -------------------------------------------------
      // Commit changed table words and normal evaluator proposals to driver
      // bytes, queueing affected nets for re-resolution. The
      // Uint8Array mark + queue replaces a per-iteration Set; queue order is
      // commit order, which keeps the scheduling deterministic.
      const netChanged = this.netChanged;
      const changedQueue = this.changedNetsQueue;
      let changedCount = 0;
      if (this.initialResolution) {
        for (let n = 0; n < nets.length; n++) { netChanged[n] = 1; changedQueue[changedCount++] = n; }
        this.initialResolution = false;
      }
      const generation = this.nextDirtyGeneration();
      for (let i = 0; i < commitCount; i++) {
        const compIdx = commitQueue[i]!;
        const compiled = (tables.offsets[compIdx] !== 0 || tables.arithmetic[compIdx] !== 0) && components[compIdx]!.evalKind === tables.kinds[compIdx];
        const proposedBuf = compiled ? null : components[compIdx]!.proposedBuf;
        let word = tables.proposed[compIdx]!;
        if (compiled) tables.current[compIdx] = word;
        const start = tables.outputOffsets[compIdx]!;
        const end = tables.outputOffsets[compIdx + 1]!;
        for (let slot = start; slot < end; slot++) {
          const pin = slot - start;
          const newVal = compiled ? word & 15 : driverByte(proposedBuf![pin]!);
          word >>>= 4;
          if (tables.driven[slot] !== newVal) {
            tables.driven[slot] = newVal;
            if (!compiled && (tables.offsets[compIdx] || tables.arithmetic[compIdx])) tables.current[compIdx] = (tables.current[compIdx]! & ~(15 << (pin * 4))) | (newVal << (pin * 4));
            const netIdx = tables.outputNets[slot]!;
            if (!netChanged[netIdx]) {
              netChanged[netIdx] = 1;
              changedQueue[changedCount++] = netIdx;
            }
          }
        }
      }

      // Re-resolve every changed net; if the resolved value moved, wake its
      // listeners for the next iteration.
      for (let q = 0; q < changedCount; q++) {
        const netIdx = changedQueue[q]!;
        netChanged[netIdx] = 0;
        const driver = tables.singleDrivers[netIdx]!;
        const newValue = driver >= 0 && tables.forced[netIdx] === 2
          ? RESOLVED_DRIVERS[tables.driven[driver]!]!
          : this.computeNetByte(netIdx);
        if (newValue === netValues[netIdx]) continue;
        netValues[netIdx] = newValue;
        const end = tables.listenerOffsets[netIdx + 1]!;
        for (let k = tables.listenerOffsets[netIdx]!; k < end; k++) {
          const comp = tables.listeners[k]!;
          if (this.inDirty[comp] === generation) continue;
          next[nextCount++] = comp;
          this.inDirty[comp] = generation;
        }
      }

      // Swap queues.
      const tmp = now;
      now = next;
      next = tmp;
      nowCount = nextCount;
      nextCount = 0;
    }

    this.dirtyA = now;
    this.dirtyB = next;
    this.dirtyCount = 0;
    this.step++;
  }

  // -- helpers --

  private evaluate(comp: RuntimeComponent, netValues: Uint8Array, ctx: EvalCtx): void {
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

  private nextDirtyGeneration(): number {
    this.dirtyGeneration = (this.dirtyGeneration + 1) >>> 0;
    if (this.dirtyGeneration === 0) {
      this.inDirty.fill(0);
      this.dirtyGeneration = 1;
    }
    return this.dirtyGeneration;
  }

  private markDirty(compIdx: number): void {
    if (this.inDirty[compIdx] === this.dirtyGeneration) return;
    this.dirtyA[this.dirtyCount++] = compIdx;
    this.inDirty[compIdx] = this.dirtyGeneration;
  }

  private computeNetByte(netIdx: number): number {
    const tables = this.tables;
    const start = tables.driverOffsets[netIdx]!;
    const end = tables.driverOffsets[netIdx + 1]!;
    const forced = tables.forced[netIdx]!;
    if (forced === 2 && end - start <= 1) {
      return start === end ? 2 : RESOLVED_DRIVERS[tables.driven[tables.drivers[start]!]!]!;
    }
    let mask = forced === 2 ? 0 : 1 << forced;
    for (let i = start; i < end; i++) mask |= 1 << tables.driven[tables.drivers[i]!]!;
    if ((mask & 3) === 3 && this.contendedThisSettle[netIdx] !== this.contentionGeneration) {
      this.contendedThisSettle[netIdx] = this.contentionGeneration;
      this.recordEvent({
        kind: 'contention',
        detail: `net "${this.graph.nets[netIdx]!.id}" driven by conflicting strong values`,
        step: this.step,
      });
    }
    return RESOLVED_MASKS[mask]!;
  }

  private recordOscillation(now: Uint32Array, count: number): void {
    const sample = Array.from(now.subarray(0, Math.min(count, 8)), i => this.graph.components[i]!.id);
    this.recordEvent({
      kind: 'oscillation',
      detail: `MAX_ITERATIONS=${this.maxIterations} exceeded; ${count} components still dirty (sample: ${sample.join(', ')})`,
      step: this.step,
    });
    this.nextDirtyGeneration();
    this.dirtyCount = 0;
  }

  private recordEvent(event: SimEvent): void {
    this.eventsEmitted++;
    this.events.push(event);
    if (this.events.length > MAX_RETAINED_EVENTS) this.events.shift();
    this.onEvent?.(event);
  }
}
