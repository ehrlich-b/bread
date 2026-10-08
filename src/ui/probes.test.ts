import { describe, expect, it } from 'vitest';
import '../engine/index';
import eater from '../../examples/ben_eater_8bit.json';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import type { LoadSnapshot, WorkerBus } from './bus';
import { EditorModel } from './editor';
import { pinProbe } from './probes';

const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'probes', components: [{ id: 'sw', type: 'io.switch' }, { id: 'rom', type: 'mem.ROM', params: { addressBits: 2, dataBits: 8 } }], nets: [{ id: 'signal', endpoints: ['sw.Y'] }] };
const snapshot = (next: CircuitJSON): LoadSnapshot => {
  const graph = loadCircuit(next); const netIds = graph.nets.map(n => n.id);
  return { netIds, componentIds: graph.components.map(c => c.id), netIndex: graph.netById, netsView: graph.netValues };
};
const model = () => new EditorModel({ mutate: async (next: CircuitJSON) => snapshot(next) } as WorkerBus, circuit, snapshot(circuit));

describe('persisted editor probes', () => {
  it('adds and removes net and bus probes in queued order, saves, reopens and undoes/redoes', async () => {
    const editor = model();
    await Promise.all([editor.addPinProbe('sw.Y', false), editor.addPinProbe('rom.D0', true)]);
    expect(editor.project.probes?.map(p => p.label)).toEqual(['sw.Y', 'rom.D[7:0]']);
    const saved = JSON.parse(JSON.stringify(editor.project)) as CircuitJSON;
    loadCircuit(saved); await editor.replaceCircuit(saved);
    expect(editor.project.probes).toEqual(saved.probes);
    await editor.removeProbe('probe1'); expect(editor.project.probes).toHaveLength(1);
    await editor.undo(); expect(editor.project.probes).toHaveLength(2);
    await editor.redo(); expect(editor.project.probes).toHaveLength(1);
  });
  it('does not duplicate a probe or create history for repeated attachment', async () => {
    const editor = model();
    await Promise.all([editor.addNetProbe('signal'), editor.addPinProbe('sw.Y', false)]);
    expect(editor.project.probes).toHaveLength(1);
    await editor.undo(); expect(editor.project.probes).toBeUndefined(); expect(editor.canUndo()).toBe(false);
  });
  it('keeps probes through wiring floating pins and merging nets', async () => {
    const editor = model();
    await editor.addPinProbe('rom.D0', false);
    await editor.connect('sw.Y', 'rom.D0');
    expect(editor.project.probes?.[0]?.nets).toEqual(['signal']);
    await editor.undo(); expect(editor.project.probes?.[0]?.nets).toEqual(['__floating__rom__D0']);
    await editor.redo(); expect(editor.project.probes?.[0]?.nets).toEqual(['signal']);
  });
  it('removes probes whose lanes disappear, and restores them together with undo', async () => {
    const editor = model(); await editor.addPinProbe('rom.D0', true);
    await editor.removeComponent('rom'); expect(editor.project.probes).toEqual([]);
    await editor.undo(); expect(editor.project.probes?.[0]?.nets).toHaveLength(8);
    await editor.addNetProbe('signal'); await editor.removeNet('signal');
    expect(editor.project.probes?.some(p => p.nets.includes('signal'))).toBe(false);
    await editor.undo(); expect(editor.project.probes?.some(p => p.nets.includes('signal'))).toBe(true);
  });
  it('attaches to the actual SAP-1 OUT storage lanes through visible composite pins', () => {
    const probe = pinProbe(eater as CircuitJSON, 'display.OUT0', true);
    expect(probe.nets).toEqual(['display__nlo0', 'display__nlo1', 'display__nlo2', 'display__nlo3', 'display__nhi0', 'display__nhi1', 'display__nhi2', 'display__nhi3']);
    const graph = loadCircuit({ ...eater, probes: [{ id: 'out', ...probe }] } as CircuitJSON);
    expect(probe.nets.every(net => graph.netById.has(net))).toBe(true);
  });
});
