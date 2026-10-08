# Best-effort Verilog export

Click **Download Verilog** beside **Download JSON**, or export a saved circuit:

```sh
node --import tsx scripts/verilog.ts examples/full_adder.json full_adder.v
```

Omit the output filename to write to stdout. The pure `exportVerilog(circuit)`
function returns `source`, `topModule`, chip `modules`, external `sources` and
engine-net-to-Verilog `nets` paths. It validates with the engine loader and
exports saved parameters and images. Live register/memory state is session-only.

The file contains a `top_<circuit>` module and one `chip_<type>` module for each
referenced chip and each project definition, including unused definitions.
Instances, nets, ports and temporaries use prefixed identifiers derived from
IDs; unsafe characters become underscores and collisions receive numeric
suffixes. Original IDs appear in escaped comments. No executable text is taken
from labels, descriptions or memory images.

Every root net is an `inout wire n_<id>` for driving and observing the circuit.
Switches and generated clocks become `input wire s_<component>_<pin>` ports;
nested sources are forwarded to the top. Drive switches and clocks low at
power-on. The source metadata identifies the original component, pin and clock
frequency. Chip ports use `inout`/`tran` aliases, with original directions in
comments, to preserve bread's electrical net stitching across hierarchy.
Unconnected pins receive floating wires. Bus lanes stay scalar and keep their
original bit order; testbench signals remain LSB-first in JSON and MSB-first
when displayed.

| Construct | Mapping and limits |
| --- | --- |
| Gates, mux/demux, decoder, ripple adder | Four-state combinational expressions, including per-bit unknown carry and mux agreement. Pure inputs translate Z to X. |
| Tristate and wired nets | Independent continuous drivers resolve on ordinary Verilog wires; released outputs are Z and conflicting strong drivers resolve to X. Open-collector outputs drive 0 or Z. |
| Weak pulls | Weak-strength assignments approximate H/L resolution; hardware/tool support varies. |
| DFF, latch, counter | Registers, level-sensitive latches and clocked processes. Known-edge behavior matches the directed tests; Verilog event ordering, uncertain edges, simultaneous data/control changes and some unknown asynchronous-control cases can differ. |
| TTL and SAP-1 chips | Structural modules retain their JSON component/net hierarchy, with primitive mappings inside. Composite instance parameters are ignored by both loader and exporter. |
| ROM, 74LS189, 6116, 28C16 | Initialized arrays, asynchronous reads, tristate/open-collector outputs and level-sensitive writes. Unknown address/data skips whole-word writes. Initialization and asynchronous writes need target-specific synthesis support; EEPROM programming timing/protection/endurance is omitted. |
| Clock / 555 | External clock inputs replace autonomous tick/rate timing. The 555's analog network and reset behavior are omitted. |
| LEDs / seven-segment displays | Visual state is omitted; connected logic nets remain available. |
| Custom registered leaf without a mapping | Each output drives X, with an explicit unsupported comment. Unknown component types and invalid/cyclic libraries fail validation. |

The output uses synthesizable-style logic, but synthesis support for initial
values, internal tristates, weak strengths, `tran` aliases and asynchronous
memories depends on the target. No FPGA synthesis result is promised. The
exported comments identify approximations and omissions. Zero-delay Verilog
events replace bread's READ/COMMIT settling; oscillation detection and
contention diagnostics are omitted, as are layout, probes and UI state.

## Independent oracle

Install `iverilog` and `vvp` as optional development tools, then run:

```sh
npm run test:verilog
npm run test:verilog -- examples/testbenches/full_adder.json
```

The generator reuses the [JSON testbench runner](TESTBENCH.md), including loops,
clock pulses and bounded edge waits. It records only external drives and
independently generates clock inputs from frequency, rate and tick count.
Icarus compiles the exported design and generated testbench; `vvp` computes
internal state independently. Every declared output is compared after every
settlement/tick, including startup and intermediate clock phases, with exact
0/1/X/Z equality regardless of expectation masks. Bread expectations must pass
too. Edge waits determine replay length from bread; disagreement on the waiting
signals is still checked at every sample. Hung compilations/simulations time out.
Transient delta-cycle states and diagnostic events are outside the comparison.

The default corpus checks all eight binary full-adder rows (9 samples), the
register/shared bus including Z and contention (38 vectors, 90 samples), and
three Fibonacci OUT sequences through carry restart (41 vectors, 3,527 samples).
Vitest also covers all 64 four-state adder inputs, every shipped chip's startup,
nested wired buses, memory writes, ROM images and storage controls, and detects
a deliberately corrupted Verilog adder. Oracle tests and the command print a
clear skip when either tool is missing, keeping CI independent of Icarus.
Generated files are temporary and removed after each run.
