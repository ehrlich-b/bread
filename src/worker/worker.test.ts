import { afterEach, expect, it, vi } from 'vitest';
import type { CircuitJSON } from '../engine/ir';
import type { WorkerReq, WorkerRes } from './protocol';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it('rejects a graph transaction without stopping the old run loop, and does not multiply loops on edits', async () => {
  let receive!: (e: { data: WorkerReq }) => void;
  const messages: WorkerRes[] = [];
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (message: WorkerRes) => messages.push(message) });
  const queued = vi.fn(); vi.stubGlobal('queueMicrotask', queued);
  await import('./worker');
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'stable', components: [{ id: 'sw', type: 'io.switch' }], nets: [{ id: 'signal', endpoints: ['sw.Y'] }] };
  receive({ data: { type: 'load', id: 1, circuit } });
  receive({ data: { type: 'run', id: 2, rateHz: 1000 } }); expect(queued).toHaveBeenCalledTimes(1);
  receive({ data: { type: 'mutate', id: 3, circuit: { ...circuit, components: [{ id: 'bad', type: 'missing' }] } } });
  expect(messages.at(-1)).toMatchObject({ type: 'err', id: 3 });
  receive({ data: { type: 'run', id: 4, rateHz: 1000 } }); expect(queued).toHaveBeenCalledTimes(1);
  receive({ data: { type: 'set_input', id: 5, component: 'sw', pin: 'Y', value: 1 } });
  expect(messages.at(-1)).toMatchObject({ type: 'ack', id: 5 });
  const load = messages.find((m) => m.type === 'load_res'); if (load?.type !== 'load_res') throw new Error('missing snapshot');
  expect(new Uint8Array(load.netsBuffer)[0]).toBe(1);
  receive({ data: { type: 'mutate', id: 6, circuit } }); expect(messages.at(-1)).toMatchObject({ type: 'load_res', id: 6 });
  expect(queued).toHaveBeenCalledTimes(1);
  receive({ data: { type: 'set_net_input', id: 7, net: 'signal', value: 1 } });
  expect(messages.at(-1)).toMatchObject({ type: 'ack', id: 7 });
  receive({ data: { type: 'pause', id: 8 } });
});

it('invalidates a pending timer chain across pause and resume', async () => {
  let receive!: (e: { data: WorkerReq }) => void;
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: () => {} });
  const microtasks: Array<() => void> = []; const timers: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (fn: () => void) => microtasks.push(fn));
  vi.stubGlobal('setTimeout', (fn: () => void) => { timers.push(fn); return timers.length; });
  await import('./worker');
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'loop', components: [], nets: [] };
  receive({ data: { type: 'load', id: 1, circuit } });
  receive({ data: { type: 'run', id: 2, rateHz: 1000 } }); microtasks.shift()!();
  expect(timers).toHaveLength(1);
  receive({ data: { type: 'pause', id: 3 } });
  receive({ data: { type: 'run', id: 4, rateHz: 1000 } }); microtasks.shift()!();
  expect(timers).toHaveLength(2);
  const stale = timers.shift()!; stale(); expect(timers).toHaveLength(1);
  const current = timers.shift()!; current(); expect(timers).toHaveLength(1);
});

it('validates rates transactionally and reports measured ticks, including the 1 Hz boundary', async () => {
  let receive!: (e: { data: WorkerReq }) => void;
  const messages: WorkerRes[] = [];
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (m: WorkerRes) => messages.push(m) });
  const microtasks: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (fn: () => void) => microtasks.push(fn));
  vi.stubGlobal('setTimeout', () => 1);
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  await import('./worker');
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'boundary', components: [], nets: [] };
  receive({ data: { type: 'load', id: 1, circuit } });
  for (const rateHz of [0, -1, NaN, Infinity, 1.5, 1_000_001]) {
    receive({ data: { type: 'run', id: 2, rateHz } }); expect(messages.at(-1)).toMatchObject({ type: 'err', id: 2 });
  }
  expect(microtasks).toHaveLength(0);
  receive({ data: { type: 'run', id: 3, rateHz: 1 } });
  now = 1000; microtasks.shift()!();
  expect(messages.filter((m) => m.type === 'metrics').at(-1)).toMatchObject({ running: true, targetRateHz: 1, actualRateHz: 1, ticks: 1 });
  receive({ data: { type: 'load', id: 4, circuit, rateHz: 0 } });
  expect(messages.at(-1)).toMatchObject({ type: 'err', id: 4 });
  receive({ data: { type: 'pause', id: 5 } });
  expect(messages.filter((m) => m.type === 'metrics').at(-1)).toMatchObject({ running: false, actualRateHz: 0, ticks: 1 });
  receive({ data: { type: 'step', id: 6 } });
  expect(messages.filter((m) => m.type === 'metrics').at(-1)).toMatchObject({ ticks: 2 });
});

it('yields an overloaded high-rate batch within its time budget and keeps pause responsive', async () => {
  let receive!: (e: { data: WorkerReq }) => void;
  const messages: WorkerRes[] = [];
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (m: WorkerRes) => messages.push(m) });
  const microtasks: Array<() => void> = []; const timers: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (fn: () => void) => microtasks.push(fn));
  vi.stubGlobal('setTimeout', (fn: () => void) => { timers.push(fn); return timers.length; });
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  await import('./worker');
  receive({ data: { type: 'load', id: 1, circuit: { version: 1, kind: 'circuit', name: 'large rate', components: [], nets: [] } } });
  receive({ data: { type: 'run', id: 2, rateHz: 1_000_000 } });
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => { const current = now; now += 10; return current; });
  microtasks.shift()!();
  const metrics = messages.filter((m) => m.type === 'metrics').at(-1);
  expect(metrics).toMatchObject({ targetRateHz: 1_000_000, ticks: 32 });
  receive({ data: { type: 'pause', id: 3 } });
  expect(messages.at(-1)).toMatchObject({ type: 'ack', id: 3 });
  timers.shift()!(); expect(timers).toHaveLength(0);
});

it('delivers each diagnostic once after the retained history fills', async () => {
  let receive!: (e: { data: WorkerReq }) => void;
  const messages: WorkerRes[] = [];
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (m: WorkerRes) => messages.push(m) });
  await import('./worker');
  const circuit: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'diagnostics',
    components: [{ id: 'low', type: 'prim.CONST_0' }],
    nets: [{ id: 'signal', endpoints: ['low.Y'] }],
  };
  receive({ data: { type: 'load', id: 1, circuit } });
  for (let i = 0; i < 1200; i++) {
    receive({ data: { type: 'set_net_input', id: 2 + i * 2, net: 'signal', value: 1 } });
    receive({ data: { type: 'set_net_input', id: 3 + i * 2, net: 'signal', value: 'Z' } });
  }
  const events = messages.filter(m => m.type === 'event');
  expect(events).toHaveLength(1200);
  expect(events.map(event => event.step)).toEqual(Array.from({ length: 1200 }, (_, i) => 1 + i * 2));
  expect(events.every(event => event.kind === 'contention')).toBe(true);
});


it('captures every tick in bursts, pause and step, and preserves live inputs on probe-only edits', async () => {
  let receive!: (e: { data: WorkerReq }) => void;
  const messages: WorkerRes[] = [];
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (m: WorkerRes) => messages.push(m) });
  const microtasks: Array<() => void> = []; const timers: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (fn: () => void) => microtasks.push(fn));
  vi.stubGlobal('setTimeout', (fn: () => void) => { timers.push(fn); return timers.length; });
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  await import('./worker');
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'observe', components: [{ id: 'sw', type: 'io.switch' }], nets: [{ id: 'signal', endpoints: ['sw.Y'] }] };
  receive({ data: { type: 'load', id: 1, circuit } });
  const initial = messages.at(-1); if (initial?.type !== 'load_res') throw new Error('missing load');
  expect(initial.waveform).toBeNull();
  receive({ data: { type: 'set_input', id: 2, component: 'sw', pin: 'Y', value: 1 } });
  const probes = [{ id: 'probe', label: 'switch', nets: ['signal'] }];
  receive({ data: { type: 'mutate', id: 3, circuit: { ...circuit, probes }, preserveProbeEdits: true } });
  const changed = messages.at(-1); if (changed?.type !== 'load_res') throw new Error('missing probe reply');
  expect(changed.preserved).toBe(true); expect(changed.netsBuffer).toBe(initial.netsBuffer);
  expect(Array.from(changed.waveform!.values)).toEqual([1]);
  receive({ data: { type: 'run', id: 4, rateHz: 1000 } });
  now = 100; microtasks.shift()!();
  const burst = messages.filter(m => m.type === 'waveform').at(-1);
  if (burst?.type !== 'waveform') throw new Error('missing burst');
  expect(Array.from(burst.snapshot.ticks)).toEqual(Array.from({ length: 101 }, (_, tick) => tick));
  expect(Array.from(burst.snapshot.values)).toEqual(Array(101).fill(1));
  receive({ data: { type: 'pause', id: 5 } });
  timers.shift()!();
  receive({ data: { type: 'step', id: 6 } });
  const stepped = messages.filter(m => m.type === 'waveform').at(-1);
  if (stepped?.type !== 'waveform') throw new Error('missing step');
  expect(stepped.snapshot.ticks.at(-1)).toBe(101);
  receive({ data: { type: 'set_input', id: 7, component: 'sw', pin: 'Y', value: 0 } });
  const settled = messages.filter(m => m.type === 'waveform').at(-1);
  if (settled?.type !== 'waveform') throw new Error('missing settle');
  expect(settled.snapshot.ticks).toHaveLength(102); expect(settled.snapshot.values.at(-1)).toBe(0);
  receive({ data: { type: 'mutate', id: 8, circuit: { ...circuit, probes: [{ ...probes[0]!, nets: ['missing'] }] }, preserveProbeEdits: true } });
  expect(messages.at(-1)).toMatchObject({ type: 'err', id: 8 });
  receive({ data: { type: 'step', id: 9 } });
  const afterFailure = messages.filter(m => m.type === 'waveform').at(-1);
  if (afterFailure?.type !== 'waveform') throw new Error('capture lost after failure');
  expect(afterFailure.snapshot.ticks.at(-1)).toBe(102);
  receive({ data: { type: 'mutate', id: 10, circuit, preserveProbeEdits: true } });
  expect(messages.at(-1)).toMatchObject({ type: 'load_res', waveform: null, preserved: true });
  const count = messages.filter(m => m.type === 'waveform').length;
  receive({ data: { type: 'step', id: 11 } });
  expect(messages.filter(m => m.type === 'waveform')).toHaveLength(count);
  receive({ data: { type: 'set_input', id: 12, component: 'sw', pin: 'Y', value: 1 } });
  receive({ data: { type: 'mutate', id: 13, circuit } });
  const reopened = messages.at(-1); if (reopened?.type !== 'load_res') throw new Error('missing reopen');
  expect(reopened.preserved).toBeUndefined(); expect(reopened.netsBuffer).not.toBe(initial.netsBuffer);
  expect(new Uint8Array(reopened.netsBuffer)[0]).toBe(0);
});

it.each([100, 2000])('aligns clock and 555 waveform edges after changing the tick rate to %i Hz', async rateHz => {
  let receive!: (e: { data: WorkerReq }) => void;
  const messages: WorkerRes[] = [];
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (m: WorkerRes) => messages.push(m) });
  const microtasks: Array<() => void> = []; const timers: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (fn: () => void) => microtasks.push(fn));
  vi.stubGlobal('setTimeout', (fn: () => void) => { timers.push(fn); return timers.length; });
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  await import('./worker');
  const circuit: CircuitJSON = {
    version: 1, kind: 'circuit', name: 'clock phases',
    components: [{ id: 'clock', type: 'gen.clock', params: { freqHz: 1 } }, { id: 'timer', type: 'gen.555', params: { freqHz: 1 } }],
    nets: [{ id: 'clock', endpoints: ['clock.Y'] }, { id: 'timer', endpoints: ['timer.OUT'] }],
    probes: [{ id: 'clock', label: 'clock', nets: ['clock'] }, { id: 'timer', label: 'timer', nets: ['timer'] }],
  };
  receive({ data: { type: 'load', id: 1, circuit, rateHz: 1000 } });
  receive({ data: { type: 'run', id: 2, rateHz: 1000 } });
  now = 250; microtasks.shift()!();
  receive({ data: { type: 'pause', id: 3 } }); timers.shift()!();
  receive({ data: { type: 'run', id: 4, rateHz } });
  now = 500; microtasks.shift()!();
  receive({ data: { type: 'pause', id: 5 } }); timers.shift()!();
  const rising = messages.filter(m => m.type === 'waveform').at(-1);
  if (rising?.type !== 'waveform') throw new Error('missing rising edge capture');
  const edgeTick = 250 + rateHz / 4;
  expect(rising.snapshot.ticks.at(-1)).toBe(edgeTick);
  expect(Array.from(rising.snapshot.values)).toEqual([...Array(edgeTick * 2).fill(0), 1, 1]);
  receive({ data: { type: 'run', id: 6, rateHz } });
  now = 750; microtasks.shift()!();
  now = 1000; timers.shift()!();
  receive({ data: { type: 'pause', id: 7 } }); timers.shift()!();
  const falling = messages.filter(m => m.type === 'waveform').at(-1);
  if (falling?.type !== 'waveform') throw new Error('missing falling edge capture');
  const fallTick = edgeTick + rateHz / 2;
  expect(falling.snapshot.ticks).toHaveLength(fallTick + 1);
  expect(Array.from(falling.snapshot.ticks)).toEqual(Array.from({ length: fallTick + 1 }, (_, tick) => tick));
  expect(Array.from(falling.snapshot.values)).toEqual(Array.from({ length: fallTick + 1 }, (_, tick) => tick >= edgeTick && tick < fallTick ? [1, 1] : [0, 0]).flat());
  receive({ data: { type: 'step', id: 8 } });
  const stepped = messages.filter(m => m.type === 'waveform').at(-1);
  if (stepped?.type !== 'waveform') throw new Error('missing stepped capture');
  expect(stepped.snapshot.ticks.at(-1)).toBe(fallTick + 1);
  expect(Array.from(stepped.snapshot.values.slice(-2))).toEqual([0, 0]);
});


it('bounds queued waveform notifications while retaining every tick until the UI acknowledges delivery', async () => {
  let receive!: (e: { data: WorkerReq }) => void;
  const messages: WorkerRes[] = [];
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (m: WorkerRes) => messages.push(m) });
  const microtasks: Array<() => void> = []; const timers: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (fn: () => void) => microtasks.push(fn));
  vi.stubGlobal('setTimeout', (fn: () => void) => { timers.push(fn); return timers.length; });
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  await import('./worker');
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'backpressure', components: [{ id: 'sw', type: 'io.switch' }], nets: [{ id: 'signal', endpoints: ['sw.Y'] }], probes: [{ id: 'p', label: 'signal', nets: ['signal'] }] };
  receive({ data: { type: 'load', id: 1, circuit } });
  receive({ data: { type: 'run', id: 2, rateHz: 1000 } });
  now = 100; microtasks.shift()!();
  const first = messages.filter(m => m.type === 'waveform').at(-1);
  if (first?.type !== 'waveform') throw new Error('missing waveform');
  now = 200; timers.shift()!();
  receive({ data: { type: 'waveform_ack', id: 0, sequence: first.sequence - 1 } });
  now = 300; timers.shift()!();
  expect(messages.filter(m => m.type === 'waveform')).toHaveLength(1);
  receive({ data: { type: 'waveform_ack', id: 0, sequence: first.sequence } });
  now = 400; timers.shift()!();
  const latest = messages.filter(m => m.type === 'waveform').at(-1);
  if (latest?.type !== 'waveform') throw new Error('missing acknowledged update');
  expect(messages.filter(m => m.type === 'waveform')).toHaveLength(2);
  expect(latest.snapshot.ticks).toHaveLength(401); expect(latest.snapshot.ticks.at(-1)).toBe(400);
  receive({ data: { type: 'pause', id: 3 } });
});
