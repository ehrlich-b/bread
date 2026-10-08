import { afterEach, expect, it, vi } from 'vitest';
import '../engine/index';
import type { CircuitJSON } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import { ProbeCapture, type WaveformSnapshot } from '../engine/probes';
import { Simulator } from '../engine/sim';
import { runTestbench } from '../engine/testbench';
import type { MetricsNotif } from '../worker/protocol';
import type { LoadSnapshot, WorkerBus } from './bus';
import { EditorModel } from './editor';
import { TUTORIAL_STORAGE_KEY, tutorialCircuit } from './tutorial';
import { mountTutorial } from './tutorial_view';
import { mountWaveform } from './waveform_view';

// Exercise panel events and editor ordering with the real simulator, without
// a browser or a DOM dependency. The canvas only supplies component groups.
class TestElement extends EventTarget {
  children: TestElement[] = [];
  dataset: Record<string, string | undefined> = {};
  attributes = new Map<string, string>();
  textContent = ''; hidden = false; disabled = false; id = ''; className = ''; tabIndex = 0;
  focused = false;
  constructor(readonly tag: string) { super(); }
  clientWidth = 600; scrollLeft = 0;
  append(...children: TestElement[]): void { this.children.push(...children); }
  prepend(...children: TestElement[]): void { this.children.unshift(...children); }
  replaceChildren(...children: TestElement[]): void { this.children = children; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  focus(): void { this.focused = true; }
  remove(): void {}
  click(): void { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  find(predicate: (element: TestElement) => boolean): TestElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
  querySelectorAll(): TestElement[] { return this.children.filter(child => child.dataset.compId); }
  querySelector(): TestElement | null { return this.find(child => child.className === 'schematic-fit') ?? null; }
}

async function setup(hash = '#tutorial', saved?: string) {
  const header = new TestElement('header'); const canvas = new TestElement('section');
  const host = new TestElement('section'); host.id = 'tutorial';
  const values = new Map<string, string>(); if (saved) values.set(TUTORIAL_STORAGE_KEY, saved);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const window = Object.assign(new EventTarget(), { location: { hash }, localStorage: storage });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { createElement: (tag: string) => new TestElement(tag), createElementNS: (_ns: string, tag: string) => new TestElement(tag), querySelector: () => header });
  let sim!: Simulator;
  let capture: ProbeCapture | null = null;
  let ticks = 0;
  let running = false;
  let body = '';
  let snapshot!: LoadSnapshot;
  const handlers = new Map<string, Set<(value: never) => void>>();
  const emit = (event: string, value: MetricsNotif | WaveformSnapshot | null): void => {
    for (const handler of handlers.get(event) ?? []) handler(value as never);
  };
  const metrics = (): void => emit('metrics', { type: 'metrics', running, ticks, targetRateHz: 1000, actualRateHz: running ? 1000 : 0 });
  const record = (): void => { capture?.record(ticks, sim.graph.netValues); bus.waveform = capture?.snapshot() ?? null; emit('waveform', bus.waveform); };
  const adopt = (circuit: CircuitJSON, preserve = false): LoadSnapshot => {
    const { probes: _probes, ...nextBody } = circuit;
    const preserved = preserve && body === JSON.stringify(nextBody);
    if (!preserved) {
      sim = new Simulator(loadCircuit(circuit), { rateHz: 1000 }); sim.settle(); ticks = 0;
      body = JSON.stringify(nextBody); metrics();
      const groups = circuit.components.map(component => { const group = new TestElement('g'); group.dataset.compId = component.id; return group; });
      const fit = new TestElement('button'); fit.className = 'schematic-fit'; canvas.replaceChildren(...groups, fit);
    }
    capture = circuit.probes?.length ? new ProbeCapture(circuit.probes, sim.graph) : null;
    snapshot = { netIds: sim.graph.nets.map(net => net.id), componentIds: sim.graph.components.map(c => c.id), netIndex: sim.graph.netById, netsView: sim.graph.netValues, preserved };
    record(); return snapshot;
  };
  const bus: WorkerBus = {
    netIds: [], componentIds: [],
    load: async circuit => adopt(circuit), mutate: async (circuit, preserve) => adopt(circuit, preserve),
    run: async () => { running = true; metrics(); },
    pause: async () => { running = false; record(); metrics(); },
    step: async () => { sim.tick(); ticks++; record(); metrics(); },
    setInput: async (component, pin, value) => { sim.setComponentInput(component, pin, value); sim.settle(); record(); },
    setNetInput: async (net, value) => { sim.setInput(net, value); sim.settle(); record(); },
    readNet: net => sim.readNet(net),
    testbench: async (circuit, bench) => runTestbench(circuit, bench, { capture: true }),
    on: (event: string, handler: (value: never) => void) => {
      const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set);
      return () => { set.delete(handler); };
    },
  } as WorkerBus;
  const initial: CircuitJSON = { version: 1, kind: 'circuit', name: 'previous work', components: [], nets: [] };
  const editor = new EditorModel(bus, initial, adopt(initial));
  const dispose = mountTutorial(host as unknown as HTMLElement, editor, canvas as unknown as HTMLElement);
  const label = (name: string): TestElement => host.find(child => child.attributes.get('aria-label') === name)!;
  const button = (name: string): TestElement => host.find(child => child.tag === 'button' && child.textContent === name)!;
  const ready = async (): Promise<void> => { await vi.waitFor(() => expect(label('Tutorial completion').textContent).not.toBe('Loading…')); };
  if (hash === '#tutorial') await ready();
  return { host, header, canvas, editor, bus, initial, dispose, label, button, ready, values, window };
}
afterEach(() => vi.unstubAllGlobals());

it('the panel grades simulator state, navigates, and keeps skipped steps separate', async () => {
  const h = await setup();
  try {
    expect(h.host.hidden).toBe(false);
    expect(h.canvas.find(group => group.dataset.compId === 'clk_gen')!.dataset.tutorialFocus).toBe('true');
    expect(h.button('Next step').disabled).toBe(true);
    await h.editor.step();
    expect(h.label('Tutorial live state').textContent).toContain('CLK 1');
    expect(h.button('Next step').disabled).toBe(true);
    await h.editor.run(1000); await h.editor.pause();
    expect(h.button('Next step').disabled).toBe(true);
    await h.editor.run(1000); await h.editor.step(); await h.editor.step(); await h.editor.pause();
    expect(h.button('Next step').disabled).toBe(false);
    h.button('Next step').click(); await h.ready();
    expect(h.label('Tutorial completion').textContent).toBe('Waiting for simulator state.');
    expect(h.button('Next step').disabled).toBe(true);
    h.button('Skip step').click(); await h.ready();
    expect(JSON.parse(h.values.get(TUTORIAL_STORAGE_KEY)!).results.slice(0, 3)).toEqual(['complete', 'skipped', 'pending']);
    h.button('Back step').click(); await h.ready();
    expect(h.button('Next step').disabled).toBe(true);
    h.button('Back step').click(); await h.ready(); h.button('Skip step').click(); await h.ready();
    expect(JSON.parse(h.values.get(TUTORIAL_STORAGE_KEY)!).results[0]).toBe('complete');
    h.button('Reset tutorial').click(); await h.ready();
    expect(JSON.parse(h.values.get(TUTORIAL_STORAGE_KEY)!).results).toEqual(new Array(7).fill('pending'));
  } finally { h.dispose(); }
});

it('stored completion cannot grade fresh state; the final button uses real testbench waveforms', async () => {
  const h = await setup('#tutorial', JSON.stringify({ step: 6, results: new Array(7).fill('complete') }));
  const focus = vi.fn(); const unsub = h.editor.onWaveformFocus(focus);
  try {
    expect(h.button('Finish tutorial').disabled).toBe(true);
    expect(h.button('Check Fibonacci').disabled).toBe(true);
    await h.editor.addPinProbe('display.OUT0', true);
    expect(h.button('Check Fibonacci').disabled).toBe(false);
    h.button('Check Fibonacci').click(); await h.ready();
    expect(h.label('Tutorial testbench result').textContent).toBe('PASS Fibonacci: 41/41 vectors');
    expect(h.label('Tutorial completion').textContent).toContain('233 in order.');
    expect(h.button('Finish tutorial').disabled).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    h.button('Finish tutorial').click(); expect(h.host.hidden).toBe(true);
    expect(h.canvas.children.some(group => group.dataset.tutorialFocus)).toBe(false);
  } finally { unsub(); h.dispose(); }
});

it.each(['run', 'step', 'pause'] as const)('Check Fibonacci respects a later %s command without focusing its historical waveform', async command => {
  const h = await setup('#tutorial', JSON.stringify({ step: 6, results: new Array(7).fill('pending') }));
  let release!: () => void; const testbench = h.bus.testbench;
  vi.spyOn(h.bus, 'testbench').mockImplementationOnce((circuit, bench) => new Promise(resolve => {
    release = () => resolve(testbench(circuit, bench));
  }));
  const focus = vi.fn(); const unsub = h.editor.onWaveformFocus(focus);
  const waveHost = new TestElement('section'); const disposeWaveform = mountWaveform(waveHost as unknown as HTMLElement, h.editor);
  let running = false; const unsubMetrics = h.bus.on('metrics', metrics => { running = metrics.running; });
  try {
    await h.editor.addPinProbe('display.OUT0', true);
    h.button('Check Fibonacci').click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const later = command === 'run' ? h.editor.run(1000) : h.editor[command]();
    const revision = h.editor.commandRevision;
    release(); await later; await h.ready();
    expect(h.editor.commandRevision).toBe(revision);
    expect(focus).not.toHaveBeenCalled();
    expect(running).toBe(command === 'run');
    expect(waveHost.find(element => element.attributes.get('aria-label') === 'Waveform capture')!.textContent).toContain(command === 'run' ? 'Running' : 'Paused');
    expect(h.label('Tutorial testbench result').textContent).toBe('PASS Fibonacci: 41/41 vectors');
    expect(h.button('Finish tutorial').disabled).toBe(false);
  } finally { unsub(); unsubMetrics(); disposeWaveform(); h.dispose(); }
});

it('circuit changes remove highlights and Restart recovers the lesson', async () => {
  const h = await setup();
  try {
    await h.editor.replaceCircuit(h.initial);
    expect(h.label('Tutorial completion').textContent).toBe('Circuit changed. Restart step to continue.');
    expect(h.button('Next step').disabled).toBe(true);
    expect(h.canvas.children.some(group => group.dataset.tutorialFocus)).toBe(false);
    h.button('Restart step').click(); await h.ready();
    expect(h.editor.project).toEqual(tutorialCircuit('clock'));
    expect(h.label('Tutorial completion').textContent).toBe('Waiting for simulator state.');
  } finally { h.dispose(); }
});

it('a later document action supersedes a tutorial load waiting for Pause', async () => {
  const h = await setup('');
  let release!: () => void;
  vi.spyOn(h.bus, 'pause').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  try {
    h.header.find(child => child.textContent === 'Tutorial')!.click();
    await Promise.resolve();
    const replacement: CircuitJSON = { ...h.initial, name: 'later file' };
    const load = h.editor.replaceCircuit(replacement); release(); await load; await h.ready();
    expect(h.editor.project).toEqual(replacement);
    expect(h.label('Tutorial completion').textContent).toBe('Circuit changed. Restart step to continue.');
  } finally { h.dispose(); }
});

it('probe-only edits preserve clock evidence but reloading the circuit clears it', async () => {
  const h = await setup();
  try {
    await h.editor.step(); await h.editor.addPinProbe('reg_a.CLK', false);
    await h.editor.run(1000); await h.editor.step(); await h.editor.pause();
    expect(h.button('Next step').disabled).toBe(false);
    await h.editor.replaceCircuit(h.editor.project);
    expect(h.button('Next step').disabled).toBe(true);
    expect(h.label('Tutorial completion').textContent).toBe('Waiting for simulator state.');
  } finally { h.dispose(); }
});

it('storage denial still allows opening, skipping, closing and resetting in memory', async () => {
  const h = await setup('');
  Object.defineProperty(h.window, 'localStorage', { get: () => { throw new Error('denied'); } });
  try {
    h.window.location.hash = '#tutorial'; h.window.dispatchEvent(new Event('hashchange')); await h.ready();
    h.button('Skip step').click(); await h.ready(); h.button('Close tutorial').click();
    h.header.find(child => child.textContent === 'Tutorial')!.click(); await h.ready();
    expect(h.host.find(child => child.tag === 'h2')!.textContent).toContain('2 / 7');
    h.button('Reset tutorial').click(); await h.ready();
    expect(h.host.find(child => child.tag === 'h2')!.textContent).toContain('1 / 7');
  } finally { h.dispose(); }
});
