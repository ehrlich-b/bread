import { afterEach, expect, it, vi } from 'vitest';
import '../engine/index';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import { runTestbench, type TestbenchResult } from '../engine/testbench';
import type { WorkerReq } from '../worker/protocol';
import { createWorkerBus, type LoadSnapshot, type WorkerBus } from './bus';
import { mountChips } from './chips';
import { EditorModel } from './editor';
import { mountFileControls } from './file';
import * as permalink from './permalink';
import { mountTestbench } from './testbench';

// Exercise the mounted handlers without a browser or a DOM dependency.
class Element extends EventTarget {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = ''; value = ''; disabled = false; open = false;
  files: Array<{ text(): Promise<string> }> = [];
  set innerHTML(_value: string) { this.children = []; }
  append(...children: Element[]): void { this.children.push(...children); }
  appendChild(child: Element): Element { this.append(child); return child; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  replaceChildren(...children: Element[]): void { this.children = [...children]; }
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
  return { host: new Element(), editor: new EditorModel(bus, circuit, snapshot(circuit)), mutate, bus };
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

const probedBuffer: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'Buffer', components: [{ id: 'buf', type: 'prim.BUF' }],
  nets: [{ id: 'in', endpoints: ['buf.A'] }, { id: 'out', endpoints: ['buf.Y'] }],
  probes: [{ id: 'q', label: 'Q', nets: ['out'] }],
};
const failingBench = { version: 1, name: 'Failure', inputs: { IN: ['in'] }, outputs: { OUT: ['out'] }, vectors: [{ drive: { IN: 1 }, expect: { OUT: 0 } }] };

it.each(['run', 'step', 'toggleSwitch'])('automatic failure focus respects a later explicit %s', async action => {
  const { host, editor, bus } = setup({ ...probedBuffer, components: [...probedBuffer.components, { id: 'sw', type: 'io.switch' }] });
  const events: string[] = [];
  let finish!: (result: TestbenchResult) => void;
  bus.pause = async () => { events.push('pause'); };
  bus.run = async rate => { events.push(`run ${rate}`); };
  bus.step = async () => { events.push('step'); };
  bus.setInput = async () => { events.push('toggleSwitch'); };
  bus.testbench = async () => { events.push('testbench'); return new Promise(resolve => { finish = resolve; }); };
  const focused = vi.fn(); editor.onWaveformFocus(focused);
  const dispose = mountTestbench(host as unknown as HTMLElement, editor);
  host.find(e => e.attributes['aria-label'] === 'Testbench JSON')!.value = JSON.stringify(failingBench);
  host.find(e => e.textContent === 'Run testbench')!.click();
  await flush(); expect(events).toEqual(['pause', 'testbench']);
  const later = action === 'run' ? editor.run(2000) : action === 'step' ? editor.step() : editor.toggleSwitch('sw');
  finish(runTestbench(probedBuffer, failingBench, { capture: true }));
  await later; await flush(); await editor.whenIdle();
  expect(events).toEqual(['pause', 'testbench', action === 'run' ? 'run 2000' : action]);
  expect(focused).not.toHaveBeenCalled();
  expect(host.find(e => e.attributes['aria-label'] === 'Testbench result')!.textContent).toContain('FAIL Failure');
  // A later explicit request to inspect the failure may still pause and focus.
  host.find(e => e.textContent === 'Show failing vector 1')!.click();
  await flush(); await editor.whenIdle();
  expect(events.at(-1)).toBe('pause');
  expect(focused).toHaveBeenCalledTimes(1);
  dispose();
});

it('automatically focuses a failure when no later command supersedes it', async () => {
  const { host, editor, bus } = setup(probedBuffer);
  const result = runTestbench(probedBuffer, failingBench, { capture: true });
  bus.pause = vi.fn(async () => {});
  bus.testbench = async () => result;
  const focused = vi.fn(); editor.onWaveformFocus(focused);
  const dispose = mountTestbench(host as unknown as HTMLElement, editor);
  host.find(e => e.attributes['aria-label'] === 'Testbench JSON')!.value = JSON.stringify(failingBench);
  host.find(e => e.textContent === 'Run testbench')!.click();
  await flush(); await editor.whenIdle();
  expect(focused).toHaveBeenCalledWith(result.waveform, result.results[0]!.step);
  dispose();
});

it('releases the testbench panel and editor queue after an unstructured worker failure', async () => {
  const { host, editor } = setup(probedBuffer);
  const sent: WorkerReq[] = [];
  const worker = new EventTarget();
  vi.stubGlobal('Worker', class {
    constructor() { return Object.assign(worker, { postMessage: (message: WorkerReq) => {
      sent.push(message);
      if (message.type === 'pause') queueMicrotask(() => worker.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'ack', id: message.id } })));
    } }); }
  });
  const bus = createWorkerBus();
  editor.bus.pause = bus.pause;
  editor.bus.testbench = bus.testbench;
  editor.bus.run = bus.run;
  const dispose = mountTestbench(host as unknown as HTMLElement, editor);
  host.find(e => e.attributes['aria-label'] === 'Testbench JSON')!.value = JSON.stringify(failingBench);
  const run = host.find(e => e.textContent === 'Run testbench')!;
  run.click(); await flush();
  expect(sent.map(message => message.type)).toEqual(['pause', 'testbench']);
  let laterError: Error | undefined;
  const later = editor.run(2000).catch(error => { laterError = error; });
  worker.dispatchEvent(Object.assign(new Event('error'), { message: 'Worker out of memory' }));
  await flush();
  expect(run.disabled).toBe(false);
  expect(host.find(e => e.attributes['aria-label'] === 'Testbench result')!.textContent).toBe('');
  expect(host.find(e => e.attributes.role === 'alert')!.textContent).toContain('Worker out of memory');
  expect(laterError).toBeInstanceOf(Error);
  await later; await editor.whenIdle();
  dispose();
});
