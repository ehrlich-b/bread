import type { NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface DffParams {
  clrActiveLow?: boolean;
  preActiveLow?: boolean;
  // Explicit simulator power-on value, useful when porting a circuit whose
  // source simulator initializes storage. Unspecified still starts unknown.
  initialQ?: 0 | 1;
  enable?: boolean;
  // Verilog registers can store Z; ordinary physical D inputs read Z as X.
  verilogData?: boolean;
}

interface DffState {
  q: NetState;
  prevClk: NetState;
}

const dffPins = (params: DffParams): PinSpec[] => {
  if (params.initialQ !== undefined && params.initialQ !== 0 && params.initialQ !== 1) {
    throw new Error('DFF initialQ must be 0 or 1');
  }
  const pins: PinSpec[] = [
    { name: 'D', dir: 'in', ...(params.verilogData ? { readAsWire: true } : {}) },
    { name: 'CLK', dir: 'in' },
  ];
  if (params.enable) pins.push({ name: 'EN', dir: 'in' });
  if (params.clrActiveLow) pins.push({ name: '/CLR', dir: 'in', activeLow: true });
  if (params.preActiveLow) pins.push({ name: '/PRE', dir: 'in', activeLow: true });
  pins.push({ name: 'Q', dir: 'out' });
  pins.push({ name: 'Qn', dir: 'out' });
  return pins;
};

const invert = (q: NetState): NetState => {
  if (q === 0) return 1;
  if (q === 1) return 0;
  return 'X';
};

const dff: PrimitiveDef<DffState, DffParams> = {
  pins: dffPins,
  init: (params) => {
    dffPins(params);
    return { q: params.initialQ ?? 'X', prevClk: params.initialQ === undefined ? 'X' : 0 };
  },
  evaluate(inputs, outputs, state, params) {
    let i = 0;
    const d = inputs[i++]!;
    const clk = inputs[i++]!;
    const en = params.enable ? inputs[i++]! : 1;
    const clr = params.clrActiveLow ? inputs[i++]! : undefined;
    const pre = params.preActiveLow ? inputs[i++]! : undefined;

    let q = state.q;
    if (clr === 0) {
      q = 0;
    } else {
      if (pre === 0) {
        q = 1;
      } else {
        const rose = state.prevClk === 0 && clk === 1;
        if (rose) {
          if (en === 1) q = d;
          else if (en !== 0 && d !== q) q = 'X';
        }
        // An unknown async pin may be asserted or released. Keep a known
        // value only when both possibilities produce the same result.
        if ((pre === 'X' || pre === 'Z') && q !== 1) q = 'X';
      }
      if ((clr === 'X' || clr === 'Z') && q !== 0) q = 'X';
    }

    outputs[0] = q;
    outputs[1] = invert(q);
    state.q = q;
    state.prevClk = clk;
    return state;
  },
};

registerPrimitive('prim.DFF', dff);
