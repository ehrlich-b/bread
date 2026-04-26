# Standard Library

The chips and atoms we ship. Each entry says which tier it lives in and what's needed to implement it.

## Primitives (TS, ~20 types)

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

| ID | Real chip | Function | Built from |
|---|---|---|---|
| `ttl.74LS00` | 74LS00 | Quad 2-input NAND | 4 × NAND |
| `ttl.74LS02` | 74LS02 | Quad 2-input NOR | 4 × NOR |
| `ttl.74LS04` | 74LS04 | Hex inverter | 6 × NOT |
| `ttl.74LS08` | 74LS08 | Quad 2-input AND | 4 × AND |
| `ttl.74LS32` | 74LS32 | Quad 2-input OR | 4 × OR |
| `ttl.74LS86` | 74LS86 | Quad 2-input XOR | 4 × XOR |
| `ttl.74LS107` | 74LS107 | Dual JK flip-flop, async clear | 2 × DFF + JK input logic + async /CLR |
| `ttl.74LS138` | 74LS138 | 3-to-8 decoder, active-low outputs | DECODER + enable gating |
| `ttl.74LS139` | 74LS139 | Dual 2-to-4 decoder | 2 × DECODER |
| `ttl.74LS157` | 74LS157 | Quad 2:1 MUX | 4 × MUX2 + select gating + /OE |
| `ttl.74LS161` | 74LS161 | 4-bit synchronous counter | 4 × DFF + carry chain + sync load + async /CLR |
| `ttl.74LS173` | 74LS173 | 4-bit D register, tristate outputs | 4 × DFF + 4 × TRISTATE + load gating |
| `ttl.74LS245` | 74LS245 | Octal bus transceiver | 16 × TRISTATE + DIR logic + /OE |
| `ttl.74LS273` | 74LS273 | Octal D flip-flop, async clear | 8 × DFF |
| `ttl.74LS283` | 74LS283 | 4-bit binary adder | ADDER (width=4) |

## Behavioral chips (TS, in `src/engine/behavioral/`)

Things we don't model as primitive graphs.

| ID | Real chip | Why behavioral |
|---|---|---|
| `mem.28C16` | 28C16 | 2K × 8 EEPROM. Storage as `Uint8Array(2048)`. Programmable via UI (paste hex, upload `.bin`). |
| `mem.6116` | 6116 | 2K × 8 SRAM. Storage as `Uint8Array(2048)`. Volatile; resets to 0 on power-on. |
| `mem.74LS189` | 74LS189 | 16 × 4 RAM with **open-collector inverted outputs**. Storage as `Uint8Array(16)` (4 bits per byte). The inverted-output quirk is part of the behavioral model — Eater wraps these in 74LS04s in his RAM module, which we represent in the schematic, not by hiding the inversion. |
| `gen.555` | 555 | Astable square-wave clock generator. Param: target frequency in Hz. The behavioral model counts simulator steps relative to the worker's current rate. |
| `gen.clock` | — | Idealized square-wave clock. Param: frequency in Hz. Used in tests and as the default clock for student circuits. |
| `io.led` | — | One-pin LED. Renders color by input value (`0`=off, `1`=on, `Z`=dim, `X`=warning). |
| `io.7seg` | — | 7-segment display, common-anode or common-cathode. 8 input pins (a–g + dp). |
| `io.switch` | — | SPST switch. User toggles in UI; output is `0` or `1`. |
| `io.button` | — | Momentary button. Output `1` while held. Optional debouncing. |
| `io.dipswitch` | — | n-bit DIP switch. n outputs. |
| `io.pin_input` | — | Numeric value input (binary/hex/decimal). For testbenches and quick prototyping. |
| `io.pin_output` | — | Watch a net. Logs to a waveform buffer; for testbenches and probes. |

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
