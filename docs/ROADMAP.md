# Roadmap

Milestones, each independently demonstrable. Ship in order.

## M0 — Engine kernel

No UI. No worker. Plain Node module.

- IR types defined in `src/engine/ir.ts`.
- Primitive registry with `NAND`, `NOT`, `AND`, `OR`, `XOR`, `BUF`, `DFF`.
- Two-phase event-driven scheduler (`settle`).
- Four-state logic + tristate resolution.
- Oscillation detection.
- Determinism test: same circuit + inputs → byte-identical net trace across runs.
- **Demo:** Node script loads a JSON NAND latch, runs N steps with scripted inputs, prints the net trace. Pass: trace matches a checked-in reference.

## M1 — Primitive completion

- All ~20 primitives.
- Full unit-test coverage per primitive (truth tables, X propagation, edge cases, async pin behavior).
- Net resolution warns on contention; warnings surface in trace output.
- **Demo:** Node script runs a 4-bit ripple-carry adder built from primitives, verifies all 256 input combos.

## M2 — Composite loader + first TTL chips

- JSON Schema for circuits + validator.
- Composite loader: flatten subcircuits into the runtime graph.
- Cycle detection on composite imports.
- Ship `ttl.74LS00`, `74LS04`, `74LS08`, `74LS32`, `74LS86`, `74LS173`, `74LS283`.
- **Demo:** Node script loads a 4-bit register-to-bus circuit, drives a clock, verifies bus values across cycles.

## M3 — Worker + minimal UI

- Vite app skeleton.
- Engine in Web Worker. Protocol: `load`, `run`, `pause`, `step`, `mutate`, `set_input`.
- `SharedArrayBuffer` for net state read.
- Schematic view: SVG, render components from a hardcoded preset, no editing yet.
- `io.led`, `io.switch`, `gen.clock` behavioral components.
- **Demo:** in-browser, blink an LED with a manual switch and a 1 Hz clock.

## M4 — Schematic editor

- Place / move / rotate / delete components.
- Wire drawing with orthogonal routing.
- Property inspector (edit params, label, position).
- Save / load circuit JSON via the File System Access API (with download fallback).
- Undo / redo (UI-side; doesn't touch the engine).
- **Demo:** user builds a 1-bit full adder from gates in the editor, simulates it, verifies all 8 input combos.

## M5 — Memory + Ben Eater chip set

- `mem.28C16` EEPROM (UI affordance: paste hex, upload `.bin`).
- `mem.74LS189` RAM with the open-collector inverted-output quirk.
- `mem.6116` SRAM.
- `gen.555` timer.
- `ttl.74LS107`, `74LS138`, `74LS139`, `74LS157`, `74LS161`, `74LS245`, `74LS273` composites.
- Pre-built Eater 8-bit reference circuit in `examples/ben_eater_8bit/`.
- **Demo:** load Eater's "fibonacci" microcode + program, watch the LEDs count.

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
