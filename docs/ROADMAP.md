# Roadmap

M0–M5 and M7 are shipped. The two M6 JavaScript backends have an offline
correctness and performance comparison; unrestricted speed targets remain open.

## Shipped milestones

| Milestone | Capabilities and demonstration |
| --- | --- |
| M0 — Engine | Two-phase scheduler, four-state logic, tristate resolution, oscillation detection and deterministic NAND-latch traces. |
| M1 — Primitives | Gates, storage, arithmetic and routing primitives with truth-table, X/Z and sequential tests; four-bit adder demo. |
| M2 — Composites | Runtime validation, JSON schema, hierarchy flattening/cycle detection and TTL chips; register-bus demo. |
| M3 — Worker/UI | Web Worker simulation, shared net-state reads, switches/LEDs/clocks; blink demo. |
| M4 — Editor | Placement, rotation, wiring, inspector, JSON save/load and undo/redo; editor-built full-adder truth table. |
| M5 — Memory/SAP-1 | All 15 TTL composites, SRAM/EEPROM, 555 timer, live seven-segment display, eight SAP-1 modules and generated microcode; bundled Fibonacci example. |
| M5a — Palette | Generic pin-aware renderer, every shipped chip available in the palette, bundled-examples menu and programmable memory inspector. |

The bundled SAP-1 outputs 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233
before carry restarts Fibonacci. Independent program tests cover arithmetic,
load/store, conditional loops, carry and repeated OUT instructions.

The [editor-built four-bit CPU](CPU_ASCENT.md) has 14 reusable modules and
checked arithmetic/HALT behavior. Automated ISA tests also cover load/store
and branches; those UI checks and interactive throughput remain open.

The [original Digital CPU port](ORIGINAL_CPU_PORT.md) runs CALLRET, countdown,
Fibonacci and PUSH/POP. Nine source modules and 16 supporting composites
preserve its topology and 31-byte boot-loader limit. Tests compare architecture
and ordered outputs after each instruction; browser tests cover CALLRET and
save/reopen.

## M6 — Performance

The integration retains main's hand-inlined typed-array simulator from
`6a5ffbd`. Native primitive evaluation, driver/listener sidecars and integer
resolution remain in its hot loop. Clock time advances only on ticks;
initialized/enabled DFFs, uncertain Verilog drivers, bounded diagnostics,
mutable graph inspection and synchronous callbacks are supported.

The competing compiled four-state backend remains isolated from the
production engine. Frozen test fixtures preserve it for differential vectors
and paired benchmarks. See [the simulator comparison](SIMULATOR_BENCHMARK.md)
for the acceptance decision, workload definitions, seven paired trial samples
and fresh-process retained-memory measurements.

```sh
BREAD_DIFFERENTIAL_BACKEND=truth-table npm test -- --maxWorkers=2 --minWorkers=1 src/engine/differential.test.ts src/engine/sim.callbacks.test.ts src/engine/sim.reentry.test.ts
taskpolicy -b nice -n 15 node --expose-gc --import tsx scripts/bench_simulators.ts 7 100000
```

The existing Eater, observed Eater, editor-checkpoint CPU and hierarchy tools
remain available. Benchmarks run headlessly; throughput excludes browser
rendering and delivery. The target is **100+ kHz JavaScript / 1+ MHz WASM**;
clock Hz is half the ticks/s for the Eater example. These background nice(15)
measurements do not establish unrestricted speed.

The standalone `scripts/bench_wasm_read.ts` and `scripts/wasm_read_probe.c`
experiment is retained against the frozen compiler. It measures a stateless
READ kernel rather than scheduling, memory, DFF state or resolution. A complete
WASM simulator and its speed target remain unimplemented.

## M7 — Polish

Implemented:

- [Reusable chip authoring](CHIP_AUTHORING.md): select fragments, name ports, nest/edit/test definitions and save project libraries.
- Atomic bus connections with bit-mapping preview; configurable word ROMs and live binary/hex readouts.
- Visual wire bundles inferred from consecutive bits, including Connect bus wiring and partial fan-out. Thick bus-colored trunks show width and live hex/X/Z values; **Group wires** restores individual wires. Pins and bit fan-out paths retain probing and wiring edits, with ordinary JSON nets and undo/redo.
- Fit circuit and editable labels that persist through save/reopen.
- [Permalink sharing](../README.md#sharing-circuits) with raw-deflate/base64url version-1 hashes, damage detection, validated and ordered loads, named example links and a 16,000-character full-URL limit. Seven bundled circuit links fit; the original Digital CPU uses JSON export or its named example link.
- [Keyboard shortcuts](../README.md#keyboard-shortcuts) for run/pause, step, undo/redo, deletion, rotation, mode cancellation, fit and help, guarded while typing or using dialogs.
- [Touch controls](../README.md#touch-controls): Pointer Events for one-finger canvas pan, pinch zoom, tap placement/selection/wiring, component dragging and long-press actions. Phones and tablets use a canvas-first layout with collapsible panels. Gesture and pointer-lifecycle unit tests cover thresholds, cancellation and preview rollback; mobile Playwright checks cover editing, simulation and expanded layouts at 390×844 and 768×1024.
- Canvas net/bus probes saved in version-1 JSON, with undo/redo; an 8,192-tick waveform ring, distinct 0/1/X/Z traces, hex bus segments, zoom, scroll and a tick cursor integrated with run/pause/step. Probe-only edits preserve running state; capture is absent with no probes.
- [Declarative testbench files](TESTBENCH.md): schema-validated JSON signal bindings, four-state vectors and masks, clock pulses, bounded edge waits and exhaustive loops. Node CLI and worker-backed UI panel share the engine runner; adder, register/bus and SAP-1 Fibonacci corpus runs in Vitest.
- [SAP-1 program gallery](../README.md#sap-1-programs): count up and wrap, count up/down with carry/zero branches, RAM multiplication by repeated addition, add/subtract with flags, and output/HLT. Each has a commented 16-byte image, Examples menu entry, named link, JSON corpus assertions and browser OUT checks; count-up and multiplication have Icarus cross-checks.
- An Eater CPU tutorial, opened with **Tutorial** or `#tutorial`: seven guided steps covering step/run, a CLK probe, A-register loading, addition, RAM/PC fetch, one ADD instruction’s microcode and Fibonacci OUT waveforms. Canvas highlights and completion checks use real control signals, register values and recorded edges; Back, Skip, Restart and Reset work with optional browser-local progress. The final step can run the bundled Fibonacci testbench.
- [Best-effort Verilog export](VERILOG.md): pure saved-circuit export, a top module and one module per reusable chip, scalar bus lanes, tristates/wired nets, storage, TTL/memory and SAP-1 mappings. UI download and Node CLI include explicit approximation/omission comments. Optional Icarus/vvp oracles compare every settle/tick for exhaustive full-adder inputs, the register/shared bus and three Fibonacci OUT sequences through carry restart; memory, storage and all shipped chips have additional checks.
- [Structural Verilog import](VERILOG.md#import): a dependency-free parser for documented unsigned gate-level hierarchy, vector ports/wires, continuous expressions, gate primitives, tristates and positive-edge registers. Checked exporter cells recover all shipped storage/memory/source primitives; helper modules become placed project chips. UI and CLI use engine validation and ordered document loading. Round-trip oracles compare every net for all bundled examples/library types and the existing testbench corpus; Icarus executes original hand-written adder, counter, eight-bit register and ALU designs for independent four-state comparisons.

Same-session background Node benchmarks measured median clock throughput of
**22,763 Hz without probes** and **22,396 Hz with eight OUT-bit probes**
(200,000 ticks, 20,000 warmup). These include capture, excluding UI delivery
and rendering; the simulator tick path is unchanged when no probes exist.

## Later possibilities

WASM-isolated user behavioral chips, a visual breadboard skin,
cloud save/sharing and collaboration. These are not promised.
Analog simulation, CPU-specific engine instructions, PCB layout and real
hardware programming remain out of scope.

Each milestone needs passing tests, a working example and current documentation.
