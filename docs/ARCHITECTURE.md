# Architecture

## Layers

```
+--------------------------------------------------+
|  UI (main thread)                                |
|  - Schematic editor (SVG)                        |
|  - Property inspector                            |
|  - Run/pause/step controls                       |
|  - Reads net state at vsync via SharedArrayBuffer|
+--------------------------------------------------+
                    |  postMessage (control + mutate ops)
                    v
+--------------------------------------------------+
|  Engine (Web Worker)                             |
|  - Owns the canonical circuit IR                 |
|  - Runs the event-driven simulator               |
|  - Writes net state into SharedArrayBuffer       |
|  - No DOM, no rendering; runs equally in Node    |
+--------------------------------------------------+
                    |  (in-process)
                    v
+--------------------------------------------------+
|  WASM (optional)                                 |
|  - Hot path: event dispatch + primitive eval     |
|  - Drop-in replacement for the JS dispatch loop  |
+--------------------------------------------------+
```

## Why this split

- **UI thread responsiveness.** A 30-chip schematic at 100 kHz simulated clock cannot block scrolling, hit-testing, or property edits. The worker absorbs the simulation cost.
- **Engine testability.** The engine is a pure function `(circuit, time, inputs) → (net states, traces)`. Test it in Node with `vitest`; no jsdom, no Playwright for the hot path.
- **WASM optionality.** The engine's interface is decoupled from its implementation. Swap the hot loop without touching the UI. Defer WASM until profiling demands it.

## Module layout

```
src/
  engine/         # Pure simulation. No DOM, no Web APIs.
    sim.ts        # Two-phase event-driven scheduler.
    nets.ts       # Net state, four-valued logic, tristate resolution.
    components.ts # Component registry, evaluation dispatch.
    primitives/   # Built-in primitive eval functions (one per kind).
    behavioral/   # Built-in behavioral chips (memory, displays, I/O).
    ir.ts         # Canonical circuit IR types + validation.
    loader.ts     # Parse JSON, flatten composites, build runtime graph.

  worker/         # Worker entry point.
    worker.ts
    protocol.ts   # Message types: load, run, pause, step, mutate, set_input.

  ui/
    schematic/    # SVG schematic view, hit-testing, wire routing.
    inspector/    # Property panel, parameter editing.
    controls/     # Run/pause/step UI.
    bus.ts        # postMessage wrapper, RPC over the worker boundary.

  stdlib/         # Composite chip definitions (JSON).
    74LS00.json
    74LS173.json
    ...

  app/            # Top-level Vite entry, routing, layout.
```

## Worker protocol

Messages are RPC-style with request IDs. Subset of the v1 protocol:

| Message | Direction | Payload | Notes |
|---|---|---|---|
| `load` | UI → engine | `{ circuit: CircuitJSON }` | Replaces current IR. Resets sim state. |
| `mutate` | UI → engine | `{ patch: IRPatch }` | Incremental edit. Engine pauses, applies, resumes if running. |
| `run` | UI → engine | `{ rateHz?: number }` | Free-run if `rateHz` omitted; paced otherwise. |
| `pause` | UI → engine | — | |
| `step` | UI → engine | `{ kind: 'cycle' \| 'edge', net?: NetId }` | One settled cycle, or run until next edge of `net`. |
| `set_input` | UI → engine | `{ component: InstId, pin: string, value: NetState }` | For switches, buttons. |
| `state_snapshot` | engine → UI | `{ nets: SAB, components: SAB }` | Sent once after `load`; UI keeps the SAB handle. |
| `event` | engine → UI | `{ kind: 'oscillation' \| 'contention' \| 'halted'; ... }` | Out-of-band notifications. |

`SharedArrayBuffer` carries net state for high-frequency reads. The UI samples at `requestAnimationFrame`; no per-frame messaging needed.

## State ownership

- **Canonical circuit IR** lives in the worker. UI keeps an editable copy and posts patches; the worker's copy is authoritative once running.
- **Net state during sim** lives in the SAB, written by the worker, read by the UI. Atomic reads aren't required for visualization (last-write-wins is fine for LEDs and 7-segs).
- **Selection, cursor, pan/zoom, undo stack** are UI-only. The worker doesn't care.
- **File I/O** (save/load) happens on the main thread via the File System Access API or download/upload fallbacks. The worker doesn't touch storage.

## What lives in which thread

| Concern | Main | Worker |
|---|:-:|:-:|
| Schematic rendering | ✓ | |
| Hit testing, drag-drop | ✓ | |
| Undo / redo | ✓ | |
| Circuit IR (canonical) | | ✓ |
| Event queue | | ✓ |
| Component evaluation | | ✓ |
| Net state | (read) | (write) |
| File save / load | ✓ | |
| Verilog export | | ✓ |
| Headless tests | | ✓ |

## Data layout for performance

The engine owns flat, typed-array-backed structures:

- `nets: Uint8Array(numNets)` — one byte per net (`0`, `1`, `Z`, `X`).
- `components: Uint32Array(numComponents * STRIDE)` — packed component records: kind, pin offsets, state offset.
- `pinNetMap: Uint32Array(totalPins)` — per-pin net index.
- `netListeners: Uint32Array(...)` + `Uint32Array(...)` (CSR-style adjacency) — components listening on each net.
- `dirtyA, dirtyB: Uint32Array(numComponents)` — double-buffered dirty queue.
- `componentState: Uint8Array(...)` — per-instance state (FF Q values, counter values, memory contents).

Object allocation is forbidden in the inner loop. Component evaluators are monomorphic functions indexed by kind. See [SIMULATION.md](SIMULATION.md) for the loop itself.

## Build & test

- `npm run dev` — Vite dev server, HMR, worker bundled automatically.
- `npm run build` — production bundle. Engine ships as both a worker module and a plain ES module (so Node tests import it directly).
- `npm test` — `vitest` against the engine. Runs in Node. Should be sub-second for the full suite.
- `npm run e2e` — Playwright smoke tests against the built bundle. Few in number; the engine is the test surface, the UI is just a thin shell.

## Performance budget

- Engine: 50 kHz sustained simulated clock for Ben Eater's 8-bit machine in JS, 1 MHz with WASM.
- UI: 60 fps schematic render, regardless of simulated clock.
- First-paint: under 1 s on a midrange laptop.
- Save/load: a 100-component circuit saves and parses in under 50 ms.

If a budget is missed, profile before optimizing.
