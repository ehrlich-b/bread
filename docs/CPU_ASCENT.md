# Editor-driven NAND-to-CPU ascent

The editor-built CPU runs arithmetic and HALT. The broader mountain test is
unfinished: manual load/store, conditional branch/loop, and high-speed UI
validation are the next steps. Work is parked at Bryan's explicit overnight
stopping instruction.

## Actual editor construction

A separate local Codex browser task used the supported Browser skill and
browser-client. Every component was placed from the palette and every connection
was made by clicking visible pins. Selected fragments were packaged through
Create chip, ports named through the form, and nested chips reused from My
chips. No generated circuit or prebuilt CPU was imported as construction proof.

The authored library contains Nand, Not, And, Or, Xor, Mux, HalfAdder,
FullAdder, SRLatch, RegisterBit, Register4, Mux4, Adder4, and PC4. Storage uses
the clocked DFF primitive inside an authored mux-feedback RegisterBit; SRAM,
EEPROM, decoder, constants, and tristate primitives supply their native
behaviors. This is not a transistor-level or entirely NAND-only CPU.

Manual checks include gate truth tables, all eight FullAdder rows, latch
set/reset/hold, register clear/clock/enable, arithmetic carry and wrap, and PC
increment/hold/target load/wrap. Cold reload followed by Paste JSON restored
And, FullAdder, Register4, and PC4 libraries and their checked behavior. The
exact [action log](evidence/manual-ascent/action-log.json) contains 1,520 actual
actions and 117 result records, including failed attempts and limitations.

The final root contains 43 placed components and 14 definitions. The editor
ROM inspector was used to enter `05 13 19 60`. Actual switch actions produced:

| Action | PC | Accumulator | Evidence |
| --- | ---: | ---: | --- |
| Reset high then low, clock low | 0 | 0 | [Reset](evidence/manual-ascent/cpu4-reset.jpg) |
| First rising edge: LDI 5 | 1 | 5 | [Edge 1](evidence/manual-ascent/cpu4-edge1.jpg) |
| Second rising edge: ADDI 3 | 2 | 8 | [Edge 2](evidence/manual-ascent/cpu4-edge2.jpg) |
| Third rising edge: ADDI 9, modulo 16 | 3 | 1 | [Edge 3](evidence/manual-ascent/cpu4-edge3.jpg) |
| Additional raw clock edge at HALT | 3 | 1 | [Halt](evidence/manual-ascent/cpu4-halt.jpg) |

The [wiring screenshot](evidence/manual-ascent/cpu4-wiring.jpg) and exact
[saved CPU checkpoint](evidence/manual-ascent/cpu4-editor-checkpoint.json)
are retained in the repository. The complete sequence of intermediate JSON
files and screenshots remains in `/Users/ehrlich/repos/bread-manual-evidence`.
The [PC4 library checkpoint](evidence/manual-ascent/pc4-editor-checkpoint.json)
is retained separately.

The browser's native Save picker and Blob download did not yield usable saved
paths. A visible Circuit JSON textarea and Paste JSON dialog were implemented
and tested. QA saved the exact text exposed by that explicit export control.
No private app-state or browser-session access was substituted. JSON persists
circuit definitions and ROM contents; live register/SRAM state is not serialized,
so reopened circuits need reset. The complete CPU has not yet been cold-reopened
and manually rechecked.

Checkpoint SHA256:

- CPU: `7f91eb530486ba91ac5a1ca13718591daa6af2335e9c2f3720200bdc3f242366`
- PC4: `8dea7ee4d33323b4651b9695f328db4a5550cbf8d32b56b4d1ab4d43a1ae9864`

## Separate correctness gates

[Module checks](evidence/manual-ascent/module-checks.json) run 4,743 independent
headless assertions on unchanged editor-authored definitions, including all
512 input/control combinations for Mux4 and Adder4. These assertions are
ordinary automated harnesses, not additional manual actions.

[CPU tests](../src/climb/cpu4.plan.test.ts) compare PC, accumulator, all 16
addressed RAM bytes, halt, and reset to a separate integer ISA after each
instruction. Three graph sources are labeled explicitly: a generated primitive
plan, generated integration using the exact manual library, and the actual
editor-built CPU checkpoint. The last changes only the ROM in a headless clone
for each program; the saved checkpoint remains byte-for-byte unchanged.

| Program | Expected result | Actual UI | Actual saved CPU, headless |
| --- | --- | --- | --- |
| `05 13 19 60` | ACC 1, HALT at PC 3 | Passed | Passed |
| `09 3F 00 2F 11 3E 60` | RAM F=9, RAM E=10, ACC 10 | Pending | Passed |
| `03 1F 44 51 60` | Countdown 3→0, taken/untaken JZ, backward JMP, HALT at PC 4 | Pending | Passed |

Encoding: 4-bit operand, three opcode bits in bits 4–6, bit 7 zero; opcodes
LDI, ADDI, LD, ST, JZ, JMP, HALT, NOP. The independent plan helper rejects
invalid, high-bit, sparse, and oversized programs consistently with its ISA.
The simulator itself remains a general circuit editor, with no CPU-specific
instruction validation imposed on ROMs.

Current source checks:

- [350 unit tests](evidence/cpu-validation/unit-tests.txt), including sequential
  and four-state behavior, hierarchy cycles, transactional worker failures,
  library edits/revisions, undo/redo, and repeated queued actions.
- [40 browser regressions](evidence/cpu-validation/browser-tests.txt), including
  chip creation/reuse/edit propagation, visible JSON round-trip, real
  parameterized pins, and the tick-rate control.
- [Typecheck](evidence/cpu-validation/typecheck.txt) and
  [production build](evidence/cpu-validation/build.txt) pass.
- [Independent review](evidence/cpu-validation/review.txt) verified fixes,
  unchanged manual definitions, seeded programs and worker timing/metrics.

## Performance and current UI changes

The actual editor CPU flattens to 263 leaf evaluators and 276 nets. A checked
100,000-instruction headless loop completed at **55,035 observed CPU cycles and
instructions per second** on Apple M4, macOS arm64, Node v25.6.1. Every completed
instruction was compared to the integer ISA, and actual settled clock edges
were counted; there were zero oscillations or diagnostic events in this sample.
This is one local measurement including observation cost, not an interactive
frame-rate or clock-speed guarantee. [Exact metrics](evidence/cpu-validation/actual-cpu-benchmark.json).

Reproduce from this checkout with:

```sh
node --import tsx scripts/bench_climb_cpu.ts
node --import tsx scripts/check_manual_climb.ts docs/evidence/manual-ascent/pc4-editor-checkpoint.json
```

The loop ROM `01 1F 3F 2F 51` is a derived headless workload; it has not been
entered or run in the manual browser. A prior generated integration profile
placed 40.7% of samples in settle and 18.7% in net resolution. No engine
semantic shortcut or primitive promotion was introduced.

Run previously hardcoded 1,000 ticks/s. The current isolated source candidate
provides a requested tick-rate input (1–1,000,000), measured worker ticks/s,
and total ticks. Rates are validated before changing the worker. Batches yield
after about 8 ms, checked every 32 ticks, with capped wall-time debt so Pause
remains responsive; a single expensive tick can still exceed that budget.
The 1 Hz boundary has a specific regression. Requested and achieved tick rates
are distinct from CPU clocks and instruction rates.

These controls passed ordinary browser regressions; the manual CPU browser
used the earlier frozen candidate. Interactive CPU speed and render frame rate
remain unmeasured. Changing worker ticks/s alone adjusts gen.clock resolution;
the clock component's freqHz must also be set for a faster circuit clock.
High-speed diagnostic retention still needs attention: the simulator event
array and UI log are unbounded. Their four-state/contention meaning was preserved.

Composite definitions remain recursively flattened before execution. The
separate [hierarchy benchmark](../scripts/bench_hierarchy.ts) compares load cost
and equivalent leaf graphs; no hierarchical execution backend exists, so it
does not establish an execution speedup from packaging gates.

The actual QA also exposed DFF clear pins missing from the hand-crafted
renderer. The current candidate falls back to the actual engine pin spec when
parameters change pins, covering DFF clear/preset, n-ary gates, and active-low
tristates. QA had used the supported port exposure form before this fix.

## Park and next step

The CPU is paused with raw clock/reset low, observed PC=3/ACC=1. Baseline 5188
and source-owned candidate servers 5189/5190 are stopped. The browser regression
server 5191 ended with its test run. Tabs and all source branches/checkpoints
are preserved. Port 5173 belongs to another application and was untouched.
No WSL resources, pushes, deployments, releases, or new external uploads were used.

Resume by serving the saved source candidate, reopening the exact CPU JSON
through Paste JSON, resetting, and running the two pending ROMs through the
inspector and actual manual clock actions. Check RAM in the UI, then measure
correctness at higher interactive clock rates and UI responsiveness. Native
save fallback, module discoverability, crowded wire routing, and bounded
diagnostics remain prioritized usability/performance follow-through.
