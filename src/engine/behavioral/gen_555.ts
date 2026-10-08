// gen.555 — idealized astable model of the NE555 timer. One output pin OUT,
// one param freqHz. Same phase-preserving toggle as gen.clock but lives as its own
// chip so circuits authored against the real datasheet name (and the Eater
// clock module) keep their identity. We do not model TRIG/THRESH/DISCH/CTRL —
// those belong to the analog timing network, which sits below our four-state
// abstraction. RESET (datasheet pin 4) is treated as tied high; an exposed
// /RST pin can be added later if a circuit needs it.

import type { NetState, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

interface Gen555Params {
  freqHz: number;
}

interface Gen555State {
  OUT: NetState;
  lastStep: number;
  elapsedSteps: number;
  rateHz: number;
}

const halfPeriodSteps = (rateHz: number, freqHz: number): number => {
  const raw = Math.round(rateHz / freqHz / 2);
  return raw > 0 ? raw : 1;
};

const gen555: PrimitiveDef<Gen555State, Gen555Params> = {
  pins: () => [{ name: 'OUT', dir: 'out' }],
  tickActive: true,
  init: (params) => {
    if (!Number.isFinite(params.freqHz) || params.freqHz <= 0) {
      throw new Error(`gen.555: freqHz must be positive, got ${String(params.freqHz)}`);
    }
    return { OUT: 0, lastStep: 0, elapsedSteps: 0, rateHz: 1 };
  },
  evaluate(_inputs, outputs, state, params, ctx) {
    const step = ctx?.step ?? 0;
    const rateHz = ctx?.rateHz ?? 1;
    outputs[0] = state.OUT;
    if (step === state.lastStep) return undefined;
    const elapsed = state.elapsedSteps * (rateHz / state.rateHz) + (step - state.lastStep);
    const half = halfPeriodSteps(rateHz, params.freqHz);
    // Rate changes can leave fractional ticks; tolerate rescaling roundoff.
    if (elapsed >= half - 1e-9) {
      const flipped: NetState = state.OUT === 1 ? 0 : 1;
      outputs[0] = flipped;
      return { OUT: flipped, lastStep: step, elapsedSteps: 0, rateHz };
    }
    return { OUT: state.OUT, lastStep: step, elapsedSteps: elapsed, rateHz };
  },
};

registerBehavioral('gen.555', gen555);
