// Main-thread RPC wrapper around the simulation worker. Owns request id
// generation, response routing, the snapshot SAB handle, and the event
// listener fan-out. The UI imports `createWorkerBus()`; the schematic and
// controls call methods on the returned object.

import type { CircuitJSON, NetState } from '../engine/ir';
import {
  NET_STATE_FROM_BYTE,
  type EventNotif,
  type LoadRes,
  type WorkerReq,
  type WorkerRes,
} from '../worker/protocol';

export interface LoadSnapshot {
  netIds: string[];
  componentIds: string[];
  netIndex: Map<string, number>;
  netsView: Uint8Array;
}

export interface WorkerBus {
  load(circuit: CircuitJSON, rateHz?: number): Promise<LoadSnapshot>;
  mutate(circuit: CircuitJSON): Promise<LoadSnapshot>;
  run(rateHz: number): Promise<void>;
  pause(): Promise<void>;
  step(): Promise<void>;
  setInput(component: string, pin: string, value: NetState): Promise<void>;
  setNetInput(net: string, value: NetState): Promise<void>;
  on(event: 'event', handler: (e: EventNotif) => void): () => void;
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

  let snapshot: LoadSnapshot | null = null;

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
    };
    bus.netIds = res.netIds;
    bus.componentIds = res.componentIds;
    return snapshot;
  };

  worker.addEventListener('message', (e: MessageEvent<WorkerRes>) => {
    const msg = e.data;
    if (msg.type === 'event') {
      for (const h of eventHandlers) h(msg);
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

  const send = <R>(req: WorkerReq): Promise<R> => {
    return new Promise<R>((resolve, reject) => {
      pending.set(req.id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      worker.postMessage(req);
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

    async mutate(circuit) {
      const id = nextId++;
      const res = await send<LoadRes>({ type: 'mutate', id, circuit });
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

    on(_event, handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
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
