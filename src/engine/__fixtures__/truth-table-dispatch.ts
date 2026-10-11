// Stable builtin targets for the frozen comparison backend only.
import '../primitives/index';
import type { PrimitiveDef } from '../ir';
import { getPrimitive } from '../primitives/registry';
const kinds = ['AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR', 'NOT', 'BUF', 'DFF', 'LATCH', 'TRISTATE', 'MUX2', 'DEMUX2', 'DECODER', 'ADDER', 'CONST_0', 'CONST_1', 'PULLUP', 'PULLDOWN'];
const targets = kinds.map(id => getPrimitive(`prim.${id}`)!.evaluate);
export function getEvalKind(def: PrimitiveDef<unknown, unknown>): number {
  return targets.indexOf(def.evaluate) + 1;
}
export const [evaluateAnd, evaluateOr, evaluateNand, evaluateNor, evaluateXor, evaluateXnor,
  evaluateNot, evaluateBuf, evaluateDff, evaluateLatch, evaluateTristate, evaluateMux2,
  evaluateDemux2, evaluateDecoder, evaluateAdder, evaluateConst0, evaluateConst1, evaluatePullup, evaluatePulldown] = targets as [
  typeof targets[number], typeof targets[number], typeof targets[number], typeof targets[number], typeof targets[number],
  typeof targets[number], typeof targets[number], typeof targets[number], typeof targets[number], typeof targets[number],
  typeof targets[number], typeof targets[number], typeof targets[number], typeof targets[number], typeof targets[number],
  typeof targets[number], typeof targets[number], typeof targets[number], typeof targets[number]];
