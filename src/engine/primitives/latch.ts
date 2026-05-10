// Level-sensitive D latch. Transparent while EN=1; holds while EN=0.

import type { NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface LatchState {
  q: NetState;
}

const latchPins = (): PinSpec[] => [
  { name: 'D', dir: 'in' },
  { name: 'EN', dir: 'in' },
  { name: 'Q', dir: 'out' },
  { name: 'Qn', dir: 'out' },
];

const invert = (q: NetState): NetState => {
  if (q === 0) return 1;
  if (q === 1) return 0;
  return 'X';
};

const latch: PrimitiveDef<LatchState, undefined> = {
  pins: latchPins,
  init: () => ({ q: 'X' }),
  evaluate(inputs, outputs, state) {
    const d = inputs[0]!;
    const en = inputs[1]!;
    let q: NetState;
    if (en === 1) {
      q = d;
    } else if (en === 0) {
      q = state.q;
    } else {
      // EN unknown: only safe answer is Q=X unless transparent and held
      // would agree. If d === state.q (and is strong) we can pin Q to that.
      q = d === state.q && (d === 0 || d === 1) ? d : 'X';
    }
    outputs[0] = q;
    outputs[1] = invert(q);
    return { q };
  },
};

registerPrimitive('prim.LATCH', latch);
