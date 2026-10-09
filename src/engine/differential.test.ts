import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './behavioral/index';
import '../stdlib/index';
import { getBehavioral } from './behavioral/registry';
import { ReferenceSimulator } from './__fixtures__/reference-sim';
import type { CircuitJSON, ComponentInstanceJSON, DriverValue, NetState } from './ir';
import { loadCircuit } from './loader';
import { getPrimitive, registerPrimitive } from './primitives/registry';
import { Simulator, type SimEvent } from './sim';

registerPrimitive('prim.DIFFERENTIAL_INOUT', {
  pins: () => [{ name: 'A', dir: 'in' }, { name: 'IO', dir: 'inout' }, { name: 'Y', dir: 'out' }],
  tickActive: true,
  init: () => ({ calls: 0, last: 'Z' as NetState }),
  evaluate(ins, outs, state, _params, ctx) {
    outs[0] = ins[0] === 1 ? ins[1]! : 'Z';
    outs[1] = (ctx!.step & 1) ? ins[1]! : ins[0]!;
    return { calls: state.calls + 1, last: ins[1]! };
  },
});

function randomCircuit(seed: number) {
  let word = seed;
  const random = (limit: number) => {
    word ^= word << 13; word ^= word >>> 17; word ^= word << 5;
    return (word >>> 0) % limit;
  };
  const circuit: CircuitJSON = {
    version: 1, kind: 'circuit', name: `differential-${seed}`,
    components: [
      { id: 'ring', type: 'prim.NAND', params: { inputs: 2 } },
      ...['i1', 'i2'].map(id => ({ id, type: 'prim.NOT' })),
      { id: 'low', type: 'prim.CONST_0' }, { id: 'high', type: 'prim.CONST_1' },
      { id: 'up', type: 'prim.PULLUP' }, { id: 'down', type: 'prim.PULLDOWN' },
      { id: 'busUp', type: 'prim.PULLUP' },
      { id: 'tri0', type: 'prim.TRISTATE' }, { id: 'tri1', type: 'prim.TRISTATE' },
      { id: 'floating', type: 'prim.BUF' },
      { id: 'switch', type: 'io.switch' },
      { id: 'clock', type: 'gen.clock', params: { freqHz: 1 + random(4) } },
      { id: 'inout', type: 'prim.DIFFERENTIAL_INOUT' },
    ],
    nets: [
      { id: 'enable', endpoints: ['ring.A'] },
      { id: 'node0', endpoints: ['ring.Y', 'i1.A'] },
      { id: 'node1', endpoints: ['i1.Y', 'i2.A'] },
      { id: 'node2', endpoints: ['i2.Y', 'ring.B'] },
      { id: 'conflict', endpoints: ['low.Y', 'high.Y'] },
      { id: 'weakFight', endpoints: ['up.Y', 'down.Y'] },
      { id: 'bus', endpoints: ['tri0.Y', 'tri1.Y', 'busUp.Y', 'inout.IO'] },
      { id: 'data0', endpoints: ['tri0.A'] }, { id: 'data1', endpoints: ['tri1.A'] },
      { id: 'oe0', endpoints: ['tri0.OE'] }, { id: 'oe1', endpoints: ['tri1.OE'] },
      { id: 'inoutEnable', endpoints: ['inout.A'] },
    ],
  };
  const pool = Array.from({ length: 12 + random(16) }, (_, i) => ({ id: `random${i}`, endpoints: [] as string[] }));
  const catalog: Array<Omit<ComponentInstanceJSON, 'id'>> = [
    ...['AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR'].map(gate => ({ type: `prim.${gate}`, params: { inputs: 1 + random(6) } })),
    ...['NOT', 'BUF', 'LATCH', 'CONST_0', 'CONST_1', 'PULLUP', 'PULLDOWN'].map(gate => ({ type: `prim.${gate}` })),
    { type: 'prim.DFF', params: { initialQ: random(2), enable: true, verilogData: true, clrActiveLow: true, preActiveLow: true } },
    { type: 'prim.DFF', params: {} },
    { type: 'prim.TRISTATE', params: { oeActiveLow: true } },
    { type: 'prim.MUX2', params: { width: 1 + random(3) } },
    { type: 'prim.DEMUX2', params: { width: 1 + random(5) } },
    { type: 'prim.DECODER', params: { bits: 1 + random(4), activeLow: random(2) === 1 } },
    { type: 'prim.ADDER', params: { width: 1 + random(3) } },
    { type: 'mem.6116', params: { contents: 'a5 5a' } },
    { type: 'mem.28C16', params: { contents: '3c c3' } },
    { type: 'mem.74LS189' }, { type: 'prim.DIFFERENTIAL_INOUT' },
  ];
  // Random wiring includes feedback, fan-out, multiple drivers, repeated
  // input nets and unwired pins; the isolated witnesses guarantee that the
  // corpus actually exercises oscillation, contention, weak fights and Z.
  for (let i = 0; i < catalog.length + 8; i++) {
    const inst = { ...catalog[i < catalog.length ? i : random(catalog.length)]!, id: `c${i}` };
    circuit.components.push(inst);
    const def = getPrimitive(inst.type) ?? getBehavioral(inst.type)!;
    for (const pin of def.pins(inst.params ?? {})) {
      if (random(8) !== 0) pool[random(pool.length)]!.endpoints.push(`${inst.id}.${pin.name}`);
    }
  }
  circuit.nets.push(...pool.filter(net => net.endpoints.length));
  return { circuit, random, pool: pool.filter(net => net.endpoints.length).map(net => net.id) };
}

describe('f6c3595 scheduler differential', () => {
  it.each(Array.from({ length: 64 }, (_, i) => i + 1))('matches every net, state, driver and event for random circuit seed %i', seed => {
    const { circuit, random, pool } = randomCircuit(seed);
    const beforeEvents: SimEvent[] = [];
    const afterEvents: SimEvent[] = [];
    const before = new ReferenceSimulator(loadCircuit(circuit), { maxIterations: 32, onEvent: event => beforeEvents.push(event) });
    const after = new Simulator(loadCircuit(circuit), { maxIterations: 32, onEvent: event => afterEvents.push(event) });
    const values: DriverValue[] = [0, 1, 'Z', 'X', 'L', 'H'];
    let eventCursor = 0;
    const compare = (where: string, settled = true) => {
      assert.deepEqual(after.graph.netValues, before.graph.netValues, where);
      if (settled) {
        assert.deepEqual(after.graph.components.map(c => c.outputBuf), before.graph.components.map(c => c.outputBuf), where);
        assert.deepEqual(after.graph.components.map(c => c.state), before.graph.components.map(c => c.state), where);
        assert.deepEqual(after.events, before.events, where);
      }
      assert.deepEqual(afterEvents.slice(eventCursor), beforeEvents.slice(eventCursor), where);
      eventCursor = beforeEvents.length;
      assert.equal(after.step, before.step, where);
      assert.equal(after.eventsEmitted, before.eventsEmitted, where);
    };
    const drive = (net: string, value: DriverValue) => {
      before.setInput(net, value); after.setInput(net, value);
      compare(`seed ${seed}, immediate drive ${net}=${value}`, false);
    };
    drive('enable', 0);
    drive('data0', 0); drive('data1', 1);
    drive('oe0', 0); drive('oe1', 0);
    drive('inoutEnable', 0);
    if (seed & 1) { before.settle(); after.settle(); }
    else { before.tick(); after.tick(); }
    compare('power-on');
    expect(after.readNet('weakFight')).toBe('X');
    expect(after.readNet('__floating__floating__A')).toBe('Z');
    for (let tick = 0; tick < 256; tick++) {
      // Force both generation counters through uint32 rollover without
      // changing which components/nets their existing marks designate.
      if (tick === 32) {
        for (const [counter, bitmap] of [['dirtyGeneration', 'inDirty'], ['contentionGeneration', 'contendedThisSettle']]) {
          const generation = Reflect.get(after, counter!) as number;
          const marks = Reflect.get(after, bitmap!) as Uint32Array;
          marks.forEach((mark, i) => { if (mark === generation) marks[i] = 0xffffffff; });
          Reflect.set(after, counter!, 0xffffffff);
        }
      }
      drive('enable', tick % 4 === 0 ? 0 : 1);
      drive('oe0', values[tick % values.length]!);
      drive('oe1', values[(tick + 1) % values.length]!);
      drive('inoutEnable', (tick & 1) as 0 | 1);
      for (let n = 0; n < 1 + random(3); n++) drive(pool[random(pool.length)]!, values[random(values.length)]!);
      const switchValue = values[random(4)] as NetState;
      before.setComponentInput('switch', 'Y', switchValue); after.setComponentInput('switch', 'Y', switchValue);
      before.rateHz = after.rateHz = 1 + random(16);
      if (tick % 5 === 0) { before.settle(); after.settle(); compare(`paused settle ${tick}`); }
      before.tick(); after.tick();
      compare(`tick ${tick}`);
    }
    expect(afterEvents.some(event => event.kind === 'contention')).toBe(true);
    expect(afterEvents.some(event => event.kind === 'oscillation')).toBe(true);
  });
});

registerPrimitive('prim.DIFFERENTIAL_DRIVER', {
  pins: () => [{ name: 'EN', dir: 'in' }, { name: 'Y', dir: 'out' }],
  evaluate(ins, outs, _state: undefined, params: { value: DriverValue }) {
    outs[0] = ins[0] === 1 ? params.value : 'Z';
    return undefined;
  },
});

it('matches the old resolver for all 64 driver-presence masks and every external force', () => {
  const values: DriverValue[] = [0, 1, 'Z', 'X', 'L', 'H'];
  const circuit: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'all-resolution-masks',
    components: values.map((value, i) => ({ id: `d${i}`, type: 'prim.DIFFERENTIAL_DRIVER', params: { value } })),
    nets: [{ id: 'bus', endpoints: values.map((_, i) => `d${i}.Y`) }, ...values.map((_, i) => ({ id: `en${i}`, endpoints: [`d${i}.EN`] }))],
  };
  const oldEvents: SimEvent[] = [], newEvents: SimEvent[] = [];
  const before = new ReferenceSimulator(loadCircuit(circuit), { onEvent: event => oldEvents.push(event) });
  const after = new Simulator(loadCircuit(circuit), { onEvent: event => newEvents.push(event) });
  for (let mask = 0; mask < 64; mask++) {
    for (let i = 0; i < values.length; i++) {
      const enable = ((mask >>> i) & 1) as 0 | 1;
      before.setInput(`en${i}`, enable); after.setInput(`en${i}`, enable);
    }
    for (const force of values) {
      before.setInput('bus', force); after.setInput('bus', force);
      assert.deepEqual(after.graph.netValues, before.graph.netValues);
      before.settle(); after.settle();
      assert.deepEqual(after.graph.netValues, before.graph.netValues);
      assert.deepEqual(newEvents, oldEvents);
    }
  }
});

it('preserves held driver buffers, direct forces and dispatch changes through graph views', () => {
  const circuit: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'driver-views',
    components: [{ id: 'buffer', type: 'prim.BUF' }],
    nets: [{ id: 'in', endpoints: ['buffer.A'] }, { id: 'out', endpoints: ['buffer.Y'] }],
  };
  const before = new ReferenceSimulator(loadCircuit(circuit)), after = new Simulator(loadCircuit(circuit));
  const oldBuffer = before.graph.components[0]!.outputBuf;
  const newBuffer = after.graph.components[0]!.outputBuf;
  for (const sim of [before, after]) {
    sim.setInput('in', 0); sim.settle();
    sim.graph.components[0]!.outputBuf[0] = 1;
    sim.setInput('in', 1); sim.setInput('in', 0); sim.settle();
  }
  assert.deepEqual(newBuffer, oldBuffer);
  expect(newBuffer).toEqual([0]);
  for (const sim of [before, after]) {
    sim.graph.nets[1]!.forced = 1;
    sim.setInput('in', 1); sim.settle();
    sim.graph.components[0]!.evalKind = 7; // NOT through normal dispatch
    sim.setInput('in', 0); sim.settle();
    sim.graph.components[0]!.evalKind = 8; // restore BUF after fallback
    sim.setInput('in', 1); sim.setInput('in', 0); sim.settle();
  }
  assert.deepEqual(after.graph.netValues, before.graph.netValues);
  assert.deepEqual(newBuffer, oldBuffer);
  assert.deepEqual(after.events, before.events);
  expect(newBuffer).toEqual([0]);
});

it.each(['ben_eater_8bit', 'sap1_count_up', 'original_digital_cpu_generated'])('matches the frozen scheduler throughout 1,024 active ticks of %s', example => {
  const circuit = JSON.parse(readFileSync(new URL(`../../examples/${example}.json`, import.meta.url), 'utf8')) as CircuitJSON;
  const large = example === 'original_digital_cpu_generated';
  if (large) {
    // LDAi 1; LDBi 1; ADD; OUT; JMP 4 keeps the larger CPU active.
    circuit.components.find(comp => comp.id === 'v82')!.params!.contents = '02 01 04 01 06 1e 08 04';
  }
  const oldEvents: SimEvent[] = [], newEvents: SimEvent[] = [];
  const before = new ReferenceSimulator(loadCircuit(circuit), { rateHz: large ? 100 : 1, onEvent: event => oldEvents.push(event) });
  const after = new Simulator(loadCircuit(circuit), { rateHz: large ? 100 : 1, onEvent: event => newEvents.push(event) });
  let eventCursor = 0;
  const compare = (where: string) => {
    assert.deepEqual(after.graph.netValues, before.graph.netValues, where);
    assert.deepEqual(after.graph.components.map(comp => comp.outputBuf), before.graph.components.map(comp => comp.outputBuf), where);
    assert.deepEqual(after.graph.components.map(comp => comp.state), before.graph.components.map(comp => comp.state), where);
    assert.deepEqual(after.events, before.events, where);
    assert.deepEqual(newEvents.slice(eventCursor), oldEvents.slice(eventCursor), where);
    assert.equal(after.eventsEmitted, before.eventsEmitted, where);
    assert.equal(after.step, before.step, where);
    eventCursor = oldEvents.length;
  };
  for (const sim of [before, after]) {
    sim.settle();
    if (!large) { sim.setComponentInput('sw_reset', 'Y', 1); sim.settle(); }
  }
  compare('power-on/reset');
  for (let tick = 0; tick < 1024; tick++) {
    // Repeated empty settlements must not replay stale FIFO entries or clock edges.
    if (tick % 17 === 0) { before.settle(); after.settle(); compare(`paused ${tick}`); }
    before.tick(); after.tick();
    compare(`tick ${tick}`);
  }
});

it('matches the frozen evaluator across every compiled input arity and all eight output slots', () => {
  const instances: ComponentInstanceJSON[] = [
    { id: 'source', type: 'prim.CONST_0' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `gate${i + 1}`, type: 'prim.NAND', params: { inputs: i + 1 } })),
    { id: 'dff2', type: 'prim.DFF', params: { verilogData: true } },
    { id: 'dff3', type: 'prim.DFF', params: { enable: true } },
    { id: 'dff4', type: 'prim.DFF', params: { clrActiveLow: true, preActiveLow: true } },
    { id: 'dff5', type: 'prim.DFF', params: { enable: true, clrActiveLow: true, preActiveLow: true, verilogData: true } },
    { id: 'decoder', type: 'prim.DECODER', params: { bits: 3 } },
    { id: 'demux', type: 'prim.DEMUX2', params: { width: 3 } },
    { id: 'adder', type: 'prim.ADDER', params: { width: 7 } },
  ];
  const inputs = Array.from({ length: 5 }, (_, i) => ({ id: `input${i}`, endpoints: [] as string[] }));
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'compiled-arities', components: instances, nets: inputs };
  for (const inst of instances) {
    let slot = 0;
    for (const pin of getPrimitive(inst.type)!.pins(inst.params ?? {})) {
      if (pin.dir === 'in') inputs[slot++ % inputs.length]!.endpoints.push(`${inst.id}.${pin.name}`);
      else circuit.nets.push({ id: `${inst.id}_${pin.name}`, endpoints: [`${inst.id}.${pin.name}`] });
    }
  }
  const before = new ReferenceSimulator(loadCircuit(circuit)), after = new Simulator(loadCircuit(circuit));
  const values: NetState[] = [0, 1, 'Z', 'X'];
  const drivers: DriverValue[] = [0, 1, 'Z', 'X', 'L', 'H', '0Z', '1Z'];
  const compare = (tick: number) => {
    assert.deepEqual(after.graph.netValues, before.graph.netValues, `nets at tick ${tick}`);
    assert.deepEqual(after.graph.components.map(comp => comp.outputBuf), before.graph.components.map(comp => comp.outputBuf), `drivers at tick ${tick}`);
    assert.deepEqual(after.graph.components.map(comp => comp.state), before.graph.components.map(comp => comp.state), `states at tick ${tick}`);
    assert.deepEqual(after.events, before.events, `events at tick ${tick}`);
    assert.equal(after.eventsEmitted, before.eventsEmitted);
    assert.equal(after.step, before.step);
  };
  before.settle(); after.settle(); compare(-1);
  // Two exhaustive sweeps of all 4^5 inputs. The second reverses the
  // trajectory to exercise different previous-clock/Q combinations.
  for (let tick = 0; tick < 2048; tick++) {
    const vector = tick < 1024 ? tick : 2047 - tick;
    for (let pin = 0; pin < inputs.length; pin++) {
      const value = values[(vector >>> (pin * 2)) & 3]!;
      before.setInput(inputs[pin]!.id, value); after.setInput(inputs[pin]!.id, value);
    }
    if (tick % 13 === 0) {
      // Mutable graph views must keep the packed word in sync, including
      // weak/uncertain drivers and the top nibble of an eight-output leaf.
      for (const sim of [before, after]) {
        for (const comp of sim.graph.components) {
          for (let pin = 0; pin < comp.outputBuf.length; pin++) comp.outputBuf[pin] = drivers[(tick + pin) & 7]!;
          sim.setComponentInput(comp.id, 'differentialWake', (tick & 1) as 0 | 1);
        }
        sim.settle();
      }
      compare(tick);
    }
    before.tick(); after.tick(); compare(tick);
  }
});

it('matches the frozen scheduler when a contention observer mutates state during settle', () => {
  const circuit: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'observer-state-differential',
    components: [
      { id: 'zero', type: 'prim.CONST_0' }, { id: 'buf', type: 'prim.BUF' },
      { id: 'switch', type: 'io.switch' },
    ],
    nets: [
      { id: 'input', endpoints: ['zero.Y', 'buf.A'] },
      { id: 'fight', endpoints: ['buf.Y'] },
      { id: 'signal', endpoints: ['switch.Y'] },
    ],
  };
  const run = (Sim: typeof Simulator | typeof ReferenceSimulator) => {
    const delivered: SimEvent[] = [];
    const sim = new Sim(loadCircuit(circuit), { onEvent: event => {
      delivered.push(event);
      if (event.kind === 'contention') sim.setComponentInput('switch', 'Y', 1);
    } });
    sim.setInput('fight', 1);
    sim.settle();
    const first = sim.readNet('signal');
    sim.settle();
    sim.tick();
    return {
      first, nets: sim.graph.netValues,
      drivers: sim.graph.components.map(comp => comp.outputBuf),
      states: sim.graph.components.map(comp => comp.state),
      events: sim.events, delivered, step: sim.step,
    };
  };
  const before = run(ReferenceSimulator);
  expect(before.first).toBe(1);
  expect(before.delivered).toHaveLength(1);
  expect(run(Simulator)).toEqual(before);
});
