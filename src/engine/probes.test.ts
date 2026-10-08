import { describe, expect, it } from 'vitest';
import './index';
import eater from '../../examples/ben_eater_8bit.json';
import type { CircuitJSON, ProbeJSON } from './ir';
import { loadCircuit } from './loader';
import { ProbeCapture, type ProbeSequence } from './probes';
import { Simulator } from './sim';

const circuit: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'capture',
  components: [{ id: 'a', type: 'io.switch' }, { id: 'b', type: 'io.switch' }],
  nets: [{ id: 'a', endpoints: ['a.Y'] }, { id: 'b', endpoints: ['b.Y'] }],
};
const probes: ProbeJSON[] = [{ id: 'a', label: 'a', nets: ['a'] }, { id: 'bus', label: 'bus', nets: ['b', 'a'] }];

describe('bounded probe capture', () => {
  it('retains chronological four-state samples after wraparound, preserving LSB lane order', () => {
    const graph = loadCircuit(circuit); const capture = new ProbeCapture(probes, graph, 3);
    for (let tick = 0; tick < 5; tick++) capture.record(tick, Uint8Array.of(tick % 4, (tick + 1) % 4));
    const result = capture.snapshot();
    expect(Array.from(result.ticks)).toEqual([2, 3, 4]);
    expect(Array.from(result.values)).toEqual([2, 3, 2, 3, 0, 3, 0, 1, 0]);
    expect(result.stride).toBe(3); expect(result.capacity).toBe(3);
    result.probes[0]!.nets[0] = 'changed outside capture';
    capture.record(5, Uint8Array.of(1, 2));
    expect(capture.snapshot().probes[0]!.nets).toEqual(['a']);
    expect(Array.from(result.ticks)).toEqual([2, 3, 4]);
    expect(Array.from(capture.snapshot().ticks)).toEqual([3, 4, 5]);
  });
  it('replaces paused input changes at the current tick without consuming history', () => {
    const capture = new ProbeCapture(probes, loadCircuit(circuit), 2);
    capture.record(7, Uint8Array.of(0, 0)); capture.record(7, Uint8Array.of(1, 2));
    expect(Array.from(capture.snapshot().ticks)).toEqual([7]);
    expect(Array.from(capture.snapshot().values)).toEqual([1, 2, 1]);
    capture.record(8, Uint8Array.of(3, 0)); capture.record(8, Uint8Array.of(2, 1));
    expect(Array.from(capture.snapshot().ticks)).toEqual([7, 8]);
    expect(Array.from(capture.snapshot().values)).toEqual([1, 2, 1, 2, 1, 2]);
  });
  it('supports empty history and a one-sample ring', () => {
    const capture = new ProbeCapture(probes, loadCircuit(circuit), 1);
    expect(capture.snapshot().ticks).toHaveLength(0);
    capture.record(0, Uint8Array.of(0, 1)); capture.record(1, Uint8Array.of(2, 3));
    expect(Array.from(capture.snapshot().ticks)).toEqual([1]);
    expect(Array.from(capture.snapshot().values)).toEqual([2, 3, 2]);
    expect(() => new ProbeCapture(probes, loadCircuit(circuit), 0)).toThrow(/capacity/);
  });
  it('loads old version-1 files unchanged and validates saved probe references', () => {
    const old = loadCircuit(circuit);
    const saved = JSON.parse(JSON.stringify({ ...circuit, probes })) as CircuitJSON;
    expect(loadCircuit(saved).netById).toEqual(old.netById);
    expect(saved.probes).toEqual(probes);
    for (const invalid of [null, {}, [{ ...probes[0], nets: [] }], [{ ...probes[0], nets: ['missing'] }], [probes[0], probes[0]], [{ ...probes[0], label: '' }]]) {
      expect(() => loadCircuit({ ...circuit, probes: invalid as ProbeJSON[] })).toThrow(/Probe/);
    }
  });
  it('does not perturb any Fibonacci net byte or diagnostic, through reset and 4096 ticks', () => {
    const source = eater as CircuitJSON;
    const outputNets = Array.from({ length: 8 }, (_, bit) => `display__${bit < 4 ? 'nlo' : 'nhi'}${bit % 4}`);
    const watched: ProbeJSON[] = outputNets.map((net, bit) => ({ id: `p${bit}`, label: net, nets: [net] }));
    const plain = new Simulator(loadCircuit(source));
    const observed = new Simulator(loadCircuit({ ...source, probes: watched }));
    const capture = new ProbeCapture(watched, observed.graph);
    const compare = (tick: number): void => {
      capture.record(tick, observed.graph.netValues);
      expect(Buffer.compare(observed.graph.netValues, plain.graph.netValues)).toBe(0);
      expect(observed.eventsEmitted).toBe(plain.eventsEmitted);
    };
    compare(0); plain.settle(); observed.settle(); compare(0);
    plain.setComponentInput('sw_reset', 'Y', 1); observed.setComponentInput('sw_reset', 'Y', 1);
    plain.settle(); observed.settle(); compare(0);
    for (let tick = 1; tick <= 4096; tick++) { plain.tick(); observed.tick(); compare(tick); }
    expect(observed.events).toEqual(plain.events);
    expect(capture.snapshot().ticks).toHaveLength(4097);
  });
});

describe('incremental probe sequences', () => {
  const source: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'sequence',
    components: ['clock', 'enable', 'data'].map(id => ({ id, type: 'io.switch' })),
    nets: ['clock', 'enable', 'data'].map(id => ({ id, endpoints: [`${id}.Y`] })),
  };
  const lanes = source.nets.map(net => ({ id: net.id, label: net.id, nets: [net.id] }));
  const sequence: ProbeSequence = { id: 'sequence', clock: 'clock', enable: { net: 'enable', value: 0 }, nets: ['data'], values: [1, 1, 0] };
  const capture = (probes = lanes): ProbeCapture => new ProbeCapture(probes, loadCircuit(source), 2, [sequence]);

  it('counts both repeated loads, uses pre-edge enable, and preserves evidence through ring wrap and probe-only edits', () => {
    const first = capture();
    first.record(0, Uint8Array.of(0, 0, 0)); first.record(1, Uint8Array.of(1, 1, 1));
    first.record(2, Uint8Array.of(0, 0, 1)); first.record(3, Uint8Array.of(1, 1, 1));
    expect(first.snapshot().completedSequences).toEqual([]);
    const next = capture(); next.preserveSequences(first); next.record(3, Uint8Array.of(1, 1, 1));
    next.record(4, Uint8Array.of(0, 0, 1)); next.record(5, Uint8Array.of(1, 1, 0));
    expect(next.snapshot().completedSequences).toEqual(['sequence']);
    next.record(6, Uint8Array.of(0, 0, 0)); next.record(7, Uint8Array.of(1, 1, 1));
    expect(next.snapshot().completedSequences).toEqual(['sequence']);
    expect(Array.from(next.snapshot().ticks)).toEqual([6, 7]);
    expect(capture().snapshot().completedSequences).toEqual([]);
  });

  it.each([2, 3])('rejects X/Z output bytes (%i), disabled loads, and repeated-tick input changes', unknown => {
    const observed = capture();
    observed.record(0, Uint8Array.of(0, 0, 0)); observed.record(1, Uint8Array.of(1, 0, 1));
    observed.record(2, Uint8Array.of(0, 0, 1)); observed.record(3, Uint8Array.of(1, 0, unknown));
    observed.record(4, Uint8Array.of(0, 1, 1)); observed.record(5, Uint8Array.of(1, 0, 1));
    observed.record(6, Uint8Array.of(0, 0, 1)); observed.record(6, Uint8Array.of(1, 0, 1));
    observed.record(7, Uint8Array.of(0, 0, 1)); observed.record(8, Uint8Array.of(1, 0, 0));
    expect(observed.snapshot().completedSequences).toEqual([]);
  });

  it('does not combine evidence across missing ticks', () => {
    const observed = capture();
    observed.record(0, Uint8Array.of(0, 0, 0)); observed.record(1, Uint8Array.of(1, 0, 1));
    observed.record(4, Uint8Array.of(0, 0, 1)); observed.record(5, Uint8Array.of(1, 0, 1));
    observed.record(6, Uint8Array.of(0, 0, 1)); observed.record(7, Uint8Array.of(1, 0, 0));
    expect(observed.snapshot().completedSequences).toEqual([]);
  });

  it.each(['clock', 'enable', 'data'])('requires the %s lane to be probed and does not inherit evidence across its removal', missing => {
    const first = capture();
    first.record(0, Uint8Array.of(0, 0, 0)); first.record(1, Uint8Array.of(1, 0, 1));
    const incomplete = capture(lanes.filter(probe => probe.id !== missing)); incomplete.preserveSequences(first);
    const next = capture(); next.preserveSequences(incomplete);
    next.record(2, Uint8Array.of(0, 0, 1)); next.record(3, Uint8Array.of(1, 0, 1));
    next.record(4, Uint8Array.of(0, 0, 1)); next.record(5, Uint8Array.of(1, 0, 0));
    expect(incomplete.snapshot().completedSequences).toBeUndefined();
    expect(next.snapshot().completedSequences).toEqual([]);
  });
});
