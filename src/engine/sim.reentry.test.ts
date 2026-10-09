import { describe, expect, it } from 'vitest';
import './behavioral/index';
import { CallbackReferenceSimulator } from './__fixtures__/callback-reference-sim';
import type { CircuitJSON, RuntimeGraph } from './ir';
import { loadCircuit } from './loader';
import { Simulator, type SimEvent, type SimulatorOptions } from './sim';

type Sim = Simulator | CallbackReferenceSimulator;
type SimConstructor = new (graph: RuntimeGraph, options?: SimulatorOptions) => Sim;
type Checkpoint = (label: string) => void;
interface Scenario {
  circuit: CircuitJSON;
  options?: Omit<SimulatorOptions, 'onEvent'>;
  observer?: (sim: Sim, event: SimEvent, checkpoint: Checkpoint) => void;
  prepare?: (graph: RuntimeGraph, sim: () => Sim, checkpoint: Checkpoint) => void;
  drive: (sim: Sim, checkpoint: Checkpoint) => void;
}

function snapshot(sim: Sim, delivered: SimEvent[]) {
  return structuredClone({
    nets: sim.graph.nets.map(net => ({ id: net.id, value: net.value, forced: net.forced })),
    components: sim.graph.components.map(comp => ({
      id: comp.id, state: comp.state, outputs: Array.from(comp.outputBuf),
    })),
    events: sim.events, delivered, eventsEmitted: sim.eventsEmitted,
    step: sim.step, tickStep: Reflect.get(sim, 'tickStep'), rateHz: sim.rateHz,
  });
}

function run(Constructor: SimConstructor, scenario: Scenario) {
  const graph = loadCircuit(scenario.circuit);
  const delivered: SimEvent[] = [];
  const trace: Array<{ label: string; snapshot: ReturnType<typeof snapshot> }> = [];
  let sim: Sim;
  const checkpoint: Checkpoint = label => trace.push({ label, snapshot: snapshot(sim, delivered) });
  scenario.prepare?.(graph, () => sim, checkpoint);
  sim = new Constructor(graph, { ...scenario.options, onEvent: event => {
    delivered.push(event);
    checkpoint(`observer ${event.kind}: enter`);
    scenario.observer?.(sim, event, checkpoint);
    checkpoint(`observer ${event.kind}: return`);
  } });
  checkpoint('power-on');
  scenario.drive(sim, checkpoint);
  checkpoint('finished');
  return trace;
}

function compare(scenario: Scenario) {
  const reference = run(CallbackReferenceSimulator, scenario);
  const actual = run(Simulator, scenario);
  expect(actual.map(point => point.label)).toEqual(reference.map(point => point.label));
  for (let i = 0; i < reference.length; i++) {
    expect(actual[i]!.snapshot, reference[i]!.label).toEqual(reference[i]!.snapshot);
  }
  return reference;
}

const observerCircuit: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'callback-differential',
  components: [
    { id: 'zero', type: 'prim.CONST_0' }, { id: 'buf', type: 'prim.BUF' },
    { id: 'sw', type: 'io.switch' }, { id: 'peer', type: 'io.switch' },
    { id: 'a', type: 'prim.BUF' }, { id: 'b', type: 'prim.BUF' },
    { id: 'clock', type: 'gen.clock', params: { freqHz: 1 } },
    { id: 'high', type: 'prim.CONST_1' },
    { id: 'ff', type: 'prim.DFF', params: { initialQ: 0 } },
  ],
  nets: [
    { id: 'input', endpoints: ['zero.Y', 'buf.A'] },
    { id: 'fight', endpoints: ['buf.Y'] },
    { id: 'signal', endpoints: ['sw.Y'] }, { id: 'peer', endpoints: ['peer.Y'] },
    { id: 'forced', endpoints: ['a.A', 'b.A'] },
    { id: 'a_out', endpoints: ['a.Y'] }, { id: 'b_out', endpoints: ['b.Y'] },
    { id: 'clock', endpoints: ['clock.Y', 'ff.CLK'] },
    { id: 'data', endpoints: ['high.Y', 'ff.D'] },
    { id: 'q', endpoints: ['ff.Q'] }, { id: 'qn', endpoints: ['ff.Qn'] },
  ],
};

describe('Simulator: bf70267 callback and re-entrancy differential', () => {
  it('preserves two synchronous ticks and the intervening DFF edge from a contention observer', () => {
    const circuit = structuredClone(observerCircuit);
    circuit.nets[1] = { id: 'fight', endpoints: ['buf.Y', 'sw.Y'] };
    circuit.nets.splice(2, 1);
    const trace = compare({
      circuit, options: { rateHz: 2 },
      observer(sim, event, checkpoint) {
        if (event.kind !== 'contention') return;
        sim.tick(); checkpoint('first nested tick');
        sim.tick(); checkpoint('second nested tick');
      },
      drive(sim, checkpoint) {
        sim.settle(); checkpoint('initial settle');
        sim.setComponentInput('sw', 'Y', 1); checkpoint('queue contention');
        sim.settle(); checkpoint('outer settle');
        sim.settle(); checkpoint('empty retry');
      },
    });
    for (const [label, clock] of [['first nested tick', 1], ['second nested tick', 0]] as const) {
      const point = trace.find(point => point.label === label)!.snapshot;
      expect(point.nets.find(net => net.id === 'clock')!.value).toBe(clock);
      expect(point.nets.find(net => net.id === 'q')!.value).toBe(1);
    }
  });

  it.each(['enqueue', 'settle', 'tick', 'mutate'] as const)(
    'preserves the overflow repro and every immediate observer checkpoint with %s', action => {
      let handled = false;
      const scenario: Scenario = {
        circuit: observerCircuit, options: { rateHz: 2 },
        prepare() { handled = false; },
        observer(sim, event, checkpoint) {
          if (event.kind !== 'contention' || handled) return;
          handled = true;
          sim.setComponentInput('sw', 'Y', 1); checkpoint('observer switch');
          if (action === 'enqueue') return;
          sim.setInput('forced', 1); checkpoint('observer force');
          for (const comp of sim.graph.components) sim.setComponentInput(comp.id, 'wake', 1);
          checkpoint('observer full batch');
          if (action === 'mutate') {
            sim.graph.components[3]!.state = { Y: 1 };
            sim.graph.components[3]!.outputBuf[0] = 1;
            sim.graph.nets.find(net => net.id === 'forced')!.forced = 0;
            sim.rateHz = 4;
            checkpoint('observer graph mutation');
          } else {
            sim[action](); checkpoint(`observer nested ${action}`);
          }
          sim.setComponentInput('sw', 'Y', 0); checkpoint('observer toggle low');
          sim.setComponentInput('sw', 'Y', 1); checkpoint('observer toggle high');
        },
        drive(sim, checkpoint) {
          sim.setInput('fight', 1); checkpoint('force before first settle');
          sim.settle(); checkpoint('first settle');
          sim.settle(); checkpoint('retry');
          sim.tick(); checkpoint('following tick');
        },
      };
      const trace = compare(scenario);
      expect(trace.find(point => point.label === 'first settle')!.snapshot.nets
        .find(net => net.id === 'signal')!.value).toBe(1);
    },
  );

  it.each(['settle', 'tick'] as const)('preserves a nested %s called by setInput outside settle', method => {
    let handled = false;
    compare({
      circuit: observerCircuit, options: { rateHz: 2 },
      prepare() { handled = false; },
      observer(sim, event, checkpoint) {
        if (event.kind !== 'contention' || handled) return;
        handled = true;
        sim.setInput('forced', 1); checkpoint('external observer force');
        sim.setComponentInput('sw', 'Y', 1); checkpoint('external observer switch');
        sim[method](); checkpoint('external observer nested return');
      },
      drive(sim, checkpoint) {
        sim.settle(); checkpoint('initial settle');
        sim.setInput('fight', 1); checkpoint('setInput observer return');
        sim.settle(); checkpoint('following settle');
      },
    });
  });

  it.each(['enqueue', 'settle', 'tick', 'throw'] as const)(
    'preserves READ evaluator state, synchronous callbacks and retry with %s', action => {
      compare({
        circuit: observerCircuit, options: { rateHz: 2 },
        prepare(graph, getSim, checkpoint) {
          const comp = graph.components[2]!;
          const original = comp.primitive.evaluate;
          let armed = true;
          comp.primitive = { ...comp.primitive, evaluate(...args) {
            const result = original(...args);
            if (!armed) return result;
            armed = false;
            const sim = getSim();
            checkpoint('READ before callback');
            sim.setComponentInput('sw', 'Y', 1);
            sim.setComponentInput('peer', 'Y', 1);
            sim.setInput('forced', 1); checkpoint('READ queued inputs');
            if (action === 'settle') sim.settle();
            if (action === 'tick') { sim.tick(); checkpoint('READ first tick'); sim.tick(); }
            checkpoint('READ callback return');
            if (action === 'throw') throw new Error('one-time READ error');
            return result;
          } };
        },
        drive(sim, checkpoint) {
          if (action === 'throw') expect(() => sim.settle()).toThrow('one-time READ error');
          else sim.settle();
          checkpoint('first READ outcome');
          sim.settle(); checkpoint('READ retry');
          sim.tick(); checkpoint('READ following tick');
        },
      });
    },
  );

  it.each([0, 1])('retries pending switch updates after evaluator %i throws once', index => {
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'evaluator-retry',
      components: [{ id: 'a', type: 'io.switch' }, { id: 'b', type: 'io.switch' }],
      nets: [{ id: 'a', endpoints: ['a.Y'] }, { id: 'b', endpoints: ['b.Y'] }],
    };
    let armed = false;
    const trace = compare({
      circuit,
      prepare(graph, _getSim, checkpoint) {
        armed = false;
        const comp = graph.components[index]!;
        const original = comp.primitive.evaluate;
        comp.primitive = { ...comp.primitive, evaluate(...args) {
          if (armed) {
            armed = false;
            checkpoint('evaluator throws');
            throw new Error('one-time evaluator error');
          }
          return original(...args);
        } };
      },
      drive(sim, checkpoint) {
        sim.settle(); checkpoint('initial settle');
        sim.setComponentInput('a', 'Y', 1);
        sim.setComponentInput('b', 'Y', 1); checkpoint('both updates queued');
        armed = true;
        expect(() => sim.settle()).toThrow('one-time evaluator error');
        checkpoint('after evaluator error');
        sim.settle(); checkpoint('evaluator retry');
        sim.tick(); checkpoint('retry following tick');
      },
    });
    expect(trace.at(-1)!.snapshot.nets.map(net => net.value)).toEqual([1, 1]);
  });

  it.each(['contention', 'oscillation'] as const)('preserves queued work and event order when a %s observer throws once', kind => {
    let handled = false;
    compare({
      circuit: observerCircuit, options: { maxIterations: kind === 'oscillation' ? 1 : 100, rateHz: 2 },
      prepare() { handled = false; },
      observer(sim, event, checkpoint) {
        if (event.kind !== kind || handled) return;
        handled = true;
        sim.setComponentInput('sw', 'Y', 1);
        sim.setComponentInput('peer', 'Y', 1); checkpoint('throwing observer queued work');
        throw new Error('one-time observer error');
      },
      drive(sim, checkpoint) {
        if (kind === 'contention') sim.setInput('fight', 1);
        expect(() => sim.settle()).toThrow('one-time observer error');
        checkpoint('after observer error');
        sim.settle(); checkpoint('observer retry');
        sim.tick(); checkpoint('observer following tick');
      },
    });
  });

  it('preserves re-entrant oscillation callbacks and their immediate state updates', () => {
    let handled = false;
    compare({
      circuit: observerCircuit, options: { maxIterations: 1 },
      prepare() { handled = false; },
      observer(sim, event, checkpoint) {
        if (event.kind !== 'oscillation' || handled) return;
        handled = true;
        sim.setComponentInput('sw', 'Y', 1); checkpoint('oscillation queued switch');
        sim.settle(); checkpoint('oscillation nested return');
      },
      drive(sim, checkpoint) {
        sim.settle(); checkpoint('oscillation outer return');
        sim.settle(); checkpoint('oscillation retry');
        sim.tick(); checkpoint('oscillation following tick');
      },
    });
  });
});
