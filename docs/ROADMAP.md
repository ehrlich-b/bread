# Roadmap

Milestones, each independently demonstrable. Ship in order.

**Status snapshot (2026-05-03):** M0–M5 shipped. M5 (memory + Ben Eater chip set) — all 15 TTL composites, behavioral memory chips (`mem.6116`, `mem.74LS189`, `mem.28C16`), `gen.555`, `io.7seg` with live segment fills, the 28C16 paste-hex / upload-`.bin` inspector affordance, eight `eater.*` SAP-1 composites with TypeScript-generated microcode injected at registration time, and a bundled `examples/ben_eater_8bit.json` running Fibonacci end-to-end. Up next: M6 performance work.

**M5a — UI playability** ✅ shipped. The engine exposes a public surface (`getPinsForType`, `listAllTypes`) so the schematic can introspect any chip without instantiating a Simulator. A generic IC renderer falls back for chips without a hand-crafted SVG, the palette covers every primitive / behavioral / TTL composite (~39 entries across 7 groups), and a bundled-examples dropdown switches between the canned circuits in `examples/`. The `io.7seg` display and `gen.555` timer have hand-crafted renderers; `io.7seg` segments update live from the SAB so a 28C16-driven hex display shows the digit on screen.

M6/M7 unstarted.

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
- **Demo:** load the bundled "Ben Eater 8-bit (Fibonacci)" example, click the RESET switch to release reset, and the machine streams 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233 onto the two-digit hex display before JC fires on overflow and the loop restarts.

## M6 — Performance

- Profile: identify hot paths in the engine on Eater's machine.
- Convert per-event closures to monomorphic dispatch.
- Pack net state in `Uint8Array`; component records in `Uint32Array` (SoA).
- Object-pool the dirty queue.
- Optional: implement WASM dispatch loop in Rust or AssemblyScript. A/B test against JS.
- **Goal:** Eater's 8-bit machine sustains 100+ kHz simulated clock in JS, 1+ MHz in WASM.

## M7 — Polish

- Bus-grouped wires (visual: multiple bits as one fat line).
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
