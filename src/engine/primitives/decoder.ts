// n-to-2^n one-hot decoder. Pins:
//   A0..A{bits-1} (binary address)
//   Y0..Y{2^bits - 1} (one-hot outputs)
// activeLow=false: selected Y is 1, others 0.
// activeLow=true: selected Y is 0, others 1.
// If any address bit is X, every output is X.

import type { NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface DecoderParams {
  bits: number;
  activeLow: boolean;
}

const decoderPins = (params: DecoderParams): PinSpec[] => {
  if (!Number.isInteger(params.bits) || params.bits < 1) {
    throw new Error(`bits must be a positive integer, got ${String(params.bits)}`);
  }
  if (params.bits > 8) {
    // Practical limit: 2^9 = 512 outputs would be unwieldy. Bumpable later.
    throw new Error(`bits=${params.bits} exceeds the supported max of 8`);
  }
  const pins: PinSpec[] = [];
  for (let i = 0; i < params.bits; i++) pins.push({ name: `A${i}`, dir: 'in' });
  const outs = 1 << params.bits;
  for (let i = 0; i < outs; i++) {
    pins.push({ name: `Y${i}`, dir: 'out', activeLow: params.activeLow });
  }
  return pins;
};

const decoder: PrimitiveDef<undefined, DecoderParams> = {
  pins: decoderPins,
  evaluate(inputs, outputs, _state, params) {
    const outs = 1 << params.bits;
    let addr = 0;
    let unknown = false;
    for (let i = 0; i < params.bits; i++) {
      const bit = inputs[i]!;
      if (bit === 0) continue;
      if (bit === 1) addr |= 1 << i;
      else {
        unknown = true;
        break;
      }
    }
    if (unknown) {
      for (let i = 0; i < outs; i++) outputs[i] = 'X';
    } else {
      const selected: NetState = params.activeLow ? 0 : 1;
      const idle: NetState = params.activeLow ? 1 : 0;
      for (let i = 0; i < outs; i++) outputs[i] = idle;
      outputs[addr] = selected;
    }
    return undefined;
  },
};

registerPrimitive('prim.DECODER', decoder);
