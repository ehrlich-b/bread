// Width-parameterized binary adder with carry-in and carry-out.
// Pins: A0..A{w-1}, B0..B{w-1}, Cin, S0..S{w-1}, Cout.
// Models a ripple chain semantically, but evaluates in one pass.
// X handling: per-bit, if any of (A_i, B_i, c_i) is X then S_i is X.
// The carry uses the standard majority form so it can stay defined when
// possible (e.g. A=B=1 ⇒ carry=1 even if c is X).

import type { DriverValue, NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface AdderParams {
  width: number;
}

const adderPins = (params: AdderParams): PinSpec[] => {
  if (!Number.isInteger(params.width) || params.width < 1) {
    throw new Error(`width must be a positive integer, got ${String(params.width)}`);
  }
  const pins: PinSpec[] = [];
  const w = params.width;
  for (let i = 0; i < w; i++) pins.push({ name: `A${i}`, dir: 'in' });
  for (let i = 0; i < w; i++) pins.push({ name: `B${i}`, dir: 'in' });
  pins.push({ name: 'Cin', dir: 'in' });
  for (let i = 0; i < w; i++) pins.push({ name: `S${i}`, dir: 'out' });
  pins.push({ name: 'Cout', dir: 'out' });
  return pins;
};

const and2 = (a: NetState, b: NetState): NetState => {
  if (a === 0 || b === 0) return 0;
  if (a === 1 && b === 1) return 1;
  return 'X';
};

const or2 = (a: NetState, b: NetState): NetState => {
  if (a === 1 || b === 1) return 1;
  if (a === 0 && b === 0) return 0;
  return 'X';
};

const xor2 = (a: NetState, b: NetState): NetState => {
  if (a === 'X' || b === 'X') return 'X';
  return a === b ? 0 : 1;
};

const adder: PrimitiveDef<undefined, AdderParams> = {
  pins: adderPins,
  evaluate(inputs, _state, params) {
    const w = params.width;
    let c: NetState = inputs[2 * w]!;
    const outputs: DriverValue[] = new Array<DriverValue>(w + 1);
    for (let i = 0; i < w; i++) {
      const a = inputs[i]!;
      const b = inputs[w + i]!;
      const s = xor2(xor2(a, b), c);
      // majority(a, b, c)
      const c_next = or2(or2(and2(a, b), and2(a, c)), and2(b, c));
      outputs[i] = s;
      c = c_next;
    }
    outputs[w] = c;
    return { outputs };
  },
};

registerPrimitive('prim.ADDER', adder);
