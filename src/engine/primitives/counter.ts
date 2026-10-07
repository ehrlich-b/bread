// Synchronous binary counter. Clear beats preset load, then enabled count.
// Control and preset data are sampled directly on the rising edge, without
// combinational propagation between the external pins and storage.
import type { NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface CounterParams {
  width: number;
  preset?: boolean;
}

interface CounterState {
  q: NetState[];
  prevClk: NetState;
}

const counterPins = (params: CounterParams): PinSpec[] => {
  if (!Number.isInteger(params.width) || params.width < 1) {
    throw new Error(`width must be a positive integer, got ${String(params.width)}`);
  }
  const pins: PinSpec[] = [{ name: 'EN', dir: 'in' }, { name: 'CLK', dir: 'in' }];
  if (params.preset) {
    pins.push({ name: 'DIR', dir: 'in' });
    for (let i = 0; i < params.width; i++) pins.push({ name: `D${i}`, dir: 'in' });
    pins.push({ name: 'LD', dir: 'in' });
  }
  pins.push({ name: 'CLR', dir: 'in' });
  for (let i = 0; i < params.width; i++) pins.push({ name: `Q${i}`, dir: 'out' });
  return pins;
};

const select = (a: NetState, b: NetState, s: NetState): NetState =>
  s === 0 ? a : s === 1 ? b : a === b ? a : 'X';

const count = (q: readonly NetState[], down: boolean): NetState[] => {
  let carry: NetState = 1;
  return q.map((bit) => {
    const next = carry === 0 ? bit : (bit === 0 || bit === 1) && carry === 1 ? (bit === 0 ? 1 : 0) : 'X';
    const propagates = down ? bit === 0 : bit === 1;
    carry = carry === 0 || bit === (down ? 1 : 0) ? 0 : carry === 1 && propagates ? 1 : 'X';
    return next;
  });
};

export const counter: PrimitiveDef<CounterState, CounterParams> = {
  pins: counterPins,
  init(params) {
    counterPins(params);
    return { q: new Array<NetState>(params.width).fill(0), prevClk: 0 };
  },
  evaluate(inputs, outputs, state, params) {
    const en = inputs[0]!;
    const clk = inputs[1]!;
    const dir = params.preset ? inputs[2]! : 0;
    const ld = params.preset ? inputs[3 + params.width]! : 0;
    const clr = inputs[params.preset ? 4 + params.width : 2]!;
    let q = state.q;
    if (state.prevClk === 0 && clk === 1) {
      const up = count(q, false);
      const down = params.preset ? count(q, true) : up;
      q = q.map((bit, i) => {
        const counted = select(bit, select(up[i]!, down[i]!, dir), en);
        const loaded = params.preset ? select(counted, inputs[3 + i]!, ld) : counted;
        return select(loaded, 0, clr);
      });
    }
    for (let i = 0; i < params.width; i++) outputs[i] = q[i]!;
    return { q, prevClk: clk };
  },
};

registerPrimitive('prim.COUNTER', counter);
