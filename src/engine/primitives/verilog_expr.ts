// Unsigned, bounded combinational Verilog expressions. Inputs read raw wires so
// assignments and conditional expressions preserve Z, unlike physical gates.
import type { NetState, PrimitiveDef } from '../ir';
import { registerPrimitive } from './registry';

export type Expression =
  | { op: 'literal'; bits: string }
  | { op: 'input'; index: number; width: number }
  | { op: 'concat'; args: Expression[] }
  | { op: 'slice'; arg: Expression; low: number; width: number }
  | { op: 'unary'; operator: string; arg: Expression }
  | { op: 'binary'; operator: string; left: Expression; right: Expression }
  | { op: 'mux' | 'if'; condition: Expression; yes: Expression; no: Expression };

export interface ExpressionParams {
  width?: number;
  inputWidths?: number[];
  expression?: Expression;
}

const operators = new Set(['&', '|', '^', '~^', '+', '-', '==', '!=', '===', '!==', '&&', '||']);
const unaryOperators = new Set(['~', '!', '&', '|', '^', '~&', '~|', '~^']);
const validWidth = (n: number): number => {
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error('Verilog expression width must be 1..256');
  return n;
};

export function expressionWidth(e: Expression): number {
  switch (e.op) {
    case 'literal': return e.bits.length;
    case 'input': case 'slice': return e.width;
    case 'concat': return e.args.reduce((n, a) => n + expressionWidth(a), 0);
    case 'unary': return e.operator === '~' ? expressionWidth(e.arg) : 1;
    case 'binary': return ['==', '!=', '===', '!==', '&&', '||'].includes(e.operator) ? 1 : Math.max(expressionWidth(e.left), expressionWidth(e.right));
    case 'mux': case 'if': return Math.max(expressionWidth(e.yes), expressionWidth(e.no));
  }
}

function validate(params: ExpressionParams): void {
  validWidth(params.width ?? 1);
  const widths = params.inputWidths ?? [];
  if (!Array.isArray(widths) || widths.length > 4096) throw new Error('Verilog expression exceeds input limit');
  widths.forEach(validWidth);
  if (widths.reduce((n, w) => n + w, 0) > 16384) throw new Error('Verilog expression exceeds input lane limit');
  let nodes = 0;
  const visit = (e: Expression, depth: number): void => {
    if (++nodes > 4096 || depth > 64) throw new Error('Verilog expression too complex');
    if (!e || typeof e !== 'object') throw new Error('Invalid Verilog expression');
    switch (e.op) {
      case 'literal':
        if (typeof e.bits !== 'string' || !/^[01XZ]+$/.test(e.bits)) throw new Error('Invalid Verilog literal');
        break;
      case 'input':
        if (!Number.isInteger(e.index) || widths[e.index] !== e.width) throw new Error('Invalid Verilog input');
        break;
      case 'slice':
        visit(e.arg, depth + 1);
        if (!Number.isInteger(e.low) || e.low < 0 || e.low + e.width > expressionWidth(e.arg)) throw new Error('Invalid Verilog slice');
        break;
      case 'concat':
        if (!Array.isArray(e.args) || !e.args.length) throw new Error('Invalid Verilog concatenation');
        e.args.forEach(a => visit(a, depth + 1)); break;
      case 'unary':
        if (!unaryOperators.has(e.operator)) throw new Error('Invalid Verilog unary operator');
        visit(e.arg, depth + 1); break;
      case 'binary':
        if (!operators.has(e.operator)) throw new Error('Invalid Verilog binary operator');
        visit(e.left, depth + 1); visit(e.right, depth + 1); break;
      case 'mux': case 'if':
        visit(e.condition, depth + 1); visit(e.yes, depth + 1); visit(e.no, depth + 1); break;
      default: throw new Error('Invalid Verilog expression construct');
    }
    validWidth(expressionWidth(e));
  };
  if (params.expression) visit(params.expression, 0);
}

const resize = (bits: string, width: number): string => bits.padStart(width, '0').slice(-width);
const known = (bits: string): boolean => /^[01]+$/.test(bits);
const truth = (bits: string): string => bits.includes('1') ? '1' : known(bits) ? '0' : 'X';
const invert = (bit: string): string => bit === '0' ? '1' : bit === '1' ? '0' : 'X';
const bitOp = (op: string, a: string, b: string): string => {
  if (op === '&') return a === '0' || b === '0' ? '0' : a === '1' && b === '1' ? '1' : 'X';
  if (op === '|') return a === '1' || b === '1' ? '1' : a === '0' && b === '0' ? '0' : 'X';
  const xor = /^[01]$/.test(a) && /^[01]$/.test(b) ? a === b ? '0' : '1' : 'X';
  return op === '~^' ? invert(xor) : xor;
};

export function evaluateExpression(e: Expression, inputs: readonly string[], context = expressionWidth(e)): string {
  const width = Math.max(context, expressionWidth(e));
  const evaluate = (a: Expression, size = expressionWidth(a)): string => evaluateExpression(a, inputs, size);
  let result: string;
  switch (e.op) {
    case 'literal': result = e.bits; break;
    case 'input': result = inputs[e.index]!; break;
    case 'slice': result = evaluate(e.arg).slice(-(e.low + e.width), e.low ? -e.low : undefined); break;
    case 'concat': result = e.args.map(a => evaluate(a)).join(''); break;
    case 'unary': {
      const a = evaluate(e.arg, e.operator === '~' ? width : expressionWidth(e.arg));
      if (e.operator === '~') result = [...a].map(invert).join('');
      else if (e.operator === '!') result = invert(truth(a));
      else {
        const op = e.operator.replace('~', '');
        result = [...a].reduce((v, bit) => bitOp(op, v, bit), op === '&' ? '1' : '0');
        if (e.operator.startsWith('~')) result = invert(result);
      }
      break;
    }
    case 'binary': {
      const op = e.operator;
      const scalar = ['==', '!=', '===', '!==', '&&', '||'].includes(op);
      const size = Math.max(expressionWidth(e.left), expressionWidth(e.right), scalar ? 0 : width);
      const logical = op === '&&' || op === '||';
      const a = evaluate(e.left, logical ? expressionWidth(e.left) : size);
      const b = evaluate(e.right, logical ? expressionWidth(e.right) : size);
      if (op === '+' || op === '-') {
        const mask = (1n << BigInt(size)) - 1n;
        result = known(a) && known(b) ? ((op === '+' ? BigInt(`0b${a}`) + BigInt(`0b${b}`) : BigInt(`0b${a}`) - BigInt(`0b${b}`)) & mask).toString(2).padStart(size, '0') : 'X'.repeat(size);
      } else if (op === '===' || op === '!==') result = (a === b) === (op === '===') ? '1' : '0';
      else if (op === '==' || op === '!=') {
        const mismatch = [...a].some((bit, i) => /^[01]$/.test(bit) && /^[01]$/.test(b[i]!) && bit !== b[i]);
        result = mismatch ? '0' : known(a) && known(b) ? '1' : 'X';
        if (op === '!=') result = invert(result);
      } else if (op === '&&' || op === '||') result = bitOp(op === '&&' ? '&' : '|', truth(a), truth(b));
      else result = [...a].map((bit, i) => bitOp(op, bit, b[i]!)).join('');
      break;
    }
    case 'mux': case 'if': {
      const condition = truth(evaluate(e.condition));
      const yes = evaluate(e.yes, width); const no = evaluate(e.no, width);
      result = condition === '1' ? yes : condition === '0' || e.op === 'if' ? no : [...yes].map((bit, i) => bit === no[i] ? bit : 'X').join('');
      break;
    }
  }
  return resize(result, context);
}

export function expressionVerilog(params: ExpressionParams, pin: (name: string) => string): string {
  const render = (e: Expression): string => {
    switch (e.op) {
      case 'literal': return `${e.bits.length}'b${e.bits.toLowerCase()}`;
      case 'input': return `{${Array.from({ length: e.width }, (_, i) => pin(`I${e.index}_${e.width - i - 1}`)).join(', ')}}`;
      case 'concat': return `{${e.args.map(render).join(', ')}}`;
      // Shift and mask avoid illegal part-selects on a parenthesized expression.
      case 'slice': return `${e.width}'((${render(e.arg)}) >> ${e.low})`;
      case 'unary': return `(${e.operator}${render(e.arg)})`;
      case 'binary': return `(${render(e.left)} ${e.operator} ${render(e.right)})`;
      case 'mux': case 'if': return `(${e.op === 'if' ? `((|${render(e.condition)}) === 1'b1)` : render(e.condition)} ? ${render(e.yes)} : ${render(e.no)})`;
    }
  };
  return render(params.expression ?? { op: 'literal', bits: 'X' });
}

export const verilogExpression: PrimitiveDef<undefined, ExpressionParams> = {
  pins(params) {
    validate(params);
    return [...(params.inputWidths ?? []).flatMap((w, index) => Array.from({ length: w }, (_, i) => ({ name: `I${index}_${i}`, dir: 'in' as const, readAsWire: true }))),
      ...Array.from({ length: params.width ?? 1 }, (_, i) => ({ name: `Y${i}`, dir: 'out' as const }))];
  },
  evaluate(inputs, outputs, _state, params) {
    let offset = 0;
    const words = (params.inputWidths ?? []).map(width => {
      const word = inputs.slice(offset, offset + width).reverse().join(''); offset += width; return word;
    });
    const result = evaluateExpression(params.expression ?? { op: 'literal', bits: 'X' }, words, params.width ?? 1);
    for (let i = 0; i < result.length; i++) outputs[i] = (result[result.length - i - 1] === '0' ? 0 : result[result.length - i - 1] === '1' ? 1 : result[result.length - i - 1]) as NetState;
    return undefined;
  },
};

registerPrimitive('prim.VERILOG', verilogExpression);
