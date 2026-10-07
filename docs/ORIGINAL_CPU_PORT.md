# Bryan's original Digital CPU

The port targets [ehrlich-b/8bitcpu](https://github.com/ehrlich-b/8bitcpu/tree/966772fbf4c0cb43c86e0b5850a65205526c121d),
commit `966772fbf4c0cb43c86e0b5850a65205526c121d` (May 2022). It differs from
the Eater SAP-1 and [four-bit CPU](CPU_ASCENT.md). All four original programs
pass independent ISA tests; constructing this machine through the editor
remains open.

## Run and regenerate

Choose **Bryan's Digital CPU (generated port)** in Examples, **Fit circuit**,
then **Run**. Two 50 Hz oscillators boot CALLRET and output 1 through 10
before HALT. Select output register `v34` to inspect `Q[7:0]` in hex/binary.
Editable labels survive JSON save/reopen.

Regeneration needs Python 3.9+ and a source clone at the pinned commit.
Replace `path/to/8bitcpu` with that clone's path:

```sh
taskpolicy -b nice -n 15 mkdir -p .scratch/original-cpu
taskpolicy -b nice -n 15 python3 -B scripts/original_cpu/extract_topology.py --source path/to/8bitcpu --output .scratch/original-cpu
taskpolicy -b nice -n 15 python3 -B scripts/original_cpu/convert.py --source path/to/8bitcpu --topology .scratch/original-cpu/digital-topology.json --output examples
```

The extractor resolves XML endpoints, tunnels, rotations, mirrors, splitters
and port order. The converter retains nine source modules and implements
16 supporting composites with Bread primitives: 70 root components and
25 definitions. ROM images come from `assembler/prog.hex` and
`microcode/rom.hex`, replacing stale inline previews. Source-relative paths,
commit IDs and SHA-256 hashes identify the inputs. No Digital runtime is needed.

Use `--program path/to/program.hex` to select a boot image, or edit top-level
ROM `v82` in the inspector and **Apply**. Unchanged source programs live in
`scripts/original_cpu/programs/`; the independent TypeScript assembler and ISA
interpreter in `scripts/original_cpu/reference.ts` import no engine or control ROM.

## Architecture and source quirks

- Eight-bit tristate bus, PC and stack pointer; 32 bytes of unified program/data/stack RAM. MAR uses five bits, so address 32 aliases 0; PC and SP wrap at 256.
- Load-enabled bit cells implement registers. RAM uses 32 byte registers, write decoding, read multiplexers and tristate drivers, preserving synchronous writes.
- Add/subtract ALU, unsigned equal/greater comparisons and an A-zero test. Branch microcode latches flags; ordinary arithmetic does not.
- The loader copies addresses 0–30. READY asserts at counter 31, leaving byte 31 zero on cold boot or unchanged on warm boot. All source programs fit; byte 31 remains writable for data and stack use.
- An inverted clock advances a three-bit microstep counter. The 256 × 29 control ROM address is `((instruction & 31) << 3) | (microstep & 7)`; instruction bits 5–7 are ignored.
- CALL saves the PC pointing to its operand; RET restores it and increments. NOP skips an additional byte. The port preserves these conventions.

Control bits, least significant first:

```
PCOut PCEnable PCClear PCLd ALUOut LdOut LdA EnA LdB EnB Sub
LdInst EnInst LdMAddr MWr MEn Hlt LdFlags EnGnd RstDone MPCRst
PCLdIfEq PCLdIfGorEq PCLdIfZero StkEn StkLd StkInc StkDec StkRst
```

Fetch slot 0 loads MAR from PC; slot 1 loads IR from RAM and increments PC.
Later slots execute the instruction and reset the microstep counter or halt.

## Editor controls

**ROM (words)** supports `addressBits` 1–16 and `dataBits` 1–32, scalar
`A0…`/`D0…` pins, active-high `SEL`, and optional least-significant-first
`bitLabels`. Paste/open hex words, select **Preview address**, **Set word in
draft**, then **Apply** for one undoable edit. Preview selection does not
drive live address pins. Images accept `v2.0 raw`, whitespace/comma separators,
decimal `count*word` repetitions and `#`/`//` comments. `10042968` is one
29-bit word; overflow is rejected and missing words initialize to zero.
`SEL=0` releases outputs to Z; undefined selection/address produces X when enabled.

**Connect bus** previews an explicit scalar-bit mapping from numbered pins.
Width and start bit are adjustable; rotation does not change significance.
Fan-out and shared drivers persist. One undo removes the batch, repetition
adds no history, and Cancel/Escape changes nothing. **Live signals** retains
exact X/Z bits; hex nibbles display `?` for unknown/mixed states and `Z` when released.

DFF `initialQ: 0` or `1` sets startup storage; omission leaves it unknown.
Cold nets start X, so settle clocks LOW before testing rising edges.
Structural edits reload simulation. Live registers, RAM writes and switch
drives are not serialized; selection and wiring-mode changes retain switch
drives, while structural reload resets them LOW. Save actions wait for queued edits.

## Tests and limits

```sh
taskpolicy -b nice -n 15 npx vitest run src/stdlib/original.programs.test.ts --maxWorkers=2 --minWorkers=1
```

Tests compare PC, A/B, output, SP, flags, all 32 RAM bytes and HALT after every
instruction. They use both original oscillators and controlled clocks, covering
reset/restart, stable HALT, loader termination, overflow, branches, aliasing,
opcode masking, stack conventions and PC wrap. OUT sampling preserves repeats.

| Program | Ordered output |
| --- | --- |
| `callret.asm` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 |
| `countdown.asm` | 5, 4, 3, 2, 1, 0 |
| `fib.asm` | 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144 |
| `pushpop.asm` | 42 |

[Browser tests](../e2e/original_cpu.spec.ts) cover CALLRET output/HALT and
hierarchy/label save-reopen. The conversion is specific to this pinned CPU.
Glyphs and routing differ from Digital; pulse reset by toggling HIGH then LOW.
Analog delay, debounce and startup timing are not equivalent. Bread retains
X/Z and transient contention warnings; tests require defined architectural
values and no settled conflicting bus drivers.

Digital v0.31 (`9cf6e1077ec9d2e6618101f3d4ff9a6501b3cf60`) supplies pin/shape
semantics; the source CPU does not identify its 2022 Digital version. No
Digital implementation or runtime is vendored. Throughput measurements of
this port remain open.
