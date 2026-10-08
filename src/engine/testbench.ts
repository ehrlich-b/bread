import schema from '../../schema/testbench.schema.json';
import './index';
import type { CircuitJSON, NetState } from './ir';
import { loadCircuit } from './loader';
import { ProbeCapture, type WaveformSnapshot } from './probes';
import { Simulator } from './sim';
import { validateSchema } from './testbench_schema';

type Literal = number | string;
type Value = Literal | { var: string; bit?: number } | { table: Literal[]; index: string };
type Input = string[] | { component: string; pin: 'Y' };
interface Vector {
  label?: string;
  drive?: Record<string, Value>;
  expect?: Record<string, Value>;
  clock?: string;
  ticks?: number;
  wait?: { rising: string; when?: Record<string, Literal>; maxTicks: number };
}
interface Loop {
  for: Record<string, number[] | { from: number; to: number }>;
  vectors: Step[];
}
type Step = Vector | Loop;

export interface TestbenchJSON {
  version: 1;
  name: string;
  circuit?: string;
  description?: string;
  rateHz?: number;
  inputs: Record<string, Input>;
  outputs: Record<string, string[]>;
  vectors: Step[];
}

export interface VectorResult {
  vector: number;
  label: string;
  step: number;
  drive: Record<string, string>;
  expected: Record<string, string>;
  actual: Record<string, string>;
  mismatches: string[];
  passed: boolean;
  reason?: string;
}

export interface TestbenchResult {
  name: string;
  total: number;
  passed: number;
  results: VectorResult[];
  waveform: WaveformSnapshot | null;
}

const MAX_VECTORS = 10_000;
const MAX_STEPS = 100_000;
const owns = (record: object, key: string): boolean => Object.hasOwn(record, key);

export function parseTestbench(input: unknown): TestbenchJSON {
  validateSchema(input, schema);
  return input as TestbenchJSON;
}

// Nets and probe lanes are LSB-first; displayed/expected binary strings are
// MSB-first. X, Z and '-' alone broadcast across the whole signal.
function bits(value: Literal, width: number, expected: boolean): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** width) throw new Error(`Value ${value} does not fit ${width} bits`);
    return value.toString(2).padStart(width, '0');
  }
  if (value === 'X' || value === 'Z' || (expected && value === '-')) return value.repeat(width);
  if (value.length !== width || !(expected ? /^[01XZ-]+$/ : /^[01XZ]+$/).test(value)) throw new Error(`Value ${value} must contain ${width} bits${expected ? ' or don’t-care (-)' : ''}`);
  return value;
}

function resolveValue(value: Value, vars: Record<string, number>): Literal {
  if (typeof value !== 'object') return value;
  const name = 'var' in value ? value.var : value.index;
  if (!owns(vars, name)) throw new Error(`Unknown loop variable ${name}`);
  const number = vars[name]!;
  if ('table' in value) {
    const entry = value.table[number];
    if (entry === undefined) throw new Error(`Table index ${name}=${number} is out of range`);
    return entry;
  }
  return value.bit === undefined ? number : Math.floor(number / 2 ** value.bit) % 2;
}

interface PreparedVector {
  label: string;
  drive: Record<string, string>;
  expected: Record<string, string>;
  clock?: string;
  ticks?: number;
  wait?: { rising: string; when: Record<string, string>; maxTicks: number };
}

function prepare(bench: TestbenchJSON): PreparedVector[] {
  const vectors: PreparedVector[] = [];
  const width = (name: string, output: boolean): number => {
    const signals = output ? bench.outputs : bench.inputs;
    if (!owns(signals, name)) throw new Error(`Unknown ${output ? 'output' : 'input'} ${name}`);
    const signal = signals[name]!;
    return Array.isArray(signal) ? signal.length : 1;
  };
  const values = (record: Record<string, Value>, vars: Record<string, number>, output: boolean): Record<string, string> =>
    Object.fromEntries(Object.entries(record).map(([name, value]) => [name, bits(resolveValue(value, vars), width(name, output), output)]));
  const visit = (steps: Step[], vars: Record<string, number>, depth: number): void => {
    if (depth > 16) throw new Error('Testbench loops nest too deeply (maximum 16)');
    for (const step of steps) {
      if ('for' in step) {
        const entries = Object.entries(step.for);
        const expand = (index: number, scope: Record<string, number>): void => {
          if (index === entries.length) { visit(step.vectors, scope, depth + 1); return; }
          const [name, range] = entries[index]!;
          if (!Array.isArray(range) && (range.to < range.from || range.to - range.from >= MAX_VECTORS)) throw new Error(`Invalid or oversized range for ${name}`);
          const choices = Array.isArray(range) ? range : Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i);
          for (const choice of choices) expand(index + 1, { ...scope, [name]: choice });
        };
        if (entries.length > 16) throw new Error('Too many loop variables (maximum 16)');
        expand(0, vars);
        continue;
      }
      if (vectors.length >= MAX_VECTORS) throw new Error(`Testbench exceeds ${MAX_VECTORS} vectors`);
      if ([step.clock, step.ticks, step.wait].filter(value => value !== undefined).length > 1) throw new Error('A vector may use only one of clock, ticks or wait');
      if (step.clock && width(step.clock, false) !== 1) throw new Error(`Clock ${step.clock} must be one bit`);
      if (step.wait && width(step.wait.rising, true) !== 1) throw new Error(`Edge signal ${step.wait.rising} must be one bit`);
      const context = Object.entries(vars).map(([key, value]) => `${key}=${value}`).join(', ');
      vectors.push({
        label: [step.label ?? `Vector ${vectors.length + 1}`, context].filter(Boolean).join(' · '),
        drive: values(step.drive ?? {}, vars, false),
        expected: values(step.expect ?? {}, vars, true),
        clock: step.clock,
        ticks: step.ticks,
        wait: step.wait ? { ...step.wait, when: values(step.wait.when ?? {}, vars, true) } : undefined,
      });
    }
  };
  visit(bench.vectors, {}, 0);
  if (!vectors.some(vector => Object.values(vector.expected).some(value => /[01XZ]/.test(value)))) throw new Error('Testbench needs at least one checked output');
  return vectors;
}

const matches = (expected: string, actual: string): boolean => [...expected].every((bit, index) => bit === '-' || bit === actual[index]);

// Each run starts from power-on state. No scheduler or primitive changes are
// needed, and none of this work runs unless a caller invokes the testbench.
export function runTestbench(circuit: CircuitJSON, input: unknown, options: { stopOnFailure?: boolean; capture?: boolean; throughVector?: number } = {}): TestbenchResult {
  const bench = parseTestbench(input);
  const vectors = prepare(bench);
  if (options.throughVector !== undefined && (!Number.isInteger(options.throughVector) || options.throughVector < 1 || options.throughVector > vectors.length)) throw new Error('Invalid replay vector');
  let oscillated = false;
  const sim = new Simulator(loadCircuit(circuit), { rateHz: bench.rateHz ?? 1000, onEvent: event => { if (event.kind === 'oscillation') oscillated = true; } });
  const driven = new Set<string>();
  for (const [name, signal] of Object.entries(bench.inputs)) {
    let nets: string[];
    if (Array.isArray(signal)) nets = signal;
    else {
      const index = sim.graph.componentById.get(signal.component);
      const comp = index === undefined ? undefined : sim.graph.components[index];
      if (comp?.typeId !== 'io.switch' || signal.pin !== 'Y') throw new Error(`Input ${name}: component input must name an io.switch Y pin`);
      nets = [sim.graph.nets[comp.pinNetIdx[0]!]!.id];
    }
    for (const net of nets) {
      if (!sim.graph.netById.has(net)) throw new Error(`Input ${name}: unknown net ${net}`);
      if (driven.has(net)) throw new Error(`Input ${name}: duplicate drive of net ${net}`);
      driven.add(net);
    }
  }
  for (const [name, nets] of Object.entries(bench.outputs)) for (const net of nets) {
    if (!sim.graph.netById.has(net)) throw new Error(`Output ${name}: unknown net ${net}`);
  }
  const capture = options.capture && circuit.probes?.length ? new ProbeCapture(circuit.probes, sim.graph) : null;
  let sample = 0;
  const settle = (tick = false): void => {
    if (sample >= MAX_STEPS) throw new Error(`Testbench exceeds ${MAX_STEPS} simulation steps`);
    if (tick) sim.tick(); else sim.settle();
    capture?.record(sample, sim.graph.netValues);
    sample++;
  };
  const drive = (name: string, value: string): void => {
    const signal = bench.inputs[name]!;
    const state = (bit: string): NetState => bit === '0' ? 0 : bit === '1' ? 1 : bit as 'X' | 'Z';
    if (Array.isArray(signal)) signal.forEach((net, bit) => sim.setInput(net, state(value[value.length - bit - 1]!)));
    else sim.setComponentInput(signal.component, signal.pin, state(value));
  };
  const read = (name: string): string => [...bench.outputs[name]!].reverse().map(net => String(sim.readNet(net))).join('');
  settle();
  const results: VectorResult[] = [];
  for (const [index, vector] of vectors.entries()) {
    for (const [name, value] of Object.entries(vector.drive)) drive(name, value);
    settle();
    if (vector.clock) {
      for (const level of ['0', '1', '0']) { drive(vector.clock, level); settle(); }
    }
    for (let tick = 0; tick < (vector.ticks ?? 0); tick++) settle(true);
    let reason: string | undefined;
    if (vector.wait) {
      const wait = vector.wait;
      let found = false;
      for (let tick = 0; tick < wait.maxTicks; tick++) {
        const before = read(wait.rising);
        const enabled = Object.entries(wait.when).every(([name, value]) => matches(value, read(name)));
        settle(true);
        if (before === '0' && read(wait.rising) === '1' && enabled) { found = true; break; }
      }
      if (!found) reason = `No rising ${wait.rising} edge within ${wait.maxTicks} ticks`;
    }
    if (oscillated) reason = 'Circuit did not settle (oscillation)';
    const actual = Object.fromEntries(Object.keys(vector.expected).map(name => [name, read(name)]));
    const mismatches = Object.entries(vector.expected).filter(([name, value]) => !matches(value, actual[name]!)).map(([name]) => name);
    const passed = !reason && mismatches.length === 0;
    results.push({ vector: index + 1, label: vector.label, step: sample - 1, drive: vector.drive, expected: vector.expected, actual, mismatches, passed, reason });
    if (!passed && options.stopOnFailure !== false) break;
    if (options.throughVector === index + 1) break;
    oscillated = false;
  }
  return { name: bench.name, total: vectors.length, passed: results.filter(result => result.passed).length, results, waveform: capture?.snapshot() ?? null };
}
