# bread

Browser-based digital circuit simulator. Goal: run Ben Eater's 8-bit computer at full speed in a tab, along with other TTL-class digital circuits.

## Status

Alpha. [Roadmap milestones M0–M5](docs/ROADMAP.md) are shipped:

- Event-driven, two-phase engine with four-state logic, tristate resolution, oscillation detection and deterministic traces.
- Primitive gates and storage, 16 TTL composites, clocks, a live seven-segment display, SRAM and programmable EEPROMs. Every shipped component is available in the palette.
- SVG schematic editor with placement, rotation, wiring, labels, bus connections, live signal inspection and undo/redo. Save/open files, copy/paste Circuit JSON or share a circuit permalink, including memory images, probes and project-local reusable chips. See [chip authoring](docs/CHIP_AUTHORING.md).
- Persisted canvas probes and a bounded, four-state waveform viewer with hex buses, zoom, scroll and a tick cursor. Run, pause and step share the same recording.
- Web Worker simulation with `SharedArrayBuffer` net-state reads, configurable tick rate and measured worker throughput.
- Eight `eater.*` SAP-1 modules and the bundled `examples/ben_eater_8bit.json`. Release RESET to run Fibonacci: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, then restart on carry.
- [Bryan's original 2022 Digital CPU](docs/ORIGINAL_CPU_PORT.md), converted from pinned sources by rerunnable Python scripts. Select **Bryan's Digital CPU (generated port)** in Examples, click **Fit circuit**, then **Run** to output 1 through 10. Its CALLRET, countdown, Fibonacci and PUSH/POP programs pass instruction-by-instruction comparisons against an independent ISA interpreter. The source loader's 31-byte limit is preserved.

The [editor-built four-bit CPU](docs/CPU_ASCENT.md) uses 14 reusable modules. Arithmetic and HALT work in the editor; automated ISA tests also cover load/store and conditional loops. UI checks for those programs and high-speed responsiveness remain open.

Vitest covers engine semantics, queued editor actions, library edits, save/load and all three CPU designs. Playwright covers editor workflows, full-adder truth tables, ROMs, bus wiring, live displays and bundled examples. See the [roadmap](docs/ROADMAP.md) for benchmark methods and remaining performance targets.

## Quick start

Requires Node.js 20+ and npm. Install dependencies with `npm ci`, then start Vite with `npm run dev` and open the URL it prints. Use a current browser with `SharedArrayBuffer` support; Vite supplies the required isolation headers.

Run `npm run typecheck`, `npm test -- --maxWorkers=2 --minWorkers=1` and `npm run build` for local checks. For browser tests, install Chromium once with `npx playwright install chromium`, then run `npm run e2e`.

## Sharing circuits

Click **Share**, then **Copy link**, or copy the selected link manually. Opening
it restores the circuit through the same validation and undoable editor queue
as **Open JSON**. Changing the URL hash loads another circuit; later edits or
loads supersede pending decoding. Sharing updates the address without resetting
the current simulation. Links contain saved circuit data, including probes,
memory images and project chip libraries. Live simulation state and waveform
history are session-only.

Version 1 links use the browser's built-in `CompressionStream('deflate-raw')`
and base64url, with the format
`#c1=<compressed UTF-8 JSON>.<SHA-256 of compressed bytes>` (both fields are
base64url). The checksum detects damage; circuit content is parsed as JSON data
and validated against registered components. Corrupt, truncated, invalid or
future-version links show an error and preserve the current circuit. A current
browser with raw-deflate compression and Web Crypto support is required.

The practical limit is **16,000 characters for the full URL**, including the
origin and path. Share reports its length and offers **Download JSON** when the
circuit exceeds that limit. Opening an oversized circuit URL also shows an
error. Decoded JSON is bounded to 4 MiB during decompression. This is a
conservative sharing limit; messaging services may impose smaller limits.

Measured with the built-in raw-deflate encoder (Node 25.6.1):

| Bundled example | Hash characters | Full URL characters¹ |
| --- | ---: | ---: |
| `blink_demo` | 492 | 514 |
| `full_adder` | 644 | 666 |
| `nand_latch` | 378 | 400 |
| `register_bus_4bit` | 612 | 634 |
| `ripple_adder_4bit` | 782 | 804 |
| `hex_display_28c16` | 930 | 952 |
| `ben_eater_8bit` | 2,626 | 2,648 |
| `original_digital_cpu_generated` | 65,842 | 65,864 (use JSON) |

¹ Using the illustrative 22-character base `https://bread.example/`; actual
lengths depend on the hosting address and browser compression output.

For an unedited bundled example, use `#example=<name>`, such as
`#example=full_adder` or `#example=original_digital_cpu_generated`. These short
links select the example bundled with the app rather than carrying its data.

## Keyboard shortcuts

Click the canvas or another area outside a text field to use these keys.
Shortcuts are disabled in inputs, textareas, selects, editable text and open
dialogs, including the JSON editor. **?** or **Keyboard shortcuts** opens help.

| Key | Action |
| --- | --- |
| Space | Run / pause at the configured tick rate |
| `.` | Step one tick |
| Ctrl/Cmd+Z | Undo |
| Shift+Ctrl/Cmd+Z, Ctrl+Y | Redo |
| Delete / Backspace | Remove selection |
| R | Rotate selection 90° |
| Escape | Cancel placement, wiring, probe or bus mode |
| F | Fit circuit |
| ? | Show shortcuts help |
| + / − / 0 | Zoom in / out / reset view |

## Design and scope

TypeScript in strict mode, Vite, SVG schematics and Web Worker simulation. Circuits and reusable chip definitions use versioned JSON. Composites flatten into primitive and behavioral evaluators at load time; packaging gates improves reuse without changing execution cost.

Bread models digital `0`, `1`, `Z` and `X`. Analog effects, breadboard physics, FPGA synthesis and hardware programming are out of scope. Best-effort Verilog export is planned. A WASM engine remains a profiling-driven option.

## Documentation

| Doc | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Threading, data flow, module boundaries and worker protocol. |
| [Simulation](docs/SIMULATION.md) | Scheduling, four-state logic, tristates, oscillation and timing. |
| [Components](docs/COMPONENTS.md) | Primitive, composite and behavioral tiers. |
| [Circuit format](docs/CIRCUIT_FORMAT.md) | Saved circuits and chip definitions. |
| [Standard library](docs/STDLIB.md) | Chip catalog and implementation strategy. |
| [Roadmap](docs/ROADMAP.md) | Milestones, performance measurements and planned features. |
