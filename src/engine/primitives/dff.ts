import type { NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface DffParams {
  clrActiveLow?: boolean;
  preActiveLow?: boolean;
}

interface DffState {
  q: NetState;
  prevClk: NetState;
}

const dffPins = (params: DffParams): PinSpec[] => {
  const pins: PinSpec[] = [
    { name: 'D', dir: 'in' },
    { name: 'CLK', dir: 'in' },
  ];
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
  init: () => ({ q: 'X', prevClk: 'X' }),
  evaluate(inputs, state, params) {
    let i = 0;
    const d = inputs[i++]!;
    const clk = inputs[i++]!;
    const clr = params.clrActiveLow ? inputs[i++]! : undefined;
    const pre = params.preActiveLow ? inputs[i++]! : undefined;

    let q = state.q;
    if (clr === 0) {
      q = 0;
    } else if (pre === 0) {
      q = 1;
    } else {
      const rose = state.prevClk === 0 && clk === 1;
      if (rose) q = d;
    }

    return {
      outputs: [q, invert(q)],
      nextState: { q, prevClk: clk },
    };
  },
};

registerPrimitive('prim.DFF', dff);
