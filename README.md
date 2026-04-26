# bread

Browser-based digital circuit simulator. Goal: run Ben Eater's 8-bit computer at full speed in a tab — and anything else built from TTL-class digital logic.

## Status

Pre-alpha. Anchor design docs only. No code yet.

## What it is

A schematic-style digital simulator with:

- A TTL chip library (74xx series, EEPROMs, SRAMs — the parts on Eater's bench).
- An event-driven, two-phase simulation engine.
- Persistent circuits in a versioned JSON format.
- Subcircuit hierarchy, composed visually or in JSON.
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
