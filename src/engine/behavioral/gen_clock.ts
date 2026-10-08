// gen.clock — idealized square-wave generator. params: { freqHz }. The output
// toggles every halfPeriod ticks, where halfPeriod = max(1, round(rateHz /
// freqHz / 2)). The simulator hands rateHz in via EvalCtx, so changing the
// worker's tick rate rescales elapsed ticks to preserve simulated-time phase.

import type { NetState, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

interface ClockParams {
  freqHz: number;
}

interface ClockState {
  Y: NetState;
  lastStep: number;
  elapsedSteps: number;
  rateHz: number;
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
    return { Y: 0, lastStep: 0, elapsedSteps: 0, rateHz: 1 };
  },
  evaluate(_inputs, outputs, state, params, ctx) {
    const step = ctx?.step ?? 0;
    const rateHz = ctx?.rateHz ?? 1;
    outputs[0] = state.Y;
    if (step === state.lastStep) return undefined;
    const elapsed = state.elapsedSteps * (rateHz / state.rateHz) + (step - state.lastStep);
    const half = halfPeriodSteps(rateHz, params.freqHz);
    // Rate changes can leave fractional ticks; tolerate rescaling roundoff.
    if (elapsed >= half - 1e-9) {
      const flipped: NetState = state.Y === 1 ? 0 : 1;
      outputs[0] = flipped;
      state.Y = flipped;
      state.lastStep = step;
      state.elapsedSteps = 0;
      state.rateHz = rateHz;
      return state;
    }
    state.lastStep = step;
    state.elapsedSteps = elapsed;
    state.rateHz = rateHz;
    return state;
  },
};

registerBehavioral('gen.clock', genClock);
