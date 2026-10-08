import { afterEach, expect, it, vi } from 'vitest';
import '../engine/index';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import type { LoadSnapshot, WorkerBus } from './bus';
import { mountChips } from './chips';
import { EditorModel } from './editor';
import { mountFileControls } from './file';
import * as permalink from './permalink';

// Exercise the mounted handlers without a browser or a DOM dependency.
class Element extends EventTarget {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = ''; value = ''; disabled = false; open = false;
  files: Array<{ text(): Promise<string> }> = [];
  set innerHTML(_value: string) { this.children = []; }
  append(...children: Element[]): void { this.children.push(...children); }
  appendChild(child: Element): Element { this.append(child); return child; }
  setAttribute(): void {}
  remove(): void {}
  focus(): void {}
  select(): void {}
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  click(): void { this.dispatchEvent(new Event('click')); }
  find(predicate: (element: Element) => boolean): Element | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return undefined;
  }
}

const empty = (): CircuitJSON => ({ version: 1, kind: 'circuit', name: 'initial', components: [], nets: [] });
const setup = (circuit = empty()) => {
  vi.stubGlobal('document', { body: new Element(), createElement: () => new Element() });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hash: '', href: 'https://bread.example/' }, history: { replaceState: vi.fn() } }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const snapshot = (next: CircuitJSON): LoadSnapshot => {
    const graph = loadCircuit(next);
    return { netIds: graph.nets.map(n => n.id), componentIds: graph.components.map(c => c.id), netIndex: graph.netById, netsView: graph.netValues };
  };
  const mutate = vi.fn(async (next: CircuitJSON) => snapshot(next));
  const bus = { mutate, readNet: () => 0 } as unknown as WorkerBus;
  return { host: new Element(), editor: new EditorModel(bus, circuit, snapshot(circuit)), mutate };
};
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('drops a delayed Open JSON after New and a later placement', async () => {
  const { host, editor } = setup();
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  let finish!: (text: string) => void;
  const input = host.find(e => e.dataset.fileAction === 'load-input')!;
  input.files = [{ text: () => new Promise(resolve => { finish = resolve; }) }];
  input.dispatchEvent(new Event('change'));
  host.find(e => e.dataset.fileAction === 'new')!.click();
  await editor.whenIdle();
  await editor.addComponent({ id: 'new_work', type: 'prim.NOT' });
  finish(JSON.stringify({ ...empty(), name: 'older-file', components: [{ id: 'old', type: 'prim.BUF' }] }));
  await flush(); await editor.whenIdle();
  expect(editor.project.name).toBe('Untitled');
  expect(editor.project.components.map(c => c.id)).toEqual(['new_work']);
  await editor.undo(); expect(editor.project.components).toEqual([]);
  await editor.undo(); expect(editor.project).toEqual(empty());
  dispose();
});

it('drops a native file-picker result after a later edit, even before that edit commits', async () => {
  const { host, editor, mutate } = setup();
  let finishPicker!: (handles: unknown[]) => void;
  const picker = vi.fn(() => new Promise(resolve => { finishPicker = resolve; }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hash: '', href: 'https://bread.example/' }, history: { replaceState: vi.fn() }, showOpenFilePicker: picker }));
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  host.find(e => e.dataset.fileAction === 'load')!.click();
  expect(picker).toHaveBeenCalledTimes(1);
  let finishEdit!: () => void;
  mutate.mockImplementationOnce(next => new Promise(resolve => { finishEdit = () => resolve({ netIds: [], componentIds: next.components.map(c => c.id), netIndex: new Map(), netsView: new Uint8Array() }); }));
  const edit = editor.addComponent({ id: 'new_work', type: 'prim.NOT' });
  await Promise.resolve();
  finishPicker([{ getFile: async () => ({ text: async () => JSON.stringify({ ...empty(), name: 'older-file' }) }) }]);
  await flush(); finishEdit(); await edit; await editor.whenIdle();
  expect(editor.project.components.map(c => c.id)).toEqual(['new_work']);
  expect(mutate).toHaveBeenCalledTimes(1);
  dispose();
});

it('loads JSON normally but keeps the latest file selection when reads finish out of order', async () => {
  const { host, editor } = setup();
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  const input = host.find(e => e.dataset.fileAction === 'load-input')!;
  let finish!: (text: string) => void;
  input.files = [{ text: () => new Promise(resolve => { finish = resolve; }) }];
  input.dispatchEvent(new Event('change'));
  input.files = [{ text: async () => JSON.stringify({ ...empty(), name: 'newer-file' }) }];
  input.dispatchEvent(new Event('change'));
  await flush(); await editor.whenIdle();
  expect(editor.project.name).toBe('newer-file');
  finish(JSON.stringify({ ...empty(), name: 'older-file' }));
  await flush(); await editor.whenIdle();
  expect(editor.project.name).toBe('newer-file');
  await editor.undo(); expect(editor.project).toEqual(empty());
  expect(editor.canUndo()).toBe(false);
  dispose();
});

it('removes both ports when clicks arrive before the first worker reply', async () => {
  const definition: CircuitJSON = {
    version: 1, kind: 'composite', name: 'user.Test',
    components: [{ id: 'a', type: 'prim.BUF' }, { id: 'b', type: 'prim.BUF' }],
    nets: [{ id: 'na', endpoints: ['a.A'] }, { id: 'nb', endpoints: ['b.A'] }, { id: 'out', endpoints: ['a.Y'] }],
    ports: [{ name: 'A', dir: 'in', internalNet: 'na' }, { name: 'B', dir: 'in', internalNet: 'nb' }, { name: 'Y', dir: 'out', internalNet: 'out' }],
  };
  const { host, editor, mutate } = setup({ ...empty(), definitions: [definition] });
  await editor.editChip('user.Test');
  const dispose = mountChips(host as unknown as HTMLElement, editor);
  const a = host.find(e => e.textContent === 'Remove port A')!;
  const b = host.find(e => e.textContent === 'Remove port B')!;
  const realMutate = mutate.getMockImplementation()!;
  let finish!: () => void;
  mutate.mockImplementationOnce(next => new Promise(resolve => { finish = () => { void realMutate(next).then(resolve); }; }));
  a.click(); await flush(); b.click();
  expect(editor.state.circuit.ports!.map(p => p.name)).toEqual(['A', 'B', 'Y']);
  finish(); await editor.whenIdle();
  expect(editor.state.circuit.ports!.map(p => p.name)).toEqual(['Y']);
  await editor.undo(); expect(editor.state.circuit.ports!.map(p => p.name)).toEqual(['B', 'Y']);
  await editor.undo(); expect(editor.state.circuit.ports!.map(p => p.name)).toEqual(['A', 'B', 'Y']);
  await editor.redo(); await editor.redo(); expect(editor.state.circuit.ports!.map(p => p.name)).toEqual(['Y']);
  dispose();
});

const changeHash = (hash: string): void => {
  window.location.hash = hash;
  Object.assign(window.location, { href: `https://bread.example/${hash}` });
  window.dispatchEvent(new Event('hashchange'));
};

it('loads a permalink on mount and hashchange through the validated editor history', async () => {
  const { host, editor } = setup();
  const first = { ...empty(), name: 'first link' };
  window.location.hash = await permalink.encodeCircuit(first);
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  await vi.waitFor(() => expect(editor.project).toEqual(first));
  const second = { ...empty(), name: 'second link' };
  changeHash(await permalink.encodeCircuit(second));
  await vi.waitFor(() => expect(editor.project).toEqual(second));
  await editor.undo(); expect(editor.project).toEqual(first);
  await editor.undo(); expect(editor.project).toEqual(empty());
  dispose();
});

it('drops delayed permalink decompression after New and a later queued edit', async () => {
  const { host, editor, mutate } = setup();
  let finish!: (circuit: CircuitJSON) => void;
  vi.spyOn(permalink, 'decodeCircuit').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  changeHash('#c1=delayed');
  host.find(e => e.dataset.fileAction === 'new')!.click();
  const edit = editor.addComponent({ id: 'new_work', type: 'prim.NOT' });
  finish({ ...empty(), name: 'stale link' });
  await edit; await flush(); await editor.whenIdle();
  expect(editor.project.name).toBe('Untitled');
  expect(editor.project.components.map(c => c.id)).toEqual(['new_work']);
  expect(mutate).toHaveBeenCalledTimes(2);
  dispose();
});

it('keeps the newest hash when two decodes complete out of order', async () => {
  const { host, editor } = setup();
  let finishFirst!: (circuit: CircuitJSON) => void;
  let finishSecond!: (circuit: CircuitJSON) => void;
  vi.spyOn(permalink, 'decodeCircuit')
    .mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }))
    .mockReturnValueOnce(new Promise(resolve => { finishSecond = resolve; }));
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  changeHash('#c1=first'); changeHash('#c1=second');
  finishSecond({ ...empty(), name: 'newest link' });
  await flush(); await editor.whenIdle();
  finishFirst({ ...empty(), name: 'stale link' });
  await flush(); await editor.whenIdle();
  expect(editor.project.name).toBe('newest link');
  await editor.undo(); expect(editor.project).toEqual(empty());
  expect(editor.canUndo()).toBe(false);
  dispose();
});

it('clearing the hash cancels a pending link without adding history', async () => {
  const { host, editor, mutate } = setup();
  let finish!: (circuit: CircuitJSON) => void;
  vi.spyOn(permalink, 'decodeCircuit').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  changeHash('#c1=delayed'); changeHash('');
  finish({ ...empty(), name: 'stale link' });
  await flush(); await editor.whenIdle();
  expect(editor.project).toEqual(empty()); expect(editor.canUndo()).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
  dispose();
});

it('ignores a stale read error after a later edit, for both files and links', async () => {
  const { host, editor } = setup();
  let fail!: (error: Error) => void;
  vi.spyOn(permalink, 'decodeCircuit').mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  changeHash('#c1=delayed');
  await editor.addComponent({ id: 'new_work', type: 'prim.NOT' });
  fail(new Error('stale decode failure')); await flush();
  expect(editor.state.error).toBeNull();
  expect(editor.project.components.map(c => c.id)).toEqual(['new_work']);
  let failFile!: (error: Error) => void;
  const input = host.find(e => e.dataset.fileAction === 'load-input')!;
  input.files = [{ text: () => new Promise((_resolve, reject) => { failFile = reject; }) }];
  input.dispatchEvent(new Event('change'));
  await editor.updateComponent('new_work', { label: 'newest' });
  failFile(new Error('stale file failure')); await flush();
  expect(editor.state.error).toBeNull(); expect(editor.project.components[0]!.label).toBe('newest');
  dispose();
});

it('reports a corrupt link and preserves the current circuit and history', async () => {
  const { host, editor, mutate } = setup();
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  changeHash('#c1=corrupt');
  await vi.waitFor(() => expect(editor.state.error).toContain('corrupt or truncated'));
  expect(editor.project).toEqual(empty()); expect(editor.canUndo()).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
  dispose();
});

it('validates decoded links with the same worker mutation path as files', async () => {
  const { host, editor, mutate } = setup();
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  changeHash(await permalink.encodeCircuit({ ...empty(), components: [{ id: 'bad', type: 'unknown.code' }] }));
  await vi.waitFor(() => expect(editor.state.error).toContain('Cannot open shared circuit'));
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(editor.project).toEqual(empty()); expect(editor.canUndo()).toBe(false);
  dispose();
});

it('shares after queued edits finish without reopening the circuit', async () => {
  const { host, editor, mutate } = setup();
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  const edit = editor.addComponent({ id: 'latest', type: 'prim.NOT' });
  host.find(e => e.dataset.fileAction === 'share')!.click();
  await edit;
  await vi.waitFor(() => expect(window.history.replaceState).toHaveBeenCalledTimes(1));
  const url = vi.mocked(window.history.replaceState).mock.calls[0]![2] as string;
  expect(await permalink.decodeCircuit(new URL(url).hash)).toEqual(editor.project);
  expect(mutate).toHaveBeenCalledTimes(1);
  dispose();
});

it('loads a named example and reports an unknown example', async () => {
  const { host, editor } = setup();
  const dispose = mountFileControls(host as unknown as HTMLElement, editor);
  changeHash('#example=full_adder');
  await vi.waitFor(() => expect(editor.project.name).toBe('full_adder'));
  const before = editor.project;
  changeHash('#example=does_not_exist');
  await vi.waitFor(() => expect(editor.state.error).toContain('Unknown shared example'));
  expect(editor.project).toEqual(before);
  dispose();
});
