// io.led — one-pin display. Sinks a logic value, produces nothing onto the
// circuit. Storing the value in component state makes the LED's "color" cheap
// to read from the worker side (state is owned by the worker; the UI samples
// the wired net via SAB if it wants the bit directly).

import type { NetState, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

interface LedState {
  value: NetState;
}

const ioLed: PrimitiveDef<LedState, undefined> = {
  pins: () => [{ name: 'A', dir: 'in' }],
  init: () => ({ value: 'X' }),
  evaluate(inputs) {
    return { outputs: [], nextState: { value: inputs[0]! } };
  },
};

registerBehavioral('io.led', ioLed);
