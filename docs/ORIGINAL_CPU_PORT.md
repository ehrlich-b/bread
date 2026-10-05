# Porting Bryan's original Digital CPU

The target is [ehrlich-b/8bitcpu](https://github.com/ehrlich-b/8bitcpu/tree/966772fbf4c0cb43c86e0b5850a65205526c121d),
commit `966772fbf4c0cb43c86e0b5850a65205526c121d` (May 2022).
This machine differs from the bundled Eater SAP-1 and the earlier manually
authored four-bit CPU. The original full build through Bread's editor is
pending. Source-derived fixtures and headless checks are port evidence;
they do not establish manual construction.

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
- A boot ROM and loader copy the assembled program into RAM. An inverted
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
edge. The original CPU's cold boot/reset phase requires separate validation.

Structural edits reload simulation state. Runtime registers, RAM writes and
switch values are not serialized as a running-machine snapshot. Local
selection and wiring-mode changes retain a switch's requested drive; a
structural reload resets it LOW. **Circuit JSON**, **Download JSON** and
**Save** wait for queued document edits before serializing them.

## Evidence and boundaries

The source map was cross-checked against 199 original SVG pin coordinates.
Independent Python ISA/microcode references match the original Go assembler
and all 256 control-ROM words. Headless generated-port and real Digital
runtime comparisons are separate validation stages. Digital v0.31 is an
available reference version; the original repository does not identify its
2022 Digital version.

The Digital implementation is GPL-3.0. Bread's new ROM, bus tools and probes
are clean implementations of the documented interfaces; no Digital runtime
or implementation source is vendored into Bread. A converter must retain
original CPU/source-ROM provenance and label its generated output honestly.
The full editor-built CPU, all original program checks, cold/reset timing,
and correctness-gated throughput remain explicit acceptance gates.
