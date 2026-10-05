// Wire protocol between the UI thread and the simulation worker. Each request
// from the UI carries a numeric `id`; the worker echoes it back on responses.
// Notifications (events) flow worker→UI without an id.
//
// The net-state SAB encoding is one byte per net:
//   0 → 0, 1 → 1, 2 → 'Z', 3 → 'X'
// The UI samples the SAB at requestAnimationFrame; no per-frame messaging.

import type { CircuitJSON, NetState } from '../engine/ir';

export const NET_STATE_BYTE: Record<NetState, number> = {
  0: 0,
  1: 1,
  Z: 2,
  X: 3,
};

export const NET_STATE_FROM_BYTE: NetState[] = [0, 1, 'Z', 'X'];

export interface LoadReq {
  type: 'load';
  id: number;
  circuit: CircuitJSON;
  rateHz?: number;
}

export interface RunReq {
  type: 'run';
  id: number;
  rateHz: number;
}

export interface PauseReq {
  type: 'pause';
  id: number;
}

export interface StepReq {
  type: 'step';
  id: number;
}

export interface SetInputReq {
  type: 'set_input';
  id: number;
  component: string;
  pin: string;
  value: NetState;
}

export interface SetNetInputReq {
  type: 'set_net_input';
  id: number;
  net: string;
  value: NetState;
}

// Replace the engine's circuit with a new IR. Distinct from `load` so the UI
// can signal intent: mutate preserves the worker's targetRateHz and auto-
// resumes if the simulator was running. The response shape matches LoadRes
// (new SAB + ids) because every structural edit invalidates the previous
// snapshot handle.
export interface MutateReq {
  type: 'mutate';
  id: number;
  circuit: CircuitJSON;
}

export type WorkerReq = LoadReq | RunReq | PauseReq | StepReq | SetInputReq | SetNetInputReq | MutateReq;

export interface LoadRes {
  type: 'load_res';
  id: number;
  netIds: string[];
  componentIds: string[];
  netsBuffer: SharedArrayBuffer;
}

export interface Ack {
  type: 'ack';
  id: number;
}

export interface ErrRes {
  type: 'err';
  id: number;
  message: string;
}

export interface EventNotif {
  type: 'event';
  kind: 'contention' | 'oscillation';
  detail: string;
  step: number;
}

export const MAX_RATE_HZ = 1_000_000;
export const validateRateHz = (rateHz: number): number => {
  if (!Number.isInteger(rateHz) || rateHz < 1 || rateHz > MAX_RATE_HZ) throw new Error(`Simulation tick rate must be an integer from 1 to ${MAX_RATE_HZ.toLocaleString()}`);
  return rateHz;
};

// Tick throughput is distinct from circuit clock edges and instructions.
export interface MetricsNotif {
  type: 'metrics';
  running: boolean;
  targetRateHz: number;
  actualRateHz: number;
  ticks: number;
}

export type WorkerRes = LoadRes | Ack | ErrRes | EventNotif | MetricsNotif;
