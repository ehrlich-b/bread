// io.7seg — seven-segment display sink. Eight input pins (a, b, c, d, e, f,
// g, dp) drive the segment-illumination state stored in the component. The
// chip drives nothing back onto the circuit — the renderer owns the
// "common-anode vs common-cathode" interpretation, since lit-vs-dark is a UI
// concern, not a logic-level one. Tests inspect component state directly to
// verify the latched segment values.

import type { NetState, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

interface SevenSegState {
  a: NetState;
  b: NetState;
  c: NetState;
  d: NetState;
  e: NetState;
  f: NetState;
  g: NetState;
  dp: NetState;
}

const SEGMENT_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;

const io7seg: PrimitiveDef<SevenSegState, undefined> = {
  pins: () => SEGMENT_NAMES.map((name) => ({ name, dir: 'in' as const })),
  init: () => ({ a: 'X', b: 'X', c: 'X', d: 'X', e: 'X', f: 'X', g: 'X', dp: 'X' }),
  evaluate(inputs, _outputs, state) {
    state.a = inputs[0]!;
    state.b = inputs[1]!;
    state.c = inputs[2]!;
    state.d = inputs[3]!;
    state.e = inputs[4]!;
    state.f = inputs[5]!;
    state.g = inputs[6]!;
    state.dp = inputs[7]!;
    return undefined;
  },
};

registerBehavioral('io.7seg', io7seg);
