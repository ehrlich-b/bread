// Zero-input "source" primitives: tie-offs and weak pulls.
// These have no inputs and one output (Y) that drives a constant value.

import type { DriverValue, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

const constantSource = (driverValue: DriverValue): PrimitiveDef<undefined, undefined> => ({
  pins: () => [{ name: 'Y', dir: 'out' }],
  evaluate(_inputs, outputs) {
    outputs[0] = driverValue;
    return undefined;
  },
});

export const const0 = constantSource(0);
export const const1 = constantSource(1);
export const pullup = constantSource('H');
export const pulldown = constantSource('L');

registerPrimitive('prim.CONST_0', const0);
registerPrimitive('prim.CONST_1', const1);
registerPrimitive('prim.PULLUP', pullup);
registerPrimitive('prim.PULLDOWN', pulldown);
