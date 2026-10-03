// Headless benchmark of an exact editor checkpoint, with a derived loop ROM.
// A library-only checkpoint uses the separate generated integration oracle.
import { readFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { cpu4Instruction, cpu4ManualModulePlan, type Cpu4State } from '../src/climb/cpu4.plan';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';
import type { CircuitJSON } from '../src/engine/ir';

const path = process.argv[2] ?? 'docs/evidence/manual-ascent/cpu4-editor-checkpoint.json';
const instructions = Number(process.argv[3] ?? 100_000);
if (!Number.isSafeInteger(instructions) || instructions < 1) throw new Error('Positive integer instruction count required');
const exact = readFileSync(path, 'utf8');
const checkpoint = JSON.parse(exact) as CircuitJSON;
const program = [0x01, 0x1f, 0x3f, 0x2f, 0x51];
const actual = checkpoint.components.some((c) => c.type === 'mem.6116');
const circuit = actual ? structuredClone(checkpoint) : cpu4ManualModulePlan(program, checkpoint.definitions!);
if (actual) circuit.components.find((c) => c.type === 'mem.28C16')!.params = { contents: program.map((b) => b.toString(16).padStart(2, '0')).join(' ') };
const graph = loadCircuit(circuit);
// These actual IDs are recorded by the manual action log's cpuRoleMap.
const clock = actual ? 'switch1' : 'clock'; const reset = actual ? 'switch2' : 'reset';
const names = (role: 'pc' | 'acc'): string[] => Array.from({ length: 4 }, (_, bit) => actual ? circuit.nets.find((n) => n.endpoints.includes(`${role === 'pc' ? 'pc41' : 'register41'}.Q${bit}`))!.id : `${role}${bit}`);
const pcNets = names('pc'); const accNets = names('acc');
const clockNet = actual ? circuit.nets.find((n) => n.endpoints.includes('and1.Y'))!.id : 'clock';
const sim = new Simulator(graph);
const signal = (nets: string[]): number => {
  let value = 0;
  for (let bit = 0; bit < 4; bit++) {
    const v = sim.readNet(nets[bit]!);
    if (v !== 0 && v !== 1) throw new Error(`${nets[bit]}=${v}`);
    value |= v << bit;
  }
  return value;
};
sim.settle(); sim.setComponentInput(reset, 'Y', 1); sim.settle();
sim.setComponentInput(reset, 'Y', 0); sim.settle();
let model: Cpu4State = { pc: 0, acc: 0, ram: Array<number>(16).fill(0), halted: false };
const memory = (graph.components.find((c) => c.id === (actual ? '61161' : 'ram'))!.state as { data: Uint8Array }).data;
let observedRisingEdges = 0; let completedInstructions = 0;
let lastClock = sim.readNet(clockNet);
if (lastClock !== 0) throw new Error(`Initial CPU clock=${lastClock}`);
const start = performance.now();
for (let i = 0; i < instructions; i++) {
  model = cpu4Instruction(model, program);
  sim.setComponentInput(clock, 'Y', 1); sim.settle();
  const risingClock = sim.readNet(clockNet);
  if (lastClock === 0 && risingClock === 1) observedRisingEdges++;
  else throw new Error(`Missing CPU rising edge at instruction ${i}`);
  lastClock = risingClock;
  if (signal(pcNets) !== model.pc || signal(accNets) !== model.acc || memory[15] !== model.ram[15]) throw new Error(`ISA mismatch at instruction ${i}`);
  completedInstructions++;
  sim.setComponentInput(clock, 'Y', 0); sim.settle();
  lastClock = sim.readNet(clockNet);
  if (lastClock !== 0) throw new Error(`CPU clock did not fall at instruction ${i}`);
}
const elapsedMs = performance.now() - start;
const oscillations = sim.events.filter((e) => e.kind === 'oscillation').length;
if (oscillations) throw new Error(`Oscillations: ${oscillations}`);
console.log(JSON.stringify({ provenance: actual ? 'Actual editor-built CPU checkpoint, derived headless loop ROM only, every instruction independently checked; not an interactive UI speed measurement' : 'Generated headless CPU integration plan, exact manually authored library, every instruction checked; not manual CPU proof', source: path, sha256: createHash('sha256').update(exact).digest('hex'), host: { cpu: cpus()[0]?.model, platform: platform(), arch: arch(), node: process.version }, runtimeLeaves: graph.components.length, runtimeNets: graph.nets.length, programHex: program.map((b) => b.toString(16).padStart(2, '0')).join(' '), completedInstructions, observedRisingEdges, elapsedMs, instructionsPerSecond: completedInstructions / (elapsedMs / 1000), observedCyclesPerSecond: observedRisingEdges / (elapsedMs / 1000), diagnosticEvents: sim.events.length, oscillations }, null, 2));
