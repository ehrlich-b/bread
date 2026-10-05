// Headless engineering plan/oracle fixture. This is not manual editor evidence
// and must never be imported into the editor as a substitute for construction.
import '../engine/index';
import type { CircuitJSON, ComponentInstanceJSON } from '../engine/ir';

function validProgram(program: number[]): void {
  if (program.length > 16 || Array.from(program).some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0x7f)) {
    throw new Error('CPU4 program: at most 16 bytes, each 0x00..0x7f (three opcode bits; bit 7 must be zero)');
  }
}

export function cpu4Plan(program: number[]): CircuitJSON {
  validProgram(program);
  const components: ComponentInstanceJSON[] = [];
  const nets: CircuitJSON['nets'] = [];
  const add = (id: string, type: string, params?: Record<string, unknown>): void => { components.push({ id, type, params }); };
  const net = (id: string, ...endpoints: string[]): void => { nets.push({ id, endpoints }); };
  add('clock', 'io.switch'); add('reset', 'io.switch');
  add('gnd', 'prim.CONST_0'); add('vcc', 'prim.CONST_1');
  add('pc', 'ttl.74LS161'); add('acc', 'ttl.74LS173');
  add('rom', 'mem.28C16', { contents: program.map((n) => n.toString(16).padStart(2, '0')).join(' ') });
  add('ram', 'mem.6116'); add('decode', 'prim.DECODER', { bits: 3, activeLow: false });
  add('alu', 'prim.ADDER', { width: 4 });
  add('source', 'prim.MUX2', { width: 4 }); add('result', 'prim.MUX2', { width: 4 });
  const gates: Array<[string, string, number?]> = [
    ['not_reset', 'NOT'], ['not_halt', 'NOT'], ['cpu_clock', 'AND', 2], ['not_clock', 'NOT'],
    ['write_enable', 'NAND', 3], ['not_load', 'NOT'], ['load_enable', 'OR', 3], ['not_enable', 'NOT'],
    ['zero', 'NOR', 4], ['zero_branch', 'AND', 2], ['jump', 'OR', 2], ['not_jump', 'NOT'],
  ];
  for (const [id, type, inputs] of gates) add(id, `prim.${type}`, inputs ? { inputs } : undefined);
  for (let i = 0; i < 8; i++) add(`drive${i}`, 'prim.TRISTATE');
  const low: string[] = ['gnd.Y', 'rom./CE', 'rom./OE', 'ram./CE', 'alu.Cin', 'acc./G2', 'acc./M', 'acc./N'];
  const high: string[] = ['vcc.Y', 'rom./WE', 'pc.ENT', 'pc.ENP'];
  for (let i = 4; i <= 10; i++) low.push(`rom.A${i}`, `ram.A${i}`);
  for (let i = 4; i < 8; i++) low.push(`drive${i}.A`);
  net('low', ...low); net('high', ...high);
  net('raw_clock', 'clock.Y', 'cpu_clock.A', 'not_clock.A');
  net('reset', 'reset.Y', 'acc.CLR', 'not_reset.A'); net('reset_n', 'not_reset.Y', 'pc./CLR', 'write_enable.C');
  net('run', 'not_halt.Y', 'cpu_clock.B'); net('halt', 'decode.Y6', 'not_halt.A');
  net('clock', 'cpu_clock.Y', 'pc.CLK', 'acc.CLK'); net('clock_n', 'not_clock.Y', 'write_enable.B');
  net('store', 'decode.Y3', 'write_enable.A', ...Array.from({ length: 8 }, (_, i) => `drive${i}.OE`));
  net('write_n', 'write_enable.Y', 'ram./WE');
  net('load', 'decode.Y2', 'source.S', 'not_load.A', 'load_enable.C'); net('read_n', 'not_load.Y', 'ram./OE');
  net('imm', 'decode.Y0', 'load_enable.A'); net('add', 'decode.Y1', 'result.S', 'load_enable.B');
  net('load_acc', 'load_enable.Y', 'not_enable.A'); net('load_acc_n', 'not_enable.Y', 'acc./G1');
  net('is_zero', 'zero.Y', 'zero_branch.B'); net('jz', 'decode.Y4', 'zero_branch.A');
  net('branch_taken', 'zero_branch.Y', 'jump.B'); net('jmp', 'decode.Y5', 'jump.A');
  net('do_jump', 'jump.Y', 'not_jump.A'); net('load_pc_n', 'not_jump.Y', 'pc./LD');
  for (let i = 0; i < 3; i++) net(`opcode${i}`, `rom.IO${i + 4}`, `decode.A${i}`);
  const pcIns = ['A', 'B', 'C', 'D']; const pcOuts = ['QA', 'QB', 'QC', 'QD'];
  const zeroPins = ['A', 'B', 'C', 'D'];
  for (let i = 0; i < 4; i++) {
    net(`pc${i}`, `pc.${pcOuts[i]}`, `rom.A${i}`);
    net(`operand${i}`, `rom.IO${i}`, `ram.A${i}`, `pc.${pcIns[i]}`, `alu.B${i}`, `source.A${i}`);
    net(`acc${i}`, `acc.Q${i + 1}`, `alu.A${i}`, `zero.${zeroPins[i]}`, `drive${i}.A`);
    net(`data${i}`, `ram.DQ${i}`, `drive${i}.Y`, `source.B${i}`);
    net(`source${i}`, `source.Y${i}`, `result.A${i}`);
    net(`sum${i}`, `alu.S${i}`, `result.B${i}`);
    net(`next${i}`, `result.Y${i}`, `acc.D${i + 1}`);
  }
  for (let i = 4; i < 8; i++) net(`data${i}`, `ram.DQ${i}`, `drive${i}.Y`);
  return { version: 1, kind: 'circuit', name: 'headless_cpu4_plan_only', description: 'Generated engineering fixture, not manual construction. Harvard 4-bit accumulator/PC with 16-byte program and data addressing.', components, nets };
}

// Uses exact, unchanged definitions exported from the manually built library.
// The surrounding integration graph is still a generated headless oracle;
// it is never an editor construction checkpoint.
export function cpu4ManualModulePlan(program: number[], definitions: CircuitJSON[]): CircuitJSON {
  const plan = cpu4Plan(program);
  plan.name = 'headless_manual_module_integration_only';
  plan.definitions = definitions;
  const removed = new Set(['not_enable', 'not_jump', 'zero', 'load_enable', 'write_enable']);
  plan.components = plan.components.filter((c) => !removed.has(c.id)).map((c) => {
    const replacements: Record<string, string> = { pc: 'user.PC4', acc: 'user.Register4', alu: 'user.Adder4', source: 'user.Mux4', result: 'user.Mux4' };
    return { ...c, type: replacements[c.id] ?? (c.type.startsWith('prim.') && ['NOT', 'AND', 'OR', 'NAND'].includes(c.type.slice(5)) ? `user.${c.type.slice(5)[0]}${c.type.slice(6).toLowerCase()}` : c.type), ...(c.type.startsWith('prim.') ? { params: c.type === 'prim.DECODER' ? c.params : undefined } : {}) };
  });
  for (const [id, type] of [['load_pair', 'Or'], ['load_enable', 'Or'], ['zero_low', 'Or'], ['zero_high', 'Or'], ['zero_pair', 'Or'], ['zero', 'Not'], ['write_phase', 'And'], ['write_enable', 'Nand']]) plan.components.push({ id: id!, type: `user.${type}` });
  const pcPins: Record<string, string> = { QA: 'Q0', QB: 'Q1', QC: 'Q2', QD: 'Q3', A: 'D0', B: 'D1', C: 'D2', D: 'D3', '/CLR': 'CLR', ENT: 'EN', ENP: 'EN' };
  const accPins: Record<string, string> = { Q1: 'Q0', Q2: 'Q1', Q3: 'Q2', Q4: 'Q3', D1: 'D0', D2: 'D1', D3: 'D2', D4: 'D3' };
  plan.nets = plan.nets.filter((n) => !['load_acc_n', 'load_pc_n'].includes(n.id)).map((n) => ({ ...n, endpoints: [...new Set(n.endpoints.flatMap((e) => {
    if (['acc.CLR', 'acc./G2', 'acc./M', 'acc./N', 'not_enable.A', 'not_jump.A'].includes(e)) return [];
    const split = e.indexOf('.'); const id = e.slice(0, split); const pin = e.slice(split + 1);
    if (id === 'pc') return [`pc.${pcPins[pin] ?? pin}`];
    if (id === 'acc') return [`acc.${accPins[pin] ?? pin}`];
    if (id === 'load_enable') return [pin === 'Y' ? e : pin === 'C' ? 'load_enable.B' : `load_pair.${pin}`];
    if (id === 'zero' && pin !== 'Y') return [`${['A', 'B'].includes(pin) ? 'zero_low' : 'zero_high'}.${['A', 'C'].includes(pin) ? 'A' : 'B'}`];
    if (id === 'write_enable') return [pin === 'C' ? 'write_enable.B' : pin === 'Y' ? e : `write_phase.${pin}`];
    return [e];
  }))] }));
  const append = (id: string, ...endpoints: string[]): void => { const n = plan.nets.find((n) => n.id === id); if (n) n.endpoints.push(...endpoints); else plan.nets.push({ id, endpoints }); };
  append('reset_n', 'acc.CLR'); append('load_acc', 'acc.EN'); append('do_jump', 'pc.LOAD');
  append('load_pair', 'load_pair.Y', 'load_enable.A');
  append('zero_low', 'zero_low.Y', 'zero_pair.A'); append('zero_high', 'zero_high.Y', 'zero_pair.B');
  append('zero_pair', 'zero_pair.Y', 'zero.A'); append('write_phase', 'write_phase.Y', 'write_enable.A');
  return plan;
}

export interface Cpu4State { pc: number; acc: number; ram: number[]; halted: boolean }
// Independent integer ISA model, intentionally unrelated to the gate graph.
export function cpu4Instruction(state: Cpu4State, program: number[]): Cpu4State {
  validProgram(program);
  const next = { ...state, ram: [...state.ram] };
  const byte = program[state.pc] ?? 0; const op = byte >> 4; const operand = byte & 15;
  if (op === 6) { next.halted = true; return next; }
  next.pc = (state.pc + 1) & 15;
  switch (op) {
    case 0: next.acc = operand; break;
    case 1: next.acc = (state.acc + operand) & 15; break;
    case 2: next.acc = state.ram[operand]!; break;
    case 3: next.ram[operand] = state.acc; break;
    case 4: if (state.acc === 0) next.pc = operand; break;
    case 5: next.pc = operand; break;
    default: break;
  }
  return next;
}
