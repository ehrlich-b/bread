import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../engine/index';
import type { CircuitJSON, NetState } from '../../engine/ir';
import { loadCircuit } from '../../engine/loader';
import { Simulator } from '../../engine/sim';
import type { LoadSnapshot, WorkerBus } from '../bus';
import { EditorModel } from '../editor';
import { mountControls } from '../controls';
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
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
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
    sim = new Simulator(loadCircuit(next), { rateHz: 1000 });
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
    run: async () => {}, pause: async () => {}, step: async () => { sim.tick(); sync(); },
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

describe('simulation controls waiting for editor actions', () => {
  it('samples a queued enable toggle before Step after a delayed rename', async () => {
    const circuit: CircuitJSON = {
      version: 1, kind: 'circuit', name: 'enabled clock',
      components: [
        { id: 'switch1', type: 'io.switch' },
        { id: 'data', type: 'prim.CONST_1' },
        { id: 'clk', type: 'gen.clock', params: { freqHz: 500 } },
        { id: 'ff', type: 'prim.DFF', params: { initialQ: 0, enable: true } },
      ],
      nets: [
        { id: 'enable', endpoints: ['switch1.Y', 'ff.EN'] },
        { id: 'data', endpoints: ['data.Y', 'ff.D'] },
        { id: 'clk', endpoints: ['clk.Y', 'ff.CLK'] },
        { id: 'q', endpoints: ['ff.Q'] },
      ],
    };
    const h = mount(circuit);
    const controls = new TestElement();
    const unmountControls = mountControls(controls as unknown as HTMLElement, h.editor);
    const calls: string[] = [];
    const mutate = h.bus.mutate;
    const step = h.bus.step;
    vi.spyOn(h.bus, 'mutate').mockImplementation(next => { calls.push('mutate'); return mutate(next); });
    const setInput = h.setInput.getMockImplementation()!;
    h.setInput.mockImplementation(async (...args) => { calls.push('set_input'); await setInput(...args); });
    vi.spyOn(h.bus, 'step').mockImplementation(async () => { calls.push('step'); await step(); });
    try {
      const rename = h.editor.updateComponent('switch1', { label: 'renamed' });
      await Promise.resolve();
      clickSwitch(h.host);
      controls.children.find(child => child.textContent === 'Step')!.click();
      h.reply();
      await rename;
      await h.flush();
      expect(calls).toEqual(['mutate', 'set_input', 'step']);
      expect(h.bus.readNet('q')).toBe(1);
    } finally { unmountControls(); h.unmount(); }
  });

  it.each(['Run', 'Pause'] as const)('orders %s after a toggle and before a later edit', async (label) => {
    const h = mount(switches);
    const controls = new TestElement();
    const unmountControls = mountControls(controls as unknown as HTMLElement, h.editor);
    const calls: string[] = [];
    const mutate = h.bus.mutate;
    let loaded = 0;
    let secondLoaded!: () => void;
    const secondLoad = new Promise<void>(resolve => { secondLoaded = resolve; });
    vi.spyOn(h.bus, 'mutate').mockImplementation(next => {
      calls.push('mutate');
      const pending = mutate(next);
      if (++loaded === 2) secondLoaded();
      return pending;
    });
    h.setInput.mockImplementation(async () => { calls.push('set_input'); });
    vi.spyOn(h.bus, label === 'Run' ? 'run' : 'pause').mockImplementation(async () => { calls.push(label.toLowerCase()); });
    try {
      const rename = h.editor.updateComponent('switch1', { label: 'first' });
      await Promise.resolve();
      clickSwitch(h.host);
      controls.children.find(child => child.textContent === label)!.click();
      const later = h.editor.updateComponent('switch1', { label: 'second' });
      h.reply();
      await rename;
      await secondLoad;
      expect(calls).toEqual(['mutate', 'set_input', label.toLowerCase(), 'mutate']);
      h.reply();
      await later;
      await h.flush();
    } finally { unmountControls(); h.unmount(); }
  });
});


describe('canvas probe attachment', () => {
  it('attaches to a pin and removes the probe with undo and restores it with redo', async () => {
    const h = mount(switches);
    try {
      h.editor.setProbing('net');
      h.host.querySelector('[data-pin="switch1.Y"]')!.click();
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.project.probes).toEqual([{ id: 'probe1', label: 'switch1.Y', nets: ['out'] }]);
      expect(h.editor.state.probing).toBeNull();
      expect(h.host.querySelector('[data-pin="switch1.Y"]')!.dataset.probed).toBe('true');
      const undo = h.editor.undo(); await Promise.resolve(); h.reply(); await undo;
      expect(h.editor.project.probes).toBeUndefined();
      const redo = h.editor.redo(); await Promise.resolve(); h.reply(); await redo;
      expect(h.editor.project.probes?.[0]?.nets).toEqual(['out']);
    } finally { h.unmount(); }
  });
  it('attaches to a wire through the canvas click handler and to an unwired byte bus', async () => {
    const circuit: CircuitJSON = {
      ...switches,
      components: [...switches.components, { id: 'led', type: 'io.led' }, { id: 'rom', type: 'mem.ROM', params: { addressBits: 2, dataBits: 8 } }],
      nets: [{ id: 'out', endpoints: ['switch1.Y', 'led.A'] }],
    };
    const h = mount(circuit);
    try {
      h.editor.setProbing('net');
      const svg = h.host.children[0]!; const wire = h.host.querySelector('[data-net-id="out"]')!;
      const click = new Event('click'); Object.defineProperty(click, 'target', { value: wire }); svg.dispatchEvent(click);
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.project.probes?.[0]).toEqual({ id: 'probe1', label: 'out', nets: ['out'] });
      h.editor.setProbing('bus'); h.host.querySelector('[data-pin="rom.D0"]')!.click();
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.project.probes?.[1]?.label).toBe('rom.D[7:0]');
      expect(h.editor.project.probes?.[1]?.nets).toEqual(Array.from({ length: 8 }, (_, bit) => `__floating__rom__D${bit}`));
    } finally { h.unmount(); }
  });
});
