// Automated reference-machine checks, not evidence of editor construction.
// The oracle below implements architectural instructions with integer math;
// it does not import the microcode, TTL definitions, or gate implementations.
import { describe, expect, it } from 'vitest';
import reference from '../../examples/ben_eater_8bit.json';
import '../engine/index';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import { Simulator } from '../engine/sim';

const interpret = (image: number[]) => {
  const memory = [...image];
  const outputs: number[] = [];
  let a = 0;
  let b = 0;
  let pc = 0;
  let carry = 0;
  let zero = 0;
  for (let instructions = 0; instructions < 256; instructions++) {
    const instruction = memory[pc]!;
    pc = (pc + 1) & 15;
    const operand = instruction & 15;
    switch (instruction >> 4) {
      case 0: break;
      case 1: a = memory[operand]!; break;
      case 2: {
        b = memory[operand]!;
        const sum = a + b;
        a = sum & 255;
        carry = sum > 255 ? 1 : 0;
        zero = a === 0 ? 1 : 0;
        break;
      }
      case 3: {
        b = memory[operand]!;
        const difference = a - b;
        a = difference & 255;
        carry = difference >= 0 ? 1 : 0;
        zero = a === 0 ? 1 : 0;
        break;
      }
      case 4: memory[operand] = a; break;
      case 5: a = operand; break;
      case 6: pc = operand; break;
      case 7: if (carry) pc = operand; break;
      case 8: if (zero) pc = operand; break;
      case 14: outputs.push(a); break;
      case 15: return { a, b, pc, carry, zero, memory, outputs };
      default: throw new Error('unsupported oracle opcode');
    }
  }
  throw new Error('oracle did not halt within 256 instructions');
};

const readBits = (sim: Simulator, nets: string[]): number => nets.reduce((value, net, index) => {
  const bit = sim.readNet(net);
  if (bit !== 0 && bit !== 1) throw new Error(`undefined architectural bit ${net}: ${String(bit)}`);
  return value | (bit << index);
}, 0);

const cases = [
  { name: 'addition and subtraction', code: [0x59, 0x4f, 0x54, 0x2f, 0xe0, 0x3f, 0xe0, 0xf0], data: {}, outputs: [13, 4] },
  { name: 'load and store', code: [0x57, 0x4e, 0x53, 0x4f, 0x1e, 0x2f, 0x4d, 0x50, 0x1d, 0xe0, 0xf0], data: {}, outputs: [10] },
  { name: 'countdown with taken and untaken zero branch', code: [0x53, 0x4f, 0xe0, 0x3e, 0x86, 0x62, 0x59, 0xe0, 0xf0], data: { 14: 1 }, outputs: [3, 2, 1, 9] },
  { name: 'carry branch after overflow', code: [0x1e, 0x2f, 0x75, 0x50, 0xe0, 0x59, 0xe0, 0xf0], data: { 14: 250, 15: 10 }, outputs: [9] },
  { name: 'repeated output instructions', code: [0x55, 0xe0, 0xe0, 0xf0], data: {}, outputs: [5, 5] },
];

describe('SAP-1 reference programs against an independent ISA oracle', () => {
  it.each(cases)('$name', ({ code, data, outputs }) => {
    const image = new Array<number>(16).fill(0);
    code.forEach((byte, index) => { image[index] = byte; });
    for (const [address, byte] of Object.entries(data)) image[Number(address)] = byte;
    const expected = interpret(image);
    expect(expected.outputs).toEqual(outputs);

    const circuit = structuredClone(reference) as CircuitJSON;
    circuit.components.find((component) => component.id === 'ram_chip')!.params = {
      contents: image.map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    };
    const sim = new Simulator(loadCircuit(circuit), { onEvent: event => expect(event.kind).not.toBe('oscillation') });
    sim.settle();
    sim.setComponentInput('sw_reset', 'Y', 1);
    sim.settle();

    const actualOutputs: number[] = [];
    let previousClock = sim.readNet('gated_clk');
    let ticks = 0;
    while (sim.readNet('ctl_hlt') !== 1 && ticks++ < 5000) {
      const outputEnabled = sim.readNet('ctl_oi') === 0;
      sim.tick();
      const clock = sim.readNet('gated_clk');
      if (previousClock === 0 && clock === 1 && outputEnabled) {
        actualOutputs.push(readBits(sim, [
          ...Array.from({ length: 4 }, (_, bit) => `display__nlo${bit}`),
          ...Array.from({ length: 4 }, (_, bit) => `display__nhi${bit}`),
        ]));
      }
      previousClock = clock;
    }

    expect(sim.readNet('ctl_hlt'), 'program must halt').toBe(1);
    expect(actualOutputs).toEqual(expected.outputs);
    expect(readBits(sim, Array.from({ length: 8 }, (_, bit) => `av${bit}`))).toBe(expected.a);
    expect(readBits(sim, Array.from({ length: 8 }, (_, bit) => `bv${bit}`))).toBe(expected.b);
    expect(readBits(sim, ['pc__qa', 'pc__qb', 'pc__qc', 'pc__qd'])).toBe(expected.pc);
    expect(sim.readNet('cflag')).toBe(expected.carry);
    expect(sim.readNet('zflag')).toBe(expected.zero);
    const ram = sim.graph.components[sim.graph.componentById.get('ram_chip')!]!.state as { data: Uint8Array };
    expect([...ram.data.slice(0, 16)]).toEqual(expected.memory);
    expect(sim.events.filter((event) => event.kind === 'oscillation')).toEqual([]);

    // Halt must keep the architectural state stable despite the raw clock.
    const before = [...ram.data.slice(0, 16)];
    for (let tick = 0; tick < 20; tick++) sim.tick();
    expect([...ram.data.slice(0, 16)]).toEqual(before);
    expect(readBits(sim, Array.from({ length: 8 }, (_, bit) => `av${bit}`))).toBe(expected.a);
    expect(sim.readNet('ctl_hlt')).toBe(1);
  });
});
