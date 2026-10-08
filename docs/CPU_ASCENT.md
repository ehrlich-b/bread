# Editor-built four-bit CPU

The CPU uses 14 reusable chips: Nand, Not, And, Or, Xor, Mux, HalfAdder,
FullAdder, SRLatch, RegisterBit, Register4, Mux4, Adder4 and PC4. RegisterBit
combines a DFF primitive with mux feedback; SRAM, EEPROM, decoders, constants
and tristates provide their native behaviors. The root has 43 components.

The [CPU fixture](../src/climb/fixtures/cpu4-editor-checkpoint.json) contains
the complete circuit and ROM `05 13 19 60`. The
[PC4 fixture](../src/climb/fixtures/pc4-editor-checkpoint.json) contains the
reusable library. Open either through **Open JSON** or **Paste JSON**.
Saved definitions and initial memory images persist; live registers and RAM
writes do not, so reset after reopening.

## Programs and tests

Instructions have a four-bit operand and three opcode bits in bits 4–6;
bit 7 is zero. Opcodes are LDI, ADDI, LD, ST, JZ, JMP, HALT and NOP.

| ROM bytes | Expected result |
| --- | --- |
| `05 13 19 60` | ACC 5 → 8 → 1, HALT at PC 3 |
| `09 3F 00 2F 11 3E 60` | RAM F=9, RAM E=10, ACC 10 |
| `03 1F 44 51 60` | Countdown 3 → 0, taken/untaken JZ, backward JMP, HALT at PC 4 |

Arithmetic, wrap and stable HALT have been checked with editor clock/reset
switches. UI checks for load/store, branches and full-CPU reopening remain open.

[CPU tests](../src/climb/cpu4.plan.test.ts) compare PC, accumulator, all 16
addressed RAM bytes, reset and HALT against an independent integer ISA after
each instruction. They exercise the saved CPU, a primitive plan and an
integration plan using the saved chip library. Program variants replace ROM
contents in a clone. Invalid, high-bit, sparse and oversized programs are
rejected by the plan helper; general-purpose ROMs accept arbitrary bytes.

The module checker makes 4,743 assertions on the saved definitions, including
all 512 input/control combinations for Mux4 and Adder4. Browser regressions
cover chip creation/reuse, edit propagation, JSON round-trips, parameterized
pins and tick-rate controls.

```sh
taskpolicy -b nice -n 15 node --import tsx scripts/check_manual_climb.ts src/climb/fixtures/pc4-editor-checkpoint.json
taskpolicy -b nice -n 15 node --import tsx scripts/bench_climb_cpu.ts
```

## Performance and limits

The CPU flattens to 263 leaf evaluators and 276 nets. A 100,000-instruction
loop (`01 1F 3F 2F 51`) measured **55,035 CPU cycles and instructions/s** on
Apple M4, macOS arm64, Node 25.6.1. Each instruction was checked against the
ISA and settled rising edges were counted. This sample included observation
cost and emitted zero diagnostics or oscillations. Interactive CPU throughput
and render frame rate remain unmeasured.

Run accepts 1–1,000,000 requested ticks/s and reports achieved worker ticks/s
and total ticks. Batches yield after roughly 8 ms, checked every 32 ticks;
a single expensive tick can exceed that budget. Wall-time debt is capped to
keep Pause responsive. Worker ticks, circuit clocks and CPU instructions
are separate rates: change a clock component's `freqHz` as well as worker
resolution to increase its circuit clock.

The engine retains the latest 1024 diagnostics and delivers every emitted
event to callbacks. The UI log is unbounded, limiting high-speed runs.
Composites flatten before execution; the
[hierarchy benchmark](../scripts/bench_hierarchy.ts) compares load cost and
equivalent leaf graphs. No hierarchical execution backend exists. Crowded
wire routing and chip discoverability remain usability priorities.
