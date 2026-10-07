import { describe, expect, it } from 'vitest';
import { loadCircuit } from '../engine/loader';
import { Simulator } from '../engine/sim';
import { cpu4Instruction, cpu4Plan, cpu4ManualModulePlan, type Cpu4State } from './cpu4.plan';
import editorCheckpoint from './fixtures/pc4-editor-checkpoint.json';
import cpuCheckpoint from './fixtures/cpu4-editor-checkpoint.json';
import type { CircuitJSON } from '../engine/ir';

const cases: Array<{ name: string; program: number[]; instructions: number; acc: number; ram?: [number, number] }> = [
  { name: 'arithmetic with wrapping', program: [0x05, 0x13, 0x19, 0x60], instructions: 3, acc: 1 },
  { name: 'independent load/store', program: [0x09, 0x3f, 0x00, 0x2f, 0x11, 0x3e, 0x60], instructions: 6, acc: 10, ram: [14, 10] },
  { name: 'countdown, untaken/taken JZ and backward JMP', program: [0x03, 0x1f, 0x44, 0x51, 0x60], instructions: 9, acc: 0 },
];
describe('CPU4 independent headless ISA checks (separate from manual UI results)', () => {
  it('rejects high opcode bits and oversized programs consistently with the hardware encoding', () => {
    const state: Cpu4State = { pc: 0, acc: 0, ram: Array<number>(16).fill(0), halted: false };
    for (const program of [[0x03, 0x81, 0x60], [-1], [256], Array<number>(2), Array<number>(17).fill(0)]) {
      expect(() => cpu4Plan(program)).toThrow('three opcode bits');
      expect(() => cpu4Instruction(state, program)).toThrow('three opcode bits');
    }
  });
  for (const mode of ['primitive plan', 'exact editor-authored modules / generated integration', 'actual editor-built CPU / headless program check']) for (const example of cases) it(`${mode}: ${example.name}`, () => {
    const actual = mode.startsWith('actual');
    const circuit = actual ? structuredClone(cpuCheckpoint) as unknown as CircuitJSON : mode.startsWith('exact') ? cpu4ManualModulePlan(example.program, (editorCheckpoint as unknown as CircuitJSON).definitions!) : cpu4Plan(example.program);
    if (actual) circuit.components.find((c) => c.type === 'mem.28C16')!.params = { contents: example.program.map((b) => b.toString(16).padStart(2, '0')).join(' ') };
    const graph = loadCircuit(circuit); const sim = new Simulator(graph, { onEvent: event => expect(event.kind).not.toBe('oscillation') });
    const clock = actual ? 'switch1' : 'clock'; const reset = actual ? 'switch2' : 'reset'; const ramId = actual ? '61161' : 'ram';
    const netAt = (endpoint: string): string => circuit.nets.find((n) => n.endpoints.includes(endpoint))!.id;
    const signal = (prefix: string): number => {
      let value = 0; for (let bit = 0; bit < 4; bit++) {
        const name = actual ? netAt(`${prefix === 'pc' ? 'pc41' : 'register41'}.Q${bit}`) : `${prefix}${bit}`;
        const v = sim.readNet(name); if (v !== 0 && v !== 1) throw new Error(`${prefix}${bit}=${v}`);
        value |= v << bit;
      } return value;
    };
    sim.settle(); sim.setComponentInput(reset, 'Y', 1); sim.settle();
    expect(signal('acc')).toBe(0); expect(signal('pc')).toBe(0);
    sim.setComponentInput(reset, 'Y', 0); sim.settle();
    let model: Cpu4State = { pc: 0, acc: 0, ram: Array<number>(16).fill(0), halted: false };
    for (let i = 0; i < example.instructions; i++) {
      model = cpu4Instruction(model, example.program);
      sim.setComponentInput(clock, 'Y', 1); sim.settle();
      expect(signal('acc'), `ACC after instruction ${i}`).toBe(model.acc);
      expect(signal('pc'), `PC after instruction ${i}`).toBe(model.pc);
      const ram = (graph.components.find((c) => c.id === ramId)!.state as { data: Uint8Array }).data;
      expect([...ram.slice(0, 16)], `RAM after instruction ${i}`).toEqual(model.ram);
      sim.setComponentInput(clock, 'Y', 0); sim.settle();
    }
    expect(signal('acc')).toBe(example.acc);
    expect(sim.readNet(actual ? netAt('decoder1.Y6') : 'halt')).toBe(1);
    for (let i = 0; i < 4; i++) { sim.setComponentInput(clock, 'Y', i % 2 ? 1 : 0); sim.settle(); }
    expect(signal('acc')).toBe(example.acc); expect(signal('pc')).toBe(model.pc);
    if (example.ram) expect(model.ram[example.ram[0]]).toBe(example.ram[1]);
    // Reset while paused in a stable low clock phase must clear architecture
    // and inhibit memory writes while retaining the SRAM's stored contents.
    const memory = (graph.components.find((c) => c.id === ramId)!.state as { data: Uint8Array }).data;
    const savedMemory = [...memory];
    sim.setComponentInput(clock, 'Y', 0); sim.settle();
    sim.setComponentInput(reset, 'Y', 1); sim.settle();
    expect(signal('acc')).toBe(0); expect(signal('pc')).toBe(0); expect(sim.readNet(actual ? netAt('61161./WE') : 'write_n')).toBe(1);
    expect([...memory]).toEqual(savedMemory);
    expect(sim.events.some((e) => e.kind === 'oscillation')).toBe(false);
  });
});
