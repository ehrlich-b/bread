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
    nets.ts       # Driver list resolution (four-valued logic + tristate).
    ir.ts         # Canonical circuit IR types (JSON + runtime shapes).
    loader.ts     # Parse JSON, flatten composites, build runtime graph.
    primitives/   # Built-in primitives + per-tier registry.
      registry.ts gates.ts dff.ts latch.ts mux.ts decoder.ts
      adder.ts tristate.ts sources.ts
    composites/   # Composite registry + flatten helpers.
      registry.ts
    behavioral/   # Built-in behavioral chips + per-tier registry.
      registry.ts gen_clock.ts io_led.ts io_switch.ts

  worker/         # Worker entry point.
    worker.ts
    protocol.ts   # Message types: load, run, pause, step, mutate, set_input.

  ui/
    schematic/    # SVG schematic view, hit-testing, wire routing.
    palette/      # Component palette: drag/click-to-place chips.
    inspector/    # Property panel, parameter editing.
    controls/     # Run/pause/step + Undo/Redo buttons.
    bus.ts        # postMessage wrapper, RPC over the worker boundary.
    editor.ts     # Editable circuit model + undo/redo stack.
    file.ts       # Save/Load via File System Access API + fallbacks.

  stdlib/         # Composite chip definitions (JSON) + registration.
    index.ts
    ttl.74LS00.json
    ttl.74LS173.json
    ...

  app/            # Top-level Vite entry, page bootstrap, layout CSS.
```

Three registries — `primitives/registry.ts`, `composites/registry.ts`, `behavioral/registry.ts` — together act as the single component-resolution surface. There is no umbrella `components.ts`; resolution is a fall-through across the three.

## Worker protocol

Messages are RPC-style with numeric request IDs. Notifications (events) flow worker→UI without an id. Source of truth: `src/worker/protocol.ts`.

| Message | Direction | Payload | Notes |
|---|---|---|---|
| `load` | UI → engine | `{ circuit: CircuitJSON, rateHz?: number }` | Replaces current IR. Resets sim state. Reply: `load_res`. |
| `mutate` | UI → engine | `{ circuit: CircuitJSON }` | Whole-circuit replacement. Preserves `targetRateHz` and auto-resumes if a free run was active. Reply: `load_res`. |
| `run` | UI → engine | `{ rateHz: number }` | Paced free run. `rateHz` is required; there is no unpaced mode. Reply: `ack`. |
| `pause` | UI → engine | — | Reply: `ack`. |
| `step` | UI → engine | — | One `tick` of the simulator (settle once). Reply: `ack`. |
| `set_input` | UI → engine | `{ component: InstId, pin: string, value: NetState }` | For switches, buttons. Settles once before replying. Reply: `ack`. |
| `load_res` | engine → UI | `{ netIds, componentIds, netsBuffer: SharedArrayBuffer }` | Reply to `load` and `mutate`. Carries the new SAB handle and id arrays. |
| `ack` | engine → UI | `{ id }` | Generic ack for `run`/`pause`/`step`/`set_input`. |
| `err` | engine → UI | `{ id, message }` | Any handler throw turns into this. |
| `event` | engine → UI | `{ kind: 'oscillation' \| 'contention', detail, step }` | Out-of-band notification. Drained after every settle. |

`SharedArrayBuffer` carries net state for high-frequency reads. The UI samples at `requestAnimationFrame`; no per-frame messaging needed.

Two protocol simplifications relative to the original v1 sketch are intentional:

- **Whole-circuit `mutate` over an `IRPatch` op-list.** A 100-component circuit serializes in well under 50 ms, the editor sequences mutations through a single `inflight` slot in `ui/editor.ts`, and skipping the patch grammar keeps the worker boundary trivial. Patches remain a future option if profiling shows the round-trip cost matters.
- **Single-shape `step` (no `cycle`/`edge` modes).** The current `step` calls `sim.tick()` once and returns. Edge-stepping (run until a designated net transitions) belongs to a debugger UI we haven't built yet; it goes on the worker boundary as `{ kind: 'edge', net }` when that lands.

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

## Data layout

Today (M0–M4): `RuntimeGraph` is plain JS objects — `RuntimeComponent[]`, `RuntimeNet[]`, and `Map<string, number>` lookups (see `src/engine/ir.ts`). The simulator's hot path uses two `number[]` dirty queues and a per-iteration `proposedOutputs` array. This is fine for everything we run today; full-adder e2e settles in microseconds.

Planned (M6, perf milestone) — when profiling on the Ben Eater 8-bit machine demands it:

- `nets: Uint8Array(numNets)` — one byte per net (`0`, `1`, `Z`, `X`).
- `components: Uint32Array(numComponents * STRIDE)` — packed component records: kind, pin offsets, state offset.
- `pinNetMap: Uint32Array(totalPins)` — per-pin net index.
- `netListeners: Uint32Array(...)` + `Uint32Array(...)` (CSR-style adjacency) — components listening on each net.
- `dirtyA, dirtyB: Uint32Array(numComponents)` — double-buffered dirty queue.
- `componentState: Uint8Array(...)` — per-instance state (FF Q values, counter values, memory contents).

Once that lands, object allocation is forbidden in the inner loop and component evaluators are monomorphic functions indexed by kind. See [SIMULATION.md](SIMULATION.md) for the loop itself; the conversion is a drop-in for the existing scheduler.

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
