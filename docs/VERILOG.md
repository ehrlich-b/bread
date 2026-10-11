# Structural Verilog import and export

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
| 74LS193 | Behavioral up/down counter with asynchronous load/reset and carry/borrow outputs. The mapping uses SystemVerilog `always_comb` for startup evaluation; use Icarus `-g2012`. Independent clocks and initialized storage require target-specific synthesis support. |
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

## Import

Click **Import Verilog** beside the downloads and select a `.v` file, or run:

```sh
node --import tsx scripts/verilog-import.ts examples/verilog/counter4.v counter4.json
node --import tsx scripts/verilog-import.ts design.v circuit.json --top main
```

Omit the output filename for JSON on stdout. `importVerilog(source, { topModule })`
returns `circuit`, `topModule`, a module-to-chip `modules` map and hierarchical
wire-to-runtime-net `nets`. A single uninstantiated module is the default top;
Bread exports identify their first `top_` module even when unused definitions
remain. Other ambiguous designs require `--top`.

Each helper module becomes a project-local `user.V_<module>` chip. Unused
modules are retained and validated. Vector ports become scalar lanes named
`a_0`, `a_1`, etc.; wire/net IDs retain brackets, such as `a[0]`. Lanes are
LSB-first, including ascending declarations. Components receive deterministic,
size-aware placement using the existing schematic renderers. Import uses the
same loader, undo history and ordered document queue as **Open JSON**; a newer
document action supersedes an unfinished file read. Errors leave the current
circuit intact. Imported inputs can be driven by the Testbench panel's net
bindings or by wiring switches into the circuit.
File reading, parsing, elaboration and placement run in a separate worker.
The phase indicator stays cancellable throughout import; cancelling terminates
the worker and leaves the document and undo history intact. Files above 16 MB
are rejected before reading.

The hand-written subset is intentionally bounded:

| Construct | Supported form |
| --- | --- |
| Modules and ports | ANSI or classic headers; `input`, `output`, `inout`, `wire` and `reg`; unsigned scalar/vector declarations with constant nonnegative bounds. Helper modules need ports. |
| Hierarchy | Module instances with named or positional ports, scalar/vector connections, constant slices and concatenations; empty port connections are allowed. Connected widths must match exactly. No recursive modules. |
| Continuous assignments | Wire/vector/concatenation targets; constants, signal references, constant bit/part selects, parentheses, concatenation, `~`, `!`, reductions, `&`, `\|`, `^`, `~^`, `+`, `-`, `==`, `!=`, `===`, `!==`, `&&`, `\|\|` and `?:`. Unsigned Verilog width context and four-state semantics are preserved. Wire initializers are continuous assignments. |
| Constants | Sized binary/octal/decimal/hex literals, including X/Z and underscores; nonnegative unsized decimal integers up to 2,147,483,647. Sized literals zero-extend in expression context; use `8'bz` to release all eight lanes. |
| Gate primitives | Scalar `and`, `or`, `not`, `nand`, `nor`, `xor`, `xnor`, `buf`, `bufif0`, `bufif1`, `tran`, `pullup`, `pulldown`; optional instance names and comma-separated instances. Gates have one output and at most 24 inputs. |
| Registers | `always @(posedge clk)` with nonblocking assignments to whole declared registers, optional `begin`/`end` and nested `if`/`else`. Missing branches hold state; unknown procedural conditions take the else/hold branch. Multiple assignments in one block use the last scheduled value. Separate always blocks may not drive the same register. Constant 0/1 declaration initialization is supported. |
| Comments and directives | Line/block comments; `default_nettype none`/`wire` and numeric `timescale` directives. No macro expansion. |

Positive-edge registers use existing DFF storage with raw Verilog data inputs,
so Q can store Z. Ordinary Bread physical gates still read Z as X. Continuous
expressions use a bounded `prim.VERILOG` component so wire copies, conditional
Z branches and equality retain Verilog semantics without bidirectional net
shorting. Simulation retains Bread's READ/COMMIT scheduler: settle data and
synchronous controls before a known 0-to-1 clock edge. Uncertain clock edges,
simultaneous data/clock changes and delta-cycle races are outside the timing
contract, as they are for export. This is structural import, not behavioral
RTL synthesis or an event-driven Verilog runtime.
This includes startup edges on derived clocks: the generated original Digital
CPU export can differ from Bread before the first external clock pulse when
initializing logic changes a derived clock from X to 1 (a Verilog posedge).
Imported `bufif0`/`bufif1` gates preserve uncertain 0/Z and 1/Z drives until net
resolution, so an unknown enable can still resolve with a matching driver.
Re-export retains these Verilog gate primitives; ordinary Bread tristates keep
their existing unknown-enable behavior.

Current Bread exports also contain `bread:cell` annotations for every leaf and
`bread:sources` annotations for forwarded switch/clock ports. The importer
regenerates each cell's complete Verilog body and requires identical tokens
before restoring its original type, parameters and pin bindings. This recovers
all shipped gates, storage, memory images, clocks and displays with Bread's
original timing. Cell annotations contain no saved circuit, layout or live
state. Edited bodies, extra statements, invalid bindings, overlapping
temporaries and inconsistent source forwarding fail; annotations cannot hide
logic. This checked template path supports exported latches, asynchronous
controls and memory arrays without accepting arbitrary behavioral processes.
Older unannotated exports can use the plain subset where applicable; arbitrary
memory/initialization processes require a current Bread export.
Every nested source port must be connected exactly once, and recovered sources
must match the `bread:sources` list in component/source order. Swapping or
removing source connections is rejected, including when the parent list is
cleared. Preserve this order when editing an annotated export.

Unsupported constructs fail with a line/column error naming the token or
construct. These include parameters, signed types, macros/includes, generate
blocks, arrays/memories outside checked cells, arbitrary `initial` blocks,
procedural loops/case statements, functions/tasks, delays/strength syntax,
blocking assignments, asynchronous or negative-edge hand-written processes,
dynamic selects, replication and other operators. No statement is silently
discarded. Limits are 16 MB of UTF-8 source, 250,000 tokens, 256-bit vectors,
64 levels of expression/statement nesting and module hierarchy, 4,096 nodes
and 16,384 input lanes per expression. Clocked blocks merge repeated writes
using last-assignment priority and bounded temporary expressions; each generated
component and net counts toward the budget before allocation. Elaboration checks a memoized expansion budget
before flattening: at most 25,000 instances (including intermediate module
instances) and 100,000 nets (before port stitching, including floating leaf
pins) in each module's expanded hierarchy. Unused modules are checked too.
Excess expansion fails with a line/column error naming the instance or net
limit, so a small acyclic hierarchy cannot request exponential allocation.

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

The export corpus checks all eight binary full-adder rows (9 samples), the
register/shared bus including Z and contention (38 vectors, 90 samples), and
three Fibonacci OUT sequences through carry restart (41 vectors, 3,527 samples).
Vitest also covers all 64 four-state adder inputs, every shipped chip's startup,
nested wired buses, memory writes, ROM images and storage controls, and detects
a deliberately corrupted Verilog adder. Oracle tests and the command print a
clear skip when either tool is missing, keeping CI independent of Icarus.
Generated files are temporary and removed after each run.

The default command also exports and imports all eight bundled examples and
every registered library type, then compares every original runtime net at
power-on, after settling and through 256 four-state stimulus ticks, with matching
diagnostic counts, kinds and steps. The three
existing JSON testbenches compare every net at every round-trip sample,
including the complete Fibonacci/carry-restart run. These checks run even when
Icarus is unavailable.

The separate [hand-written corpus](../examples/verilog) executes the original
Verilog in Icarus and the imported circuit in Bread: all 64 four-state full-adder
inputs, a four-bit counter with wrap/reset/enable, all 256 bytes of an eight-bit
tristate register plus X/Z/contention, and all 1,024 binary four-bit ALU operand/
operation combinations plus four-state vectors. Each declared output is
compared with exact 0/1/X/Z equality after every settlement and clock phase.
Vitest additionally checks width context, wire direction, equality/reductions,
parser errors, annotation corruption and ordered UI import/undo behavior.
