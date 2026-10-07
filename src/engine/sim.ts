import type { DriverValue, EvalCtx, NetState, RuntimeGraph, RuntimeNet } from './ir';

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
  rateHz?: number;
}

// ---- Internal value encoding -------------------------------------------------
// The simulator's hot path works on small integers instead of the string
// NetState values so every buffer can be a typed array and every comparison is
// an integer op.  Public entry points (setInput/readNet, net.value, component
// state objects) still speak the string NetState language; the encode/decode
// tables below translate at the boundary.
//
// Driver values (what a component outputs):  0,1, 2=Z, 3=X, 4=L, 5=H
// Net/input values (resolved):               0,1, 2=Z, 3=X

const TO_DRIVER: Record<string, number> = { Z: 2, X: 3, L: 4, H: 5 };
const TO_NET: Record<string, number> = { Z: 2, X: 3 };
export const decodeNet = (v: number): NetState =>
  v === 2 ? 'Z' : v === 3 ? 'X' : ((v as 0 | 1) || 0) as NetState;

const encDriver = (v: DriverValue): number => {
  if (v === 0 || v === 1) return v;
  return TO_DRIVER[v]!;
};
const encNet = (v: NetState): number => {
  if (v === 0 || v === 1) return v;
  return TO_NET[v]!;
};

// Native primitive kinds that get an inlined integer evaluator. Everything else
// (behavioral chips and any primitive not listed here) falls back to the
// original string-buffer path.
const K_NOT = 1;
const K_BUF = 2;
const K_MUX2 = 3;
const K_DFF = 4;
const K_TRISTATE = 5;
const K_CONST = 7;
const K_ADDER = 9;
const K_AND = 10;
const K_OR = 11;
const K_XOR = 12;
const K_NAND = 13;
const K_NOR = 14;
const K_XNOR = 15;


export class Simulator {
  readonly graph: RuntimeGraph;
  readonly events: SimEvent[] = [];
  step = 0;
  // Clock time advances only on tick(), independently of input settling.
  private tickStep = 0;
  // Worker-controlled tick rate handed to evaluate() via EvalCtx. Defaults to
  // 1 Hz so unit tests that never set it get sensible numbers.
  rateHz: number;

  private readonly maxIterations: number;
  // Two dirty queues, swapped per iteration. Insertion order is iteration order.
  private dirtyA: number[] = [];
  private dirtyB: number[] = [];
  // Bitmap: 1 if component is currently in either dirty queue.
  private readonly inDirty: Uint8Array;
  // Nets that already emitted a contention event during the current settle().
  // Cleared at the start of each settle so repeats during one step don't spam.
  private readonly contendedThisSettle: Set<number> = new Set();
  // Components flagged tickActive in their def — re-dirtied at every tick().
  private readonly tickActive: number[] = [];
  // Net-changed mark + commit-order queue, replacing a per-iteration Set.
  private readonly netChanged: Uint8Array;
  private readonly changedNetsQueue: number[] = [];

  // ---- Native fast-path state (SoA over the component list) ----------------
  // native[i]: 1 if component i is evaluated by the inlined integer path.
  private readonly native: Uint8Array;
  // kindOf[i]: native kind id for component i (0 = slow path).
  private readonly kindOf: Int16Array;
  // flags[i]: bit0 oeActiveLow (TRISTATE), bit1 clrActiveLow (DFF), bit2 preActiveLow (DFF).
  private readonly compFlags: Uint8Array;
  // width/arity for MUX2/ADDER/nary gates.
  private readonly compWidth: Int16Array;
  // Constant driven value for CONST_*/PULLUP/PULLDOWN (driver-encoded).
  private readonly constVal: Uint8Array;
  // Per-component input/output buffer dimensions.
  private readonly compInCount: Int16Array;
  private readonly compOutCount: Int16Array;
  // Flat input scratch, proposed outputs and committed outputs for native
  // components. Indexed by a per-component offset; flat so the inner loops
  // stay on one typed array.
  private readonly inBuf: Uint8Array;
  private readonly propBuf: Uint8Array;
  private readonly outBuf: Uint8Array;
  private readonly inOff: Int32Array;
  private readonly outOff: Int32Array;
  // DFF state (q, prevClk) kept off the component object so the hot loop never
  // allocates or shape-shifts the public state.
  private readonly dq: Uint8Array;
  private readonly dprev: Uint8Array;

  // ---- Flat net driver/listener lists --------------------------------------
  // drivers for net i: [ndOff[i], ndOff[i+1]); pairs (ndComp[k], ndOut[k]).
  private readonly ndComp: Int32Array;
  private readonly ndOut: Int32Array;
  private readonly ndOff: Int32Array;
  private readonly nl: Int32Array;
  private readonly nlOff: Int32Array;

  // Resolved net values in encoded form (source of truth for native inputs)
  // plus the encoded forced value.
  private readonly netV: Uint8Array;
  private readonly forcedV: Uint8Array;

  private initialResolution = true;

  constructor(graph: RuntimeGraph, opts: SimulatorOptions = {}) {
    this.graph = graph;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.rateHz = opts.rateHz ?? 1;
    const nComp = graph.components.length;
    const nNet = graph.nets.length;
    this.inDirty = new Uint8Array(nComp);
    this.netChanged = new Uint8Array(nNet);
    this.native = new Uint8Array(nComp);
    this.kindOf = new Int16Array(nComp);
    this.compFlags = new Uint8Array(nComp);
    this.compWidth = new Int16Array(nComp);
    this.constVal = new Uint8Array(nComp);
    this.compInCount = new Int16Array(nComp);
    this.compOutCount = new Int16Array(nComp);
    this.inOff = new Int32Array(nComp);
    this.outOff = new Int32Array(nComp);
    this.dq = new Uint8Array(nComp).fill(3); // 'X'
    this.dprev = new Uint8Array(nComp).fill(3);
    this.netV = new Uint8Array(nNet).fill(3);
    this.forcedV = new Uint8Array(nNet).fill(2);

    let totalIn = 0;
    let totalOut = 0;
    for (let i = 0; i < nComp; i++) {
      const comp = graph.components[i]!;
      this.compInCount[i] = comp.inputNetIdx.length;
      this.compOutCount[i] = comp.outputNetIdx.length;
      this.inOff[i] = totalIn;
      this.outOff[i] = totalOut;
      totalIn += comp.inputNetIdx.length;
      totalOut += comp.outputNetIdx.length;
      const t = comp.typeId;
      const params = comp.params as Record<string, unknown> | undefined;
      let kind = 0;
      switch (t) {
        case 'prim.NOT': kind = K_NOT; break;
        case 'prim.BUF': kind = K_BUF; break;
        case 'prim.AND': kind = K_AND; break;
        case 'prim.OR': kind = K_OR; break;
        case 'prim.XOR': kind = K_XOR; break;
        case 'prim.NAND': kind = K_NAND; break;
        case 'prim.NOR': kind = K_NOR; break;
        case 'prim.XNOR': kind = K_XNOR; break;
        case 'prim.MUX2': kind = K_MUX2; this.compWidth[i] = (params as { width?: number }).width ?? 1; break;
        case 'prim.ADDER': kind = K_ADDER; this.compWidth[i] = (params as { width?: number }).width ?? 1; break;
        case 'prim.DFF': {
          kind = K_DFF;
          const p = (params ?? {}) as { clrActiveLow?: boolean; preActiveLow?: boolean };
          if (p.clrActiveLow) this.compFlags[i]! |= 2;
          if (p.preActiveLow) this.compFlags[i]! |= 4;
          break;
        }
        case 'prim.TRISTATE': {
          kind = K_TRISTATE;
          if ((params ?? {}).oeActiveLow as boolean | undefined) this.compFlags[i]! |= 1;
          break;
        }
        case 'prim.CONST_0': kind = K_CONST; this.constVal[i] = 0; break;
        case 'prim.CONST_1': kind = K_CONST; this.constVal[i] = 1; break;
        case 'prim.PULLUP': kind = K_CONST; this.constVal[i] = 5; break;
        case 'prim.PULLDOWN': kind = K_CONST; this.constVal[i] = 4; break;
        default: kind = 0; break;
      }
      if (kind !== 0) {
        this.native[i] = 1;
        this.kindOf[i] = kind;
        if (kind >= K_AND && kind <= K_XNOR) this.compWidth[i] = comp.inputNetIdx.length;
      }
      if (comp.primitive.tickActive) this.tickActive.push(i);
    }
    this.inBuf = new Uint8Array(totalIn).fill(3);
    this.propBuf = new Uint8Array(totalOut).fill(2);
    this.outBuf = new Uint8Array(totalOut).fill(2);

    // Flatten net drivers/listeners.
    const dc: number[] = [];
    const doo: number[] = [];
    const ll: number[] = [];
    const ndOff = new Int32Array(nNet + 1);
    const nlOff = new Int32Array(nNet + 1);
    for (let i = 0; i < nNet; i++) {
      ndOff[i] = dc.length;
      const net = graph.nets[i]!;
      for (const d of net.drivers) {
        dc.push(d.comp);
        doo.push(d.outIdx);
      }
      nlOff[i] = ll.length;
      for (const l of net.listenerComps) ll.push(l);
    }
    ndOff[nNet] = dc.length;
    nlOff[nNet] = ll.length;
    this.ndComp = Int32Array.from(dc);
    this.ndOut = Int32Array.from(doo);
    this.ndOff = ndOff;
    this.nl = Int32Array.from(ll);
    this.nlOff = nlOff;

    // Initial state per SIMULATION.md: every component dirty, every net X.
    for (let i = 0; i < nComp; i++) {
      this.dirtyA.push(i);
      this.inDirty[i] = 1;
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
    this.forcedV[idx] = encDriver(value);
    const newValue = this.computeIntNetValue(idx);
    if (newValue === this.netV[idx]) return;
    this.netV[idx] = newValue;
    net.value = decodeNet(newValue);
    for (const comp of net.listenerComps) this.markDirty(comp);
  }

  readNet(netId: string): NetState {
    const idx = this.graph.netById.get(netId);
    if (idx === undefined) throw new Error(`unknown net: ${netId}`);
    return this.graph.nets[idx]!.value;
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

    const components = this.graph.components;
    const nets = this.graph.nets;
    const inDirty = this.inDirty;
    const native = this.native;
    const kindOf = this.kindOf;
    const compFlags = this.compFlags;
    const compWidth = this.compWidth;
    const constVal = this.constVal;
    const compInCount = this.compInCount;
    const compOutCount = this.compOutCount;
    const inOff = this.inOff;
    const outOff = this.outOff;
    const inBuf = this.inBuf;
    const propBuf = this.propBuf;
    const outBuf = this.outBuf;
    const dq = this.dq;
    const dprev = this.dprev;
    const netV = this.netV;
    const changedQueue = this.changedNetsQueue;
    const netChanged = this.netChanged;

    while (now.length > 0) {
      if (iter++ >= this.maxIterations) {
        this.recordOscillation(now, next);
        this.step++;
        return;
      }

      // ---- READ phase ---------------------------------------------------
      // Evaluate every dirty component using the current net state. Native
      // components write into the flat propBuf (encoded ints); slow components
      // write into their own pre-allocated string proposedBuf. outputBuf/
      // outBuf (the values currently being driven onto each net) only updates
      // in COMMIT, so no peer sees this iteration's outputs while it evaluates.
      const nowLen = now.length;
      for (let i = 0; i < nowLen; i++) {
        const ci = now[i]!;
        if (native[ci]) {
          const off = inOff[ci]!;
          const cin = compInCount[ci]!;
          const inN = components[ci]!.inputNetIdx;
          const inL = components[ci]!.inputIsLogic;
          if (cin === 1) {
            const nv = netV[inN[0]!]!;
            inBuf[off] = inL[0] === 1 ? (nv === 2 ? 3 : nv) : nv;
          } else {
            for (let j = 0; j < cin; j++) {
              const nv = netV[inN[j]!]!;
              inBuf[off + j] = inL[j] === 1 ? (nv === 2 ? 3 : nv) : nv;
            }
          }
          const po = outOff[ci]!;
          switch (kindOf[ci]) {
            case K_NOT: {
              const a = inBuf[off]!;
              propBuf[po] = a === 0 ? 1 : a === 1 ? 0 : 3;
              break;
            }
            case K_BUF: {
              propBuf[po] = inBuf[off]!;
              break;
            }
            case K_AND:
            case K_NAND: {
              const w = compWidth[ci]!;
              let acc = inBuf[off]!;
              for (let j = 1; j < w; j++) {
                const b = inBuf[off + j]!;
                if (acc === 0 || b === 0) acc = 0;
                else if (acc === 3 || b === 3) acc = 3;
                else acc = 1;
              }
              propBuf[po] = kindOf[ci] === K_NAND ? (acc === 0 ? 1 : acc === 1 ? 0 : 3) : acc;
              break;
            }
            case K_OR:
            case K_NOR: {
              const w = compWidth[ci]!;
              let acc = inBuf[off]!;
              for (let j = 1; j < w; j++) {
                const b = inBuf[off + j]!;
                if (acc === 1 || b === 1) acc = 1;
                else if (acc === 3 || b === 3) acc = 3;
                else acc = 0;
              }
              propBuf[po] = kindOf[ci] === K_NOR ? (acc === 1 ? 0 : acc === 0 ? 1 : 3) : acc;
              break;
            }
            case K_XOR:
            case K_XNOR: {
              const w = compWidth[ci]!;
              let acc = inBuf[off]!;
              for (let j = 1; j < w; j++) {
                const b = inBuf[off + j]!;
                if (acc === 3 || b === 3) acc = 3;
                else acc = acc === b ? 0 : 1;
              }
              propBuf[po] = kindOf[ci] === K_XNOR ? (acc === 0 ? 1 : acc === 1 ? 0 : 3) : acc;
              break;
            }
            case K_MUX2: {
              const w = compWidth[ci]!;
              const s = inBuf[off + 2 * w]!;
              if (s === 0) {
                for (let j = 0; j < w; j++) propBuf[po + j] = inBuf[off + j]!;
              } else if (s === 1) {
                for (let j = 0; j < w; j++) propBuf[po + j] = inBuf[off + w + j]!;
              } else {
                for (let j = 0; j < w; j++) {
                  const a = inBuf[off + j]!;
                  const b = inBuf[off + w + j]!;
                  propBuf[po + j] = a === b && (a === 0 || a === 1) ? a : 3;
                }
              }
              break;
            }
            case K_ADDER: {
              const w = compWidth[ci]!;
              let c = inBuf[off + 2 * w]!;
              for (let j = 0; j < w; j++) {
                const a = inBuf[off + j]!;
                const b = inBuf[off + w + j]!;
                // sum = xor(xor(a,b),c)
                const ab = a === 3 || b === 3 ? 3 : a === b ? 0 : 1;
                const s = ab === 3 || c === 3 ? 3 : ab === c ? 0 : 1;
                propBuf[po + j] = s;
                // majority(a,b,c) = (a&b)|(a&c)|(b&c)
                const abAnd = a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : 3;
                const acAnd = a === 0 || c === 0 ? 0 : a === 1 && c === 1 ? 1 : 3;
                const bcAnd = b === 0 || c === 0 ? 0 : b === 1 && c === 1 ? 1 : 3;
                const or1 = abAnd === 1 || acAnd === 1 ? 1 : abAnd === 0 && acAnd === 0 ? 0 : 3;
                c = or1 === 1 || bcAnd === 1 ? 1 : or1 === 0 && bcAnd === 0 ? 0 : 3;
              }
              propBuf[po + w] = c;
              break;
            }
            case K_DFF: {
              let jj = 0;
              const d = inBuf[off + jj++]!;
              const clk = inBuf[off + jj++]!;
              const clr = compFlags[ci]! & 2 ? inBuf[off + jj++]! : -1;
              const pre = compFlags[ci]! & 4 ? inBuf[off + jj++]! : -1;
              let q = dq[ci]!;
              if (clr === 0) q = 0;
              else if (pre === 0) q = 1;
              else if (dprev[ci] === 0 && clk === 1) q = d;
              dq[ci] = q;
              dprev[ci] = clk;
              propBuf[po] = q;
              propBuf[po + 1] = q === 0 ? 1 : q === 1 ? 0 : 3;
              break;
            }
            case K_TRISTATE: {
              const a = inBuf[off]!;
              const oe = inBuf[off + 1]!;
              const en = compFlags[ci]! & 1
                ? oe === 0 ? 1 : oe === 1 ? 0 : 3
                : oe;
              propBuf[po] = en === 0 ? 2 : en === 1 ? a : 3;
              break;
            }
            case K_CONST: {
              propBuf[po] = constVal[ci]!;
              break;
            }
          }
        } else {
          // Slow path: original string-buffer evaluate().
          const comp = components[ci]!;
          const inputBuf = comp.inputBuf;
          const inputNetIdx = comp.inputNetIdx;
          const inputIsLogic = comp.inputIsLogic;
          const inputCount = inputBuf.length;
          for (let j = 0; j < inputCount; j++) {
            const netVal = nets[inputNetIdx[j]!]!.value;
            inputBuf[j] = inputIsLogic[j] === 1 ? (netVal === 'Z' ? 'X' : netVal) : netVal;
          }
          const ns = comp.primitive.evaluate(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx);
          if (ns !== undefined) comp.state = ns;
        }
      }

      // ---- COMMIT phase -------------------------------------------------
      // Compare each component's proposed outputs against its committed
      // outputs; on change, copy through and queue the affected net for
      // re-resolution. Native components compare encoded ints; slow
      // components compare strings and mirror into the flat outBuf so net
      // resolution has one source of truth.
      changedQueue.length = 0;
      if (this.initialResolution) {
        for (let n = 0; n < nets.length; n++) { netChanged[n] = 1; changedQueue.push(n); }
        this.initialResolution = false;
      }
      for (let i = 0; i < nowLen; i++) {
        const ci = now[i]!;
        if (native[ci]) {
          const po = outOff[ci]!;
          const cout = compOutCount[ci]!;
          const oni = components[ci]!.outputNetIdx;
          for (let j = 0; j < cout; j++) {
            const newVal = propBuf[po + j]!;
            if (outBuf[po + j] !== newVal) {
              outBuf[po + j] = newVal;
              const netIdx = oni[j]!;
              if (!netChanged[netIdx]) {
                netChanged[netIdx] = 1;
                changedQueue.push(netIdx);
              }
            }
          }
        } else {
          const comp = components[ci]!;
          const proposedBuf = comp.proposedBuf;
          const outputBuf = comp.outputBuf;
          const outputNetIdx = comp.outputNetIdx;
          const po = outOff[ci]!;
          for (let j = 0; j < proposedBuf.length; j++) {
            const newVal = proposedBuf[j]!;
            if (outputBuf[j] !== newVal) {
              outputBuf[j] = newVal;
              outBuf[po + j] = encDriver(newVal);
              const netIdx = outputNetIdx[j]!;
              if (!netChanged[netIdx]) {
                netChanged[netIdx] = 1;
                changedQueue.push(netIdx);
              }
            }
          }
        }
        inDirty[ci] = 0;
      }
      now.length = 0;

      // Re-resolve every changed net; if the resolved value moved, wake its
      // listeners for the next iteration.
      for (let q = 0; q < changedQueue.length; q++) {
        const netIdx = changedQueue[q]!;
        netChanged[netIdx] = 0;
        const newValue = this.computeIntNetValue(netIdx);
        if (newValue === netV[netIdx]) continue;
        netV[netIdx] = newValue;
        nets[netIdx]!.value = decodeNet(newValue);
        const ls = this.nlOff[netIdx]!;
        const le = this.nlOff[netIdx + 1]!;
        const nl = this.nl;
        for (let k = ls; k < le; k++) {
          const comp = nl[k]!;
          if (inDirty[comp]) continue;
          next.push(comp);
          inDirty[comp] = 1;
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

  // Resolve a net's encoded value from the flat committed output buffers.
  private computeIntNetValue(netIdx: number): number {
    const ndComp = this.ndComp;
    const ndOut = this.ndOut;
    const outBuf = this.outBuf;
    const outOff = this.outOff;
    let strong = -1;
    let strongConflict = false;
    let weak = -1;
    let weakConflict = false;
    let sawX = false;
    for (let k = this.ndOff[netIdx]!, e = this.ndOff[netIdx + 1]!; k < e; k++) {
      const v = outBuf[outOff[ndComp[k]!]! + ndOut[k]!]!;
      if (v === 2) continue;
      if (v === 3) {
        sawX = true;
        continue;
      }
      if (v === 4 || v === 5) {
        const w = v === 5 ? 1 : 0;
        if (weak < 0) weak = w;
        else if (weak !== w) weakConflict = true;
        continue;
      }
      if (strong < 0) strong = v;
      else if (strong !== v) strongConflict = true;
    }
    const f = this.forcedV[netIdx]!;
    if (f !== 2) {
      if (f === 4 || f === 5) {
        const w = f === 5 ? 1 : 0;
        if (weak < 0) weak = w;
        else if (weak !== w) weakConflict = true;
      } else if (f === 0 || f === 1) {
        if (strong < 0) strong = f;
        else if (strong !== f) strongConflict = true;
      } else if (f === 3) {
        sawX = true;
      }
    }
    if (strongConflict) {
      if (!this.contendedThisSettle.has(netIdx)) {
        this.contendedThisSettle.add(netIdx);
        this.events.push({
          kind: 'contention',
          detail: `net "${this.graph.nets[netIdx]!.id}" driven by conflicting strong values`,
          step: this.step,
        });
      }
      return 3;
    }
    if (sawX) return 3;
    if (strong >= 0) return strong;
    if (weakConflict) return 3;
    if (weak >= 0) return weak;
    return 2;
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
