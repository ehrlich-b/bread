// Main-thread RPC wrapper around the simulation worker. Owns request id
// generation, response routing, the snapshot SAB handle, and the event
// listener fan-out. The UI imports `createWorkerBus()`; the schematic and
// controls call methods on the returned object.

import type { CircuitJSON, NetState } from '../engine/ir';
import type { WaveformSnapshot } from '../engine/probes';
import type { TestbenchJSON, TestbenchResult } from '../engine/testbench';
import {
  NET_STATE_FROM_BYTE,
  type EventNotif,
  type LoadRes,
  type MetricsNotif,
  type TestbenchRes,
  type WorkerReq,
  type WorkerRes,
} from '../worker/protocol';

export interface LoadSnapshot {
  netIds: string[];
  componentIds: string[];
  netIndex: Map<string, number>;
  netsView: Uint8Array;
  preserved?: boolean;
}

export interface WorkerBus {
  load(circuit: CircuitJSON, rateHz?: number): Promise<LoadSnapshot>;
  mutate(circuit: CircuitJSON, preserveProbeEdits?: boolean): Promise<LoadSnapshot>;
  run(rateHz: number): Promise<void>;
  pause(): Promise<void>;
  step(): Promise<void>;
  setInput(component: string, pin: string, value: NetState): Promise<void>;
  setNetInput(net: string, value: NetState): Promise<void>;
  testbench(circuit: CircuitJSON, bench: TestbenchJSON, throughVector?: number): Promise<TestbenchResult>;
  on(event: 'event', handler: (e: EventNotif) => void): () => void;
  on(event: 'metrics', handler: (e: MetricsNotif) => void): () => void;
  on(event: 'waveform', handler: (snapshot: WaveformSnapshot | null) => void): () => void;
  waveform?: WaveformSnapshot | null;
  readNet(netId: string): NetState;
  netIds: string[];
  componentIds: string[];
}

interface Pending {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
}

export const createWorkerBus = (): WorkerBus => {
  const worker = new Worker(new URL('../worker/worker.ts', import.meta.url), {
    type: 'module',
  });

  let nextId = 1;
  const pending = new Map<number, Pending>();
  const eventHandlers = new Set<(e: EventNotif) => void>();
  const metricsHandlers = new Set<(e: MetricsNotif) => void>();

  let snapshot: LoadSnapshot | null = null;
  const waveformHandlers = new Set<(snapshot: WaveformSnapshot | null) => void>();

  // Hoisted so both load() and mutate() can update the same closure state.
  // `bus` is captured below; we redefine it after construction so this
  // function can flip its publicly-exposed netIds/componentIds.
  let bus: WorkerBus;
  const adoptSnapshot = (res: LoadRes): LoadSnapshot => {
    const netIndex = new Map<string, number>();
    res.netIds.forEach((n, i) => netIndex.set(n, i));
    snapshot = {
      netIds: res.netIds,
      componentIds: res.componentIds,
      netIndex,
      netsView: new Uint8Array(res.netsBuffer),
      preserved: res.preserved,
    };
    bus.netIds = res.netIds;
    bus.componentIds = res.componentIds;
    bus.waveform = res.waveform;
    for (const h of waveformHandlers) h(res.waveform);
    return snapshot;
  };

  worker.addEventListener('message', (e: MessageEvent<WorkerRes>) => {
    const msg = e.data;
    if (msg.type === 'waveform') {
      bus.waveform = msg.snapshot;
      try { for (const h of waveformHandlers) h(msg.snapshot); }
      finally { worker.postMessage({ type: 'waveform_ack', id: 0, sequence: msg.sequence } satisfies WorkerReq); }
      return;
    }
    if (msg.type === 'event') {
      for (const h of eventHandlers) h(msg);
      return;
    }
    if (msg.type === 'metrics') {
      for (const h of metricsHandlers) h(msg);
      return;
    }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.type === 'err') {
      slot.reject(new Error(msg.message));
      return;
    }
    slot.resolve(msg);
  });

  let failure: Error | null = null;
  const fail = (message: string): void => {
    failure = new Error(`Simulation worker failed: ${message}. Reload to restart the simulation.`);
    for (const slot of pending.values()) slot.reject(failure);
    pending.clear();
  };
  worker.addEventListener('error', (event: ErrorEvent) => fail(event.message || 'Unknown worker error'));
  worker.addEventListener('messageerror', () => fail('Could not receive a worker response'));

  const send = <R>(req: WorkerReq): Promise<R> => {
    return new Promise<R>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      pending.set(req.id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try { worker.postMessage(req); }
      catch (error) { pending.delete(req.id); reject(error); }
    });
  };

  bus = {
    netIds: [],
    componentIds: [],

    async load(circuit, rateHz) {
      const id = nextId++;
      const res = await send<LoadRes>({ type: 'load', id, circuit, rateHz });
      return adoptSnapshot(res);
    },

    async mutate(circuit, preserveProbeEdits) {
      const id = nextId++;
      const res = await send<LoadRes>({ type: 'mutate', id, circuit, preserveProbeEdits });
      return adoptSnapshot(res);
    },

    async run(rateHz) {
      const id = nextId++;
      await send<void>({ type: 'run', id, rateHz });
    },

    async pause() {
      const id = nextId++;
      await send<void>({ type: 'pause', id });
    },

    async step() {
      const id = nextId++;
      await send<void>({ type: 'step', id });
    },

    async setInput(component, pin, value) {
      const id = nextId++;
      await send<void>({ type: 'set_input', id, component, pin, value });
    },

    async setNetInput(net, value) {
      const id = nextId++;
      await send<void>({ type: 'set_net_input', id, net, value });
    },

    async testbench(circuit, bench, throughVector) {
      const res = await send<TestbenchRes>({ type: 'testbench', id: nextId++, circuit, bench, throughVector });
      return res.result;
    },

    on(event, handler) {
      if (event === 'waveform') {
        const h = handler as (snapshot: WaveformSnapshot | null) => void;
        waveformHandlers.add(h); return () => { waveformHandlers.delete(h); };
      }
      if (event === 'metrics') {
        const h = handler as (e: MetricsNotif) => void;
        metricsHandlers.add(h); return () => { metricsHandlers.delete(h); };
      }
      const h = handler as (e: EventNotif) => void;
      eventHandlers.add(h); return () => { eventHandlers.delete(h); };
    },

    readNet(netId) {
      if (!snapshot) throw new Error('readNet before load');
      const idx = snapshot.netIndex.get(netId);
      if (idx === undefined) throw new Error(`unknown net: ${netId}`);
      return NET_STATE_FROM_BYTE[snapshot.netsView[idx]!]!;
    },
  };
  return bus;
};
