// 2:1 MUX and 1:2 DEMUX, parameterized by bus width.
//
// MUX2 pins (width=w): A0..A{w-1}, B0..B{w-1}, S, Y0..Y{w-1}
//   Y_i = S==0 ? A_i : B_i.  S=X → Y_i=X.
//
// DEMUX2 pins (width=w): A0..A{w-1}, S, Y0_0..Y0_{w-1}, Y1_0..Y1_{w-1}
//   S==0 → Y0=A, Y1 driven 0.  S==1 → Y1=A, Y0 driven 0.  S=X → both X.

import type { NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface WidthParams {
  width: number;
}

const validateWidth = (params: WidthParams): number => {
  if (!Number.isInteger(params.width) || params.width < 1) {
    throw new Error(`width must be a positive integer, got ${String(params.width)}`);
  }
  return params.width;
};

const muxPins = (params: WidthParams): PinSpec[] => {
  const w = validateWidth(params);
  const pins: PinSpec[] = [];
  for (let i = 0; i < w; i++) pins.push({ name: `A${i}`, dir: 'in' });
  for (let i = 0; i < w; i++) pins.push({ name: `B${i}`, dir: 'in' });
  pins.push({ name: 'S', dir: 'in' });
  for (let i = 0; i < w; i++) pins.push({ name: `Y${i}`, dir: 'out' });
  return pins;
};

export const mux2: PrimitiveDef<undefined, WidthParams> = {
  pins: muxPins,
  evaluate(inputs, outputs, _state, params) {
    const w = params.width;
    const s = inputs[2 * w]!;
    for (let i = 0; i < w; i++) {
      const a = inputs[i]!;
      const b = inputs[w + i]!;
      let y: NetState;
      if (s === 0) y = a;
      else if (s === 1) y = b;
      else y = a === b && (a === 0 || a === 1) ? a : 'X';
      outputs[i] = y;
    }
    return undefined;
  },
};

const demuxPins = (params: WidthParams): PinSpec[] => {
  const w = validateWidth(params);
  const pins: PinSpec[] = [];
  for (let i = 0; i < w; i++) pins.push({ name: `A${i}`, dir: 'in' });
  pins.push({ name: 'S', dir: 'in' });
  for (let i = 0; i < w; i++) pins.push({ name: `Y0_${i}`, dir: 'out' });
  for (let i = 0; i < w; i++) pins.push({ name: `Y1_${i}`, dir: 'out' });
  return pins;
};

export const demux2: PrimitiveDef<undefined, WidthParams> = {
  pins: demuxPins,
  evaluate(inputs, outputs, _state, params) {
    const w = params.width;
    const s = inputs[w]!;
    for (let i = 0; i < w; i++) {
      const a = inputs[i]!;
      let y0: NetState;
      let y1: NetState;
      if (s === 0) {
        y0 = a;
        y1 = 0;
      } else if (s === 1) {
        y0 = 0;
        y1 = a;
      } else {
        // S=X: each output is X if A is unknown enough to matter.
        // Specifically: if A=0, both routes give 0 → safe to say 0;
        // otherwise X.
        y0 = a === 0 ? 0 : 'X';
        y1 = a === 0 ? 0 : 'X';
      }
      outputs[i] = y0;
      outputs[w + i] = y1;
    }
    return undefined;
  },
};

registerPrimitive('prim.MUX2', mux2);
registerPrimitive('prim.DEMUX2', demux2);
