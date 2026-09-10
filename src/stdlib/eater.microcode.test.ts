import { describe, expect, it } from 'vitest';
import {
  generateMicrocodeHiHex,
  generateMicrocodeLoHex,
  __testing,
} from './eater.microcode';

const { idleByte, encode, stepFor } = __testing;

// Signal name for typing in the coverage arrays below.
type Signal =
  | 'HLT' | 'MI' | 'RI' | 'RO' | 'IO' | 'II' | 'AI' | 'AO'
  | 'EU'  | 'SU' | 'BI' | 'OI' | 'CE' | 'CO' | 'J'  | 'FI';

describe('eater.microcode idleByte', () => {
  it("idleByte('hi') is 0x7F", () => {
    // idleByte sets bit b to 1 for every signal on the rom where
    // activeHigh === false (active-low lines idle HIGH). On the HI rom those
    // active-low loads/drives are, LSB first:
    //   bit0 AO (idle bus-in-drive-inverted)   -> 0x01
    //   bit1 AI                                -> 0x02
    //   bit2 II                                -> 0x04
    //   bit3 IO                                -> 0x08
    //   bit4 RO                                -> 0x10
    //   bit5 RI                                -> 0x20
    //   bit6 MI                                -> 0x40
    //   bit7 HLT is active-HIGH, so it stays 0 (idle = no halt).
    // Sum: 0x01|0x02|0x04|0x08|0x10|0x20|0x40 = 0x7F.
    expect(idleByte('hi')).toBe(0x7f);
  });

  it("idleByte('lo') is 0xB5", () => {
    // On the LO rom the active-low lines are, LSB first:
    //   bit0 FI -> 0x01
    //   bit1 J  is active-HIGH, stays 0
    //   bit2 CO -> 0x04
    //   bit3 CE is active-HIGH, stays 0
    //   bit4 OI -> 0x10
    //   bit5 BI -> 0x20
    //   bit6 SU is active-HIGH, stays 0
    //   bit7 EU -> 0x80
    // Sum: 0x01|0x04|0x10|0x20|0x80 = 0xB5.
    expect(idleByte('lo')).toBe(0xb5);
  });
});

describe('eater.microcode encode', () => {
  it('FETCH_T0 [MI, CO] encodes to { hi: 0x3F, lo: 0xB1 }', () => {
    // Start from idle: hi=0x7F, lo=0xB5.
    //   MI: HI rom, bit6, active-low -> AND bit out -> 0x7F & ~0x40 = 0x3F
    //   CO: LO rom, bit2, active-low -> AND bit out -> 0xB5 & ~0x04 = 0xB1
    expect(encode(['MI', 'CO'])).toEqual({ hi: 0x3f, lo: 0xb1 });
  });

  it('FETCH_T1 [RO, II, CE] encodes to { hi: 0x6B, lo: 0xBD }', () => {
    // Start from idle: hi=0x7F, lo=0xB5.
    //   RO: HI rom, bit4, active-low -> clear -> 0x7F & ~0x10 = 0x6F
    //   II: HI rom, bit2, active-low -> clear -> 0x6F & ~0x04 = 0x6B
    //   CE: LO rom, bit3, active-HIGH -> set  -> 0xB5 | 0x08 = 0xBD
    expect(encode(['RO', 'II', 'CE'])).toEqual({ hi: 0x6b, lo: 0xbd });
  });

  it('encode([]) is exactly the idle pair', () => {
    // No signals asserted: both bytes stay at their idle values.
    expect(encode([])).toEqual({ hi: 0x7f, lo: 0xb5 });
  });

  it('a LO-rom-only signal (SU) does not perturb the HI byte', () => {
    // SU: LO rom, bit6, active-HIGH -> set -> 0xB5 | 0x40 = 0xF5.
    // No HI-rom signal named: HI byte keeps its fresh-idle value 0x7F.
    expect(encode(['SU'])).toEqual({ hi: 0x7f, lo: 0xf5 });
  });

  it('active-high signals on the SAME rom stack on top of each other [CE, J]', () => {
    // CE: LO rom, bit3, active-HIGH -> set -> 0xB5 | 0x08 = 0xBD
    // J:  LO rom, bit1, active-HIGH -> set -> 0xBD | 0x02 = 0xBF
    // HI byte untouched (idle 0x7F).
    expect(encode(['CE', 'J'])).toEqual({ hi: 0x7f, lo: 0xbf });
  });

  it('coverage sweep: every one of the 16 SIGNALS hand-verified', () => {
    // Each row is derived from idle (hi=0x7F, lo=0xB5) exactly as encode()
    // computes it: active-HIGH ORs the bit in, active-low ANDs it out.
    const expected: Record<Signal, { hi: number; lo: number }> = {
      // HI-rom signals (idle hi = 0x7F):
      HLT: { hi: 0xff, lo: 0xb5 }, // bit7 AH -> 0x7F | 0x80        = 0xFF
      MI:  { hi: 0x3f, lo: 0xb5 }, // bit6 AL -> 0x7F & ~0x40       = 0x3F
      RI:  { hi: 0x5f, lo: 0xb5 }, // bit5 AL -> 0x7F & ~0x20       = 0x5F
      RO:  { hi: 0x6f, lo: 0xb5 }, // bit4 AL -> 0x7F & ~0x10       = 0x6F
      IO:  { hi: 0x77, lo: 0xb5 }, // bit3 AL -> 0x7F & ~0x08       = 0x77
      II:  { hi: 0x7b, lo: 0xb5 }, // bit2 AL -> 0x7F & ~0x04       = 0x7B
      AI:  { hi: 0x7d, lo: 0xb5 }, // bit1 AL -> 0x7F & ~0x02       = 0x7D
      AO:  { hi: 0x7e, lo: 0xb5 }, // bit0 AL -> 0x7F & ~0x01       = 0x7E
      // LO-rom signals (idle lo = 0xB5):
      EU:  { hi: 0x7f, lo: 0x35 }, // bit7 AL -> 0xB5 & ~0x80       = 0x35
      SU:  { hi: 0x7f, lo: 0xf5 }, // bit6 AH -> 0xB5 | 0x40        = 0xF5
      BI:  { hi: 0x7f, lo: 0x95 }, // bit5 AL -> 0xB5 & ~0x20       = 0x95
      OI:  { hi: 0x7f, lo: 0xa5 }, // bit4 AL -> 0xB5 & ~0x10       = 0xA5
      CE:  { hi: 0x7f, lo: 0xbd }, // bit3 AH -> 0xB5 | 0x08        = 0xBD
      CO:  { hi: 0x7f, lo: 0xb1 }, // bit2 AL -> 0xB5 & ~0x04       = 0xB1
      J:   { hi: 0x7f, lo: 0xb7 }, // bit1 AH -> 0xB5 | 0x02        = 0xB7
      FI:  { hi: 0x7f, lo: 0xb4 }, // bit0 AL -> 0xB5 & ~0x01       = 0xB4
    };
    const signals = Object.keys(expected) as Signal[];
    expect(signals).toHaveLength(16); // all 16 named control lines covered
    for (const sig of signals) {
      expect(encode([sig])).toEqual(expected[sig]);
    }
  });
});

describe('eater.microcode stepFor', () => {
  it('t=0 always returns FETCH_T0 regardless of opcode or flags', () => {
    for (const opcode of [0x0, 0x1, 0x5, 0x9, 0xF]) {
      expect(stepFor(opcode, 0, 0, 0)).toEqual(['MI', 'CO']);
      expect(stepFor(opcode, 0, 1, 1)).toEqual(['MI', 'CO']);
    }
  });

  it('t=1 always returns FETCH_T1 regardless of opcode or flags', () => {
    for (const opcode of [0x0, 0x2, 0x8, 0xA, 0xE]) {
      expect(stepFor(opcode, 1, 0, 0)).toEqual(['RO', 'II', 'CE']);
      expect(stepFor(opcode, 1, 1, 1)).toEqual(['RO', 'II', 'CE']);
    }
  });

  it('t=5,6,7 are unused padding and return [] for a representative opcode', () => {
    for (const t of [5, 6, 7]) {
      expect(stepFor(0x2, t, 0, 0)).toEqual([]);
    }
  });

  it('opcodes absent from INSTRUCTIONS (0x9..0xD) return [] for t=2,3,4', () => {
    // INSTRUCTIONS only keys 0x0..0x8, 0xE, 0xF; 0x9..0xD are verified absent.
    for (const opcode of [0x9, 0xa, 0xb, 0xc, 0xd]) {
      for (const t of [2, 3, 4]) {
        expect(stepFor(opcode, t, 0, 0)).toEqual([]);
      }
    }
  });

  it('matches INSTRUCTIONS literally for every defined opcode at t=2,3,4', () => {
    // Expected signal arrays lifted straight from each INSTRUCTIONS entry.
    const expectations: Record<number, Signal[][]> = {
      0x0: [[], [], []],                 // NOP
      0x1: [['IO', 'MI'], ['RO', 'AI'], []],                    // LDA
      0x2: [['IO', 'MI'], ['RO', 'BI'], ['EU', 'AI', 'FI']],    // ADD
      0x3: [['IO', 'MI'], ['RO', 'BI'], ['EU', 'SU', 'AI', 'FI']], // SUB
      0x4: [['IO', 'MI'], ['AO', 'RI'], []],                    // STA
      0x5: [['IO', 'AI'], [], []],                              // LDI
      0x6: [['IO', 'J'], [], []],                               // JMP
      0xE: [['AO', 'OI'], [], []],                              // OUT
      0xF: [['HLT'], [], []],                                   // HLT
    };
    for (const [opcode, steps] of Object.entries(expectations)) {
      // Unconditional opcodes must be insensitive to both flag inputs.
      for (const flags of [[0, 0], [1, 0], [0, 1], [1, 1]] as Array<[0 | 1, 0 | 1]>) {
        for (let t = 2; t <= 4; t++) {
          expect(stepFor(Number(opcode), t, flags[0], flags[1])).toEqual(steps[t - 2]);
        }
      }
    }
  });

  it('JC (0x7) is conditional on cflag: taken vs not-taken', () => {
    // Source: 0x7: (c) => [c === 1 ? ['IO','J'] : [], [], []]
    expect(stepFor(0x7, 2, 1, 0)).toEqual(['IO', 'J']); // carry set -> jump
    expect(stepFor(0x7, 2, 0, 0)).toEqual([]);          // carry clear -> fall
    expect(stepFor(0x7, 2, 1, 1)).toEqual(['IO', 'J']);
    expect(stepFor(0x7, 2, 0, 1)).toEqual([]);
    expect(stepFor(0x7, 3, 1, 0)).toEqual([]);
    expect(stepFor(0x7, 4, 1, 0)).toEqual([]);
  });

  it('JZ (0x8) is conditional on zflag: taken vs not-taken', () => {
    // Source: 0x8: (_c, z) => [z === 1 ? ['IO','J'] : [], [], []]
    expect(stepFor(0x8, 2, 0, 1)).toEqual(['IO', 'J']); // zero set -> jump
    expect(stepFor(0x8, 2, 0, 0)).toEqual([]);          // zero clear -> fall
    expect(stepFor(0x8, 2, 1, 1)).toEqual(['IO', 'J']);
    expect(stepFor(0x8, 2, 1, 0)).toEqual([]);
    expect(stepFor(0x8, 3, 0, 1)).toEqual([]);
    expect(stepFor(0x8, 4, 0, 1)).toEqual([]);
  });
});

const parseHex = (hex: string): number[] =>
  hex.trim().split(/\s+/).map((tok) => parseInt(tok, 16));

describe('eater.microcode ROM assembly', () => {
  const addr = (opcode: number, t: number, cflag: 0 | 1, zflag: 0 | 1): number =>
    cflag * 256 + zflag * 128 + opcode * 8 + t;

  // Representative sample over the 512 used bytes: every opcode at the two
  // fetch states, plus a spread of execute states with both flag polarities.
  const samples: Array<[number, number, 0 | 1, 0 | 1]> = [];
  for (let op = 0; op < 16; op++) {
    samples.push([op, 0, 0, 0], [op, 1, 0, 0]);
  }
  for (const op of [0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0xE, 0xF]) {
    for (const t of [2, 3, 4]) {
      samples.push([op, t, 0, 0], [op, t, 1, 0], [op, t, 0, 1], [op, t, 1, 1]);
    }
  }

  for (const rom of ['hi', 'lo'] as const) {
    it(`generateMicrocode${rom === 'hi' ? 'Hi' : 'Lo'}Hex() matches encode∘stepFor at every sampled address`, () => {
      const hex = rom === 'hi' ? generateMicrocodeHiHex() : generateMicrocodeLoHex();
      const decoded = parseHex(hex);
      expect(decoded).toHaveLength(2048); // SIZE = 1 << 11
      for (const [opcode, t, cflag, zflag] of samples) {
        const want = encode(stepFor(opcode, t, cflag, zflag))[rom];
        expect(decoded[addr(opcode, t, cflag, zflag)]).toBe(want);
      }
    });
  }

  it('the 512..2047 padding region is inert (idle bytes)', () => {
    const hi = parseHex(generateMicrocodeHiHex());
    const lo = parseHex(generateMicrocodeLoHex());
    for (const a of [512, 1000, 2047]) {
      expect(hi[a]).toBe(0x7f);
      expect(lo[a]).toBe(0xb5);
    }
  });

  it('raw hex format: 128 lines of 16 space-separated 2-digit uppercase hex', () => {
    for (const hex of [generateMicrocodeHiHex(), generateMicrocodeLoHex()]) {
      const lines = hex.split('\n');
      expect(lines).toHaveLength(128); // 2048 / 16
      for (const line of lines.slice(0, 3)) {
        // 16 tokens, each exactly two uppercase hex digits, space separated
        // and no trailing whitespace.
        expect(line).toMatch(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
      }
    }
  });
});
