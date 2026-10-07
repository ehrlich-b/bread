// One stable call site per built-in evaluator. A function array indexed by
// kind would still make its single call site megamorphic. Keep this switch
// in sim.ts explicit so V8 can specialize each call, in queue order.
import type { PrimitiveDef } from '../ir';
import { adder as adderDef } from './adder';
import { decoder as decoderDef } from './decoder';
import { dff as dffDef } from './dff';
import * as gates from './gates';
import { latch as latchDef } from './latch';
import { demux2 as demux2Def, mux2 as mux2Def } from './mux';
import * as sources from './sources';
import { tristate as tristateDef } from './tristate';

// Stable byte tags. sim.ts uses literal cases to compile a jump table;
// imported enum properties would require a dynamic comparison per arm.
export enum EvalKind {
  Generic = 0,
  And = 1,
  Or = 2,
  Nand = 3,
  Nor = 4,
  Xor = 5,
  Xnor = 6,
  Not = 7,
  Buf = 8,
  Dff = 9,
  Latch = 10,
  Tristate = 11,
  Mux2 = 12,
  Demux2 = 13,
  Decoder = 14,
  Adder = 15,
  Const0 = 16,
  Const1 = 17,
  Pullup = 18,
  Pulldown = 19,
}

// Same type erasure as the registry: the loader has already validated the
// params and initialized the matching state for each definition.
const leaf = <S, P>(def: PrimitiveDef<S, P>): PrimitiveDef => def as PrimitiveDef;
const and = leaf(gates.and);
export const evaluateAnd = and.evaluate;
const or = leaf(gates.or);
export const evaluateOr = or.evaluate;
const nand = leaf(gates.nand);
export const evaluateNand = nand.evaluate;
const nor = leaf(gates.nor);
export const evaluateNor = nor.evaluate;
const xor = leaf(gates.xor);
export const evaluateXor = xor.evaluate;
const xnor = leaf(gates.xnor);
export const evaluateXnor = xnor.evaluate;
const not = leaf(gates.not);
export const evaluateNot = not.evaluate;
const buf = leaf(gates.buf);
export const evaluateBuf = buf.evaluate;
const dff = leaf(dffDef);
export const evaluateDff = dff.evaluate;
const latch = leaf(latchDef);
export const evaluateLatch = latch.evaluate;
const tristate = leaf(tristateDef);
export const evaluateTristate = tristate.evaluate;
const mux2 = leaf(mux2Def);
export const evaluateMux2 = mux2.evaluate;
const demux2 = leaf(demux2Def);
export const evaluateDemux2 = demux2.evaluate;
const decoder = leaf(decoderDef);
export const evaluateDecoder = decoder.evaluate;
const adder = leaf(adderDef);
export const evaluateAdder = adder.evaluate;
const const0 = leaf(sources.const0);
export const evaluateConst0 = const0.evaluate;
const const1 = leaf(sources.const1);
export const evaluateConst1 = const1.evaluate;
const pullup = leaf(sources.pullup);
export const evaluatePullup = pullup.evaluate;
const pulldown = leaf(sources.pulldown);
export const evaluatePulldown = pulldown.evaluate;

const kinds = new Map<PrimitiveDef, EvalKind>([
  [and, EvalKind.And], [or, EvalKind.Or], [nand, EvalKind.Nand],
  [nor, EvalKind.Nor], [xor, EvalKind.Xor], [xnor, EvalKind.Xnor],
  [not, EvalKind.Not], [buf, EvalKind.Buf], [dff, EvalKind.Dff],
  [latch, EvalKind.Latch], [tristate, EvalKind.Tristate], [mux2, EvalKind.Mux2],
  [demux2, EvalKind.Demux2], [decoder, EvalKind.Decoder], [adder, EvalKind.Adder],
  [const0, EvalKind.Const0], [const1, EvalKind.Const1],
  [pullup, EvalKind.Pullup], [pulldown, EvalKind.Pulldown],
]);

export function getEvalKind(def: PrimitiveDef): EvalKind {
  // Match definition identity, not a type-name prefix: arbitrary registered
  // primitives and behavioral leaves must retain their own evaluator.
  return kinds.get(def) ?? EvalKind.Generic;
}
