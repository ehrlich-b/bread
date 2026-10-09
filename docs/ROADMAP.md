# Roadmap

M0–M5 are shipped. M6 has three measured JavaScript optimization passes;
unrestricted speed targets remain open. M7 is shipped.

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

First JavaScript pass (2026-10-07):

- Resolved nets use `Uint8Array` values. Typed-array sidecars index pins and mark dirty/changed state; component records and evaluator buffers remain objects/arrays.
- All 19 built-in primitives dispatch through fixed call sites in the READ phase. Custom primitives and behavioral components retain the registry fallback.
- The changed-net queue uses byte marks and a stable array; dirty queues reuse their arrays.
- Unforced single-driver nets resolve directly, including weak pulls. Forced/multiple-driver nets retain contention resolution.

Target: **100+ kHz JavaScript / 1+ MHz WASM**. A historical unrestricted
JavaScript sample reached **88 kHz**. The 2026-10-07 efficiency-core median
was **16.627 kHz**; these execution conditions are not comparable. The
100 kHz target is unverified on this revision; a full WASM simulator is not implemented.

### Benchmark method and results

Apple Mac, Node 25.6.1, low-priority efficiency-core execution via
`taskpolicy -b nice -n 15`. `scripts/bench_eater.ts` runs the bundled Fibonacci
circuit (307 leaf components, 344 nets), with 20,000 warmup ticks and 200,000
measured ticks. Clock Hz is ticks/s divided by two. Each run emits 33,652 events.

```sh
taskpolicy -b nice -n 15 node --import tsx scripts/bench_eater.ts
```

Standalone results, three samples per version:

| Version | Clock samples (Hz) | Median (Hz) | Baseline change |
| --- | --- | --- | --- |
| `93655c0` baseline | 14,816 / 15,204 / 16,225 | 15,204 | — |
| Byte storage (`65584d8`) | 15,663 / 17,158 / 16,732 | 16,732 | +10.1% |
| Final (`88c46ae`) | 15,992 / 17,815 / 16,627 | 16,627 | +9.4% |

To control for changing laptop load, interleaved trials rotate versions in
2,000-tick blocks within one process, excluding other versions' execution
time. Each version receives the same warmup and measured tick counts.

| Version | Paired clock samples (Hz) | Median (Hz) | Paired baseline change |
| --- | --- | --- | --- |
| `93655c0` baseline | 14,077 / 13,468 / 13,040 | 13,468 | — |
| Byte storage + dispatch (`a9644f6`) | 15,381 / 15,442 / 14,069 | 15,381 | +14.2% |
| Final, direct single-driver resolution | 17,190 / 17,280 / 15,754 | 17,190 | +27.6% (+11.8% over dispatch) |

These clock-throughput figures exclude timed architectural observation.
An earlier correctness-observed SAP-1 sample on macOS arm64, Node 25.6.1,
measured 75,731 counted cycles/s and 15,146 instructions/s over 200,000 ticks,
checking 2,222 outputs. Reproduce with `scripts/bench_eater_observed.ts`.
The [four-bit CPU measurement](CPU_ASCENT.md) uses a different circuit and
checks each instruction. None establishes interactive frame rate.

Golden regressions compare every net byte over 2,048 Fibonacci cycles and
all 64 four-state full-adder input combinations, including startup/reset and
the full contention/oscillation event sequence. Validation uses typecheck,
Vitest (436 tests) and the production build.

The first pass’s final Node profile, including startup/warmup, attributes 86.5% inclusive
time to `tick`, 66.5% to `settle` and 15.6% to `computeNetValue`; these overlap.
A future WASM experiment should move scheduler, evaluation and resolution
behind a burst-level call and compare equivalent semantics. No WASM speedup
has been measured. Bounded diagnostic retention and interactive profiling
remain open.

### Second JavaScript pass (2026-10-08)

Small built-ins now read four-state bytes through generated truth tables;
DFF tables include Q/previous-clock state and share matching configurations.
Wider small adders use numeric four-state sum/majority evaluation. Driver
values, output/net mappings and listener lists use flat typed arrays, with
mutable inspection views preserving existing graph access. Packed words skip
unchanged output commits. Generation marks remove dirty-list clearing and
contention-set churn, including tested uint32 rollover. READ/COMMIT phases,
FIFO scheduling, oscillation limits and diagnostic ordering stay intact;
custom leaves and larger primitives retain normal evaluator dispatch.

Five paired trials per condition compare the frozen `f6c3595` scheduler with
this pass in one process. Each receives 20,000 warmup and 200,000 measured
ticks, alternating first execution in 2,000-tick blocks. Timing excludes
all-net/event checks after each block; both versions emit 33,652 events.
Clock Hz remains ticks/s divided by two.

| Execution condition | `f6c3595` median (Hz) | This pass median (Hz) | Gain |
| --- | ---: | ---: | ---: |
| Background, nice(15), efficiency-core conditions | 16,260 | 36,279 | 2.231× |
| Background tier removed, nice(15) retained | 15,805 | 35,376 | 2.238× |

Unrestricted performance-core trials were unavailable under the mandatory
nice(15) rule. The second row changes only the macOS background tier; it does
not establish unrestricted throughput or the 100 kHz target.

```sh
taskpolicy -b nice -n 15 node --import tsx scripts/bench_eater_paired.ts
taskpolicy -b nice -n 15 env BREAD_BENCH_FOREGROUND=1 node --import tsx scripts/bench_eater_paired.ts
```

The trace lock remains byte-identical. Differential tests compare every net,
driver, component state and observer event against `f6c3595` over 64 seeded
random circuits × 64 ticks, including paused/input changes, feedback,
contention, weak pulls, floating pins, inout, storage and oscillation. They
also cover all 64 driver-presence masks with six external forces and held
mutable graph views. Existing full-net golden traces remain unchanged. Typecheck, all 857 Vitest
tests, build, blink, the three testbench corpus files, Verilog oracles and
all 94 in-memory Playwright checks pass.

The fresh Node profile includes startup/warmup: `tick` is 71.0% inclusive,
`settle` 70.7%, fallback evaluation 4.4%, and `computeNetByte` 2.4%; these
fractions overlap. Most remaining work is inside the compiled scheduler.

Third JavaScript pass (2026-10-08): fixed-capacity dirty FIFOs remove array
truncation/growth, and compiled DFF state conversion stays inline. Five paired
trials against `bf70267`, in one background/nice(15) process with 20,000 warmup
and 200,000 measured ticks per version, alternate 2,000-tick blocks. SAP-1
median clock throughput rises **43,047 → 53,232 Hz (+23.7%)**; eight OUT-bit
probes give **43,970 → 54,398 Hz (+23.7%)**, excluding UI delivery/rendering.
The 1,175-leaf Digital CPU example with a derived looping ROM rises
**14,821 → 18,706 ticks/s (+26.2%)**. Full-net trace bytes stay unchanged;
differentials cover 64 random circuits × 256 ticks and three CPU examples.
Unrestricted speed targets remain open.

### WASM feasibility

The installed Clang/LLVM 22.1.8 and `wasm-ld` compiled a freestanding C
[WASM module](https://lld.llvm.org/WebAssembly.html) without installing a
toolchain or dependency. Five interleaved trials of the isolated stateless
READ kernel (245 SAP-1 leaves, artificial clock-bit toggles, 2,000 batches
per boundary call) measured medians of **233,145 JS / 761,974 WASM READ
batches/s**, or **3.268×**. Checksums and every proposed word match. This
probe omits scheduling, DFF state, memory, resolution and diagnostics; its
rates are not simulated clock Hz.

A full C/LLVM core would marshal the graph once into linear memory, own
queues, driver resolution, storage and clock/memory behavior, and export
`settle`/`tickBurst(n)` with batched snapshots/events. It must preserve separate
settle/tick counters, four-state/weak-driver rules, stable phases and caps;
unsupported custom leaves can use the JS engine. Inference from the final
profile: matching the kernel’s gain across all of `settle` would imply about
**3.2× tick throughput**. Full-core gain and **1+ MHz** remain unmeasured;
a resolver-only port addresses less than 3.4% of profiled tick time.

Reproduce the optional kernel probe with an existing LLVM WASM toolchain:

```sh
taskpolicy -b nice -n 15 mkdir -p .scratch
taskpolicy -b nice -n 15 clang --target=wasm32 -nostdlib -O3 -Wl,--no-entry -Wl,--export=read_batch -Wl,--export-memory -Wl,--initial-memory=262144 scripts/wasm_read_probe.c -o .scratch/wasm-read.wasm
taskpolicy -b nice -n 15 node --import tsx scripts/bench_wasm_read.ts
```

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
