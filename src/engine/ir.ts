// Canonical IR types. The engine and the loader both speak this.
// Two layers:
//   - JSON shape (CircuitJSON, ComponentInstanceJSON, ...) — what we save/load.
//   - Runtime shape (RuntimeGraph, RuntimeComponent, ...) — what the simulator works on.
// The loader produces the second from the first.

// What a net resolves to. Always one of these four — weak driver values
// (L/H) collapse to strong 0/1 once resolution finishes.
export type NetState = 0 | 1 | 'Z' | 'X';

// What a single driver may put on a net. Adds the weak values:
//   'L' — weak 0 (pull-down)
//   'H' — weak 1 (pull-up)
// Strong drivers (0/1) override weak drivers per SIMULATION.md.
export type DriverValue = NetState | 'L' | 'H';

export type PinDir = 'in' | 'out' | 'inout';

export interface PinSpec {
  name: string;
  dir: PinDir;
  width?: number;
  activeLow?: boolean;
}

// Deterministic context handed to every evaluate(). Behavioral components that
// model real-world time (clock generators, 555 timers, EEPROM access delays)
// derive their cadence from `step` and `rateHz`. `step` advances only on a
// simulation tick, not on paused input settling. Primitives ignore it.
export interface EvalCtx {
  step: number;
  rateHz: number;
}

export interface PrimitiveDef<S = unknown, P = unknown> {
  // Pin spec is computed from params (n-input gates etc.).
  pins(params: P): PinSpec[];
  init?(params: P): S;
  // If true, the simulator re-marks every instance of this type dirty at the
  // start of each tick(). Use for free-running components (clocks, oscillators)
  // whose output is a function of time, not of any input net.
  tickActive?: boolean;
  // inputs[i] is the value at the i-th input/inout pin (in pin-spec order, restricted to in|inout).
  // The implementation MUST write into outputs[0..outputs.length) — one slot
  // per output/inout pin, in pin-spec order. The buffer is owned by the
  // simulator and pre-sized; do not mutate length, replace, or hand out
  // references. Return the next state, or undefined to leave state alone. ctx
  // is optional for ergonomics in tests/primitives; the simulator always
  // passes it.
  evaluate(
    inputs: readonly NetState[],
    outputs: DriverValue[],
    state: S,
    params: P,
    ctx?: EvalCtx,
  ): S | undefined;
}

// ---- JSON shape ---------------------------------------------------------

export interface CircuitJSON {
  version: number;
  kind: 'circuit' | 'composite';
  name: string;
  description?: string;
  components: ComponentInstanceJSON[];
  nets: NetJSON[];
  ports?: PortJSON[];
  probes?: ProbeJSON[];
  // Project-local composite definitions, saved with the root circuit.
  definitions?: CircuitJSON[];
  metadata?: Record<string, unknown>;
}

export interface ComponentInstanceJSON {
  id: string;
  type: string;
  position?: [number, number];
  rotation?: number;
  params?: Record<string, unknown>;
  label?: string;
}

export interface NetJSON {
  id: string;
  name?: string;
  endpoints: string[];
  waypoints?: [number, number][];
}

// Probe lanes are runtime net IDs in least-significant-bit order.
export interface ProbeJSON {
  id: string;
  label: string;
  nets: string[];
}

export interface PortJSON {
  name: string;
  dir: PinDir;
  internalNet: string;
}

// ---- Runtime shape ------------------------------------------------------

export interface RuntimeComponent {
  id: string;
  typeId: string;
  primitive: PrimitiveDef<unknown, unknown>;
  // Built-in dispatch tag, selected once by the loader; 0 = registry fallback.
  evalKind: number;
  params: unknown;
  state: unknown;
  pins: PinSpec[];
  // Sub-indexes into pins[] for input/inout vs output/inout pins.
  // Order matches what evaluate() expects/returns.
  inputPinIdx: number[];
  outputPinIdx: number[];
  // For each pin (full pins[] index), the net it's wired to. -1 if unconnected.
  pinNetIdx: number[];
  // Pre-allocated input scratch the simulator fills before each evaluate().
  // length = inputPinIdx.length. Per-component (not shared) so each component's
  // hidden class stays stable on V8.
  inputBuf: NetState[];
  // Net index per input slot, in the same order as inputBuf — flattens
  // pinNetIdx[inputPinIdx[j]] so the inner loop reads one indirection. Uint32
  // since net indices fit easily and the typed array enables monomorphic loads.
  inputNetIdx: Uint32Array;
  // 1 if the input pin direction is pure 'in' (apply readAsLogic on Z); 0 if
  // 'inout' (pass Z through). Same indexing as inputBuf.
  inputIsLogic: Uint8Array;
  // Pre-allocated proposed-output buffer. Each evaluate() writes here; commit
  // copies into outputBuf and marks any net whose driver changed.
  proposedBuf: DriverValue[];
  // Current driving value per output/inout pin (length = outputPinIdx.length).
  outputBuf: DriverValue[];
  // Net index per output slot — same flatten as inputNetIdx but for outputs.
  outputNetIdx: Uint32Array;
}

export interface RuntimeNet {
  id: string;
  name: string;
  // Each driver references a component and the index *within* that component's outputPinIdx[].
  drivers: Array<{ comp: number; outIdx: number }>;
  // Components whose evaluation depends on this net (input/inout pins). Deduped.
  listenerComps: number[];
  // Externally-forced driver value (from setInput). 'Z' means not forced.
  forced: DriverValue;
  // Compatibility view of RuntimeGraph.netValues. Initial 'X' per
  // SIMULATION.md; the scheduler reads/writes the byte storage directly.
  value: NetState;
}

export interface RuntimeGraph {
  components: RuntimeComponent[];
  nets: RuntimeNet[];
  // Resolved values: 0=low, 1=high, 2=Z, 3=X. The only net-state storage.
  netValues: Uint8Array;
  componentById: Map<string, number>;
  netById: Map<string, number>;
}
