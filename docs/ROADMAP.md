# Roadmap

Milestones, each independently demonstrable. Ship in order.

**Status snapshot (2026-05-10):** M0–M5 shipped. M5 (memory + Ben Eater chip set) — all 15 TTL composites, behavioral memory chips (`mem.6116`, `mem.74LS189`, `mem.28C16`), `gen.555`, `io.7seg` with live segment fills, the 28C16 paste-hex / upload-`.bin` inspector affordance, eight `eater.*` SAP-1 composites with TypeScript-generated microcode injected at registration time, and a bundled `examples/ben_eater_8bit.json` running Fibonacci end-to-end.

**M5a — UI playability** ✅ shipped. The engine exposes a public surface (`getPinsForType`, `listAllTypes`) so the schematic can introspect any chip without instantiating a Simulator. A generic IC renderer falls back for chips without a hand-crafted SVG, the palette covers every primitive / behavioral / TTL composite (~39 entries across 7 groups), and a bundled-examples dropdown switches between the canned circuits in `examples/`. The `io.7seg` display and `gen.555` timer have hand-crafted renderers; `io.7seg` segments update live from the SAB so a 28C16-driven hex display shows the digit on screen.

**M6 — Performance** in progress. `scripts/bench_eater.ts` measures simulated clock throughput on the bundled SAP-1. The historical unrestricted result was **88 kHz**. The 2026-10-07 efficiency-core baseline at `93655c0` is **15.204 kHz**; byte-packed resolved net storage raises it to **16.732 kHz (+10.1%)** under the same low-priority conditions. Previous wins include buffer-passing `evaluate()`, reusable per-component buffers, typed pin-index sidecars, cached input directions, and pooled net-resolution scratch. See M6 below for comparable measurements and the remaining targets.

M7 in progress.

**Original CPU port (2026-10-07):** Bryan's 2022 Digital machine now loads
from Examples and runs its original CALLRET, countdown, Fibonacci and
PUSH/POP programs. The committed converter preserves nine source modules
and adds 16 inspectable equivalents built from Bread primitives. Independent
ISA tests compare ordered outputs, PC, A/B, output, SP, flags, all RAM and
HALT after every instruction, with retained oscillators and controlled clocks.
Browser coverage checks the bundled CALLRET output and save/reopen. The
source loader copies 31 bytes; this source quirk is retained and tested.
See [ORIGINAL_CPU_PORT.md](ORIGINAL_CPU_PORT.md) for reproduction and limits.
This generated port is separate from the editor-built CPU ascent.

The NAND-to-CPU ascent now has actual editor evidence through 14 reusable
modules and an arithmetic/HALT CPU. [CPU_ASCENT.md](CPU_ASCENT.md) records the
remaining manual load/store and branch checks, separate headless ISA tests,
and current measured performance. Historical 88 kHz reference figures below
are not measurements of this new CPU or the interactive UI.

## M0 — Engine kernel  ✅ done

No UI. No worker. Plain Node module.

- IR types defined in `src/engine/ir.ts`.
- Primitive registry with `NAND`, `NOT`, `AND`, `OR`, `XOR`, `BUF`, `DFF`.
- Two-phase event-driven scheduler (`settle`).
- Four-state logic + tristate resolution.
- Oscillation detection.
- Determinism test: same circuit + inputs → byte-identical net trace across runs.
- **Demo:** Node script loads a JSON NAND latch, runs N steps with scripted inputs, prints the net trace. Pass: trace matches a checked-in reference.

## M1 — Primitive completion  ✅ done

- All ~20 primitives.
- Full unit-test coverage per primitive (truth tables, X propagation, edge cases, async pin behavior).
- Net resolution warns on contention; warnings surface in trace output.
- **Demo:** Node script runs a 4-bit ripple-carry adder built from primitives, verifies all 256 input combos.

## M2 — Composite loader + first TTL chips  ✅ done

- JSON Schema for circuits at `schema/circuit.schema.json` (editor autocomplete + linting; the runtime loader does its own structural validation in TypeScript — see [CIRCUIT_FORMAT.md](CIRCUIT_FORMAT.md) §Validation).
- Composite loader: flatten subcircuits into the runtime graph (`src/engine/loader.ts`).
- Cycle detection on composite imports.
- Shipped: `ttl.74LS00`, `74LS04`, `74LS08`, `74LS32`, `74LS86`, `74LS173`, `74LS283`. (`ttl.74LS02` is on the STDLIB catalog but was deferred to M5 — `74LS02` isn't on Ben Eater's bench.)
- **Demo:** `scripts/register_bus_demo.ts` loads `examples/register_bus_4bit.json` and drives the bus across cycles.

## M3 — Worker + minimal UI  ✅ done

- Vite app skeleton.
- Engine in Web Worker. Protocol: `load`, `run`, `pause`, `step`, `mutate`, `set_input`.
- `SharedArrayBuffer` for net state read.
- Schematic view: SVG, render components from a hardcoded preset, no editing yet.
- `io.led`, `io.switch`, `gen.clock` behavioral components.
- **Demo:** in-browser, blink an LED with a manual switch and a 1 Hz clock.

## M4 — Schematic editor  ✅ done

- Place / move / rotate / delete components.
- Wire drawing with orthogonal routing.
- Property inspector (edit params, label, position).
- Save / load circuit JSON via the File System Access API (with download fallback).
- Undo / redo (UI-side; doesn't touch the engine).
- **Demo:** user builds a 1-bit full adder from gates in the editor, simulates it, verifies all 8 input combos.

## M5 — Memory + Ben Eater chip set  ✅ done

- **M5a — UI playability** ✅. Generic IC renderer + palette entries so every shipped chip is clickable; bundled-examples menu. Engine exposes `getPinsForType` / `listAllTypes` from `src/engine/index.ts`.
- `mem.28C16` EEPROM (UI affordance: paste hex, upload `.bin`). ✅
- `mem.74LS189` RAM with the open-collector inverted-output quirk. ✅
- `mem.6116` SRAM (with `params.contents` so it can be preloaded too). ✅
- `gen.555` timer. ✅
- `io.7seg` display with live SAB-driven segment fills. ✅
- `ttl.74LS107`, `74LS138`, `74LS139`, `74LS157`, `74LS161`, `74LS245`, `74LS273` composites. ✅
- Eight `eater.*` SAP-1 composites — `register_8bit`, `alu_8bit`, `ram_module`, `program_counter`, `instruction_register`, `flags_register`, `output_display`, `control_unit`. The control unit's microcode is authored in `src/stdlib/eater.microcode.ts` and stamped into the two onboard 28C16s at registration time. ✅
- Pre-built `examples/ben_eater_8bit.json` reference circuit, registered in the Examples dropdown. ✅
- **Demo:** load the bundled "Ben Eater 8-bit (Fibonacci)" example, click the RESET switch to release reset, and the machine streams 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233 onto the two-digit hex display before JC fires on overflow and the loop restarts.

## M6 — Performance  (in progress)

- Profile: identify hot paths in the engine on Eater's machine. ✅ baseline bench at `scripts/bench_eater.ts`.
- Convert per-event closures to monomorphic dispatch. ⏳ deferred — ICs are megamorphic across 19 primitive types; not yet refactored.
- Pack net state in `Uint8Array`; component records in `Uint32Array` (SoA). 〰️ partial — resolved net values now live only in `RuntimeGraph.netValues` (0/1/Z/X encoded as 0/1/2/3). The scheduler accesses bytes directly; `RuntimeNet.value` is a compatibility accessor. `inputNetIdx` / `outputNetIdx` are typed-array sidecars and `inputIsLogic` / `netChanged` / `inDirty` are `Uint8Array`. Component records and evaluator buffers remain objects/arrays.
- Object-pool the dirty queue. ✅ for the changed-nets queue (replaced `Set<number>` with `Uint8Array` mark + commit-order `number[]`); the dirty queues themselves are stable arrays from construction.
- Optional: implement WASM dispatch loop in Rust or AssemblyScript. A/B test against JS. ⏳ not started.
- **Goal:** 100+ kHz JS / 1+ MHz WASM. Historical unrestricted JS result: **88 kHz**. Current efficiency-core JS median: **16.732 kHz**; these execution conditions are not comparable to the historical result. WASM is not implemented.

2026-10-07 measurements on Bryan's Mac, Node 25.6.1, always prefixed with
`taskpolicy -b nice -n 15`, one process at a time. Each sample uses 20,000
warmup ticks followed by 200,000 measured ticks on the bundled Fibonacci
circuit (307 components, 344 nets). Rates below are simulated clock Hz
(ticks/s divided by two); all runs emit the same 33,652 events.
`tsx` CLI IPC is denied in this execution environment, so every sample runs
the unchanged benchmark via `node --import tsx scripts/bench_eater.ts`.

| Step | Three clock samples (Hz) | Median (Hz) | Change from baseline |
|---|---|---|---|
| `93655c0` baseline | 14,816 / 15,204 / 16,225 | 15,204 | — |
| Resolved-net byte storage | 15,663 / 17,158 / 16,732 | 16,732 | +10.1% |

Golden regression traces captured before optimization at `93655c0` compare
every net byte over 2,048 Fibonacci cycles and all 64 four-state full-adder
input combinations (two frames each), including initial and reset states.
They also compare the complete contention/oscillation event sequence.

## M7 — Polish

- Visual reusable chip authoring: select a fragment, name ports, place nested chips, edit/test/save definitions with the project. ✅ Implementation, independent review, automated regressions, and manual gates-to-CPU arithmetic validation. Broader manual CPU validation remains open. See [CHIP_AUTHORING.md](CHIP_AUTHORING.md).

- Bus-grouped wires (visual: multiple bits as one fat line).
- Atomic bus wiring with an explicit scalar-bit mapping preview is available;
  wires remain separate electrical signals. Configurable word ROMs and live
  binary/hex inspector readouts support the completed [original Digital CPU port](ORIGINAL_CPU_PORT.md).
- Fit circuit and editable component labels make large imported circuits
  navigable; labels persist through save/reopen.
- Probes + waveform viewer (read `io.pin_output` history, render as VCD-style traces).
- Testbench format (`*.test.json`): drive inputs, assert outputs over time, run headless via `npm test`.
- Verilog export, best-effort: primitives + composites only; behavioral chips emit `/* not synthesizable */` stubs.
- Permalink sharing (gzipped circuit JSON in URL hash).
- Keyboard shortcuts (place common chips, rotate, delete).
- Tutorial walkthrough: "build Ben Eater's 8-bit machine."

## Beyond M7 (not promised)

- User-provided behavioral chips, sandboxed via WASM (the Wokwi model). Drives a stable chip ABI.
- Verilog *import* via a third-party parser (e.g. `slang` compiled to WASM, lowered to our IR).
- Breadboard skin (visual only; sim model unchanged).
- Mobile / touch support.
- Cloud save and sharing.
- Collaborative editing.
- Logic analyzer / scope component (driven by waveform viewer).

## Definition of done per milestone

- All planned tests pass on CI (JS engine on every push; WASM engine on PRs that touch the dispatch loop).
- Demo recorded as a short video or gif and linked in the milestone PR.
- Anchor docs updated. They are not frozen — they evolve with reality. If a doc lies, it's a bug.
- `examples/` updated with at least one circuit demonstrating the milestone's new capability.

## What is explicitly *not* on this roadmap

- Anything analog.
- Anything CPU-architecture-specific (we don't ship an opcode set; users provide microcode).
- Schematic-to-PCB.
- Real hardware programming (JEDEC, bitstreams).

If someone wants those, they can build them on top of the IR. The IR is the contract.
