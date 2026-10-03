import { describe, expect, it, vi } from 'vitest';
import '../engine/index';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import type { LoadSnapshot, WorkerBus } from './bus';
import { EditorModel } from './editor';
import { busPairs, formatSignalBits, numberedPins } from './signals';
import { runtimeSignalNet } from './inspector/signals';

const fixture = (): CircuitJSON => ({
  version: 1, kind: 'circuit', name: 'byte-bus',
  components: [
    { id: 'source', type: 'mem.ROM', params: { addressBits: 2, dataBits: 8, contents: '2A' } },
    { id: 'target', type: 'prim.MUX2', params: { width: 8 } },
    { id: 'fanout', type: 'prim.MUX2', params: { width: 8 } },
  ], nets: [],
});
const snapshot = (circuit: CircuitJSON): LoadSnapshot => {
  const graph = loadCircuit(circuit); const netIds = graph.nets.map((net) => net.id);
  return { netIds, componentIds: graph.components.map((c) => c.id), netIndex: new Map(netIds.map((id, i) => [id, i])), netsView: new Uint8Array(netIds.length) };
};
const model = () => {
  const circuit = fixture();
  const mutate = vi.fn(async (next: CircuitJSON) => snapshot(next));
  const bus = { mutate, setNetInput: async () => {} } as unknown as WorkerBus;
  return { editor: new EditorModel(bus, circuit, snapshot(circuit)), mutate };
};

describe('public bus connections', () => {
  it('uses numeric bit significance, not pin declaration order', () => {
    const circuit = fixture();
    expect(numberedPins(circuit, 'source.D0').endpoints).toEqual(Array.from({ length: 8 }, (_, i) => `source.D${i}`));
    expect(busPairs(circuit, 'source.D0', 'target.A0', 8)[7]).toEqual(['source.D7', 'target.A7']);
    expect(() => busPairs(circuit, 'source.D0', 'source.D1', 4)).toThrow(/overlap/);
    expect(() => numberedPins(circuit, 'source.SEL')).toThrow(/lowest numbered/);
  });
  it('creates eight separate signals in one undoable edit, with idempotent repeated actions', async () => {
    const { editor, mutate } = model();
    await Promise.all([editor.connectBus('source.D0', 'target.A0', 8), editor.connectBus('source.D0', 'target.A0', 8)]);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(editor.state.circuit.nets).toHaveLength(8);
    expect(new Set(editor.state.circuit.nets.map((net) => net.id)).size).toBe(8);
    await editor.undo(); expect(editor.state.circuit.nets).toEqual([]);
    expect(editor.canUndo()).toBe(false);
    await editor.redo(); expect(editor.state.circuit.nets).toHaveLength(8);
  });
  it('retains existing fan-out while merging each destination bus', async () => {
    const { editor } = model();
    await editor.connect('source.D0', 'fanout.A0');
    await editor.connect('target.A0', 'fanout.B0');
    await editor.connectBus('source.D0', 'target.A0', 8);
    expect(editor.state.circuit.nets.find((net) => net.endpoints.includes('source.D0'))!.endpoints)
      .toEqual(['source.D0', 'fanout.A0', 'target.A0', 'fanout.B0']);
    await editor.connectBus('source.D0', 'fanout.A0', 8);
    expect(editor.state.circuit.nets).toHaveLength(8);
    for (let bit = 0; bit < 8; bit++) expect(editor.state.circuit.nets.find((n) => n.endpoints.includes(`source.D${bit}`))!.endpoints)
      .toContain(`fanout.A${bit}`);
  });
  it('rejects missing bits atomically and accepts the next valid edit', async () => {
    const { editor, mutate } = model();
    await expect(editor.connectBus('source.D0', 'target.A0', 9)).rejects.toThrow(/width/);
    expect(editor.state.circuit.nets).toEqual([]); expect(editor.canUndo()).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    await editor.connectBus('source.D0', 'target.A0', 8);
    expect(editor.state.error).toBeNull();
  });
});

describe('live signal readout semantics', () => {
  it('preserves exact X/Z bits alongside conservative hexadecimal digits', () => {
    expect(formatSignalBits([0, 1, 0, 1, 0, 1, 0, 0])).toEqual({ hex: '2A', binary: '00101010' });
    expect(formatSignalBits([1, 0, 'X', 0, 1, 'Z', 0, 1])).toEqual({ hex: '??', binary: '10Z10X01' });
    expect(formatSignalBits(Array(8).fill('Z'))).toEqual({ hex: 'ZZ', binary: 'ZZZZZZZZ' });
    expect(formatSignalBits([0, 1, 0, 1, 1])).toEqual({ hex: '1A', binary: '11010' });
  });
  it('maps explicitly wired and unwired primitive lanes to actual runtime net IDs', () => {
    const circuit = fixture(); const inst = circuit.components[0]!;
    const graph = loadCircuit(circuit);
    expect(graph.netById.has(runtimeSignalNet(circuit, inst, 'D7'))).toBe(true);
    circuit.nets.push({ id: 'data7', endpoints: ['source.D7', 'target.A7'] });
    expect(runtimeSignalNet(circuit, inst, 'D7')).toBe('data7');
  });
});
