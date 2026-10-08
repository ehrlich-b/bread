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
import sap1 from '../../../examples/ben_eater_8bit.json';

// Only the DOM surface used by these real renderers and click handlers. No
// browser, replacement view logic or production dependencies are needed.
class TestElement extends EventTarget {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly captures = new Set<number>();
  attributeWrites = 0;
  readonly classList = { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() };
  textContent = '';
  set innerHTML(_value: string) { this.children.length = 0; }
  setAttribute(name: string, value: string): void {
    this.attributeWrites++;
    this.attrs.set(name, value);
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
    }
  }
  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] ?? null;
    return this.attrs.get(name) ?? null;
  }
  private matches(selector: string): boolean {
    if (selector === 'svg[data-role="canvas"]') return this.dataset.role === 'canvas';
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
  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
  getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10 }; }
  getScreenCTM() {
    const [x, y, width] = (this.getAttribute('viewBox') ?? '0 0 600 320').split(' ').map(Number);
    const scale = 600 / width!;
    return { a: scale, d: scale, inverse: () => ({ a: 1 / scale, d: 1 / scale, e: x!, f: y! }) };
  }
  createSVGPoint() {
    return { x: 0, y: 0, matrixTransform(matrix: { a: number; d: number; e: number; f: number }) {
      return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f };
    } };
  }
  remove(): void {}
  click(): void { this.dispatchEvent(new Event('click')); }
}

const mount = (circuit: CircuitJSON) => {
  const document = new TestElement();
  vi.stubGlobal('document', Object.assign(document, {
    body: new TestElement(), createElementNS: () => new TestElement(), createElement: () => new TestElement(),
  }));
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('MouseEvent', class extends Event {
    constructor(type: string, init: MouseEventInit) {
      super(type, init); Object.assign(this, { clientX: init.clientX, clientY: init.clientY });
    }
  });
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
    testbench: async () => { throw new Error('Unexpected testbench call'); },
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

const pointer = (surface: EventTarget, type: string, target: TestElement, x: number, y: number, id = 1, pointerType = 'touch'): void => {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  Object.assign(event, { pointerType, pointerId: id, clientX: x, clientY: y });
  surface.dispatchEvent(event);
};
const touchCircuit: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'touch edits',
  components: [{ id: 'buf', type: 'prim.BUF', position: [100, 100] }], nets: [],
};

describe('schematic touch editor actions', () => {
  it('suppresses compatibility clicks while allowing a subsequent real mouse click', () => {
    const h = mount(touchCircuit);
    try {
      const svg = h.host.querySelector('[data-role="canvas"]')!;
      const group = h.host.querySelector('[data-comp-id="buf"]')!;
      pointer(svg, 'pointerdown', group, 120, 120);
      pointer(document, 'pointercancel', group, 120, 120);
      const clicked = vi.fn(); h.host.addEventListener('click', clicked);
      const click = (pointerType: string): void => {
        const event = new Event('click', { cancelable: true });
        Object.defineProperties(event, { isTrusted: { value: true }, target: { value: svg } });
        Object.assign(event, { pointerType, detail: 1 }); h.host.dispatchEvent(event);
      };
      click('touch'); click(''); expect(clicked).not.toHaveBeenCalled();
      // Some browsers expose a MouseEvent rather than a PointerEvent for
      // click. Its preceding mouse pointerdown still identifies real input.
      pointer(h.host, 'pointerdown', svg, 120, 120, 2, 'mouse');
      click(''); expect(clicked).toHaveBeenCalledTimes(1);
    } finally { h.unmount(); }
  });

  it('selects with a tap and leaves history unchanged', () => {
    const h = mount(touchCircuit);
    try {
      const svg = h.host.querySelector('[data-role="canvas"]')!;
      const group = h.host.querySelector('[data-comp-id="buf"]')!;
      pointer(svg, 'pointerdown', group, 120, 120);
      pointer(document, 'pointerup', group, 120, 120);
      expect([...h.editor.state.selection]).toEqual(['buf']);
      expect(h.editor.canUndo()).toBe(false);
    } finally { h.unmount(); }
  });

  it('reuses switch toggling on a tap', async () => {
    const h = mount(switches);
    try {
      const svg = h.host.querySelector('[data-role="canvas"]')!;
      const group = h.host.querySelector('[data-comp-id="switch1"]')!;
      pointer(svg, 'pointerdown', group, 35, 20);
      pointer(document, 'pointerup', group, 35, 20);
      await h.flush();
      expect(h.bus.readNet('out')).toBe(1);
      expect(h.setInput.mock.calls.map(call => call[2])).toEqual([1]);
    } finally { h.unmount(); }
  });

  it('commits a snapped move only on release and undoes it in one step', async () => {
    const h = mount(touchCircuit);
    try {
      const svg = h.host.querySelector('[data-role="canvas"]')!;
      const group = h.host.querySelector('[data-comp-id="buf"]')!;
      pointer(svg, 'pointerdown', group, 120, 120);
      pointer(document, 'pointermove', group, 145, 137);
      expect(group.getAttribute('transform')).toBe('translate(125 117)');
      expect(h.editor.state.circuit.components[0]!.position).toEqual([100, 100]);
      expect(h.editor.canUndo()).toBe(false);
      pointer(document, 'pointerup', group, 149, 141);
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.state.circuit.components[0]!.position).toEqual([130, 120]);
      const undo = h.editor.undo(); await Promise.resolve(); h.reply(); await undo;
      expect(h.editor.state.circuit.components[0]!.position).toEqual([100, 100]);
      expect(h.editor.canUndo()).toBe(false);
    } finally { h.unmount(); }
  });

  it.each(['pointercancel', 'second finger'])('restores a move preview on %s without a mutation', reason => {
    const h = mount(touchCircuit);
    try {
      const svg = h.host.querySelector('[data-role="canvas"]')!;
      const group = h.host.querySelector('[data-comp-id="buf"]')!;
      pointer(svg, 'pointerdown', group, 120, 120);
      pointer(document, 'pointermove', group, 150, 140);
      expect(group.getAttribute('transform')).toBe('translate(130 120)');
      if (reason === 'pointercancel') pointer(document, 'pointercancel', group, 150, 140);
      else {
        pointer(svg, 'pointerdown', svg, 250, 140, 2);
        pointer(document, 'pointerup', svg, 250, 140, 2);
      }
      pointer(document, 'pointerup', group, 150, 140);
      expect(group.getAttribute('transform')).toBe('translate(100 100)');
      expect(h.editor.state.circuit.components[0]!.position).toEqual([100, 100]);
      expect(h.editor.canUndo()).toBe(false); expect(h.editor.state.selection.size).toBe(0);
    } finally { h.unmount(); }
  });

  it('places at the tap coordinate through the ordinary placement handler', async () => {
    const h = mount(touchCircuit);
    try {
      h.editor.setPlacement('prim.BUF');
      const svg = h.host.querySelector('[data-role="canvas"]')!;
      pointer(svg, 'pointerdown', svg, 310, 200);
      pointer(document, 'pointerup', svg, 310, 200);
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.state.circuit.components[1]).toEqual({ id: 'buf1', type: 'prim.BUF', position: [290, 180] });
      expect(h.editor.state.placement).toBeNull();
    } finally { h.unmount(); }
  });
});

describe('schematic circuit IDs', () => {
  it.each(['io.led', 'io.7seg'])('renders and updates %s with CSS-special IDs', type => {
    const id = 'bad"id\\[value]\n🍞';
    const pin = type === 'io.led' ? 'A' : 'a';
    const role = type === 'io.led' ? 'led' : 'seg-a';
    const h = mount({
      ...switches,
      components: [...switches.components, { id, type }],
      nets: [{ id: 'out', endpoints: ['switch1.Y', `${id}.${pin}`] }],
    });
    try {
      const frame = vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0]!;
      const indicator = h.host.querySelector(`[data-role="${role}"]`)!;
      frame(0);
      expect(indicator.getAttribute('fill')).toBe(type === 'io.led' ? 'var(--led-off)' : 'var(--seg-off)');
      h.editor.state.snapshot.netsView[h.editor.state.snapshot.netIndex.get('out')!] = 1;
      frame(0);
      expect(indicator.getAttribute('fill')).toBe(type === 'io.led' ? 'var(--led-on)' : 'var(--seg-on)');
      h.editor.select(id);
      expect(h.editor.state.selection.has(id)).toBe(true);
    } finally { h.unmount(); }
  });

  it('cancels a wire from a CSS-special endpoint without a selector', () => {
    const id = 'bad"id\\[value]\n🍞';
    const h = mount({ ...switches, components: [{ id, type: 'prim.BUF' }], nets: [] });
    try {
      const pin = h.host.querySelector('[data-role="pin"]')!;
      pin.click();
      expect(pin.classList.add).toHaveBeenCalledWith('pin-active');
      pin.click();
      expect(pin.classList.remove).toHaveBeenCalledWith('pin-active');
      expect(h.editor.canUndo()).toBe(false);
    } finally { h.unmount(); }
  });
});

describe('schematic rotated wire endpoints', () => {
  for (const type of ['prim.BUF', 'prim.DFF']) {
    it.each([0, 90, 180, 270])(`matches rendered ${type} pin geometry at %s degrees`, rotation => {
      const input = type === 'prim.BUF' ? 'A' : 'D';
      const output = type === 'prim.BUF' ? 'Y' : 'Q';
      const h = mount({
        ...switches,
        components: [{ id: 'source', type: 'prim.BUF', position: [0, 100] }, { id: 'rotated', type, position: [100, 100], rotation }, { id: 'sink', type: 'prim.BUF', position: [300, 100] }],
        nets: [{ id: 'input', endpoints: ['source.Y', `rotated.${input}`] }, { id: 'output', endpoints: [`rotated.${output}`, 'sink.A'] }],
      });
      try {
        const group = h.host.querySelector('[data-comp-id="rotated"]')!;
        const cx = type === 'prim.BUF' ? 20 : 35;
        const cy = type === 'prim.BUF' ? 20 : 30;
        expect(group.getAttribute('transform')).toBe(rotation === 0 ? 'translate(100 100)' : `translate(100 100) rotate(${rotation} ${cx} ${cy})`);
        // SVG quarter-turn matrices in screen coordinates (positive y down).
        const [a, b, c, d] = new Map([
          [0, [1, 0, 0, 1]], [90, [0, 1, -1, 0]],
          [180, [-1, 0, 0, -1]], [270, [0, -1, 1, 0]],
        ]).get(rotation)!;
        for (const [net, pinName, end] of [['input', input, -1], ['output', output, 0]] as const) {
          const pin = group.querySelector(`[data-pin="rotated.${pinName}"]`)!;
          const dx = Number(pin.getAttribute('cx')) - cx;
          const dy = Number(pin.getAttribute('cy')) - cy;
          const rendered = [100 + cx + a! * dx + c! * dy, 100 + cy + b! * dx + d! * dy];
          const points = h.host.querySelector(`[data-net-id="${net}"]`)!.getAttribute('points')!.split(' ');
          const endpoint = points.at(end)!.split(',').map(Number);
          expect(endpoint[0]).toBeCloseTo(rendered[0]!);
          expect(endpoint[1]).toBeCloseTo(rendered[1]!);
        }
      } finally { h.unmount(); }
    });
  }
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

const bundled: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'grouped counter',
  components: [
    { id: 'source', type: 'prim.COUNTER', params: { width: 8 }, position: [40, 40] },
    { id: 'target', type: 'prim.MUX2', params: { width: 8 }, position: [350, 40] },
    { id: 'led', type: 'io.led', position: [250, 300] },
  ],
  nets: Array.from({ length: 8 }, (_, bit) => ({ id: `bit${bit}`, endpoints: [`source.Q${bit}`, `target.A${bit}`] })),
};
const elements = (root: TestElement): TestElement[] => root.children.flatMap(child => [child, ...elements(child)]);
const frame = (): void => { vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](0); };
const toggleGroups = (host: TestElement): void => { host.children.find(child => child.textContent === 'Group wires')!.click(); };

describe('grouped schematic rendering', () => {
  it('toggles only the view, retains selection and undo history, and keeps the preference across edits', async () => {
    const h = mount(bundled);
    try {
      h.editor.select('target');
      const before = h.editor.project; const snapshot = h.editor.state.snapshot;
      expect(h.host.querySelector('[data-role="wire-bundle"]')!.dataset.width).toBe('8');
      toggleGroups(h.host);
      expect(h.host.querySelector('[data-role="wire-bundle"]')).toBeNull();
      expect(h.host.children.find(child => child.textContent === 'Group wires')!.getAttribute('aria-pressed')).toBe('false');
      expect(h.editor.project).toEqual(before); expect(h.editor.state.snapshot).toBe(snapshot);
      expect(h.editor.state.selection).toEqual(new Set(['target']));
      expect(h.editor.canUndo()).toBe(false);
      const edit = h.editor.updateComponent('target', { label: 'destination' });
      await Promise.resolve(); h.reply(); await edit;
      expect(h.host.querySelector('[data-role="wire-bundle"]')).toBeNull();
      toggleGroups(h.host);
      expect(h.host.querySelector('[data-role="wire-bundle"]')!.dataset.width).toBe('8');
      expect(h.editor.canUndo()).toBe(true);
    } finally { h.unmount(); }
  });

  it('shows live hex and distinct X/Z states without writing unchanged wire attributes each frame', () => {
    const h = mount(bundled);
    try {
      const { snapshot } = h.editor.state;
      const bundle = h.host.querySelector('[data-role="wire-bundle"]')!;
      const label = h.host.querySelector('[data-role="wire-bundle-label"]')!;
      const set = (bits: number[]): void => {
        bits.forEach((value, bit) => { snapshot.netsView[snapshot.netIndex.get(`bit${bit}`)!] = value; }); frame();
      };
      set([0, 1, 0, 1, 0, 1, 0, 0]);
      expect(label.textContent).toBe('/8 0x2A');
      expect(bundle.dataset.binary).toBe('00101010');
      expect(bundle.getAttribute('class')).toBe('wire wire-bus');
      expect(h.host.querySelector('[data-net-id="bit1"]')!.getAttribute('class')).toBe('wire wire-1');
      const writes = elements(h.host).reduce((sum, el) => sum + el.attributeWrites, 0);
      frame();
      // The unwired LED is skipped; wire geometry and values stay untouched.
      expect(elements(h.host).reduce((sum, el) => sum + el.attributeWrites, 0) - writes).toBe(0);
      set(Array(8).fill(2));
      expect(label.textContent).toBe('/8 ZZ'); expect(bundle.getAttribute('class')).toBe('wire wire-bus wire-Z');
      set([3, 0, 0, 0, 0, 0, 0, 0]);
      expect(label.textContent).toBe('/8 0X'); expect(bundle.getAttribute('class')).toBe('wire wire-bus wire-X');
      set([2, 0, 0, 0, 0, 0, 0, 0]);
      expect(label.textContent).toBe('/8 0?'); expect(bundle.dataset.binary).toBe('0000000Z');
      expect(bundle.getAttribute('class')).toBe('wire wire-bus wire-Z');
    } finally { h.unmount(); }
  });

  it('probes the exact fan-out bit, saves ordinary nets and restores the probe through undo/redo', async () => {
    const h = mount(bundled);
    try {
      h.editor.setProbing('net');
      const svg = h.host.children[0]!; const wire = h.host.querySelector('[data-net-id="bit3"]')!;
      expect(wire.dataset.role).toBe('wire-bit');
      const click = new Event('click'); Object.defineProperty(click, 'target', { value: wire }); svg.dispatchEvent(click);
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.project.probes).toEqual([{ id: 'probe1', label: 'bit3', nets: ['bit3'] }]);
      expect(h.host.querySelector('[data-net-id="bit3"]')!.dataset.probed).toBe('true');
      expect(h.host.querySelector('[data-role="wire-bundle"]')!.dataset.probed).toBe('true');
      expect(h.editor.project.nets).toEqual(bundled.nets);
      const saved = JSON.parse(JSON.stringify(h.editor.project));
      expect(saved).not.toHaveProperty('wireGroups');
      const undo = h.editor.undo(); await Promise.resolve(); h.reply(); await undo;
      expect(h.editor.project.probes).toBeUndefined();
      const redo = h.editor.redo(); await Promise.resolve(); h.reply(); await redo;
      expect(h.editor.project.probes).toEqual(saved.probes);
    } finally { h.unmount(); }
  });

  it('edits a grouped bit using its original pin, preserves fan-out and restores the bundle through undo/redo', async () => {
    const h = mount(bundled);
    try {
      const group = h.host.querySelector('[data-wire-group]')!.dataset.wireGroup;
      h.host.querySelector('[data-pin="target.A3"]')!.click(); h.host.querySelector('[data-pin="led.A"]')!.click();
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.project.nets.find(net => net.id === 'bit3')!.endpoints).toEqual(['source.Q3', 'target.A3', 'led.A']);
      expect(h.host.querySelector('[data-wire-group]')!.dataset.wireGroup).toBe(group);
      const undo = h.editor.undo(); await Promise.resolve(); h.reply(); await undo;
      expect(h.editor.project.nets).toEqual(bundled.nets);
      const redo = h.editor.redo(); await Promise.resolve(); h.reply(); await redo;
      expect(h.editor.project.nets.find(net => net.id === 'bit3')!.endpoints).toContain('led.A');
    } finally { h.unmount(); }
  });

  it('reduces SAP-1 wire paths and performs no wire attribute writes on an unchanged frame', () => {
    const h = mount(sap1 as CircuitJSON);
    try {
      const paths = () => elements(h.host).filter(el => el.getAttribute('class')?.startsWith('wire '));
      const groupedPaths = paths().length;
      expect(elements(h.host).filter(el => el.dataset.wireGroup)).toHaveLength(5);
      expect(groupedPaths).toBe(99);
      frame();
      const wires = paths(); const writes = wires.reduce((sum, el) => sum + el.attributeWrites, 0);
      frame();
      expect(wires.reduce((sum, el) => sum + el.attributeWrites, 0)).toBe(writes);
      toggleGroups(h.host);
      expect(paths()).toHaveLength(135);
    } finally { h.unmount(); }
  });

  it('retains the pending pin connection while toggling the wire layer', async () => {
    const h = mount(bundled);
    try {
      const pin = h.host.querySelector('[data-pin="source.Q3"]')!;
      const svg = h.host.children[0]!;
      pin.click(); toggleGroups(h.host); toggleGroups(h.host);
      expect(h.host.children[0]).toBe(svg);
      expect(h.host.querySelector('[data-pin="source.Q3"]')).toBe(pin);
      h.host.querySelector('[data-pin="led.A"]')!.click();
      await Promise.resolve(); h.reply(); await h.flush();
      expect(h.editor.project.nets.find(net => net.id === 'bit3')!.endpoints).toContain('led.A');
    } finally { h.unmount(); }
  });

  it.each([
    [0, 140, 62, 1, 0], [90, 141, 163, 0, 1], [180, 40, 164, -1, 0], [270, 39, 63, 0, -1],
  ])('attaches fans to the displayed pins after a %d degree rotation', (rotation, x, y, dx, dy) => {
    const h = mount({ ...bundled, components: bundled.components.map(comp => comp.id === 'source' ? { ...comp, rotation } : comp) });
    try {
      const path = h.host.querySelector('[data-net-id="bit0"]')!.getAttribute('d')!;
      const first = /^M (\S+) (\S+) L (\S+) (\S+)/.exec(path)!;
      expect(Number(first[1])).toBeCloseTo(x!); expect(Number(first[2])).toBeCloseTo(y!);
      expect(Number(first[3])).toBeCloseTo(x! + 12 * dx!); expect(Number(first[4])).toBeCloseTo(y! + 12 * dy!);
    } finally { h.unmount(); }
  });
});
