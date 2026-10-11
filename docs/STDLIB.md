# Standard Library

The chips and atoms we ship. Each entry says which tier it lives in and what's needed to implement it.

**Status (2026-10-10):** 19 TTL composites, the behavioral 74LS193 counter, programmable EEPROM/SRAM/word ROM, clocks and display/switch IO are shipped. The palette completeness tests check every registered type. Planned IO entries remain marked M7.

## Primitives (TS, ~20 types) — all shipped

Built into the engine bundle.

| ID | Description | Params |
|---|---|---|
| `prim.AND` | n-input AND | `inputs: number` |
| `prim.OR` | n-input OR | `inputs: number` |
| `prim.NAND` | n-input NAND | `inputs: number` |
| `prim.NOR` | n-input NOR | `inputs: number` |
| `prim.NOT` | inverter | — |
| `prim.XOR` | n-input XOR | `inputs: number` |
| `prim.XNOR` | n-input XNOR | `inputs: number` |
| `prim.BUF` | non-inverting buffer | — |
| `prim.TRISTATE` | tristate buffer | `oeActiveLow: boolean` |
| `prim.DFF` | edge-triggered D flip-flop | `clrActiveLow?: boolean`, `preActiveLow?: boolean` |
| `prim.LATCH` | level-sensitive D latch | — |
| `prim.MUX2` | 2:1 mux | `width: number` |
| `prim.DEMUX2` | 1:2 demux | `width: number` |
| `prim.DECODER` | n-to-2^n decoder | `bits: number`, `activeLow: boolean` |
| `prim.ADDER` | full adder, carry-in/out | `width: number` |
| `prim.CONST_0` | tie-off to ground | — |
| `prim.CONST_1` | tie-off to Vcc | — |
| `prim.PULLUP` | weak high driver | — |
| `prim.PULLDOWN` | weak low driver | — |

## TTL composites (JSON, in `src/stdlib/`)

These cover everything Ben Eater's 8-bit machine uses except memory and the clock.

| ID | Status | Real chip | Function | Built from |
|---|---|---|---|---|
| `ttl.74LS00`  | shipped | 74LS00  | Quad 2-input NAND                 | 4 × NAND |
| `ttl.74LS02`  | shipped | 74LS02  | Quad 2-input NOR                  | 4 × NOR |
| `ttl.74LS04`  | shipped | 74LS04  | Hex inverter                      | 6 × NOT |
| `ttl.74LS08`  | shipped | 74LS08  | Quad 2-input AND                  | 4 × AND |
| `ttl.74LS32`  | shipped | 74LS32  | Quad 2-input OR                   | 4 × OR |
| `ttl.74LS86`  | shipped | 74LS86  | Quad 2-input XOR                  | 4 × XOR |
| `ttl.74LS107` | shipped | 74LS107 | Dual JK flip-flop, neg-edge, async /CLR | 2 × DFF (clock inverted) + JK→D logic per section |
| `ttl.74LS138` | shipped | 74LS138 | 3-to-8 decoder, active-low        | DECODER + 2-of-3 enable gating + per-output OR |
| `ttl.74LS139` | shipped | 74LS139 | Dual 2-to-4 decoder               | 2 × DECODER + per-output OR (active-low /G) |
| `ttl.74LS157` | shipped | 74LS157 | Quad 2:1 MUX with /STB strobe     | 4 × MUX2 + per-output AND gated by NOT(/STB) |
| `ttl.74LS161` | shipped | 74LS161 | 4-bit sync counter, async /CLR    | 4 × DFF + ADDER (Q+1) + per-bit hold/count/load mux pair, RCO from adder Cout AND ENT |
| `ttl.74LS173` | shipped | 74LS173 | 4-bit D register, tristate output | 4 × DFF + 4 × TRISTATE + load gating |
| `ttl.74LS245` | shipped | 74LS245 | Octal bus transceiver             | 16 × TRISTATE (8 per direction) + DIR/OE gating |
| `ttl.74LS273` | shipped | 74LS273 | Octal D flip-flop, async clear    | 8 × DFF (shared CP, shared /MR) |
| `ttl.74LS283` | shipped | 74LS283 | 4-bit binary adder                | ADDER (width=4) |

| `ttl.74LS74` | shipped | 74LS74 | Dual DFF with asynchronous preset/clear | 2 × DFF |
| `ttl.74LS76` | shipped | 74LS76 | Dual JK with asynchronous preset/clear | DFF + JK logic |
| `ttl.74LS153` | shipped | 74LS153 | Dual 4:1 multiplexer | MUX2 + enable gating |
| `ttl.74LS374` | shipped | 74LS374 | Octal DFF with tristate outputs | DFF + TRISTATE |

## Behavioral chips (TS, in `src/engine/behavioral/`)

Things we don't model as primitive graphs.

| ID | Status | Real chip | Why behavioral |
|---|---|---|---|
| `mem.28C16`    | shipped | 28C16   | 2K × 8 EEPROM. Storage as `Uint8Array(2048)`. Programmable via UI (paste hex, upload `.bin`). |
| `ttl.74LS193` | shipped | 74LS193 | Four-bit up/down counter with independent clocks, asynchronous load/reset and carry/borrow outputs. |
| `mem.ROM` | shipped | — | Configurable address/data widths and a project-saved word image. |
| `mem.6116`     | shipped | 6116    | 2K × 8 SRAM. Storage as `Uint8Array(2048)`. Volatile; resets to 0 on power-on. Bidirectional `DQ0..7` pins; `/CE` `/OE` `/WE` truth table per datasheet. Writes with any X data bit are skipped. |
| `mem.74LS189`  | shipped | 74LS189 | 16 × 4 RAM with **open-collector inverted outputs**. Storage as `Uint8Array(16)` (low 4 bits per byte). Outputs drive strong-0 when the stored bit is 1 and Z otherwise; the user adds an external pullup network (Eater wraps these in 74LS04s + pullups in his RAM module). Writes with any X data bit are skipped. |
| `gen.555`      | shipped | 555     | Astable square-wave clock generator. Param: `freqHz`. Preserves simulated-time phase when the worker's `rateHz` changes. RESET (datasheet pin 4) is treated as tied high; only the OUT pin is exposed. |
| `gen.clock`    | shipped | —       | Idealized square-wave clock. Param: frequency in Hz. Used in tests and as the default clock for student circuits. |
| `io.led`       | shipped | —       | One-pin LED. Renders color by input value (`0`=off, `1`=on, `Z`=dim, `X`=warning). |
| `io.7seg`      | shipped | —       | 7-segment display sink. 8 input pins (a, b, c, d, e, f, g, dp); state holds the latched per-segment values. Common-anode vs common-cathode interpretation is a UI render concern, not a logic-level one. |
| `io.switch`    | shipped | —       | SPST switch. User toggles in UI; output is `0` or `1`. |
| `io.button`    | M7      | —       | Momentary button. Output `1` while held. Optional debouncing. |
| `io.dipswitch` | M7      | —       | n-bit DIP switch. n outputs. |
| `io.pin_input` | M7      | —       | Numeric value input (binary/hex/decimal). For testbenches and quick prototyping. |
| `io.pin_output`| M7      | —       | Watch a net. Logs to a waveform buffer; for testbenches and probes. |

[Declarative testbenches](TESTBENCH.md) use named runtime-net bindings and
`io.switch` output bindings for input, plus existing canvas probes for output
capture. They do not require the planned `io.pin_input` or `io.pin_output` chips.

## What's needed for Ben Eater's 8-bit machine

All chips in the tables above. Specifically, by module:

- **Clock module**: `gen.555` + `ttl.74LS00` + `ttl.74LS04` + `io.button` + `io.switch`.
- **A, B, IR, MAR, output registers**: `ttl.74LS173` (with tristate) and `ttl.74LS273` (without).
- **ALU**: `ttl.74LS283` + `ttl.74LS86` (XOR for two's-complement subtract) + `ttl.74LS04` (zero/carry flag inversions) + `ttl.74LS08` for flag gating.
- **Bus**: 8-bit bus is just a wide net; tristate drivers are the chips above.
- **Program counter**: `ttl.74LS161` + `ttl.74LS245`.
- **Control logic**: `ttl.74LS138` + `ttl.74LS139` + `ttl.74LS107` (step counter) + `mem.28C16` × 2 (microcode EEPROMs).
- **RAM**: `mem.74LS189` × 2 + `ttl.74LS04` (output inversion) + `ttl.74LS157` (address mux: program vs CPU).
- **Display**: `mem.28C16` (decode lookup) + `ttl.74LS107` (clock divider) + `ttl.74LS139` (digit select) + `io.7seg` × 4.

A complete Ben Eater 8-bit reference circuit lives at `examples/ben_eater_8bit/` (M5). It's the default smoke test for releases.

## Adding a new chip

1. **If it's a graph of existing primitives**: add `ttl.NEW.json` (or `mem.NEW.json` etc.) in `src/stdlib/`. Reference it from circuits via `"type": "ttl.NEW"`. Add a unit test that loads it and exercises a few input combinations.
2. **If it needs storage or special behavior**: add a TS file in `src/engine/behavioral/`, register with `registerBehavioral('ns.NEW', {...})`. Add a unit test covering each operating mode.
3. **PR with the datasheet linked.** Pin names must match the datasheet exactly (active-low marked with leading `/`).

## Versioning the stdlib

The stdlib is versioned with the engine. A circuit JSON's `version` field gates which stdlib it's compatible with. Migrations rewrite type IDs if we ever rename one.
