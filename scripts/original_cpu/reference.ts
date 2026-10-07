// Independent integer ISA oracle for ehrlich-b/8bitcpu at 966772fb.
// Semantics come from its README, assembler/main.go and microcode/main.go.
// This module imports no Bread engine, converted circuit, gates or control ROM.
const opcodes: Record<string, number> = {
  NOP: 0, LDA: 1, LDAi: 2, LDB: 3, LDBi: 4, STA: 5,
  ADD: 6, SUB: 7, JMP: 8, JZ: 9, JEQ: 10, JGE: 11,
  PUSH: 12, POP: 13, CALL: 14, RET: 15, MOVa: 16, MOVb: 17,
  OUT: 30, HLT: 31,
};
const hasOperand = new Set(['LDA', 'LDAi', 'LDB', 'LDBi', 'STA', 'JMP', 'JZ', 'JEQ', 'JGE', 'CALL']);

export const assemble = (text: string): number[] => {
  const rows = text.split(/\r?\n/).map((line) => line.split('//')[0]!.trim()).filter(Boolean);
  const labels = new Map<string, number>();
  let address = 0;
  for (const row of rows) {
    if (/^\S+:$/.test(row)) {
      const label = row.slice(0, -1);
      if (labels.has(label)) throw new Error(`Duplicate label ${label}`);
      labels.set(label, address);
      continue;
    }
    const tokens = row.split(/\s+/);
    const mnemonic = tokens[0]!;
    if (!Object.hasOwn(opcodes, mnemonic)) throw new Error(`Unknown instruction ${mnemonic}`);
    if (tokens.length !== (hasOperand.has(mnemonic) ? 2 : 1)) throw new Error(`Wrong operand count: ${row}`);
    address += tokens.length;
  }
  if (address > 32) throw new Error('Program exceeds the original 32-byte ROM');
  const bytes: number[] = [];
  for (const row of rows) {
    if (row.endsWith(':')) continue;
    const [mnemonic, operand] = row.split(/\s+/);
    bytes.push(opcodes[mnemonic!]!);
    if (operand !== undefined) {
      // Go's strconv.ParseInt(base=0) accepts leading-zero octal literals.
      const literal = operand.slice(1);
      const value = operand.startsWith('$')
        ? /^0[0-7]+$/.test(literal) ? Number.parseInt(literal, 8) : Number(literal)
        : labels.get(operand);
      if (value === undefined || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error(`Invalid byte operand ${operand}`);
      }
      bytes.push(value);
    }
  }
  return bytes;
};

export interface Architecture {
  pc: number;
  a: number;
  b: number;
  out: number;
  sp: number;
  flags: { eq: boolean; greater: boolean; zero: boolean };
  ram: number[];
  halted: boolean;
}

export interface ReferenceRun {
  program_bytes: number[];
  output_history: number[];
  final_state: Architecture;
  instructions: Array<{ opcode: number; after: Architecture }>;
}

export const interpret = (program: number[], limit = 1000): ReferenceRun => {
  if (program.length > 32 || program.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Expected at most 32 program bytes');
  }
  const state: Architecture = {
    pc: 0, a: 0, b: 0, out: 0, sp: 255,
    flags: { eq: false, greater: false, zero: false },
    ram: [...program, ...new Array<number>(32 - program.length).fill(0)], halted: false,
  };
  const outputs: number[] = [];
  const instructions: ReferenceRun['instructions'] = [];
  const operand = (): number => {
    const value = state.ram[state.pc & 31]!;
    state.pc = (state.pc + 1) & 255;
    return value;
  };
  const compare = (): void => {
    // Only conditional branches latch flags; arithmetic leaves them alone.
    state.flags = { eq: state.a === state.b, greater: state.a > state.b, zero: state.a === 0 };
  };
  for (let count = 0; count < limit; count++) {
    // Hardware ignores the high three opcode bits; PC wraps at 256, RAM at 32.
    const opcode = state.ram[state.pc & 31]! & 31;
    state.pc = (state.pc + 1) & 255;
    switch (opcode) {
      case 0: state.pc = (state.pc + 1) & 255; break; // Source NOP skips an extra byte.
      case 1: state.a = state.ram[operand() & 31]!; break;
      case 2: state.a = operand(); break;
      case 3: state.b = state.ram[operand() & 31]!; break;
      case 4: state.b = operand(); break;
      case 5: state.ram[operand() & 31] = state.a; break;
      case 6: state.a = (state.a + state.b) & 255; break;
      case 7: state.a = (state.a - state.b) & 255; break;
      case 8: state.pc = operand(); break;
      case 9: {
        compare(); const target = operand();
        if (state.flags.zero) state.pc = target;
        break;
      }
      case 10: {
        compare(); const target = operand();
        if (state.flags.eq) state.pc = target;
        break;
      }
      case 11: {
        compare(); const target = operand();
        if (state.flags.eq || state.flags.greater) state.pc = target;
        break;
      }
      case 12:
        state.ram[state.sp & 31] = state.a;
        state.sp = (state.sp - 1) & 255;
        break;
      case 13:
        state.sp = (state.sp + 1) & 255;
        state.a = state.ram[state.sp & 31]!;
        break;
      case 14: {
        // CALL saves the address of its operand. RET increments that address.
        state.ram[state.sp & 31] = state.pc;
        state.sp = (state.sp - 1) & 255;
        state.pc = operand();
        break;
      }
      case 15:
        state.sp = (state.sp + 1) & 255;
        state.pc = (state.ram[state.sp & 31]! + 1) & 255;
        break;
      case 16: state.a = state.b; break;
      case 17: state.b = state.a; break;
      case 30: state.out = state.a; outputs.push(state.out); break;
      case 31: state.halted = true; break;
      default: throw new Error(`Unsupported program opcode ${opcode}`);
    }
    instructions.push({ opcode, after: structuredClone(state) });
    if (state.halted) return { program_bytes: [...program], output_history: outputs, final_state: structuredClone(state), instructions };
  }
  throw new Error(`Reference did not halt within ${limit} instructions`);
};
