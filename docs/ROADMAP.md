# Roadmap

M0–M5 are shipped. M6's JavaScript optimization pass is complete; its speed
target remains unverified. M7 is in progress.

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

Completed JavaScript changes:

- Resolved nets use `Uint8Array` values. Typed-array sidecars index pins and mark dirty/changed state; component records and evaluator buffers remain objects/arrays.
- All 19 built-in primitives dispatch through fixed call sites in the READ phase. Custom primitives and behavioral components retain the registry fallback.
- The changed-net queue uses byte marks and a stable array; dirty queues reuse their arrays.
- Unforced single-driver nets resolve directly, including weak pulls. Forced/multiple-driver nets retain contention resolution.

Target: **100+ kHz JavaScript / 1+ MHz WASM**. A historical unrestricted
JavaScript sample reached **88 kHz**. The 2026-10-07 efficiency-core median
was **16.627 kHz**; these execution conditions are not comparable. The
100 kHz target is unverified and WASM is not implemented.

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

The final Node profile, including startup/warmup, attributes 86.5% inclusive
time to `tick`, 66.5% to `settle` and 15.6% to `computeNetValue`; these overlap.
A future WASM experiment should move scheduler, evaluation and resolution
behind a burst-level call and compare equivalent semantics. No WASM speedup
has been measured. Bounded diagnostic retention and interactive profiling
remain open.

## M7 — Polish

Implemented:

- [Reusable chip authoring](CHIP_AUTHORING.md): select fragments, name ports, nest/edit/test definitions and save project libraries.
- Atomic bus connections with bit-mapping preview; configurable word ROMs and live binary/hex readouts.
- Fit circuit and editable labels that persist through save/reopen.
- [Permalink sharing](../README.md#sharing-circuits) with raw-deflate/base64url version-1 hashes, damage detection, validated and ordered loads, named example links and a 16,000-character full-URL limit. Seven bundled circuit links fit; the original Digital CPU uses JSON export or its named example link.
- [Keyboard shortcuts](../README.md#keyboard-shortcuts) for run/pause, step, undo/redo, deletion, rotation, mode cancellation, fit and help, guarded while typing or using dialogs.
- Canvas net/bus probes saved in version-1 JSON, with undo/redo; an 8,192-tick waveform ring, distinct 0/1/X/Z traces, hex bus segments, zoom, scroll and a tick cursor integrated with run/pause/step. Probe-only edits preserve running state; capture is absent with no probes.

Same-session background Node benchmarks measured median clock throughput of
**22,763 Hz without probes** and **22,396 Hz with eight OUT-bit probes**
(200,000 ticks, 20,000 warmup). These include capture, excluding UI delivery
and rendering; the simulator tick path is unchanged when no probes exist.

Planned:

- Grouped wire rendering.
- Declarative testbench files and best-effort Verilog export.
- An Eater CPU tutorial.

## Later possibilities

WASM-isolated user behavioral chips, Verilog import, a visual breadboard skin,
touch support, cloud save/sharing and collaboration. These are not promised.
Analog simulation, CPU-specific engine instructions, PCB layout and real
hardware programming remain out of scope.

Each milestone needs passing tests, a working example and current documentation.
