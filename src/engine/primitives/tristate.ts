// Tristate buffer. When the output-enable is asserted, drives A onto Y.
// When de-asserted, drives Z. When OE is X, output is X (we can't decide
// whether the buffer is enabled).

import type { DriverValue, NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface TristateParams {
  oeActiveLow?: boolean;
}

const tristatePins = (params: TristateParams): PinSpec[] => {
  const pins: PinSpec[] = [{ name: 'A', dir: 'in' }];
  if (params.oeActiveLow) {
    pins.push({ name: '/OE', dir: 'in', activeLow: true });
  } else {
    pins.push({ name: 'OE', dir: 'in' });
  }
  pins.push({ name: 'Y', dir: 'out' });
  return pins;
};

const tristate: PrimitiveDef<undefined, TristateParams> = {
  pins: tristatePins,
  evaluate(inputs, _state, params) {
    const a = inputs[0]!;
    const oe = inputs[1]!;
    const enabled: NetState = params.oeActiveLow
      ? oe === 0
        ? 1
        : oe === 1
          ? 0
          : 'X'
      : oe;
    let out: DriverValue;
    if (enabled === 0) out = 'Z';
    else if (enabled === 1) out = a;
    else out = 'X';
    return { outputs: [out] };
  },
};

registerPrimitive('prim.TRISTATE', tristate);
