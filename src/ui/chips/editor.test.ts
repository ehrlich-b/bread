import { describe, expect, it, vi } from 'vitest';
import '../../engine/index';
import type { CircuitJSON } from '../../engine/ir';
import { loadCircuit } from '../../engine/loader';
import { Simulator } from '../../engine/sim';
import { NET_STATE_BYTE } from '../../worker/protocol';
import type { LoadSnapshot, WorkerBus } from '../bus';
import { EditorModel } from '../editor';
import { chipSelection } from './model';

const initial: CircuitJSON = { version: 1, kind: 'circuit', name: 'author', components: [{ id: 'g', type: 'prim.NAND', params: { inputs: 2 } }], nets: [{ id: 'a', endpoints: ['g.A'] }, { id: 'b', endpoints: ['g.B'] }, { id: 'y', endpoints: ['g.Y'] }] };
function setup(json: CircuitJSON = initial): { editor: EditorModel; bus: WorkerBus } {
  let sim: Simulator; let snapshot: LoadSnapshot;
  const sync = (): void => { for (let i = 0; i < snapshot.netIds.length; i++) snapshot.netsView[i] = NET_STATE_BYTE[sim.readNet(snapshot.netIds[i]!)]; };
  const mutate = async (next: CircuitJSON): Promise<LoadSnapshot> => {
    await Promise.resolve();
    const graph = loadCircuit(next); const candidate = new Simulator(graph); candidate.settle(); sim = candidate;
    const netIds = graph.nets.map((n) => n.id);
    snapshot = { netIds, componentIds: graph.components.map((c) => c.id), netIndex: new Map(netIds.map((id, i) => [id, i])), netsView: new Uint8Array(netIds.length) };
    sync(); return snapshot;
  };
  // The constructor needs a synchronous initial snapshot; later loads model RPC latency.
  const graph = loadCircuit(json); sim = new Simulator(graph); sim.settle();
  const netIds = graph.nets.map((n) => n.id);
  snapshot = { netIds, componentIds: graph.components.map((c) => c.id), netIndex: new Map(netIds.map((id, i) => [id, i])), netsView: new Uint8Array(netIds.length) }; sync();
  const bus: WorkerBus = { testbench: async () => { throw new Error('Unexpected testbench call'); }, mutate, load: mutate, pause: async () => {}, run: async () => {}, step: async () => { sim.tick(); sync(); }, setInput: async (c, p, v) => { sim.setComponentInput(c, p, v); sim.settle(); sync(); }, setNetInput: async (n, v) => { sim.setInput(n, v); sim.settle(); sync(); }, readNet: (n) => sim.readNet(n), on: () => () => {}, netIds: [], componentIds: [] };
  return { editor: new EditorModel(bus, json, snapshot), bus };
}
const makeNand = async (editor: EditorModel): Promise<void> => {
  editor.select('g'); const selection = chipSelection(editor.state.circuit, editor.state.selection);
  await editor.createChip('Nand', selection.body.ports!);
};

describe('chip authoring document history and edit propagation', () => {
  it('undoes and redoes creation atomically including its saved library', async () => {
    const { editor } = setup(); await makeNand(editor);
    expect(editor.project.definitions).toHaveLength(1);
    await editor.undo(); expect(editor.project).toEqual(initial);
    await editor.redo(); expect(editor.project.components[0]!.type).toBe('user.Nand');
    expect(editor.project.definitions).toHaveLength(1);
  });
  it('edits one definition, updates two instances, increments revision, and can undo the save', async () => {
    const { editor, bus } = setup(); await makeNand(editor);
    await editor.addComponent({ id: 'second', type: 'user.Nand' });
    await editor.addNet({ id: 'a2', endpoints: ['second.A'] });
    await editor.addNet({ id: 'b2', endpoints: ['second.B'] });
    await editor.addNet({ id: 'y2', endpoints: ['second.Y'] });
    await editor.editChip('user.Nand');
    await editor.setPortInput('a', 1); await editor.setPortInput('b', 1);
    expect(bus.readNet('y')).toBe(0);
    await editor.updateComponent('g', { type: 'prim.AND' });
    expect(bus.readNet('y')).toBe(1); // Explicit tests survive this structural edit.
    await editor.saveChip();
    expect(editor.state.editingChip).toBeNull();
    expect(editor.project.definitions![0]!.metadata!.revision).toBe(2);
    await bus.setNetInput('a', 1); await bus.setNetInput('b', 1); await bus.setNetInput('a2', 1); await bus.setNetInput('b2', 1);
    expect([bus.readNet('y'), bus.readNet('y2')]).toEqual([1, 1]);
    await editor.undo(); expect(editor.state.editingChip).toBe('user.Nand');
    expect(editor.project.definitions![0]!.metadata!.revision).toBe(1);
    await editor.cancelChip();
    await bus.setNetInput('a', 1); await bus.setNetInput('b', 1);
    expect(bus.readNet('y')).toBe(0);
  });
  it('rejects a breaking port edit without replacing the old project or losing the repairable draft', async () => {
    const { editor } = setup(); await makeNand(editor); const root = editor.project;
    await editor.editChip('user.Nand');
    const ports = editor.state.circuit.ports!.map((p) => p.name === 'A' ? { ...p, name: 'Renamed' } : p);
    await editor.updatePorts(ports);
    await expect(editor.saveChip()).rejects.toThrow('unknown port "A"');
    expect(editor.project).toBe(root); expect(editor.state.editingChip).toBe('user.Nand');
    expect(editor.state.error).toContain('unknown port');
    await editor.undo(); await editor.saveChip(); expect(editor.state.editingChip).toBeNull();
  });
  it('retargets parent probes atomically with a chip save and preserves unchanged probes', async () => {
    const definition: CircuitJSON = {
      version: 1, kind: 'composite', name: 'user.Buffer',
      components: [{ id: 'a', type: 'prim.BUF' }, { id: 'b', type: 'prim.BUF' }],
      nets: [{ id: 'in', endpoints: ['a.A'] }, { id: 'middle', endpoints: ['a.Y', 'b.A'] }, { id: 'out', endpoints: ['b.Y'] }],
      ports: [{ name: 'IN', dir: 'in', internalNet: 'in' }, { name: 'OUT', dir: 'out', internalNet: 'out' }],
    };
    const project: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'Parent', components: [{ id: 'u', type: 'user.Buffer' }], nets: [], definitions: [definition],
      probes: [{ id: 'deleted', label: 'Internal output', nets: ['u__out', 'u__middle'] }],
    };
    const { editor } = setup(project);
    await editor.addPinProbe('u.OUT', false);
    await editor.addPinProbe('u.IN', false);
    const original = editor.project;
    await editor.editChip('user.Buffer');
    await editor.removePort('OUT');
    await editor.removeComponent('b');
    await editor.exposePin('a.Y', 'OUT', 'out');
    await editor.saveChip();
    expect(editor.state.editingChip).toBeNull();
    expect(editor.project.probes).toEqual([
      { id: 'deleted', label: 'Internal output', nets: ['u__middle', 'u__middle'] },
      { id: 'probe1', label: 'u.OUT', nets: ['u__middle'] },
      { id: 'probe2', label: 'u.IN', nets: ['u__in'] },
    ]);
    expect(editor.state.note).toContain('retargeted u.OUT');
    expect(editor.state.error).toBeNull();
    const saved = editor.project;
    await editor.undo();
    expect(editor.project).toBe(original);
    expect(editor.state.editingChip).toBe('user.Buffer');
    expect(editor.state.note).toBeNull();
    await editor.redo(); expect(editor.project).toBe(saved);
    await editor.undo(); await editor.cancelChip();
    expect(editor.project).toBe(original);
    expect(loadCircuit(editor.project).netById.has('u__out')).toBe(true);
  });

  it('removes a dangling internal probe after saving a nested chip edit', async () => {
    const inner: CircuitJSON = {
      version: 1, kind: 'composite', name: 'user.Inner',
      components: [{ id: 'buf', type: 'prim.BUF' }],
      nets: [{ id: 'in', endpoints: ['buf.A'] }, { id: 'out', endpoints: ['buf.Y'] }],
      ports: [{ name: 'IN', dir: 'in', internalNet: 'in' }],
    };
    const outer: CircuitJSON = { version: 1, kind: 'composite', name: 'user.Outer', components: [{ id: 'v', type: 'user.Inner' }], nets: [{ id: 'in', endpoints: ['v.IN'] }], ports: [{ name: 'IN', dir: 'in', internalNet: 'in' }] };
    const project: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'Nested', components: [{ id: 'u', type: 'user.Outer' }], nets: [], definitions: [inner, outer],
      probes: [{ id: 'gone', label: 'Internal', nets: ['u__v__out'] }],
    };
    const { editor } = setup(project);
    await editor.editChip('user.Inner');
    await editor.removeNet('out');
    await editor.saveChip();
    expect(editor.project.probes).toEqual([]);
    expect(editor.state.note).toContain('removed Internal');
    const saved = editor.project;
    await editor.undo(); expect(editor.project).toBe(project);
    await editor.redo(); expect(editor.project).toBe(saved);
  });

  it('retains chip definitions on New and restores an entire previous project through undo', async () => {
    const { editor } = setup(); await makeNand(editor); const old = editor.project;
    await editor.newCircuit(); expect(editor.project.components).toEqual([]); expect(editor.project.definitions).toEqual(old.definitions);
    await editor.undo(); expect(editor.project).toEqual(old);
    const restored = JSON.parse(JSON.stringify(editor.project)) as CircuitJSON;
    await editor.replaceCircuit(restored); expect(loadCircuit(editor.project).components[0]!.typeId).toBe('prim.NAND');
  });
  it('resolves the New library after a queued redo restores a chip', async () => {
    const { editor } = setup(); await makeNand(editor); await editor.undo();
    await Promise.all([editor.redo(), editor.newCircuit()]);
    expect(editor.project.components).toHaveLength(0);
    expect(editor.project.definitions).toHaveLength(1);
  });
  it('cancels nested chip creation together with the parent draft', async () => {
    const { editor } = setup(); await makeNand(editor); const root = editor.project;
    await editor.editChip('user.Nand'); editor.select('g');
    await editor.createChip('Inner', chipSelection(editor.state.circuit, editor.state.selection).body.ports!);
    expect(editor.state.circuit.definitions).toHaveLength(2); expect(editor.project).toBe(root);
    await editor.cancelChip(); expect(editor.project).toBe(root); expect(editor.project.definitions).toHaveLength(1);
  });
  it('guards input tests and exposes a previously free pin through editor actions', async () => {
    const { editor } = setup(); await makeNand(editor); await editor.editChip('user.Nand');
    await expect(editor.setPortInput('y', 0)).rejects.toThrow('Only chip input');
    await editor.addComponent({ id: 'buf', type: 'prim.BUF' });
    await editor.exposePin('buf.A', 'Extra', 'in');
    await editor.setPortInput(editor.state.circuit.ports!.find((p) => p.name === 'Extra')!.internalNet, 'X');
    await expect(editor.exposePin('buf.A', 'Again', 'in')).rejects.toThrow('already has a port');
  });
});

it('commits a chip input drive before a following reload preserves it', async () => {
  const { editor, bus } = setup();
  await makeNand(editor);
  await editor.editChip('user.Nand');
  let finish!: () => void;
  const setNetInput = bus.setNetInput;
  vi.spyOn(bus, 'setNetInput').mockImplementationOnce((net, value) => new Promise<void>(resolve => {
    finish = () => { void setNetInput(net, value).then(resolve); };
  }));
  const mutate = vi.spyOn(bus, 'mutate');
  const drive = editor.setPortInput('a', 1);
  const rename = editor.updateComponent('g', { label: 'renamed' });
  await Promise.resolve();
  await Promise.resolve();
  expect(mutate).not.toHaveBeenCalled();
  finish();
  await Promise.all([drive, rename]);
  expect(bus.readNet('a')).toBe(1);
});
