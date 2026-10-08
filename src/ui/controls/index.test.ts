import { afterEach, expect, it, vi } from 'vitest';
import type { CircuitJSON } from '../../engine/ir';
import type { MetricsNotif } from '../../worker/protocol';
import type { LoadSnapshot, WorkerBus } from '../bus';
import { EditorModel } from '../editor';
import { showBusDialog } from '../bus_dialog';
import { mountControls } from './index';

// A small DOM surface for exercising the actual key handlers and ordered RPCs.
class TestElement extends EventTarget {
  children: TestElement[] = [];
  dataset: Record<string, string> = {};
  textContent = ''; value = ''; disabled = false; open = false; editable = false;
  readonly attributes = new Map<string, string>();
  constructor(readonly tag: string) { super(); }
  set innerHTML(_value: string) { this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(...children: TestElement[]): void { this.children.push(...children); }
  replaceChildren(...children: TestElement[]): void { this.children = children; }
  click(): void { this.dispatchEvent(new Event('click')); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  remove(): void {}
  matches(selector: string): boolean { return selector.split(', ').includes(this.tag); }
  closest(): TestElement | null { return this.editable ? this : null; }
  find(predicate: (element: TestElement) => boolean): TestElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate); if (found) return found;
    }
    return undefined;
  }
}

const setup = () => {
  const body = new TestElement('body');
  const doc = Object.assign(new EventTarget(), {
    body, activeElement: null as TestElement | null,
    createElement: (tag: string) => new TestElement(tag),
    querySelector: () => body.find(element => element.tag === 'dialog' && element.open) ?? null,
  });
  vi.stubGlobal('document', doc); vi.stubGlobal('Element', TestElement);
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'keys', components: [], nets: [] };
  const snapshot: LoadSnapshot = { netIds: [], componentIds: [], netIndex: new Map(), netsView: new Uint8Array() };
  let metrics!: (message: MetricsNotif) => void;
  const report = (running: boolean): void => metrics({ type: 'metrics', running, targetRateHz: 1000, actualRateHz: 0, ticks: 0 });
  const bus = {
    mutate: vi.fn(async () => snapshot),
    run: vi.fn(async () => report(true)), pause: vi.fn(async () => report(false)), step: vi.fn(async () => {}),
    on: (_event: string, handler: typeof metrics) => { metrics = handler; return () => {}; },
  };
  const editor = new EditorModel(bus as unknown as WorkerBus, circuit, snapshot);
  const host = new TestElement('div');
  const dispose = mountControls(host as unknown as HTMLElement, editor);
  const key = (value: string, properties: Record<string, unknown> = {}): Event => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: value, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false }, properties);
    doc.dispatchEvent(event); return event;
  };
  return { doc, host, body, editor, bus, report, key, dispose };
};
afterEach(() => vi.unstubAllGlobals());

it('Space uses worker running state and period queues one step', async () => {
  const h = setup(); h.report(true);
  expect(h.key(' ').defaultPrevented).toBe(true);
  await h.editor.whenIdle(); await Promise.resolve();
  expect(h.bus.pause).toHaveBeenCalledTimes(1);
  h.key('.'); await h.editor.whenIdle();
  expect(h.bus.step).toHaveBeenCalledTimes(1);
  h.key(' '); await h.editor.whenIdle();
  expect(h.bus.run).toHaveBeenCalledTimes(1); expect(h.bus.run).toHaveBeenCalledWith(1000);
  h.dispose();
});

it('preserves successive Space intents across stale metrics while editor RPCs are pending', async () => {
  const h = setup(); h.report(false);
  let release!: () => void;
  h.bus.mutate.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ netIds: [], componentIds: ['a'], netIndex: new Map(), netsView: new Uint8Array() }); }));
  const edit = h.editor.addComponent({ id: 'a', type: 'prim.BUF' });
  await Promise.resolve();
  h.key(' '); // request run
  h.report(false); // an older paused sample arrives before run has committed
  h.key(' '); // request pause, following the pending run
  release(); await edit; await h.editor.whenIdle();
  expect(h.bus.run).toHaveBeenCalledTimes(1); expect(h.bus.pause).toHaveBeenCalledTimes(1);
  expect(h.bus.run.mock.invocationCallOrder[0]).toBeLessThan(h.bus.pause.mock.invocationCallOrder[0]!);
  h.dispose();
});

it('question mark opens help and an open dialog owns all shortcuts', async () => {
  const h = setup(); h.report(false);
  h.key('?');
  const help = h.body.find(element => element.tag === 'dialog')!;
  expect(help.open).toBe(true);
  h.key(' '); h.key('.'); await h.editor.whenIdle();
  expect(h.bus.run).not.toHaveBeenCalled(); expect(h.bus.step).not.toHaveBeenCalled();
  help.find(element => element.textContent === 'Close shortcuts')!.click();
  expect(help.open).toBe(false);
  h.dispose();
});

it.each(['input', 'textarea', 'select', 'contenteditable'])('ignores typing in %s', async tag => {
  const h = setup();
  const field = new TestElement(tag === 'contenteditable' ? 'div' : tag); field.editable = tag === 'contenteditable';
  h.doc.activeElement = field;
  for (const key of [' ', '.', '?']) expect(h.key(key).defaultPrevented).toBe(false);
  await h.editor.whenIdle();
  expect(h.bus.run).not.toHaveBeenCalled(); expect(h.bus.pause).not.toHaveBeenCalled(); expect(h.bus.step).not.toHaveBeenCalled();
  expect(h.body.find(element => element.tag === 'dialog')!.open).toBe(false);
  h.dispose();
});

it('ignores modifiers, composing text and repeated keydown events', async () => {
  const h = setup();
  for (const properties of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
    h.key(' ', properties); h.key('.', properties); h.key('?', properties);
  }
  await h.editor.whenIdle();
  expect(h.bus.run).not.toHaveBeenCalled(); expect(h.bus.step).not.toHaveBeenCalled();
  expect(h.body.find(element => element.tag === 'dialog')!.open).toBe(false);
  h.dispose();
});

it('Space uses rate validation and shows an error for invalid rates', async () => {
  const h = setup();
  const rate = h.host.find(element => element.tag === 'input')!;
  rate.value = '0'; h.key(' '); await h.editor.whenIdle();
  expect(h.bus.run).not.toHaveBeenCalled();
  expect(h.host.find(element => element.attributes.get('role') === 'alert')!.textContent).toContain('tick rate must be an integer');
  h.dispose();
});

it('the bus dialog Escape cancellation clears bus mode without changing the circuit', async () => {
  const h = setup();
  await h.editor.replaceCircuit({ version: 1, kind: 'circuit', name: 'bus', components: [
    { id: 'rom', type: 'mem.ROM', params: { addressBits: 2, dataBits: 2 } },
    { id: 'mux', type: 'prim.MUX2', params: { width: 2 } },
  ], nets: [] });
  h.editor.setBusWiring(true);
  const before = h.editor.project;
  const close = showBusDialog(h.editor, 'rom.D0', 'mux.A0');
  const dialog = h.body.children[h.body.children.length - 1]!;
  dialog.dispatchEvent(new Event('cancel'));
  expect(h.editor.state.busWiring).toBe(false); expect(h.editor.project).toEqual(before);
  close(); h.dispose();
});
