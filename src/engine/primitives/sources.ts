// Zero-input "source" primitives: tie-offs and weak pulls.
// These have no inputs and one output (Y) that drives a constant value.

import type { DriverValue, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

const constantSource = (driverValue: DriverValue): PrimitiveDef<undefined, undefined> => ({
  pins: () => [{ name: 'Y', dir: 'out' }],
  evaluate() {
    return { outputs: [driverValue] };
  },
});

registerPrimitive('prim.CONST_0', constantSource(0));
registerPrimitive('prim.CONST_1', constantSource(1));
registerPrimitive('prim.PULLUP', constantSource('H'));
registerPrimitive('prim.PULLDOWN', constantSource('L'));
