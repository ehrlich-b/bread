import { describe, expect, it, vi } from 'vitest';
import '../engine/index';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import type { LoadSnapshot, WorkerBus } from './bus';
import { EditorModel } from './editor';

// Model a worker round trip without a browser or app-state injection. Each
// request validates the circuit through the real loader before it succeeds.
const snapshotFor = (circuit: CircuitJSON): LoadSnapshot => {
  const graph = loadCircuit(circuit);
  const netIds = graph.nets.map((net) => net.id);
  return {
    netIds,
    componentIds: graph.components.map((component) => component.id),
    netIndex: new Map(netIds.map((id, index) => [id, index])),
    netsView: new Uint8Array(netIds.length),
  };
};

const setup = (): { editor: EditorModel; mutate: WorkerBus['mutate'] & ReturnType<typeof vi.fn> } => {
  const circuit: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'queued-edits',
    components: ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'prim.BUF' })),
    nets: [],
  };
  const mutate = vi.fn(async (next: CircuitJSON): Promise<LoadSnapshot> => {
    await Promise.resolve();
    return snapshotFor(next);
  });
  const bus: WorkerBus = {
    mutate,
    load: async (next) => snapshotFor(next),
    run: async () => {}, pause: async () => {}, step: async () => {},
    setInput: async () => {}, on: () => () => {}, readNet: () => 'X',
    netIds: [], componentIds: [],
  };
  return { editor: new EditorModel(bus, circuit, snapshotFor(circuit)), mutate };
};

describe('editor actions waiting for the worker', () => {
  it('keeps both placements when the second arrives before the first commits', async () => {
    const { editor } = setup();
    await Promise.all([
      editor.addComponent({ id: 'e', type: 'prim.BUF' }),
      editor.addComponent({ id: 'f', type: 'prim.BUF' }),
    ]);
    expect(editor.state.circuit.components.map((component) => component.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('deletes every selected component and prunes the selection', async () => {
    const { editor } = setup();
    editor.select('b');
    editor.select('c', 'add');
    await Promise.all([...editor.state.selection].map((id) => editor.removeComponent(id)));
    expect(editor.state.circuit.components.map((component) => component.id)).toEqual(['a', 'd']);
    expect([...editor.state.selection]).toEqual([]);
  });

  it('preserves separate inspector edits on the same component', async () => {
    const { editor } = setup();
    await Promise.all([
      editor.updateComponent('b', { label: 'buffer' }),
      editor.updateComponent('b', { position: [120, 80] }),
    ]);
    expect(editor.state.circuit.components.find((component) => component.id === 'b')).toMatchObject({ label: 'buffer', position: [120, 80] });
  });

  it('extends the newly committed net when wiring a fan-out rapidly', async () => {
    const { editor } = setup();
    await Promise.all([editor.connect('a.Y', 'b.A'), editor.connect('a.Y', 'c.A')]);
    expect(editor.state.circuit.nets).toEqual([{ id: 'n1', endpoints: ['a.Y', 'b.A', 'c.A'] }]);
  });

  it('merges nets created by earlier queued wiring actions', async () => {
    const { editor } = setup();
    await Promise.all([
      editor.connect('a.Y', 'b.A'), editor.connect('c.Y', 'd.A'),
      editor.connect('a.Y', 'd.A'),
    ]);
    expect(editor.state.circuit.nets).toEqual([{ id: 'n1', endpoints: ['a.Y', 'b.A', 'c.Y', 'd.A'] }]);
  });

  it('ignores a repeated wire action without adding undo history', async () => {
    const { editor, mutate } = setup();
    await Promise.all([editor.connect('a.Y', 'b.A'), editor.connect('a.Y', 'b.A')]);
    expect(mutate).toHaveBeenCalledTimes(1);
    await editor.undo();
    expect(editor.state.circuit.nets).toEqual([]);
    expect(editor.canUndo()).toBe(false);
  });

  it('resolves undo after a pending placement commits', async () => {
    const { editor } = setup();
    await Promise.all([editor.addComponent({ id: 'e', type: 'prim.BUF' }), editor.undo()]);
    expect(editor.state.circuit.components.map((component) => component.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(editor.canRedo()).toBe(true);
  });

  it('undoes and redoes two distinct actions even with repeated button presses', async () => {
    const { editor } = setup();
    await editor.updateComponent('a', { label: 'first' });
    await editor.updateComponent('b', { label: 'second' });
    await Promise.all([editor.undo(), editor.undo()]);
    expect(editor.state.circuit.components.every((component) => component.label === undefined)).toBe(true);
    expect(editor.canUndo()).toBe(false);
    await Promise.all([editor.redo(), editor.redo()]);
    expect(editor.state.circuit.components[0]!.label).toBe('first');
    expect(editor.state.circuit.components[1]!.label).toBe('second');
    expect(editor.canRedo()).toBe(false);
  });

  it('lets an edit queued after a rejected transition succeed and undo cleanly', async () => {
    const { editor } = setup();
    const results = await Promise.allSettled([
      editor.addComponent({ id: 'bad', type: 'prim.UNKNOWN' }),
      editor.updateComponent('a', { label: 'valid' }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(editor.state.circuit.components.some((component) => component.id === 'bad')).toBe(false);
    expect(editor.state.circuit.components[0]!.label).toBe('valid');
    await editor.undo();
    expect(editor.state.circuit.components[0]!.label).toBeUndefined();
    expect(editor.canUndo()).toBe(false);
  });

  it('reserves placement IDs until the pending worker request finishes', async () => {
    const { editor } = setup();
    const firstId = editor.generateId('prim.BUF');
    const first = editor.addComponent({ id: firstId, type: 'prim.BUF' });
    const secondId = editor.generateId('prim.BUF');
    const second = editor.addComponent({ id: secondId, type: 'prim.BUF' });
    expect(secondId).not.toBe(firstId);
    await Promise.all([first, second]);
    expect(editor.state.circuit.components.map((component) => component.id)).toEqual(['a', 'b', 'c', 'd', firstId, secondId]);
  });

  it('releases an ID reserved for a rejected placement', async () => {
    const { editor } = setup();
    const id = editor.generateId('prim.BUF');
    await expect(editor.addComponent({ id, type: 'prim.UNKNOWN' })).rejects.toThrow('unknown component type');
    expect(editor.generateId('prim.BUF')).toBe(id);
  });

  it('applies every rotation when presses arrive before the worker responds', async () => {
    const { editor } = setup();
    await Promise.all([editor.rotateComponent('b'), editor.rotateComponent('b'), editor.rotateComponent('b')]);
    expect(editor.state.circuit.components.find((component) => component.id === 'b')!.rotation).toBe(270);
    await editor.rotateComponent('b');
    expect(editor.state.circuit.components.find((component) => component.id === 'b')!.rotation).toBe(0);
  });

  it('keeps history and the snapshot intact when an undo is rejected', async () => {
    const { editor, mutate } = setup();
    await editor.updateComponent('a', { label: 'saved' });
    const snapshot = editor.state.snapshot;
    mutate.mockRejectedValueOnce(new Error('worker rejected undo'));
    await expect(editor.undo()).rejects.toThrow('worker rejected undo');
    expect(editor.state.snapshot).toBe(snapshot);
    expect(editor.state.circuit.components[0]!.label).toBe('saved');
    expect(editor.canUndo()).toBe(true);
    expect(editor.canRedo()).toBe(false);
    await editor.undo();
    expect(editor.state.circuit.components[0]!.label).toBeUndefined();
  });

  it('removes a just-placed component when deletion follows before commit', async () => {
    const { editor } = setup();
    await Promise.all([
      editor.addComponent({ id: 'e', type: 'prim.BUF' }), editor.removeComponent('e'),
    ]);
    expect(editor.state.circuit.components.some((component) => component.id === 'e')).toBe(false);
    await editor.undo();
    expect(editor.state.circuit.components.some((component) => component.id === 'e')).toBe(true);
  });
});
