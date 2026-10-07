# Simulation Semantics

This document defines what it means for the engine to "run" a circuit. If the engine and a doc disagree, the doc wins until reconciled.

## Logic values

Every net carries one of four values:

| Value | Meaning |
|---|---|
| `0` | Strong low. |
| `1` | Strong high. |
| `Z` | High impedance — no driver. |
| `X` | Unknown — initial state, contention, or undefined. |

`X` propagates conservatively. Each primitive defines its own `X` semantics:

- `AND(0, X) = 0` (dominant input wins).
- `AND(1, X) = X`.
- `XOR(0, X) = X`, `XOR(1, X) = X`.
- `NOT(X) = X`.
- `BUF(Z) = X` (a logic input cannot legitimately read `Z`; we surface this rather than guess).

A net with **multiple drivers** resolves as follows:

| Drivers on the net | Resolved value |
|---|---|
| All `Z` | `Z` |
| Exactly one strong + others `Z` | the strong value |
| Multiple strong, all the same | that value |
| Multiple strong, conflicting | `X` (contention) |
| Strong vs weak (pull-up/down) | strong wins |

The engine flags contention as a runtime warning. It does not halt the sim — Ben Eater's bus is *meant* to have multiple drivers, with only one enabled at a time, and a momentary contention during enable transitions is normal. Persistent contention is a circuit bug.

## Two-phase event-driven scheduler

Inspired by hneemann's *Digital*. The core operation is **settle**:

```
function settle():
  iter = 0
  while dirty_queue not empty:
    if iter++ > MAX_ITERATIONS: emit('oscillation'); return
    swap(dirty_now, dirty_next)
    # READ phase: evaluate every dirty component using current net state
    for c in dirty_now:
      proposed[c] = evaluate(c, read_inputs(c), state[c])
    # COMMIT phase: write proposed outputs to nets, schedule listeners
    for c in dirty_now:
      for (pin, value) in proposed[c].outputs:
        net = pinNet[c, pin]
        if resolve(net, c, value) changed:
          for listener in netListeners[net]:
            dirty_next.add(listener)
      state[c] = proposed[c].nextState
    clear(dirty_now)
```

Two phases avoid order-dependence: within an iteration, no component's evaluation can see another component's freshly-written output. SR latches and ring oscillators behave deterministically, regardless of insertion order in the IR.

A combinational chain of depth `d` settles in `d` iterations. At zero-delay, all settle within a single user-visible **step** (one call to `settle`). If `MAX_ITERATIONS` (default `10000`) is exceeded, the engine emits an `oscillation` event with the offending nets and halts that step.

## Steps, ticks, and time

- **Iteration** — one read + commit pass. Internal to `settle`.
- **Step** — one call to `settle`, including paused input changes. Diagnostics count these settlements. Quiescent at the end (or oscillation reported).
- **Tick** — one call to `tick`, advancing simulated time and scheduling time-dependent components before settling. Initial power-on resolution occurs at time zero.
- **Cycle** — *user-visible* clock period. Equals one or more ticks depending on the clock frequency and simulation rate.

The engine does not know wall-clock time. The worker paces it:

- **Free-run** — `tick` in a tight loop, yielding periodically to handle messages.
- **Paced** — `tick` `N` times per ms based on a target rate (Hz).
- **Single-step** — one `tick` per user click.
- **Edge-step** — `tick` until a designated net (typically `CLK`) transitions.

Clock generators and 555 timers count simulated ticks relative to the rate the worker hands them. Paused input changes settle without advancing clock phase. Evaluators do not call `Date.now()`.

## Edges

Edges are a derived concept, not a primitive event. A flip-flop's CLK pin is just a regular input; the FF's `evaluate` compares its current CLK value to the previous (held in component state):

```ts
const rose = prev.clk === 0 && now.clk === 1;
const fell = prev.clk === 1 && now.clk === 0;
```

There is no global clock. A flip-flop watches whichever net its CLK pin is wired to; that net's transitions are the FF's edges. Multiple clock domains, gated clocks, and asynchronous control all fall out for free.

## Propagation delay

The default model is **zero-delay**: combinational outputs settle in a single step (a step may contain many iterations). Adequate for everything Ben Eater's machine demands.

A future **unit-delay** mode (every output change takes one iteration to propagate) is useful for catching glitch-sensitivity bugs. Not required for v1.

We do **not** model variable per-gate delays. SPICE-style timing is out of scope.

## Tristate

A tristate buffer with output-enable low drives `Z`. A net whose drivers are all `Z` reads `Z`. A logic input reading `Z` produces `X` and propagates accordingly — drivers should not present `Z` to logic inputs (it's a circuit bug, not a simulator bug).

For Ben Eater's bus: only one chip's `OE` is low at a time. The bus reads the active driver's value. If two `OE` lines drop low simultaneously, the bus reads `X` and the engine logs contention.

## Asynchronous pins

74xx flip-flops have asynchronous clear (`/CLR`) and sometimes preset (`/PRE`) pins that override clocked behavior. These are level-sensitive checks at the start of `evaluate`:

```ts
if (clr === 0) return { Q: 0, Qn: 1 };
if (pre === 0) return { Q: 1, Qn: 0 };
// ... clocked behavior using rose/fell
```

Async pins beat clock edges. This matches every datasheet.

## Memory

EEPROMs and SRAMs are behavioral components carrying internal `Uint8Array` storage. Reads are combinational on `(addr, /CE, /OE)`; writes are clocked on `/WE` falling edge (SRAM) or are programmed out-of-band (EEPROM, with a UI affordance for loading hex/binary contents).

The 74LS189 RAM has open-collector inverted outputs — both behaviors are part of its behavioral model. Ben Eater wraps it in 74LS04 inverters in his RAM module; we represent that wrapping in the schematic, not by hiding the inversion.

## Initial state

On circuit load, all nets are `X` and every component is dirty. `settle` runs once. Its first commit resolves every net, including undriven nets and drivers which remain at their initial `Z`; these nets become `Z`. Pure logic inputs still read `Z` as `X`. A circuit with sane initial conditions (pull-ups/downs, async clears tied to a power-on-reset signal) settles into a defined state. Circuits that fail to settle from `X` are bugs in the user's circuit, not the simulator.

Behavioral components define their own `init(params): state`. Memory inits to all zeros unless contents are loaded; flip-flops init to `Q=X, Q'=X` until clocked or cleared.

## Determinism

Given the same circuit IR, the same input event sequence, and the same `MAX_ITERATIONS`, the engine produces bit-identical net traces across runs and across machines (JS or WASM). This is mandatory: it enables replay, regression tests, and shareable bug reports.

To preserve determinism:

- Iterate dirty queues in insertion order, not arbitrary order.
- Hash maps keyed by integer IDs are deterministic by construction; `Map<string, ...>` over instance names is allowed because we control insertion order.
- No `Math.random()` in component evaluators. If randomness is ever needed (e.g. metastability modeling), it goes through a seeded PRNG owned by the engine.
- WASM and JS implementations must produce identical traces on identical input. CI runs both against the same testbench corpus.

## What the engine does not do

Floating-point voltages, current, power, thermal, metastability beyond `X`, SPICE.
