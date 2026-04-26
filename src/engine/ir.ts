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

export interface PrimitiveDef<S = unknown, P = unknown> {
  // Pin spec is computed from params (n-input gates etc.).
  pins(params: P): PinSpec[];
  init?(params: P): S;
  // inputs[i] is the value at the i-th input/inout pin (in pin-spec order, restricted to in|inout).
  // outputs[i] is the value to drive at the i-th output/inout pin (in pin-spec order, restricted to out|inout).
  evaluate(
    inputs: NetState[],
    state: S,
    params: P,
  ): { outputs: DriverValue[]; nextState?: S };
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
  params: unknown;
  state: unknown;
  pins: PinSpec[];
  // Sub-indexes into pins[] for input/inout vs output/inout pins.
  // Order matches what evaluate() expects/returns.
  inputPinIdx: number[];
  outputPinIdx: number[];
  // For each pin (full pins[] index), the net it's wired to. -1 if unconnected.
  pinNetIdx: number[];
  // Current driving value per output/inout pin (length = outputPinIdx.length).
  outputBuf: DriverValue[];
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
  // Resolved value. Initial 'X' per SIMULATION.md.
  value: NetState;
}

export interface RuntimeGraph {
  components: RuntimeComponent[];
  nets: RuntimeNet[];
  componentById: Map<string, number>;
  netById: Map<string, number>;
}
