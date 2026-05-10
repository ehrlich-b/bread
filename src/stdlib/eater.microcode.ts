// Microcode generator for the Ben Eater SAP-1.
//
// 16 control bits per microinstruction, packed across two 28C16 EEPROMs:
//
//   ROM HI bit 7..0:  HLT  /MI  /RI  /RO  /IO  /II  /AI  /AO
//   ROM LO bit 7..0:  /EU   SU  /BI  /OI   CE  /CO    J  /FI
//
// Each control signal's polarity matches the chip pin it ultimately drives —
// active-low loads (/AI, /BI, …) need a 1 at idle; active-high pulses (HLT,
// SU, CE, J) need a 0 at idle. So the idle bytes work out to HI=0x7F, LO=0xB5.
//
// EEPROM address layout (9 bits, A9 and A10 grounded):
//
//   A0..A2  T-state    (3 bits, 0..7 — only 0..4 actually used per instruction)
//   A3..A6  opcode     (4 bits)
//   A7      ZFLAG
//   A8      CFLAG
//
// generateMicrocodeRomBytes() emits 512 bytes per ROM in address order so the
// resulting hex string can be fed to mem.28C16's `params.contents` verbatim.

type Signal =
  | 'HLT' | 'MI' | 'RI' | 'RO' | 'IO' | 'II' | 'AI' | 'AO'
  | 'EU'  | 'SU' | 'BI' | 'OI' | 'CE' | 'CO' | 'J'  | 'FI';

interface SignalDef {
  rom: 'hi' | 'lo';
  bit: number;        // 0..7, LSB first
  activeHigh: boolean; // true → idle 0, asserted 1; false → idle 1, asserted 0
}

const SIGNALS: Record<Signal, SignalDef> = {
  HLT: { rom: 'hi', bit: 7, activeHigh: true  },
  MI:  { rom: 'hi', bit: 6, activeHigh: false },
  RI:  { rom: 'hi', bit: 5, activeHigh: false },
  RO:  { rom: 'hi', bit: 4, activeHigh: false },
  IO:  { rom: 'hi', bit: 3, activeHigh: false },
  II:  { rom: 'hi', bit: 2, activeHigh: false },
  AI:  { rom: 'hi', bit: 1, activeHigh: false },
  AO:  { rom: 'hi', bit: 0, activeHigh: false },
  EU:  { rom: 'lo', bit: 7, activeHigh: false },
  SU:  { rom: 'lo', bit: 6, activeHigh: true  },
  BI:  { rom: 'lo', bit: 5, activeHigh: false },
  OI:  { rom: 'lo', bit: 4, activeHigh: false },
  CE:  { rom: 'lo', bit: 3, activeHigh: true  },
  CO:  { rom: 'lo', bit: 2, activeHigh: false },
  J:   { rom: 'lo', bit: 1, activeHigh: true  },
  FI:  { rom: 'lo', bit: 0, activeHigh: false },
};

const idleByte = (rom: 'hi' | 'lo'): number => {
  let b = 0;
  for (const sig of Object.values(SIGNALS)) {
    if (sig.rom !== rom) continue;
    if (!sig.activeHigh) b |= 1 << sig.bit; // idle = 1 for active-low
  }
  return b;
};

const encode = (signals: readonly Signal[]): { hi: number; lo: number } => {
  let hi = idleByte('hi');
  let lo = idleByte('lo');
  for (const s of signals) {
    const def = SIGNALS[s];
    const bit = 1 << def.bit;
    if (def.rom === 'hi') {
      hi = def.activeHigh ? hi | bit : hi & ~bit;
    } else {
      lo = def.activeHigh ? lo | bit : lo & ~bit;
    }
  }
  return { hi, lo };
};

// Two-step instruction-fetch sequence shared by every instruction.
const FETCH_T0: readonly Signal[] = ['MI', 'CO'];          // MAR ← PC
const FETCH_T1: readonly Signal[] = ['RO', 'II', 'CE'];    // IR ← mem[MAR]; PC++

// Per-opcode execute steps (T2, T3, T4). Some depend on flag inputs.
type ExecStep = readonly Signal[];
type Exec = (cflag: 0 | 1, zflag: 0 | 1) => readonly [ExecStep, ExecStep, ExecStep];

const NOOP: readonly [ExecStep, ExecStep, ExecStep] = [[], [], []];

const INSTRUCTIONS: Partial<Record<number, Exec>> = {
  0x0: () => NOOP,                                                                // NOP
  0x1: () => [['IO', 'MI'], ['RO', 'AI'], []],                                    // LDA addr
  0x2: () => [['IO', 'MI'], ['RO', 'BI'], ['EU', 'AI', 'FI']],                    // ADD addr
  0x3: () => [['IO', 'MI'], ['RO', 'BI'], ['EU', 'SU', 'AI', 'FI']],              // SUB addr
  0x4: () => [['IO', 'MI'], ['AO', 'RI'], []],                                    // STA addr
  0x5: () => [['IO', 'AI'], [], []],                                              // LDI imm
  0x6: () => [['IO', 'J'], [], []],                                               // JMP addr
  0x7: (c) => [c === 1 ? ['IO', 'J'] : [], [], []],                               // JC  addr
  0x8: (_c, z) => [z === 1 ? ['IO', 'J'] : [], [], []],                           // JZ  addr
  0xE: () => [['AO', 'OI'], [], []],                                              // OUT
  0xF: () => [['HLT'], [], []],                                                   // HLT
};

const stepFor = (opcode: number, t: number, cflag: 0 | 1, zflag: 0 | 1): readonly Signal[] => {
  if (t === 0) return FETCH_T0;
  if (t === 1) return FETCH_T1;
  if (t > 4) return [];
  const exec = INSTRUCTIONS[opcode];
  if (!exec) return [];
  return exec(cflag, zflag)[t - 2] ?? [];
};

const SIZE = 1 << 11; // 28C16 = 2KB; we use the first 512 bytes.

const generate = (rom: 'hi' | 'lo'): Uint8Array => {
  const out = new Uint8Array(SIZE);
  const idle = idleByte(rom);
  out.fill(idle); // unused address space holds the idle pattern
  for (let cflag: 0 | 1 = 0; (cflag as number) < 2; cflag = (cflag + 1) as 0 | 1) {
    for (let zflag: 0 | 1 = 0; (zflag as number) < 2; zflag = (zflag + 1) as 0 | 1) {
      for (let opcode = 0; opcode < 16; opcode++) {
        for (let t = 0; t < 8; t++) {
          const sig = stepFor(opcode, t, cflag, zflag);
          const { hi, lo } = encode(sig);
          const addr = cflag * 256 + zflag * 128 + opcode * 8 + t;
          out[addr] = rom === 'hi' ? hi : lo;
        }
      }
    }
  }
  return out;
};

const toHex = (bytes: Uint8Array): string => {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 16 === 0) parts.push('\n');
    else if (i > 0) parts.push(' ');
    parts.push(bytes[i]!.toString(16).padStart(2, '0').toUpperCase());
  }
  return parts.join('');
};

export const generateMicrocodeHiHex = (): string => toHex(generate('hi'));
export const generateMicrocodeLoHex = (): string => toHex(generate('lo'));

// Test/inspection helpers — exported so the test file can poke at individual
// microinstructions without rebuilding the whole ROM.
export const __testing = {
  encode,
  stepFor,
  idleByte,
};
