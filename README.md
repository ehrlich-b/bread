# bread

Browser-based digital circuit simulator. Goal: run Ben Eater's 8-bit computer at full speed in a tab — and anything else built from TTL-class digital logic.

## Status

Alpha. Milestones M0–M5 from [docs/ROADMAP.md](docs/ROADMAP.md) are shipped:

- Engine kernel — two-phase event-driven scheduler, four-state logic, tristate resolution, oscillation detection, determinism regression.
- All 18 primitives (`prim.AND`, `OR`, `NAND`, `NOR`, `XOR`, `XNOR`, `NOT`, `BUF`, `TRISTATE`, `DFF`, `LATCH`, `MUX2`, `DEMUX2`, `DECODER`, `ADDER`, `CONST_0`, `CONST_1`, `PULLUP`, `PULLDOWN`).
- Composite loader with cycle detection; 15 TTL composites in the stdlib (`ttl.74LS00/02/04/08/32/86/107/138/139/157/161/173/245/273/283`) — every TTL part on Ben Eater's 8-bit bench.
- Web Worker engine + `SharedArrayBuffer` net-state read path; blink demo runs in-browser.
- Schematic editor: place / move / rotate / delete, orthogonal wire drawing, property inspector, save/load via File System Access API (with download fallback and explicit Download/Open/Circuit JSON actions), undo/redo with Cmd-Z, selected subcircuit creation and project-local reusable chips. Built-from-gates 1-bit full adder verified end-to-end via Playwright.
- Behavioral chip set: `gen.555`, `io.7seg` (with live segment fills), `mem.6116` SRAM, `mem.74LS189` RAM, and `mem.28C16` EEPROM. The EEPROM has a hand-crafted DIP renderer plus a paste-hex / upload-`.bin` affordance in the property inspector; `mem.6116` and `mem.28C16` both round-trip `params.contents` through circuit JSON.
- Eater SAP-1 module library: eight `eater.*` composites (`register_8bit`, `alu_8bit`, `ram_module`, `program_counter`, `instruction_register`, `flags_register`, `output_display`, `control_unit`). The control unit's microcode is generated in TypeScript and injected into the two onboard 28C16 EEPROMs at composite-registration time so the source stays human-readable.
- Bundled `examples/ben_eater_8bit.json` — a fully-wired SAP-1 with a Fibonacci program preloaded into the 6116. Click the RESET switch to release reset and the engine streams 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233 onto the two-digit hex display before JC fires on the overflow and restarts the loop.

338 vitest cases green; 38 Playwright e2e tests cover the editor, blink demo, save/load + bundled-examples menu, full-adder truth table, the generic-renderer / palette surface, the 28C16 hex-display example, and the Ben Eater 8-bit reference. The full stdlib (every primitive, every TTL composite, every behavioral) is clickable from the palette via a generic IC renderer that builds itself from the engine's pin spec.

The [NAND-to-CPU checkpoint](docs/CPU_CLIMB_CHECKPOINT.md) records the initial capability investigation, editor queue regressions, independent reference-program checks, and measured performance. The supported local manual browser route is now available; the first manual NAND truth table passed. [Chip authoring](docs/CHIP_AUTHORING.md) enables the next ascent stages.

## What it is

A schematic-style digital simulator with:

- A TTL chip library (74xx series, EEPROMs, SRAMs — the parts on Eater's bench).
- An event-driven, two-phase simulation engine.
- Persistent circuits in a versioned JSON format.
- Visual subcircuit authoring: select gates, name ports, reuse and edit nested chips, and save the library with your circuit. See [the chip authoring guide](docs/CHIP_AUTHORING.md).
- A web UI that runs simulation in a Web Worker so the schematic stays responsive.

Built in TypeScript. Engine has a path to WASM if profiling demands it.

## Non-goals

- **Analog simulation.** No SPICE, no transistors, no RC networks. Four-state digital logic (`0`, `1`, `Z`, `X`) only.
- **FPGA toolchain replacement.** Verilog *export* is on the roadmap; synthesis, place-and-route, and bitstreams are out of scope.
- **Faithful breadboard physics.** Schematic view is canonical. A breadboard skin may come later but won't model contact resistance, lead inductance, or any analog effect.
- **A textual HDL.** Components are written in TypeScript; circuits are composed in a JSON IR. We do not invent a hardware description language. See [docs/COMPONENTS.md](docs/COMPONENTS.md) for the rationale.

## Stack

- TypeScript (strict mode).
- Vite for dev server and production build.
- SVG for schematic rendering. Canvas only if profiling forces it.
- `Web Worker` for the simulation engine; `SharedArrayBuffer` for zero-copy net state reads from the UI thread.
- Optional WASM hot path (Rust or AssemblyScript) for the event-dispatch loop. Only when JS profiling demands it.

## Anchor docs

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layer split, threading, data flow, module boundaries, message protocol. |
| [docs/SIMULATION.md](docs/SIMULATION.md) | Event-driven semantics, two-phase propagation, four-state logic, tristate resolution, oscillation, timing. |
| [docs/COMPONENTS.md](docs/COMPONENTS.md) | The three component tiers (primitive / composite / behavioral) and why we don't ship an HDL. |
| [docs/CIRCUIT_FORMAT.md](docs/CIRCUIT_FORMAT.md) | JSON schema for saved circuits and composite chip definitions. |
| [docs/STDLIB.md](docs/STDLIB.md) | TTL chip catalog with implementation strategy per chip. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones from "blink an LED" to "boot Eater's machine." |
