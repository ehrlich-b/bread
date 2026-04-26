# Components

## The three tiers

A component is anything with pins that participates in simulation. There are three tiers, in order of preference:

| Tier | Defined in | Use when |
|---|---|---|
| **Primitive** | TypeScript, `src/engine/primitives/` | Universal logic atoms. ~20 types. The fast path. |
| **Composite** | JSON, `src/stdlib/` or user-saved | Anything you can build from primitives + other composites. Most TTL chips. |
| **Behavioral** | TypeScript, `src/engine/behavioral/` | Things that can't reasonably be expressed as a graph: memory, displays, clock generators, switches. |

Always reach for **composite** first. Use **behavioral** only when storage size or external coupling makes a graph impractical.

## Primitives

Roughly 20 hardcoded types:

- Gates: `AND`, `OR`, `NAND`, `NOR`, `NOT`, `XOR`, `XNOR`, `BUF` — all parameterized by fan-in.
- `TRISTATE` — buffer with `OE` (active high or low; configurable).
- `DFF` — D flip-flop, edge-triggered, optional async `/CLR` and `/PRE`.
- `LATCH` — level-sensitive D latch.
- `MUX2`, `DEMUX2` — parameterized by data width.
- `DECODER` — n-to-2^n, optional active-low outputs.
- `ADDER` — full adder with carry-in/out, parameterized width.
- `CONST_0`, `CONST_1` — Vcc/GND tie-offs.
- `PULLUP`, `PULLDOWN` — weak drivers; lose to strong drivers.

Contract:

```ts
type Primitive = {
  pins: PinSpec[];
  init?(params: Params): State;
  evaluate(inputs: NetState[], state: State): {
    outputs: NetState[];
    nextState?: State;
  };
};
```

Primitives have no rendering metadata of their own. Their schematic symbol comes from the *composite* that wraps them (a primitive `NAND` gets drawn as part of a `74LS00`, not as a free-standing chip).

## Composites

A composite is a netlist: a list of component instances + a list of nets connecting their pins. Composites can reference other composites recursively (acyclic; the loader rejects cycles).

Most TTL chips are composites:

- `ttl.74LS00` = 4 × `prim.NAND` with the standard pinout.
- `ttl.74LS04` = 6 × `prim.NOT`.
- `ttl.74LS173` = 4 × `prim.DFF` + 4 × `prim.TRISTATE` + load-enable gating.
- `ttl.74LS181` = a graph of gates + adder primitives implementing the standard 16-function ALU.

Composites flatten into the same simulation graph as their constituents. There is no separate "subcircuit boundary" at runtime; boundaries exist only in the IR for editing, schematic display, and reuse. This makes simulation as fast as the equivalent hand-written netlist.

A composite is a plain JSON document. The same schema describes the user's top-level circuit. See [CIRCUIT_FORMAT.md](CIRCUIT_FORMAT.md).

## Behavioral

Some chips can't be expressed practically as a primitive graph:

- **Memory** (`28C16`, `6116`, `74LS189`). A 2K × 8 EEPROM is 16,384 storage cells; modeling each as a primitive D-latch is wasteful. Behavioral implementation: a `Uint8Array` and a small evaluation function.
- **Displays** (LED, 7-segment, dot matrix). They consume signals and produce visible state. No outputs back to the circuit.
- **Inputs** (switch, push button, DIP switch). They produce signals from user actions; no logical inputs.
- **Clock generators** (`555` square-wave, debounced clock). Periodic output, no inputs.

Contract:

```ts
type Behavioral = {
  pins: PinSpec[];
  init(params: Params): State;
  evaluate(inputs: NetState[], state: State, ctx: EvalCtx): {
    outputs: NetState[];
    nextState: State;
    visual?: VisualState;  // for displays; UI reads via SAB
  };
};

type EvalCtx = {
  step: number;          // monotonic step counter from worker
  rateHz: number;        // worker's current target rate
  randomSeed: number;    // for any (deterministic) randomness
};
```

Register with:

```ts
registerBehavioral('mem.28C16', {
  pins: [/* A0..A10, D0..D7, /CE, /OE, /WE */],
  init: () => ({ rom: new Uint8Array(2048) }),
  evaluate(inputs, state) { /* ... */ },
});
```

Behavioral components live in `src/engine/behavioral/`. They are compiled into the engine bundle. There is **no user-defined-at-runtime mechanism** in v1: subcircuits cover most user composability needs, and untrusted-code execution is a sandboxing problem we'd rather defer (see "What if users want custom chips?" below).

## The HDL question

We deliberately do **not** ship a textual hardware description language.

### Why not

The set of TTL chips is small (~20 distinct devices for Ben Eater). Each is either a small composite (gates wired up) or a behavioral component (memory, peripherals). A custom HDL would be hundreds of hours of parser/semantic-analyzer/error-message work to produce the same artifact our JSON IR already produces — at the cost of an extra learning curve for users and an extra maintenance burden for us.

### What about Verilog

Verilog already exists. If we want to go there, the move is:

- **Import**: third-party Verilog parser → lower to our IR → load as a composite.
- **Export**: we control the IR; emit Verilog from any composite or top-level circuit.

Both directions become a feature, not a foundation. The IR is designed with this in mind: each primitive maps to a Verilog primitive (`and`, `or`, `not`, `buf`, ...) or a small Verilog module. Behavioral components are stubbed in Verilog export with a `/* not synthesizable */` comment.

The roadmap reserves a slot for Verilog export at M7 (best-effort, primitives + composites only).

### What users do today

- Compose visually in the schematic editor. Save as JSON. Re-use the JSON as a subcircuit in another circuit.
- For chips beyond what we ship, write a behavioral TS class and PR it into `src/engine/behavioral/`. We expect this to happen rarely.

### What changes if user-provided behavioral components are wanted

That's a sandboxing problem. Wokwi solves it with WASM compiled from C/Rust, exposing a chip ABI. We could do the same in v2+ if real demand emerges. Until then, subcircuits are the user-facing extension mechanism.

## Naming and IDs

- **Type IDs** are dotted, namespaced strings: `prim.NAND`, `ttl.74LS00`, `mem.28C16`, `io.led`, `gen.555`.
- **Instance IDs** are circuit-local, user-assigned (`U1`, `U7A`, `clock_gen`). Auto-generated if the user doesn't pick one.
- **Pin names** follow the chip's datasheet. Examples: `1A`, `1B`, `1Y` for a 74LS00; `D0..D7`, `A0..A10`, `/CE`, `/OE`, `/WE` for an EEPROM. The leading `/` denotes an active-low pin (display only; doesn't affect simulation logic).

## Pin spec

```ts
type PinSpec = {
  name: string;
  dir: 'in' | 'out' | 'inout';
  width?: number;        // bits; default 1
  activeLow?: boolean;   // documentation; doesn't affect sim
};
```

`inout` pins (memory data lines, bidirectional buffers) require the component's `evaluate` to drive `Z` when not actively driving and `0`/`1` when driving. The simulator's tristate resolution handles the rest.

## Determinism and purity

Components must be:

- **Pure with respect to inputs and state.** No global mutable state. No `Date.now()`. No `Math.random()` (use the seeded PRNG via `EvalCtx` if you genuinely need randomness — almost no chip does).
- **Stable.** Same inputs + same state → same outputs + same nextState. Always.
- **Cheap.** Inner loops on `Uint8Array`s. Avoid object allocation. Pre-bind closures at registration time.
- **Tested.** Each primitive and each behavioral chip has a unit test that exercises every truth-table entry or operating mode.
