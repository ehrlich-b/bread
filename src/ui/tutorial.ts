import eater from '../../examples/ben_eater_8bit.json';
import type { CircuitJSON, NetState } from '../engine/ir';
import type { WaveformSnapshot } from '../engine/probes';
import type { MetricsNotif } from '../worker/protocol';

const bits = (prefix: string, width = 8): string[] => Array.from({ length: width }, (_, bit) => `${prefix}${bit}`);
const SIGNALS = {
  CLK: ['gated_clk'], RESET: ['reset_low'], BUS: bits('bus'), BUS_ADDR: bits('bus', 4), A: bits('av'), B: bits('bv'),
  SUM: bits('alu__sum'), PC: ['pc__qa', 'pc__qb', 'pc__qc', 'pc__qd'], MAR: bits('addr', 4),
  OPCODE: bits('op', 4), T: bits('control__tq', 3), OUT: [...bits('display__nlo', 4), ...bits('display__nhi', 4)],
  '/AI': ['ctl_ai'], '/IO': ['ctl_io'], '/EU': ['ctl_eu'], SU: ['ctl_su'], '/FI': ['ctl_fi'],
  '/MI': ['ctl_mi'], '/CO': ['ctl_co'], '/RO': ['ctl_ro'], '/II': ['ctl_ii'], CE: ['ctl_ce'],
  '/BI': ['ctl_bi'], '/OI': ['ctl_oi'],
};
type Signal = keyof typeof SIGNALS;
export type TutorialStepId = 'clock' | 'probe' | 'register' | 'alu' | 'memory' | 'microcode' | 'fibonacci';
interface TutorialStep {
  id: TutorialStepId;
  title: string;
  instruction: string;
  focus: string[];
  probes: Signal[];
  success: string;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'clock', title: 'Step and run the clock', focus: ['clk_gen', 'and_clk'], probes: [],
    instruction: 'Click Step until CLK is high, then Run and Pause to advance time automatically. Step advances one simulator tick; Run repeats ticks at the chosen rate while RESET stays held.',
    success: 'CLK rose during a paused step, and Run advanced simulator time.',
  },
  {
    id: 'probe', title: 'Probe CLK', focus: ['reg_a'], probes: [],
    instruction: 'Click Probe net, then the highlighted A register’s CLK pin, and Step until the waveform shows both 0 and 1. Each rising edge is a chance for registers to load.',
    success: 'The CLK probe recorded a rising edge.',
  },
  {
    id: 'register', title: 'Load A from the bus', focus: ['reg_a', 'ir', 'sw_reset'],
    probes: ['CLK', 'RESET', 'BUS', 'A', '/IO', '/AI'],
    instruction: 'Click sw_reset once to release RESET, then Step until A reads 03. /IO = 0 puts the instruction’s 3 on the bus; /AI = 0 loads A on the next rising CLK.',
    success: 'A loaded 03 from the bus with /IO and /AI asserted.',
  },
  {
    id: 'alu', title: 'Add A + B', focus: ['alu', 'reg_a', 'reg_b', 'sw_reset'],
    probes: ['CLK', 'RESET', 'BUS', 'A', 'B', 'SUM', '/EU', '/AI', 'SU'],
    instruction: 'Release RESET, then Step until A reads 05: the program loads A = 3 and B = 2 from RAM address 15. With SU = 0, /EU = 0 puts their sum on the bus and /AI = 0 loads it into A.',
    success: 'The ALU put 03 + 02 = 05 on the bus and A loaded it.',
  },
  {
    id: 'memory', title: 'Fetch from RAM with the PC', focus: ['ram_chip', 'mar', 'pc', 'ir', 'sw_reset'],
    probes: ['CLK', 'RESET', 'BUS', 'PC', 'MAR', 'OPCODE', '/MI', '/CO', '/RO', '/II', 'CE'],
    instruction: 'Release RESET, then Step through the first two rising clock edges. /CO and /MI copy PC = 0 into MAR; /RO and /II fetch RAM’s 53 (LDI 3), while CE increments PC to 1.',
    success: 'MAR received address 0, RAM supplied 53, and PC advanced to 1.',
  },
  {
    id: 'microcode', title: 'Follow one ADD instruction', focus: ['control', 'sw_reset'],
    probes: ['CLK', 'RESET', 'T', 'OPCODE', 'PC', 'MAR', 'BUS', 'A', 'B', 'SUM', '/MI', '/CO', '/RO', '/II', 'CE', '/IO', '/BI', '/EU', '/AI', '/FI'],
    instruction: 'Release RESET, then Step through LDI 3 and all five T-states of ADD 15. Follow the rows below: the control unit fetches 2F, reads RAM[15] = 02 into B, then loads A + B = 05 into A.',
    success: 'ADD 15 completed its five microcode rows in order.',
  },
  {
    id: 'fibonacci', title: 'Run Fibonacci on the waveform', focus: ['display', 'sw_reset'], probes: ['CLK', '/OI'],
    instruction: 'Click Probe bus, then display.OUT0, release RESET, and Run until the OUT waveform reaches E9 (233); Pause to inspect it. Check Fibonacci also runs the bundled testbench and opens its recorded waveform.',
    success: 'OUT recorded 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233 in order.',
  },
];

export const ADD_MICROCODE = [
  ['T0', '/CO /MI', 'PC → MAR'], ['T1', '/RO /II CE', 'RAM → IR; PC + 1'],
  ['T2', '/IO /MI', '15 → MAR'], ['T3', '/RO /BI', 'RAM[15] → B'], ['T4', '/EU /AI /FI', 'A + B → A; flags'],
] as const;

// Keep the bundled topology. Only the clock and lesson RAM image change;
// every navigation starts at reset so Back, Skip and resume are reproducible.
export function tutorialCircuit(id: TutorialStepId): CircuitJSON {
  const circuit = structuredClone(eater) as CircuitJSON;
  circuit.components.find(c => c.id === 'clk_gen')!.params = { freqHz: 500 };
  if (id !== 'fibonacci') {
    circuit.components.find(c => c.id === 'ram_chip')!.params = { contents: '53 2F E0 F0 00 00 00 00 00 00 00 00 00 00 00 02' };
  }
  circuit.probes = TUTORIAL_STEPS.find(step => step.id === id)!.probes.map((signal, index) => ({
    id: `tutorial${index}`, label: signal, nets: [...SIGNALS[signal]],
  }));
  return circuit;
}

export class TutorialClock {
  private tick = 0;
  private clock: NetState = 0;
  private runStart: number | null = null;
  private manual = false;
  private ran = false;
  private running = false;

  observe(metrics: MetricsNotif, clock: NetState): void {
    if (this.runStart !== null && metrics.ticks > this.runStart) this.ran = true;
    if (!metrics.running && this.runStart === null && metrics.ticks > this.tick && this.clock === 0 && clock === 1) this.manual = true;
    if (metrics.running && this.runStart === null) this.runStart = metrics.ticks;
    if (!metrics.running) this.runStart = null;
    this.tick = metrics.ticks; this.clock = clock; this.running = metrics.running;
  }

  get complete(): boolean { return this.manual && this.ran && !this.running; }
}

// Read exact lanes, independent of probe names or their order. X/Z and missing
// lanes cannot satisfy numeric checks. Edge checks use the pre-edge control
// signals because the control unit advances its T-state on that same edge.
export function tutorialComplete(id: TutorialStepId, snapshot: WaveformSnapshot | null | undefined, clock?: TutorialClock): boolean {
  if (id === 'clock') return clock?.complete ?? false;
  if (!snapshot) return false;
  const lanes = new Map<string, number>();
  let offset = 0;
  for (const probe of snapshot.probes) for (const net of probe.nets) lanes.set(net, offset++);
  const value = (sample: number, signal: Signal): number | null => {
    let result = 0;
    for (const [bit, net] of SIGNALS[signal].entries()) {
      const lane = lanes.get(net);
      const byte = lane === undefined ? undefined : snapshot.values[sample * snapshot.stride + lane];
      if (byte !== 0 && byte !== 1) return null;
      result += byte * 2 ** bit;
    }
    return result;
  };
  let stage = 0;
  const fibonacci = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
  for (let sample = 1; sample < snapshot.ticks.length; sample++) {
    if (snapshot.ticks[sample] !== snapshot.ticks[sample - 1]! + 1 || value(sample - 1, 'CLK') !== 0 || value(sample, 'CLK') !== 1) continue;
    if (id === 'probe') return true;
    const before = (signal: Signal, expected: number): boolean => value(sample - 1, signal) === expected;
    const after = (signal: Signal, expected: number): boolean => value(sample, signal) === expected;
    if (id === 'fibonacci') {
      if (!before('/OI', 0)) continue;
      const out = value(sample, 'OUT');
      stage = out === fibonacci[stage] ? stage + 1 : out === 1 ? 1 : 0;
      if (stage === fibonacci.length) return true;
      continue;
    }
    if (!before('RESET', 1)) continue;
    if (id === 'register' && before('/IO', 0) && before('/AI', 0) && before('BUS', 3) && before('A', 0) && after('A', 3)) return true;
    const sumLoaded = before('/EU', 0) && before('/AI', 0) && before('A', 3) && before('B', 2) && before('SUM', 5) && before('BUS', 5) && after('A', 5);
    if (id === 'alu' && before('SU', 0) && sumLoaded) return true;
    const address = before('/CO', 0) && before('/MI', 0) && before('PC', id === 'memory' ? 0 : 1) && before('BUS_ADDR', id === 'memory' ? 0 : 1) && after('MAR', id === 'memory' ? 0 : 1);
    const fetch = before('/RO', 0) && before('/II', 0) && before('CE', 1) && before('BUS', id === 'memory' ? 0x53 : 0x2f) && after('PC', id === 'memory' ? 1 : 2) && after('OPCODE', id === 'memory' ? 5 : 2);
    if (id === 'memory') {
      if (address) stage = 1;
      else if (stage === 1 && before('MAR', 0) && fetch) return true;
    }
    if (id === 'microcode') {
      const rows = [
        before('T', 0) && address,
        before('T', 1) && before('MAR', 1) && fetch,
        before('T', 2) && before('OPCODE', 2) && before('/IO', 0) && before('/MI', 0) && before('BUS', 15) && after('MAR', 15),
        before('T', 3) && before('OPCODE', 2) && before('/RO', 0) && before('/BI', 0) && before('MAR', 15) && before('BUS', 2) && after('B', 2),
        before('T', 4) && before('OPCODE', 2) && before('/FI', 0) && sumLoaded,
      ];
      stage = rows[stage] ? stage + 1 : rows[0] ? 1 : 0;
      if (stage === rows.length) return true;
    }
  }
  return false;
}

export interface TutorialProgress { step: number; results: Array<'pending' | 'complete' | 'skipped'> }
export const TUTORIAL_STORAGE_KEY = 'bread.tutorial.v1';
type TutorialStorage = Pick<Storage, 'getItem' | 'setItem'>;
const emptyProgress = (): TutorialProgress => ({ step: 0, results: TUTORIAL_STEPS.map(() => 'pending') });

export function readTutorialProgress(storage: () => TutorialStorage = () => window.localStorage): TutorialProgress {
  try {
    const saved = JSON.parse(storage().getItem(TUTORIAL_STORAGE_KEY) ?? 'null') as TutorialProgress | null;
    if (saved && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < TUTORIAL_STEPS.length && Array.isArray(saved.results)
      && saved.results.length === TUTORIAL_STEPS.length && saved.results.every(result => ['pending', 'complete', 'skipped'].includes(result))) return saved;
  } catch { /* Storage is optional, including its getter and malformed JSON. */ }
  return emptyProgress();
}

export function saveTutorialProgress(progress: TutorialProgress, storage: () => TutorialStorage = () => window.localStorage): void {
  try { storage().setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(progress)); }
  catch { /* The tour keeps working in memory. */ }
}
