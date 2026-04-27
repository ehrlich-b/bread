// io.switch — single-pole single-throw switch driven by the UI. One output Y,
// no inputs. State is the last value the user toggled. evaluate() simply
// reflects that value onto Y. The simulator's setComponentInput(compId, 'Y',
// newValue) is the canonical write path; the worker forwards UI clicks here.
//
// Default value 0 (open contact pulled low). Initial undefined state is
// surfaced as 0 too — the loader hasn't given the switch a chance to be
// toggled yet, and a freshly-loaded circuit should not present X to its
// downstream logic.

import type { NetState, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

interface SwitchState {
  Y: NetState;
}

const ioSwitch: PrimitiveDef<SwitchState, undefined> = {
  pins: () => [{ name: 'Y', dir: 'out' }],
  init: () => ({ Y: 0 }),
  evaluate(_inputs, state) {
    return { outputs: [state.Y] };
  },
};

registerBehavioral('io.switch', ioSwitch);
