import type { NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

interface NaryParams {
  inputs: number;
}

const isStrong = (v: NetState): v is 0 | 1 => v === 0 || v === 1;

const and2 = (a: NetState, b: NetState): NetState => {
  if (a === 0 || b === 0) return 0;
  if (!isStrong(a) || !isStrong(b)) return 'X';
  return 1;
};

const or2 = (a: NetState, b: NetState): NetState => {
  if (a === 1 || b === 1) return 1;
  if (!isStrong(a) || !isStrong(b)) return 'X';
  return 0;
};

const xor2 = (a: NetState, b: NetState): NetState => {
  if (!isStrong(a) || !isStrong(b)) return 'X';
  return a === b ? 0 : 1;
};

const not1 = (a: NetState): NetState => {
  if (a === 0) return 1;
  if (a === 1) return 0;
  return 'X';
};

const inputName = (i: number): string => {
  // 'A', 'B', ..., 'X'  — skips 'Y' (output) and 'Z' (high-impedance literal in user ID space).
  if (i >= 24) throw new Error(`gate fan-in ${i + 1} exceeds 24; use indexed naming`);
  return String.fromCharCode(65 + i);
};

const naryPins = (params: NaryParams): PinSpec[] => {
  if (!Number.isInteger(params.inputs) || params.inputs < 1) {
    throw new Error(`inputs must be a positive integer, got ${String(params.inputs)}`);
  }
  const pins: PinSpec[] = [];
  for (let i = 0; i < params.inputs; i++) pins.push({ name: inputName(i), dir: 'in' });
  pins.push({ name: 'Y', dir: 'out' });
  return pins;
};

const reduce = (
  ins: NetState[],
  fn: (a: NetState, b: NetState) => NetState,
): NetState => {
  let acc = ins[0]!;
  for (let i = 1; i < ins.length; i++) acc = fn(acc, ins[i]!);
  return acc;
};

const naryGate = (
  fn: (a: NetState, b: NetState) => NetState,
  invert: boolean,
): PrimitiveDef<undefined, NaryParams> => ({
  pins: naryPins,
  evaluate(inputs) {
    const y = reduce(inputs, fn);
    return { outputs: [invert ? not1(y) : y] };
  },
});

const not: PrimitiveDef<undefined, undefined> = {
  pins: () => [
    { name: 'A', dir: 'in' },
    { name: 'Y', dir: 'out' },
  ],
  evaluate(inputs) {
    return { outputs: [not1(inputs[0]!)] };
  },
};

const buf: PrimitiveDef<undefined, undefined> = {
  pins: () => [
    { name: 'A', dir: 'in' },
    { name: 'Y', dir: 'out' },
  ],
  evaluate(inputs) {
    // BUF passes its input through. Z input → X (handled by scheduler before we see it).
    return { outputs: [inputs[0]!] };
  },
};

registerPrimitive('prim.AND', naryGate(and2, false));
registerPrimitive('prim.OR', naryGate(or2, false));
registerPrimitive('prim.NAND', naryGate(and2, true));
registerPrimitive('prim.XOR', naryGate(xor2, false));
registerPrimitive('prim.NOT', not);
registerPrimitive('prim.BUF', buf);

// Internal exports for tests.
export const _internal = { and2, or2, xor2, not1, inputName };
