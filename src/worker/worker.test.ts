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
