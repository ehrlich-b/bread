// gen.clock — idealized square-wave generator. params: { freqHz }. The output
// toggles every halfPeriod ticks, where halfPeriod = max(1, round(rateHz /
// freqHz / 2)). The simulator hands rateHz in via EvalCtx, so changing the
// worker's tick rate at runtime adjusts the apparent clock frequency without
// touching the component.

import type { NetState, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

interface ClockParams {
  freqHz: number;
}

interface ClockState {
  Y: NetState;
  lastToggleStep: number;
}

const halfPeriodSteps = (rateHz: number, freqHz: number): number => {
  const raw = Math.round(rateHz / freqHz / 2);
  return raw > 0 ? raw : 1;
};

const genClock: PrimitiveDef<ClockState, ClockParams> = {
  pins: () => [{ name: 'Y', dir: 'out' }],
  tickActive: true,
  init: (params) => {
    if (!Number.isFinite(params.freqHz) || params.freqHz <= 0) {
      throw new Error(`gen.clock: freqHz must be positive, got ${String(params.freqHz)}`);
    }
    return { Y: 0, lastToggleStep: 0 };
  },
  evaluate(_inputs, outputs, state, params, ctx) {
    const step = ctx?.step ?? 0;
    const rateHz = ctx?.rateHz ?? 1;
    const half = halfPeriodSteps(rateHz, params.freqHz);
    if (step - state.lastToggleStep >= half) {
      const flipped: NetState = state.Y === 1 ? 0 : 1;
      outputs[0] = flipped;
      state.Y = flipped;
      state.lastToggleStep = step;
      return state;
    }
    outputs[0] = state.Y;
    return undefined;
  },
};

registerBehavioral('gen.clock', genClock);
