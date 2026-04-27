// Engine worker. Owns the canonical circuit IR, runs the event-driven
// simulator, and writes net state into a SharedArrayBuffer for the UI to
// sample at vsync. Pacing is best-effort: we accumulate a budget of pending
// ticks based on wall time and drain it in batches between yields.
//
// One Simulator instance per worker; load() replaces it. M3 doesn't support
// mutate (no live editing yet) — the protocol leaves the slot open for M4.

import '../engine/behavioral/index';
import type { NetState, RuntimeGraph } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import '../engine/primitives/index';
import { Simulator } from '../engine/sim';
import '../stdlib/index';
import {
  NET_STATE_BYTE,
  type EventNotif,
  type WorkerReq,
  type WorkerRes,
} from './protocol';

let sim: Simulator | null = null;
let graph: RuntimeGraph | null = null;
let netsBuffer: SharedArrayBuffer | null = null;
let netsView: Uint8Array | null = null;
let eventsCursor = 0;

let running = false;
let targetRateHz = 1000;
let stepBudget = 0;
let lastLoopTimeMs = 0;
const MAX_BATCH = 5000;

const post = (msg: WorkerRes): void => {
  // postMessage is on the worker global; the type is the bare DedicatedWorkerGlobalScope.
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};

const writeNets = (): void => {
  if (!graph || !netsView) return;
  for (let i = 0; i < graph.nets.length; i++) {
    const v = graph.nets[i]!.value;
    netsView[i] = NET_STATE_BYTE[v];
  }
};

const drainEvents = (): void => {
  if (!sim) return;
  while (eventsCursor < sim.events.length) {
    const ev = sim.events[eventsCursor++]!;
    const notif: EventNotif = {
      type: 'event',
      kind: ev.kind,
      detail: ev.detail,
      step: ev.step,
    };
    post(notif);
  }
};

const handleLoad = (req: Extract<WorkerReq, { type: 'load' }>): void => {
  graph = loadCircuit(req.circuit);
  sim = new Simulator(graph, { rateHz: req.rateHz ?? targetRateHz });
  // Initial settle so the first frame doesn't show all-X.
  sim.settle();

  netsBuffer = new SharedArrayBuffer(graph.nets.length);
  netsView = new Uint8Array(netsBuffer);
  writeNets();
  eventsCursor = 0;
  drainEvents();

  post({
    type: 'load_res',
    id: req.id,
    netIds: graph.nets.map((n) => n.id),
    componentIds: graph.components.map((c) => c.id),
    netsBuffer,
  });
};

const handleRun = (req: Extract<WorkerReq, { type: 'run' }>): void => {
  if (!sim) throw new Error('run before load');
  targetRateHz = req.rateHz;
  sim.rateHz = req.rateHz;
  if (!running) {
    running = true;
    stepBudget = 0;
    lastLoopTimeMs = performance.now();
    queueMicrotask(loop);
  }
  post({ type: 'ack', id: req.id });
};

const handlePause = (req: Extract<WorkerReq, { type: 'pause' }>): void => {
  running = false;
  post({ type: 'ack', id: req.id });
};

const handleStep = (req: Extract<WorkerReq, { type: 'step' }>): void => {
  if (!sim) throw new Error('step before load');
  sim.tick();
  writeNets();
  drainEvents();
  post({ type: 'ack', id: req.id });
};

const handleSetInput = (req: Extract<WorkerReq, { type: 'set_input' }>): void => {
  if (!sim) throw new Error('set_input before load');
  sim.setComponentInput(req.component, req.pin, req.value);
  // Settle right away so the change is visible to the UI even when paused.
  sim.settle();
  writeNets();
  drainEvents();
  post({ type: 'ack', id: req.id });
};

const loop = (): void => {
  if (!running || !sim) return;
  const now = performance.now();
  const dt = Math.max(0, (now - lastLoopTimeMs) / 1000);
  lastLoopTimeMs = now;
  stepBudget += dt * targetRateHz;
  // Cap how many ticks one loop turn does so we don't lock the worker.
  const ticks = Math.min(Math.floor(stepBudget), MAX_BATCH);
  for (let i = 0; i < ticks; i++) sim.tick();
  stepBudget -= ticks;
  writeNets();
  drainEvents();
  // setTimeout(0) yields ~4ms in browsers, which gives plenty of room for
  // even 1 kHz tick rates and keeps message handling responsive.
  setTimeout(loop, 0);
};

const onMessage = (req: WorkerReq): void => {
  try {
    switch (req.type) {
      case 'load': handleLoad(req); break;
      case 'run': handleRun(req); break;
      case 'pause': handlePause(req); break;
      case 'step': handleStep(req); break;
      case 'set_input': handleSetInput(req); break;
      default: {
        const x: never = req;
        throw new Error(`unknown request: ${JSON.stringify(x)}`);
      }
    }
  } catch (err) {
    post({
      type: 'err',
      id: (req as { id: number }).id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

self.addEventListener('message', (e: MessageEvent<WorkerReq>) => onMessage(e.data));
