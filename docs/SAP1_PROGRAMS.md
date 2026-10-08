# SAP-1 program listings

These examples reuse the complete `ben_eater_8bit` circuit. Only the name,
description and RAM contents differ. Choose an example in **Examples**, release
**RESET**, then **Run**. Reload the example to restore RAM after execution;
RESET clears registers but does not undo stores into RAM.

Each image below contains exactly 16 bytes. Addresses and image bytes are hex;
instruction operands are decimal, matching the comments in
`ram_chip.params.contents`. Unlisted addresses contain `00` (NOP).
Only ADD and SUB update the flags. SUB carry is 1 when there is no borrow.
Probe `flags.CFLAG` and `flags.ZFLAG`; OUT values appear in hex on the display.

## Count up and wrap — `sap1_count_up`

OUT: 0, 1, …, 255, 0, 1, … forever. The wrapped zero has carry=1, zero=1.

```text
50 E0 2F 61 00 00 00 00 00 00 00 00 00 00 00 01

0: LDI 0     ; start at zero
1: OUT       ; display the accumulator
2: ADD 15    ; increment modulo 256; update flags
3: JMP 1     ; output the next value, including wrapped zero
F: BYTE 1    ; increment
```

## Count up and down — `sap1_count_up_down`

OUT: 0, 1, …, 255, 254, …, 1, 0, 1, … forever. Carry and zero branches turn
at the endpoints, which are output once per turn. Overflow first wraps to zero;
two subtractions recover 255 and then move to 254 before the descending OUT.

```text
50 E0 2F 75 61 3F 3F E0 3F 80 67 00 00 00 00 01

0: LDI 0     ; initial zero or lower turning point
1: OUT       ; ascending output
2: ADD 15    ; increment
3: JC 5      ; overflow from 255 to zero turns downward
4: JMP 1     ; continue upward
5: SUB 15    ; recover 255 from the overflowed zero
6: SUB 15    ; move to 254 without repeating 255
7: OUT       ; descending output
8: SUB 15    ; decrement
9: JZ 0      ; reaching zero turns upward
A: JMP 7     ; continue downward
F: BYTE 1    ; increment/decrement
```

## Multiply RAM operands — `sap1_multiply`

OUT: 42, then halt. C holds the multiplicand 7; D holds the multiplier 6 and
becomes the countdown. E saves the running product while A decrements D.
Products are modulo 256. A zero multiplier takes 256 additions and yields zero.
The last decrement sets carry=1, zero=1, which the final load and OUT preserve.

```text
50 2C 4E 1D 3F 89 4D 1E 61 1E E0 F0 07 06 00 01

0: LDI 0     ; running product
1: ADD 12    ; add multiplicand from C
2: STA 14    ; save product in E
3: LDA 13    ; load countdown from D
4: SUB 15    ; decrement countdown; update zero
5: JZ 9      ; done after the last addition
6: STA 13    ; save remaining count
7: LDA 14    ; restore running product
8: JMP 1     ; repeat
9: LDA 14    ; final product
A: OUT       ; display 42 (2A hex)
B: HLT       ; stop
C: BYTE 7    ; multiplicand
D: BYTE 6    ; multiplier/countdown
E: BYTE 0    ; product scratch
F: BYTE 1    ; decrement
```

## Add/subtract and flags — `sap1_arithmetic`

OUT: 4, 250, 0, 19, then halt. At these OUT writes, (carry, zero) is
(1,0), (0,0), (1,1), (0,0), respectively.

```text
1E 2F E0 3F E0 1F 3F E0 59 2F E0 F0 00 00 FA 0A

0: LDA 14    ; A = 250
1: ADD 15    ; 250 + 10 = 4, carry=1, zero=0
2: OUT       ; 4 (04 hex)
3: SUB 15    ; 4 - 10 = 250, carry=0 (borrow), zero=0
4: OUT       ; 250 (FA hex)
5: LDA 15    ; A = 10; flags unchanged
6: SUB 15    ; 10 - 10 = 0, carry=1 (no borrow), zero=1
7: OUT       ; 0 (00 hex)
8: LDI 9     ; A = 9; flags unchanged
9: ADD 15    ; 9 + 10 = 19, carry=0, zero=0
A: OUT       ; 19 (13 hex)
B: HLT       ; stop
E: BYTE 250  ; FA hex
F: BYTE 10   ; 0A hex
```

## Output and halt — `sap1_halt`

OUT: 1, 2, 3. HLT gates the CPU clock; the following OUT 9 never executes.
Flags remain carry=0, zero=0 because no ADD or SUB executes.

```text
51 E0 52 E0 53 E0 F0 59 E0 00 00 00 00 00 00 00

0: LDI 1     ; A = 1
1: OUT       ; 1
2: LDI 2     ; A = 2
3: OUT       ; 2
4: LDI 3     ; A = 3
5: OUT       ; 3
6: HLT       ; hold registers and display
7: LDI 9     ; unreachable
8: OUT       ; unreachable
```

All five [JSON benches](../examples/testbenches) check OUT writes on rising
clock edges with /OI asserted, so repeated or zero-valued writes are preserved.
The counting benches cover a full wrap or both turns; finite programs also
check flags and halted state through 100 raw-clock ticks. Vitest runs every
bench, and browser tests load each named link and check the first live OUT
values. `npm run test:verilog` additionally checks count-up and multiplication
against Icarus at every settlement and tick, including flags and halt.
