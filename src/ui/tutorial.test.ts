import { describe, expect, it } from 'vitest';
import fibonacciBench from '../../examples/testbenches/sap1_fibonacci.json';
import '../engine/index';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import { ProbeCapture } from '../engine/probes';
import { Simulator } from '../engine/sim';
import { runTestbench, type TestbenchJSON } from '../engine/testbench';
import type { MetricsNotif } from '../worker/protocol';
import { pinProbe } from './probes';
import {
  readTutorialProgress, saveTutorialProgress, TUTORIAL_STEPS, TUTORIAL_STORAGE_KEY,
  TutorialClock, tutorialCircuit, tutorialComplete, type TutorialStepId,
} from './tutorial';

function machine(id: TutorialStepId, edit: (circuit: CircuitJSON) => void = () => {}) {
  const circuit = tutorialCircuit(id);
  if (id === 'probe') circuit.probes = [{ id: 'clk', ...pinProbe(circuit, 'reg_a.CLK', false) }];
  if (id === 'fibonacci') circuit.probes!.push({ id: 'out', ...pinProbe(circuit, 'display.OUT0', true) });
  edit(circuit);
  const sim = new Simulator(loadCircuit(circuit), { rateHz: 1000 }); sim.settle();
  let capture = new ProbeCapture(circuit.probes ?? [], sim.graph);
  let ticks = 0;
  const record = (): void => capture.record(ticks, sim.graph.netValues);
  record();
  return {
    circuit, sim,
    tick(count = 1): void { for (let n = 0; n < count; n++) { sim.tick(); ticks++; record(); } },
    release(): void { sim.setComponentInput('sw_reset', 'Y', 1); sim.settle(); record(); },
    force(net: string, value: 0 | 1 | 'X' | 'Z'): void { sim.setInput(net, value); sim.settle(); record(); },
    newRecording(): void { capture = new ProbeCapture(circuit.probes ?? [], sim.graph); record(); },
    snapshot: () => capture.snapshot(),
    metrics: (running: boolean): MetricsNotif => ({ type: 'metrics', running, ticks, targetRateHz: 1000, actualRateHz: running ? 1000 : 0 }),
  };
}

describe('tutorial completion from real SAP-1 state', () => {
  it('clock requires a paused rising edge, running ticks, and a final pause', () => {
    const h = machine('clock'); const clock = new TutorialClock();
    const observe = (running: boolean): void => clock.observe(h.metrics(running), h.sim.readNet('gated_clk'));
    observe(false); expect(tutorialComplete('clock', null, clock)).toBe(false);
    h.tick(); observe(false);
    expect(h.sim.readNet('gated_clk')).toBe(1);
    expect(tutorialComplete('clock', null, clock)).toBe(false);
    observe(true); observe(false); // Run/Pause without advancing time is insufficient.
    expect(tutorialComplete('clock', null, clock)).toBe(false);
    observe(true); h.tick(4); observe(true);
    expect(tutorialComplete('clock', null, clock)).toBe(false);
    observe(false); expect(tutorialComplete('clock', null, clock)).toBe(true);
  });

  it('running clock edges alone do not satisfy the manual clock step', () => {
    const h = machine('clock'); const clock = new TutorialClock();
    clock.observe(h.metrics(true), h.sim.readNet('gated_clk'));
    h.tick(5); clock.observe(h.metrics(false), h.sim.readNet('gated_clk'));
    expect(tutorialComplete('clock', null, clock)).toBe(false);
  });

  it('CLK probe must record a real rising edge on the CPU clock', () => {
    const h = machine('probe');
    expect(tutorialComplete('probe', h.snapshot())).toBe(false);
    h.tick(2); expect(tutorialComplete('probe', h.snapshot())).toBe(true);
    const wrong = machine('probe', circuit => { circuit.probes![0] = { id: 'clk', label: 'reg_a.CLK', nets: ['reset_low'] }; });
    wrong.tick(2); expect(tutorialComplete('probe', wrong.snapshot())).toBe(false);
    expect(tutorialComplete('probe', null)).toBe(false);
  });

  it('A loads 3 via the instruction bus and /AI on a rising edge', () => {
    const h = machine('register'); h.tick(8);
    expect(tutorialComplete('register', h.snapshot())).toBe(false); // Reset is still held.
    h.release(); h.tick(6);
    expect(tutorialComplete('register', h.snapshot())).toBe(true);
    expect(h.sim.readNet('av0')).toBe(1); expect(h.sim.readNet('av1')).toBe(1);
  });

  it('asserting /AI is necessary; a different immediate is not the lesson load', () => {
    const disabled = machine('register'); disabled.force('ctl_ai', 1); disabled.release(); disabled.tick(30);
    expect(tutorialComplete('register', disabled.snapshot())).toBe(false);
    const wrong = machine('register', circuit => { circuit.components.find(c => c.id === 'ram_chip')!.params = { contents: '59 F0' }; });
    wrong.release(); wrong.tick(30);
    expect(tutorialComplete('register', wrong.snapshot())).toBe(false);
  });

  it('ALU completion observes both operands, the sum on the bus, and the load into A', () => {
    const h = machine('alu'); h.release(); h.tick(18);
    expect(tutorialComplete('alu', h.snapshot())).toBe(false);
    h.tick(); expect(tutorialComplete('alu', h.snapshot())).toBe(true);
    expect(h.sim.readNet('av0')).toBe(1); expect(h.sim.readNet('av2')).toBe(1);
  });

  it('ALU rejects subtraction and a wrong B operand', () => {
    const sub = machine('alu'); sub.force('ctl_su', 1); sub.release(); sub.tick(30);
    expect(tutorialComplete('alu', sub.snapshot())).toBe(false);
    const wrong = machine('alu', circuit => {
      circuit.components.find(c => c.id === 'ram_chip')!.params = { contents: '53 2F E0 F0 00 00 00 00 00 00 00 00 00 00 00 04' };
    });
    wrong.release(); wrong.tick(30);
    expect(tutorialComplete('alu', wrong.snapshot())).toBe(false);
  });

  it('RAM and PC completion follows address transfer then fetch and increment', () => {
    const h = machine('memory'); h.release(); h.tick();
    expect(tutorialComplete('memory', h.snapshot())).toBe(false);
    h.tick(2); expect(tutorialComplete('memory', h.snapshot())).toBe(true);
    expect(h.sim.readNet('pc__qa')).toBe(1);
    const disabled = machine('memory'); disabled.force('ctl_ce', 0); disabled.release(); disabled.tick(30);
    expect(tutorialComplete('memory', disabled.snapshot())).toBe(false);
  });

  it('a RAM fetch without the recorded PC-to-MAR transfer is insufficient', () => {
    const h = machine('memory'); h.release(); h.tick(); h.newRecording(); h.tick(2);
    expect(h.sim.readNet('pc__qa')).toBe(1);
    expect(tutorialComplete('memory', h.snapshot())).toBe(false);
  });

  it('microcode must record all five ADD rows in order', () => {
    const h = machine('microcode'); h.release(); h.tick(18);
    expect(tutorialComplete('microcode', h.snapshot())).toBe(false);
    h.tick(); expect(tutorialComplete('microcode', h.snapshot())).toBe(true);
    const partial = machine('microcode'); partial.release(); partial.tick(14); partial.newRecording(); partial.tick(5);
    expect(tutorialComplete('microcode', partial.snapshot())).toBe(false);
  });

  it('microcode rejects a missing flags control even if A ends at 5', () => {
    const h = machine('microcode'); h.force('ctl_fi', 1); h.release(); h.tick(19);
    expect(h.sim.readNet('av0')).toBe(1); expect(h.sim.readNet('av2')).toBe(1);
    expect(tutorialComplete('microcode', h.snapshot())).toBe(false);
  });

  it('Fibonacci completion reads ordered OUT load edges, including both initial ones', () => {
    const h = machine('fibonacci');
    const result = runTestbench(h.circuit, fibonacciBench as TestbenchJSON, { capture: true });
    expect(result.passed).toBe(41);
    expect(tutorialComplete('fibonacci', result.waveform)).toBe(true);
    h.release(); h.tick(100);
    expect(tutorialComplete('fibonacci', h.snapshot())).toBe(false);
  });

  it('live Fibonacci also completes without the testbench runner', () => {
    const h = machine('fibonacci'); h.release(); h.tick(1200);
    expect(tutorialComplete('fibonacci', h.snapshot())).toBe(true);
  });

  it('OUT values without a bus probe or /OI edges cannot complete Fibonacci', () => {
    const noOut = machine('fibonacci', circuit => { circuit.probes = circuit.probes!.filter(probe => probe.id !== 'out'); });
    noOut.release(); noOut.tick(1200);
    expect(tutorialComplete('fibonacci', noOut.snapshot())).toBe(false);
    const noEnable = machine('fibonacci'); noEnable.force('ctl_oi', 1); noEnable.release(); noEnable.tick(1200);
    expect(tutorialComplete('fibonacci', noEnable.snapshot())).toBe(false);
  });

  it('unknown clock samples cannot satisfy a probe check', () => {
    const h = machine('probe'); h.force('gated_clk', 'X'); h.tick(4);
    expect(tutorialComplete('probe', h.snapshot())).toBe(false);
  });

  it('lesson setup keeps the bundled net topology and restores Fibonacci RAM in the final step', () => {
    const lesson = tutorialCircuit('register'); const final = tutorialCircuit('fibonacci');
    expect(lesson.nets).toEqual(final.nets);
    expect(lesson.components.find(c => c.id === 'ram_chip')!.params).toEqual({ contents: '53 2F E0 F0 00 00 00 00 00 00 00 00 00 00 00 02' });
    expect(final.components.find(c => c.id === 'ram_chip')!.params!.contents).toContain('50 4E 51 4F');
  });
});

describe('optional browser tutorial progress', () => {
  it('persists the current step and distinguishes checked, skipped and pending steps', () => {
    const values = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
    const progress = readTutorialProgress(storage);
    progress.step = 3; progress.results[0] = 'complete'; progress.results[1] = 'skipped';
    saveTutorialProgress(progress, storage);
    expect(readTutorialProgress(storage)).toEqual(progress);
    expect(values.has(TUTORIAL_STORAGE_KEY)).toBe(true);
  });

  it.each(['null', '{', '{"step":99,"results":[]}', '{"step":0,"results":["complete"]}'])('ignores invalid storage: %s', saved => {
    expect(readTutorialProgress(() => ({ getItem: () => saved, setItem: () => {} }))).toEqual({ step: 0, results: TUTORIAL_STEPS.map(() => 'pending') });
  });

  it('works when the storage getter, read or write throws', () => {
    const unavailable = () => { throw new Error('denied'); };
    const broken = () => ({ getItem: unavailable, setItem: unavailable });
    expect(readTutorialProgress(unavailable).step).toBe(0);
    expect(readTutorialProgress(broken).step).toBe(0);
    expect(() => saveTutorialProgress(readTutorialProgress(unavailable), unavailable)).not.toThrow();
    expect(() => saveTutorialProgress(readTutorialProgress(broken), broken)).not.toThrow();
  });
});
