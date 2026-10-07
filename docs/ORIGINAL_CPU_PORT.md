# Porting Bryan's original Digital CPU

The target is [ehrlich-b/8bitcpu](https://github.com/ehrlich-b/8bitcpu/tree/966772fbf4c0cb43c86e0b5850a65205526c121d),
commit `966772fbf4c0cb43c86e0b5850a65205526c121d` (May 2022).
This machine differs from the bundled Eater SAP-1 and the earlier manually
authored four-bit CPU. The generated port runs all four original programs;
manual construction of this original machine through Bread's editor is pending.

## Run and regenerate the port

Choose **Bryan's Digital CPU (generated port)** in Examples, click **Fit
circuit**, then **Run**. The two original 50 Hz oscillators boot the checked-in
CALLRET program and output 1 through 10 before HALT. Select the output register
(`v34`) for its live `Q[7:0]` hexadecimal/binary readout. Labels are editable
in the inspector and survive Circuit JSON export/reopen.

Regeneration requires Python 3.9+ and a clean local source clone at the pinned
commit above. These commands read the source clone and write only in Bread:

```sh
mkdir -p .scratch/original-cpu
taskpolicy -b nice -n 15 python3 -B scripts/original_cpu/extract_topology.py --source ../bread-original-cpu --output .scratch/original-cpu
taskpolicy -b nice -n 15 python3 -B scripts/original_cpu/convert.py --source ../bread-original-cpu --topology .scratch/original-cpu/digital-topology.json --output examples
```

The extractor reads the saved XML endpoint coordinates, local tunnels,
rotations, mirrors, splitter bit ranges and custom port order. The converter
retains the nine reachable source modules, scalarizes buses and expands
Digital's counters, arithmetic, comparator, register, mux/demux and drivers
into 16 project-local composites of existing Bread primitives. ROM contents
come from `assembler/prog.hex` and `microcode/rom.hex`, overriding the stale
inline preview data in the `.dig.dist` templates. Source-relative paths,
commit IDs and SHA-256 hashes make the generated JSON reproducible and
self-contained. The saved result has 70 root components and 25 definitions.
No Digital runtime is needed to open it.

Pass `--program path/to/program.hex` to the converter to select another boot
ROM image. The inspector also accepts program bytes on the top-level ROM
`v82`; Apply reloads the machine. The checked-in `.asm` copies in
`scripts/original_cpu/programs/` are unchanged source programs. A separate
TypeScript assembler and ISA interpreter in `reference.ts` read these in tests;
that interpreter imports no Bread engine, netlist or control ROM.

## The machine to preserve

- Eight-bit shared tristate bus, PC and stack pointer; 32 bytes of unified
  program, data and stack RAM. MAR's low five bits select RAM, so address 32
  aliases address 0. PC and SP still wrap at 256.
- Load-enabled bit cells make the A, B, instruction, memory-address, output,
  flags and stack registers. RAM consists of 32 byte registers with write
  decoding, read multiplexers and tristate output drivers. The port must
  preserve its synchronous writes rather than replace it with async SRAM.
- An eight-bit add/subtract ALU, unsigned equal/greater comparisons and an
  A-zero test. Branch microcode latches flags; ordinary arithmetic does not.
- A boot ROM and loader copy the assembled program into RAM. The original
  READY wiring becomes active at counter 31, so cold boot writes addresses
  0–30 and leaves RAM byte 31 at zero; warm boot retains its previous value.
  All four source programs fit within the copied range. RAM still has 32
  writable bytes, and the stack and Fibonacci program use byte 31 normally.
  An inverted
  CPU clock advances a three-bit microstep counter. A 256-word, 29-bit ROM
  drives the datapath and branch controls.
- CALL/RET and PUSH/POP use the shared RAM and SP. CALL stores the PC that
  points to its operand; RET restores it and then increments. The source
  NOP also increments past an additional byte. Preserve these behaviors.

The root reaches nine custom child circuit types, including nested bit
registers, four RAM banks and two hex decoders. There are 331 logical state
bits. Source visual-element counts include tunnels, splitters and labels;
they are not Bread evaluator counts.

## Programming the two kinds of ROM

The assembler produces **program bytes** for the 32 × 8 boot ROM.
`microcode/main.go` produces **control words** for the 256 × 29 control ROM.
The control address is `((instruction & 31) << 3) | (microstep & 7)`.
Instruction bits 5–7 are ignored by this source decoder.

Control bits from least significant to most significant are:

```
PCOut PCEnable PCClear PCLd ALUOut LdOut LdA EnA LdB EnB Sub
LdInst EnInst LdMAddr MWr MEn Hlt LdFlags EnGnd RstDone MPCRst
PCLdIfEq PCLdIfGorEq PCLdIfZero StkEn StkLd StkInc StkDec StkRst
```

Fetch slot 0 puts PC on the bus and loads MAR. Slot 1 enables RAM, loads IR
and increments PC. Subsequent slots perform the selected instruction's
transfers, then reset the microstep counter or halt. A ROM preview is a
view of programmed contents; its selected browsing address does not drive
the circuit's live address pins.

## Editor capabilities for the full build

**ROM (words)** is a generic read-only ROM with scalar `A0…`, active-high
`SEL`, and scalar `D0…` pins. Set `addressBits` (1–16), `dataBits` (1–32),
and optional least-significant-first `bitLabels` in Params. The default
palette part is 32 × 8. Paste or open a word image, choose **Preview
address**, enter one hexadecimal word, click **Set word in draft**, then
**Apply**. Apply is one undoable circuit edit. It validates the whole image
and reports overflow instead of truncating it.

Images accept an optional `v2.0 raw` header, whitespace/comma-separated hex
words, decimal `count*word` repetitions, and `#` or `//` line comments.
Words are not byte pairs: `10042968` is one 29-bit control word. Missing
words initialize to zero. `SEL=0` releases every data pin to Z. With
`SEL=1`, an undefined address produces X; an undefined SEL also produces X.

**Connect bus** batches ordinary scalar wires. Click a numbered starting
pin on each component, inspect the explicit bit mapping, adjust the width,
then confirm. A `Q0 → D0` connection preserves bit significance regardless
of pin layout or rotation. Starting at `Q4` is also valid when enough
consecutive pins remain. Existing fan-out and shared drivers remain on each
net. One undo removes the complete connection; repeating it adds no history.
Cancel/Escape leaves the circuit unchanged. Bus wiring does not mask
contention or introduce priority between drivers.

The inspector's **Live signals** shows exact binary states and hexadecimal
digits for contiguous numbered pins. Unknown or mixed undefined nibbles
show `?`; a wholly released nibble shows `Z`. The exact binary string
retains every X/Z bit. These readouts observe the worker's existing nets.

An explicit `initialQ: 0` or `initialQ: 1` parameter is available on DFFs.
Omitting it preserves Bread's previous unknown startup state. This sets Q,
but does not make startup scheduling identical to Digital: Bread's cold
nets begin X, so an internally driven clock initially HIGH may not cause
the same initial capture. Settle a clock LOW before testing its real rising
edge. The port's cold boot and low-clock reset/restart paths are tested.
This does not establish propagation timing equivalence with Digital.

Structural edits reload simulation state. Runtime registers, RAM writes and
switch values are not serialized as a running-machine snapshot. Local
selection and wiring-mode changes retain a switch's requested drive; a
structural reload resets it LOW. **Circuit JSON**, **Download JSON** and
**Save** wait for queued document edits before serializing them.

## Tests and boundaries

`taskpolicy -b nice -n 15 npm run check:original` runs the normal Vitest
regressions for this port. All four programs are compared with an independent
ISA interpreter after every instruction: PC, A/B, output, SP, flags, all 32
RAM bytes and HALT. OUT is sampled on its load edge, preserving repeated
values. Tests exercise both original oscillators and a derived test harness
with manual clock switches, plus reset/restart, stable HALT, source loader
termination, arithmetic overflow, unsigned/taken/untaken branches, aliasing,
opcode masking, moves, stack return conventions and PC wrap.

| Original program | Ordered output |
| --- | --- |
| `callret.asm` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 |
| `countdown.asm` | 5, 4, 3, 2, 1, 0 |
| `fib.asm` | 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144 |
| `pushpop.asm` | 42 |

`taskpolicy -b nice -n 15 npx playwright test --workers=1` also checks that
the Examples entry boots and outputs 1 through 10 in the browser, halts,
and exports/reopens its hierarchy and edited labels.
Execution of these browser tests remains pending: the implementation sandbox
refuses the test server's `127.0.0.1:5187` bind with `EPERM`. The coordinator
must run that command outside the sandbox to complete browser validation.

Bread can express this CPU's digital datapath and control without new
behavioral CPU evaluators. Source storage starts at zero via `initialQ: 0`;
existing Bread ROMs supply both images. Visual tunnels/text/splitters become
metadata and scalar net aliases. Bread's component glyphs and routed wires
do not reproduce the Digital drawing exactly, and the source momentary reset
button becomes a toggle switch (toggle HIGH, then LOW, to pulse reset).

The conversion is specific to this pinned CPU, not a general Digital importer.
Analog delay, debounce and startup scheduling are not timing-equivalent;
Digital's two-state interpretation of undefined inputs is not emulated.
Bread preserves X/Z and reports transient bus contention while gates settle.
The checked programs assert defined architectural values and no settled
conflicting bus drivers; transient warnings are retained.

No Digital implementation source or runtime is vendored. Digital v0.31 is
the pin/shape semantics reference (`9cf6e1077ec9d2e6618101f3d4ff9a6501b3cf60`);
the CPU repository does not identify its 2022 Digital version. This validation
uses the independent ISA oracle, not archived Digital traces. Manual assembly
and correctness-gated throughput measurements of this port remain open.
