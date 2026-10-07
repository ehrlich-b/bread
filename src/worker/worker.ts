// Engine worker. Owns the canonical circuit IR, runs the event-driven
// simulator, and writes net state into a SharedArrayBuffer for the UI to
// sample at vsync. Pacing is best-effort: we accumulate a budget of pending
// ticks based on wall time and drain it in batches between yields.
//
// One Simulator instance per worker; load() replaces it. mutate() does the
// same, but preserves targetRateHz and auto-resumes if a free run was active.

import '../engine/behavioral/index';
import type { NetState, RuntimeGraph } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import '../engine/primitives/index';
import { Simulator, type SimEvent } from '../engine/sim';
import '../stdlib/index';
import {
  NET_STATE_BYTE,
  validateRateHz,
  type WorkerReq,
  type WorkerRes,
} from './protocol';

let sim: Simulator | null = null;
let graph: RuntimeGraph | null = null;
let netsBuffer: SharedArrayBuffer | null = null;
let netsView: Uint8Array | null = null;

let running = false;
let loopGeneration = 0;
let targetRateHz = 1000;
let stepBudget = 0;
let lastLoopTimeMs = 0;
const MAX_BATCH = 5000;
const BATCH_BUDGET_MS = 8;
let ticksTotal = 0;
let sampleTicks = 0;
let sampleTimeMs = 0;

const post = (msg: WorkerRes): void => {
  // postMessage is on the worker global; the type is the bare DedicatedWorkerGlobalScope.
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};

const reportMetrics = (force = false): void => {
  const now = performance.now();
  const elapsed = now - sampleTimeMs;
  if (!force && elapsed < 500) return;
  post({ type: 'metrics', running, targetRateHz, actualRateHz: running && elapsed > 0 ? (ticksTotal - sampleTicks) * 1000 / elapsed : 0, ticks: ticksTotal });
  sampleTicks = ticksTotal; sampleTimeMs = now;
};

const resetMetrics = (): void => { ticksTotal = 0; sampleTicks = 0; sampleTimeMs = performance.now(); reportMetrics(true); };

const writeNets = (): void => {
  if (!graph || !netsView) return;
  for (let i = 0; i < graph.nets.length; i++) {
    const v = graph.nets[i]!.value;
    netsView[i] = NET_STATE_BYTE[v];
  }
};

const reportEvent = (event: SimEvent): void => {
  post({ type: 'event', kind: event.kind, detail: event.detail, step: event.step });
};

const handleLoad = (req: Extract<WorkerReq, { type: 'load' }>): void => {
  // Prepare the whole candidate before changing the live simulator.
  const nextRate = validateRateHz(req.rateHz ?? targetRateHz);
  const nextGraph = loadCircuit(req.circuit);
  const nextSim = new Simulator(nextGraph, { rateHz: nextRate, onEvent: reportEvent });
  nextSim.settle();
  const nextBuffer = new SharedArrayBuffer(nextGraph.nets.length);
  graph = nextGraph;
  sim = nextSim;
  targetRateHz = nextRate;
  stepBudget = 0;
  lastLoopTimeMs = performance.now();
  netsBuffer = nextBuffer;
  // Initial settle so the first frame doesn't show all-X.
  netsView = new Uint8Array(netsBuffer);
  writeNets();
  resetMetrics();

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
  validateRateHz(req.rateHz);
  targetRateHz = req.rateHz;
  sim.rateHz = req.rateHz;
  stepBudget = 0;
  lastLoopTimeMs = performance.now();
  sampleTicks = ticksTotal; sampleTimeMs = lastLoopTimeMs;
  if (!running) {
    running = true;
    stepBudget = 0;
    lastLoopTimeMs = performance.now();
    const generation = ++loopGeneration;
    queueMicrotask(() => loop(generation));
  }
  reportMetrics(true);
  post({ type: 'ack', id: req.id });
};

const handlePause = (req: Extract<WorkerReq, { type: 'pause' }>): void => {
  running = false;
  loopGeneration++;
  reportMetrics(true);
  post({ type: 'ack', id: req.id });
};

const handleStep = (req: Extract<WorkerReq, { type: 'step' }>): void => {
  if (!sim) throw new Error('step before load');
  sim.tick();
  ticksTotal++;
  writeNets();
  reportMetrics(true);
  post({ type: 'ack', id: req.id });
};

const handleSetInput = (req: Extract<WorkerReq, { type: 'set_input' }>): void => {
  if (!sim) throw new Error('set_input before load');
  sim.setComponentInput(req.component, req.pin, req.value);
  // Settle right away so the change is visible to the UI even when paused.
  sim.settle();
  writeNets();
  post({ type: 'ack', id: req.id });
};

const handleMutate = (req: Extract<WorkerReq, { type: 'mutate' }>): void => {
  // A rejected candidate leaves both the old graph and its run loop intact.
  const nextGraph = loadCircuit(req.circuit);
  const nextSim = new Simulator(nextGraph, { rateHz: targetRateHz, onEvent: reportEvent });
  nextSim.settle();
  const nextBuffer = new SharedArrayBuffer(nextGraph.nets.length);
  graph = nextGraph;
  sim = nextSim;
  netsBuffer = nextBuffer;
  netsView = new Uint8Array(nextBuffer);
  stepBudget = 0;
  lastLoopTimeMs = performance.now();
  writeNets();
  resetMetrics();
  post({ type: 'load_res', id: req.id, netIds: graph.nets.map((n) => n.id), componentIds: graph.components.map((c) => c.id), netsBuffer });
  // A running worker already has a scheduled loop. Scheduling another here
  // creates an additional timer chain after every edit.
};

const handleSetNetInput = (req: Extract<WorkerReq, { type: 'set_net_input' }>): void => {
  if (!sim) throw new Error('set_net_input before load');
  sim.setInput(req.net, req.value);
  sim.settle();
  writeNets();
  post({ type: 'ack', id: req.id });
};

const loop = (generation: number): void => {
  if (!running || !sim || generation !== loopGeneration) return;
  const now = performance.now();
  const dt = Math.max(0, (now - lastLoopTimeMs) / 1000);
  lastLoopTimeMs = now;
  // Discard wall-time debt beyond a quarter second, so an overloaded tab
  // can pause promptly rather than spending indefinitely catching up.
  stepBudget = Math.min(stepBudget + dt * targetRateHz, Math.max(1, targetRateHz / 4));
  // Cap how many ticks one loop turn does so we don't lock the worker.
  const wanted = Math.min(Math.floor(stepBudget), MAX_BATCH);
  const deadline = now + BATCH_BUDGET_MS;
  let ticks = 0;
  for (; ticks < wanted; ticks++) {
    sim.tick();
    if ((ticks + 1) % 32 === 0 && performance.now() >= deadline) { ticks++; break; }
  }
  ticksTotal += ticks;
  stepBudget -= ticks;
  writeNets();
  reportMetrics();
  // setTimeout(0) yields ~4ms in browsers, which gives plenty of room for
  // even 1 kHz tick rates and keeps message handling responsive.
  setTimeout(() => loop(generation), 0);
};

const onMessage = (req: WorkerReq): void => {
  try {
    switch (req.type) {
      case 'load': handleLoad(req); break;
      case 'run': handleRun(req); break;
      case 'pause': handlePause(req); break;
      case 'step': handleStep(req); break;
      case 'set_input': handleSetInput(req); break;
      case 'set_net_input': handleSetNetInput(req); break;
      case 'mutate': handleMutate(req); break;
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
