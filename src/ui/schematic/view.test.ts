import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../engine/index';
import type { CircuitJSON, NetState } from '../../engine/ir';
import { loadCircuit } from '../../engine/loader';
import { Simulator } from '../../engine/sim';
import type { LoadSnapshot, WorkerBus } from '../bus';
import { EditorModel } from '../editor';
import { chipSelection, createChip } from '../chips/model';
import { mountSchematic } from './view';

// Only the DOM surface used by these real renderers and click handlers. No
// browser, replacement view logic or production dependencies are needed.
class TestElement extends EventTarget {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  readonly classList = { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() };
  textContent = '';
  set innerHTML(_value: string) { this.children.length = 0; }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
    }
  }
  private matches(selector: string): boolean {
    const match = /^\[data-([a-z-]+)(?:="([^"\]]*)")?\]$/.exec(selector);
    if (!match) throw new Error(`Unsupported test selector: ${selector}`);
    const key = match[1]!.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return match[2] === undefined ? key in this.dataset : this.dataset[key] === match[2];
  }
  closest(selector: string): TestElement | null { return this.matches(selector) ? this : null; }
  appendChild(child: TestElement): TestElement { this.children.push(child); return child; }
  append(...children: TestElement[]): void { this.children.push(...children); }
  querySelector(selector: string): TestElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  click(): void { this.dispatchEvent(new Event('click')); }
}

const mount = (circuit: CircuitJSON) => {
  const document = new TestElement();
  vi.stubGlobal('document', Object.assign(document, {
    createElementNS: () => new TestElement(), createElement: () => new TestElement(),
  }));
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let sim: Simulator;
  let snapshot: LoadSnapshot;
  const sync = (): void => {
    snapshot.netsView.set(sim.graph.netValues);
  };
  const load = (next: CircuitJSON): LoadSnapshot => {
    sim = new Simulator(loadCircuit(next));
    sim.settle();
    const netIds = sim.graph.nets.map(net => net.id);
    snapshot = {
      netIds, componentIds: sim.graph.components.map(comp => comp.id),
      netIndex: new Map(netIds.map((id, index) => [id, index])),
      netsView: new Uint8Array(sim.graph.netValues),
    };
    return snapshot;
  };
  let reply!: () => void;
  const setInput = vi.fn(async (id: string, pin: string, value: NetState) => {
    sim.setComponentInput(id, pin, value);
    sim.settle();
    sync();
  });
  const bus: WorkerBus = {
    load: async next => load(next),
    mutate: next => {
      const loaded = load(next);
      return new Promise(resolve => { reply = () => resolve(loaded); });
    },
    setInput, setNetInput: async () => {},
    run: async () => {}, pause: async () => {}, step: async () => {},
    on: () => () => {}, readNet: id => sim.readNet(id), netIds: [], componentIds: [],
  };
  const editor = new EditorModel(bus, circuit, load(circuit));
  const host = new TestElement();
  const unmount = mountSchematic(host as unknown as HTMLElement, editor);
  const flush = async (): Promise<void> => {
    await editor.whenIdle();
    // Allow promise continuations in the input handler to complete too.
    await Promise.resolve();
  };
  return { editor, host, bus, setInput, flush, reply: () => reply(), unmount };
};

afterEach(() => vi.unstubAllGlobals());

const switches: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'switch ordering',
  components: [{ id: 'switch1', type: 'io.switch' }],
  nets: [{ id: 'out', endpoints: ['switch1.Y'] }],
};
const clickSwitch = (host: TestElement): void => host.querySelector('[data-comp-id="switch1"]')!.click();
const label = (host: TestElement): string => host.querySelector('[data-role="switch-label"]')!.textContent;

describe('schematic switch clicks', () => {
  it('agrees with the live net after a toggle during a pending rename and on the next click', async () => {
    const h = mount(switches);
    try {
      expect(label(h.host)).toBe('0');
      const rename = h.editor.updateComponent('switch1', { label: 'renamed' });
      await Promise.resolve();
      clickSwitch(h.host);
      h.reply();
      await rename;
      await h.flush();
      expect(h.bus.readNet('out')).toBe(1);
      expect(label(h.host)).toBe('1');
      clickSwitch(h.host);
      await h.flush();
      expect(h.bus.readNet('out')).toBe(0);
      expect(label(h.host)).toBe('0');
      expect(h.setInput.mock.calls.map(call => call[2])).toEqual([1, 0]);
    } finally { h.unmount(); }
  });

  it('preserves toggle order across a pending edit and local re-renders', async () => {
    const h = mount(switches);
    try {
      const rename = h.editor.updateComponent('switch1', { label: 'renamed' });
      await Promise.resolve();
      clickSwitch(h.host);
      h.editor.select('switch1');
      clickSwitch(h.host);
      h.reply();
      await rename;
      await h.flush();
      expect(h.setInput.mock.calls.map(call => call[2])).toEqual([1, 0]);
      expect(label(h.host)).toBe('0');
      expect(h.bus.readNet('out')).toBe(0);
      clickSwitch(h.host);
      await h.flush();
      expect(label(h.host)).toBe('1');
      expect(h.bus.readNet('out')).toBe(1);
    } finally { h.unmount(); }
  });

  it('waits for every structural edit requested before the toggle', async () => {
    const h = mount(switches);
    try {
      const rename = h.editor.updateComponent('switch1', { label: 'renamed' });
      const move = h.editor.updateComponent('switch1', { position: [100, 100] });
      await Promise.resolve();
      clickSwitch(h.host);
      h.reply();
      await rename;
      await Promise.resolve();
      expect(h.setInput).not.toHaveBeenCalled();
      h.reply();
      await move;
      await h.flush();
      expect(label(h.host)).toBe('1');
      expect(h.bus.readNet('out')).toBe(1);
      expect(h.editor.state.circuit.components[0]!.position).toEqual([100, 100]);
    } finally { h.unmount(); }
  });

  it('resets a completed toggle on a later structural reload', async () => {
    const h = mount(switches);
    try {
      clickSwitch(h.host);
      await h.flush();
      expect(label(h.host)).toBe('1');
      const rename = h.editor.updateComponent('switch1', { label: 'renamed' });
      await Promise.resolve();
      h.reply();
      await rename;
      expect(label(h.host)).toBe('0');
      expect(h.bus.readNet('out')).toBe(0);
    } finally { h.unmount(); }
  });

  it('keeps the display and net LOW when an input request fails', async () => {
    const h = mount(switches);
    try {
      h.setInput.mockRejectedValueOnce(new Error('input rejected'));
      clickSwitch(h.host);
      await h.flush();
      expect(h.editor.state.error).toBe('input rejected');
      expect(label(h.host)).toBe('0');
      expect(h.bus.readNet('out')).toBe(0);
    } finally { h.unmount(); }
  });
});

it('renders a wiring handle for a __proto__ input when a NOT chip is created and reopened', async () => {
  const source: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'prototype port',
    components: [...switches.components, { id: 'inv', type: 'prim.NOT' }, { id: 'led', type: 'io.led' }],
    nets: [
      { id: 'input', endpoints: ['switch1.Y', 'inv.A'] },
      { id: 'output', endpoints: ['inv.Y', 'led.A'] },
    ],
  };
  const selected = new Set(['inv']);
  const ports = chipSelection(source, selected).body.ports!.map(port =>
    port.dir === 'in' ? { ...port, name: '__proto__' } : port);
  const created = createChip(source, selected, 'ProtoNot', ports);
  for (const circuit of [created, JSON.parse(JSON.stringify(created)) as CircuitJSON]) {
    const h = mount(circuit);
    try {
      expect(h.bus.readNet('output')).toBe(1);
      expect(h.host.querySelector('[data-pin="protonot1.__proto__"]')).not.toBeNull();
      expect(h.host.querySelector('[data-net-id="input"]')).not.toBeNull();
      clickSwitch(h.host);
      await h.flush();
      expect(h.bus.readNet('output')).toBe(0);
    } finally { h.unmount(); }
  }
});
