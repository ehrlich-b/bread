// A small structural-subset parser, not a general Verilog compiler. Every
// token is consumed or rejected; exporter cells are verified before recovery.
import { getPinsForType } from './index';
import type { CircuitJSON, ComponentInstanceJSON, PinDir } from './ir';
import { loadCircuit } from './loader';
import { evaluateExpression, expressionWidth, type Expression } from './primitives/verilog_expr';
import { renderVerilogLeaf, type VerilogSource } from './verilog';
import { VERILOG_SOURCE_LIMIT, VERILOG_SOURCE_LIMIT_ERROR } from './verilog_limits';
import { resolveRenderer } from '../ui/schematic/renderers';

interface Token { text: string; line: number; column: number; cell?: Cell; body?: Token[]; sources?: string[] }
interface Cell { id: string; type: string; params?: Record<string, unknown>; bindings: Record<string, string>; temps: Record<string, string>; source?: VerilogSource }
export class VerilogImportError extends Error {
  constructor(token: Token, construct: string) {
    super(`Line ${token.line}, column ${token.column}: ${construct}`);
    this.name = 'VerilogImportError';
  }
}
function fail(t: Token, construct: string): never { throw new VerilogImportError(t, construct); }
const identifier = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const simpleIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tokenize(source: string, budget = { count: 0 }): Token[] {
  const tokens: Token[] = [];
  let offset = 0; let line = 1; let column = 1;
  const advance = (text: string): void => {
    const lines = text.split('\n');
    if (lines.length > 1) { line += lines.length - 1; column = lines.at(-1)!.length + 1; }
    else column += text.length;
    offset += text.length;
  };
  while (offset < source.length) {
    const rest = source.slice(offset);
    const token: Token = { text: '', line, column };
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { advance(whitespace[0]); continue; }
    if (rest.startsWith('// bread:sources ')) {
      const endLine = rest.indexOf('\n');
      const comment = endLine < 0 ? rest : rest.slice(0, endLine);
      try { token.sources = JSON.parse(comment.slice(17)) as string[]; }
      catch { fail(token, 'invalid bread:sources'); }
      if (!Array.isArray(token.sources) || token.sources.some(s => typeof s !== 'string' || !simpleIdentifier.test(s))) fail(token, 'invalid bread:sources');
      token.text = 'bread:sources'; tokens.push(token); advance(comment); continue;
    }
    if (rest.startsWith('// bread:cell ')) {
      const endLine = rest.indexOf('\n');
      if (endLine < 0) fail(token, 'unterminated bread:cell');
      try { token.cell = JSON.parse(rest.slice(14, endLine)) as Cell; }
      catch { fail(token, 'invalid bread:cell annotation'); }
      const end = rest.indexOf('// bread:endcell', endLine);
      if (end < 0) fail(token, 'unterminated bread:cell');
      if (rest.slice(endLine + 1, end).includes('// bread:cell ')) fail(token, 'nested bread:cell is unsupported');
      token.text = 'bread:cell';
      token.body = tokenize(rest.slice(endLine + 1, end), budget);
      tokens.push(token);
      advance(rest.slice(0, end + 16)); continue;
    }
    if (rest.startsWith('//')) {
      const endLine = rest.indexOf('\n');
      advance(endLine < 0 ? rest : rest.slice(0, endLine)); continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end < 0) fail(token, 'unterminated block comment');
      advance(rest.slice(0, end + 2)); continue;
    }
    if (rest.startsWith('`')) {
      const endLine = rest.indexOf('\n');
      const directive = endLine < 0 ? rest : rest.slice(0, endLine);
      if (!/^`default_nettype\s+(none|wire)\s*$/.test(directive) && !/^`timescale\s+\d+(s|ms|us|ns|ps|fs)\s*\/\s*\d+(s|ms|us|ns|ps|fs)\s*$/.test(directive)) fail(token, `unsupported directive ${directive}`);
      advance(directive); continue;
    }
    const match = /^(?:\d[\d_]*'[bBoOdDhH][0-9a-fA-F_xXzZ?]+|\d[\d_]*'|\d[\d_]*|[A-Za-z_][A-Za-z0-9_$]*|===|!==|~\^|\^~|~&|~\||<=|==|!=|&&|\|\||>>|[()\[\]{}.,;:@?=~!&|^+\-*/<>#])/.exec(rest);
    if (!match) fail(token, `unsupported character ${JSON.stringify(rest[0])}`);
    token.text = match[0]; tokens.push(token); advance(match[0]);
    if (++budget.count > 250_000) fail(token, 'source exceeds structural import token limit');
  }
  tokens.push({ text: '<eof>', line, column });
  return tokens;
}

type Expr = { token: Token } & (
  | { kind: 'ref'; name: string; high?: number; low?: number }
  | { kind: 'literal'; bits: string }
  | { kind: 'concat'; args: Expr[] }
  | { kind: 'unary'; operator: string; arg: Expr }
  | { kind: 'binary'; operator: string; left: Expr; right: Expr }
  | { kind: 'mux' | 'if'; condition: Expr; yes: Expr; no: Expr }
);
interface Signal { token: Token; name: string; high: number; low: number; vector?: boolean; dir?: PinDir; reg: boolean; initial?: Expr }
type Statement = { kind: 'assign'; target: Expr; value: Expr } | { kind: 'block'; statements: Statement[] } | { kind: 'if'; condition: Expr; yes: Statement; no?: Statement };
interface Instance { token: Token; type: string; id: string; anonymous?: boolean; connections: { name?: string; expression?: Expr }[] }
interface Module {
  token: Token; name: string; ports: string[]; signals: Map<string, Signal>;
  assigns: { target: Expr; value: Expr }[];
  instances: Instance[]; cells: Token[]; registers: { token: Token; clock: Expr; statement: Statement }[];
  sourcePorts: string[];
  items: ({ kind: 'cell'; token: Token } | { kind: 'instance'; instance: Instance })[];
}
const precedence: Record<string, number> = { '||': 1, '&&': 2, '|': 3, '^': 4, '~^': 4, '^~': 4, '&': 5, '==': 6, '!=': 6, '===': 6, '!==': 6, '+': 7, '-': 7 };
const gates = new Set(['and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf', 'bufif0', 'bufif1', 'tran', 'pullup', 'pulldown']);

class Parser {
  private index = 0;
  private depth = 0;
  constructor(private tokens: Token[]) {}
  peek(): Token { return this.tokens[this.index]!; }
  take(): Token { return this.tokens[this.index++]!; }
  accept(text: string): boolean { if (this.peek().text !== text) return false; this.take(); return true; }
  expect(text: string): Token { const t = this.take(); if (t.text !== text) fail(t, `expected ${text}; unsupported construct ${t.text}`); return t; }
  name(): Token { const t = this.take(); if (!identifier.test(t.text)) fail(t, `expected identifier; unsupported construct ${t.text}`); return t; }
  integer(): number {
    const t = this.take(); const value = Number(t.text.replaceAll('_', ''));
    if (!/^\d[\d_]*$/.test(t.text) || !Number.isSafeInteger(value) || value > 65535) fail(t, 'range/index requires a nonnegative integer <= 65535');
    return value;
  }
  range(): [number, number] {
    if (!this.accept('[')) return [0, 0];
    const high = this.integer(); this.expect(':'); const low = this.integer(); this.expect(']');
    if (Math.abs(high - low) + 1 > 256) fail(this.peek(), 'vector width exceeds 256');
    return [high, low];
  }
  expression(minimum = 0): Expr {
    if (++this.depth > 64) fail(this.peek(), 'expression nesting exceeds 64');
    const token = this.take(); let result: Expr;
    if (token.text === '(') { result = this.expression(); this.expect(')'); }
    else if (token.text === '{') {
      const args = [this.expression()]; while (this.accept(',')) args.push(this.expression());
      this.expect('}'); result = { token, kind: 'concat', args };
    } else if (['~', '!', '&', '|', '^', '~&', '~|', '~^', '^~'].includes(token.text)) result = { token, kind: 'unary', operator: token.text === '^~' ? '~^' : token.text, arg: this.expression(8) };
    else if (/^\d/.test(token.text)) result = { token, kind: 'literal', bits: literal(token) };
    else if (identifier.test(token.text)) {
      result = { token, kind: 'ref', name: token.text };
      if (this.accept('[')) { result.high = this.integer(); result.low = this.accept(':') ? this.integer() : result.high; this.expect(']'); }
    } else fail(token, `unsupported expression ${token.text}`);
    while ((precedence[this.peek().text] ?? -1) >= minimum) {
      const operator = this.take().text;
      result = { token, kind: 'binary', operator: operator === '^~' ? '~^' : operator, left: result, right: this.expression(precedence[operator]! + 1) };
    }
    if (minimum === 0 && this.accept('?')) {
      const yes = this.expression(); this.expect(':'); result = { token, kind: 'mux', condition: result, yes, no: this.expression() };
    }
    this.depth--; return result;
  }
  statement(): Statement {
    if (++this.depth > 64) fail(this.peek(), 'statement nesting exceeds 64');
    let result: Statement;
    if (this.accept('begin')) {
      const statements: Statement[] = [];
      while (!this.accept('end')) { if (this.peek().text === '<eof>') fail(this.peek(), 'unterminated begin'); statements.push(this.statement()); }
      result = { kind: 'block', statements };
    } else if (this.accept('if')) {
      this.expect('('); const condition = this.expression(); this.expect(')');
      const yes = this.statement(); const no = this.accept('else') ? this.statement() : undefined;
      result = { kind: 'if', condition, yes, no };
    } else {
      if (['for', 'while', 'repeat', 'forever', 'case', 'casex', 'casez', 'fork', 'wait'].includes(this.peek().text)) fail(this.peek(), `unsupported procedural construct ${this.peek().text}`);
      const target = this.expression(); this.expect('<='); const value = this.expression(); this.expect(';');
      result = { kind: 'assign', target, value };
    }
    this.depth--; return result;
  }
  modules(): Module[] {
    const modules: Module[] = [];
    while (this.peek().text !== '<eof>') {
      this.expect('module'); const token = this.name();
      const m: Module = { token, name: token.text, ports: [], signals: new Map(), assigns: [], instances: [], cells: [], registers: [], sourcePorts: [], items: [] };
      if (this.accept('(')) {
        let direction: PinDir | undefined; let range: [number, number] = [0, 0]; let reg = false; let vector = false;
        if (!this.accept(')')) do {
          if (['input', 'output', 'inout'].includes(this.peek().text)) {
            direction = directionOf(this.take().text); reg = this.accept('reg'); if (!reg) this.accept('wire');
            if (this.peek().text === 'signed') fail(this.peek(), 'unsupported signed declaration');
            vector = this.peek().text === '['; range = this.range();
          }
          const port = this.name(); m.ports.push(port.text);
          const initial = this.accept('=') ? this.expression() : undefined;
          if (initial && !reg) fail(port, 'unsupported port default value');
          if (direction) this.declare(m, { token: port, name: port.text, dir: direction, reg, vector, high: range[0], low: range[1], initial });
          else if (this.peek().text !== ',' && this.peek().text !== ')') fail(this.peek(), 'unsupported port declaration');
        } while (this.accept(','));
        if (this.tokens[this.index - 1]!.text !== ')') this.expect(')');
      }
      this.expect(';');
      while (!this.accept('endmodule')) {
        const t = this.peek();
        if (['input', 'output', 'inout', 'wire', 'reg'].includes(t.text)) {
          const declaration = this.take().text; const dir = ['input', 'output', 'inout'].includes(declaration) ? directionOf(declaration) : undefined;
          const reg = declaration === 'reg' || this.accept('reg'); if (!reg) this.accept('wire');
          if (this.peek().text === 'signed') fail(this.peek(), 'unsupported signed declaration');
          const vector = this.peek().text === '[';
          const [high, low] = this.range();
          do {
            const name = this.name(); const initial = this.accept('=') ? this.expression() : undefined;
            this.declare(m, { token: name, name: name.text, high, low, vector, dir, reg, initial });
            if (initial && !reg) m.assigns.push({ target: { token: name, kind: 'ref', name: name.text }, value: initial });
          } while (this.accept(','));
          this.expect(';');
        } else if (this.accept('assign')) {
          do { const target = this.expression(); this.expect('='); const value = this.expression(); m.assigns.push({ target, value }); } while (this.accept(','));
          this.expect(';');
        } else if (this.accept('always')) {
          this.expect('@'); this.expect('('); this.expect('posedge'); const clock = this.expression(); this.expect(')');
          m.registers.push({ token: t, clock, statement: this.statement() });
        } else if (t.cell) { m.cells.push(this.take()); m.items.push({ kind: 'cell', token: t }); }
        else if (t.sources) { m.sourcePorts = this.take().sources!; }
        else {
          const type = this.name();
          if (['parameter', 'localparam', 'generate', 'initial', 'function', 'task', 'integer', 'logic', 'always_ff', 'always_comb'].includes(type.text)) fail(type, `unsupported construct ${type.text}`);
          do {
            const anonymous = this.peek().text === '(' && gates.has(type.text);
            const id = anonymous ? `gate_${m.instances.length}` : this.name().text;
            this.expect('('); const connections: Instance['connections'] = [];
            if (!this.accept(')')) {
              do {
                const name = this.accept('.') ? this.name().text : undefined;
                if (name) this.expect('(');
                const expression = this.peek().text === ')' || this.peek().text === ',' ? undefined : this.expression();
                if (name) this.expect(')'); connections.push({ name, expression });
              } while (this.accept(',')); this.expect(')');
            }
            const instance = { token: type, type: type.text, id, anonymous, connections };
            m.instances.push(instance); m.items.push({ kind: 'instance', instance });
          } while (this.accept(',')); this.expect(';');
        }
      }
      if (new Set(m.ports).size !== m.ports.length) fail(token, 'duplicate module port');
      for (const port of m.ports) if (!m.signals.get(port)?.dir) fail(token, `undeclared port ${port}`);
      for (const signal of m.signals.values()) if (signal.dir && !m.ports.includes(signal.name)) fail(signal.token, `port ${signal.name} absent from module header`);
      modules.push(m);
    }
    if (!modules.length) fail(this.peek(), 'expected module');
    return modules;
  }
  private declare(m: Module, s: Signal): void {
    if (s.reg && s.dir && s.dir !== 'out') fail(s.token, 'unsupported input/inout reg declaration');
    const old = m.signals.get(s.name);
    if (old) {
      // Classic "output q; reg q;" declarations are legal.
      if (!s.dir && s.reg && old.dir === 'out' && !old.reg && old.high === s.high && old.low === s.low) { Object.assign(old, { reg: true, initial: s.initial }); return; }
      fail(s.token, `duplicate declaration ${s.name}`);
    }
    m.signals.set(s.name, s);
  }
}

const directionOf = (text: string): PinDir => text === 'input' ? 'in' : text === 'output' ? 'out' : 'inout';
function literal(t: Token): string {
  const match = /^(\d[\d_]*)'([bodh])([0-9a-f_xz?]+)$/i.exec(t.text);
  if (!match) {
    if (!/^\d[\d_]*$/.test(t.text)) fail(t, 'invalid numeric literal');
    const n = BigInt(t.text.replaceAll('_', ''));
    if (n >= 2n ** 31n) fail(t, 'unsized integer exceeds nonnegative signed 32-bit subset; use a sized unsigned literal');
    return n.toString(2).padStart(32, '0');
  }
  const width = Number(match[1]!.replaceAll('_', '')); if (width < 1 || width > 256) fail(t, 'literal width must be 1..256');
  const base = match[2]!.toLowerCase(); const digits = match[3]!.replaceAll('_', '').toUpperCase().replaceAll('?', 'Z');
  const allowed = base === 'b' ? /^[01XZ]+$/ : base === 'o' ? /^[0-7XZ]+$/ : base === 'h' ? /^[0-9A-FXZ]+$/ : /^(\d+|X|Z)$/;
  if (!allowed.test(digits)) fail(t, `invalid ${base} literal`);
  if (base === 'd') return /^[XZ]$/.test(digits) ? digits.repeat(width) : BigInt(digits).toString(2).padStart(width, '0').slice(-width);
  const size = base === 'b' ? 1 : base === 'o' ? 3 : 4;
  const bits = [...digits].map(d => /^[XZ]$/.test(d) ? d.repeat(size) : parseInt(d, base === 'h' ? 16 : base === 'o' ? 8 : 2).toString(2).padStart(size, '0')).join('');
  return bits.padStart(width, /^[XZ]/.test(bits) ? bits[0] : '0').slice(-width);
}

const signalBits = (s: Signal): string[] => Array.from({ length: Math.abs(s.high - s.low) + 1 }, (_, i) => !s.vector ? s.name : `${s.name}[${s.low + (s.high >= s.low ? i : -i)}]`);
function reference(m: Module, e: Expr): string[] {
  if (e.kind === 'concat') return [...e.args].reverse().flatMap(a => reference(m, a));
  if (e.kind !== 'ref') fail(e.token, 'connection/assignment target requires a wire, constant slice or concatenation');
  const s = m.signals.get(e.name); if (!s) fail(e.token, `undeclared signal ${e.name}`);
  const bits = signalBits(s);
  if (e.high === undefined) return bits;
  const low = e.low!; const high = e.high;
  if ((s.high >= s.low) !== (high >= low) && high !== low) fail(e.token, `reversed part-select ${e.name}`);
  const selected = Array.from({ length: Math.abs(high - low) + 1 }, (_, i) => !s.vector ? s.name : `${s.name}[${low + (high >= low ? i : -i)}]`);
  if (selected.some(b => !bits.includes(b)) || (s.high === s.low && (high !== s.low || low !== s.low))) fail(e.token, `out-of-range select ${e.name}`);
  return selected;
}

class Builder {
  json: CircuitJSON;
  signalNets = new Map<string, string>();
  instanceBindings = new Map<string, Map<string, string>>();
  private endpoints = new Map<string, string[]>();
  private parent = new Map<string, string>();
  private used = new Set<string>();
  private reserved = new Set<string>();
  private temporaries = new Set<string>();
  private sequence = 0;
  constructor(readonly module: Module, private types: Map<string, string>, private modules: Map<string, Module>, root: boolean) {
    this.json = { version: 1, kind: root ? 'circuit' : 'composite', name: root ? module.name : types.get(module.name)!, components: [], nets: [], ports: [] };
    for (const instance of module.instances) if (!instance.anonymous) this.reserved.add(instance.id);
    for (const cell of module.cells) this.reserved.add(cell.cell!.id);
    for (const s of module.signals.values()) for (const bit of signalBits(s)) {
      if (this.parent.size >= 100_000) fail(s.token, 'flattened hierarchy exceeds 100,000 net limit');
      this.parent.set(bit, bit); this.endpoints.set(bit, []);
    }
  }
  private find(bit: string): string {
    let root = bit;
    while (this.parent.get(root) !== root) {
      const parent = this.parent.get(root);
      if (parent === undefined) fail(this.module.token, `undeclared cell binding ${bit}`);
      root = parent;
    }
    while (bit !== root) { const parent = this.parent.get(bit)!; this.parent.set(bit, root); bit = parent; }
    return root;
  }
  private alias(a: string, b: string): void { const ar = this.find(a); const br = this.find(b); if (ar !== br) this.parent.set(br, ar); }
  private connect(bit: string, endpoint: string): void { this.endpoints.get(this.find(bit))!.push(endpoint); }
  private add(type: string, params?: Record<string, unknown>, id?: string): ComponentInstanceJSON {
    if (this.json.components.length >= 25_000) fail(this.module.token, 'flattened hierarchy exceeds 25,000 instance limit');
    let name = id;
    if (name === undefined) do { name = `v${this.sequence++}`; } while (this.used.has(name) || this.reserved.has(name));
    if (!name || name.includes('.') || this.used.has(name)) fail(this.module.token, `duplicate/invalid instance ${name}`);
    this.used.add(name); const component = { id: name, type, ...(params ? { params } : {}) }; this.json.components.push(component); return component;
  }
  private expression(e: Expr, inputs: string[][], depth = 0): Expression {
    if (depth > 64) fail(e.token, 'expression nesting exceeds 64');
    const convert = (arg: Expr): Expression => this.expression(arg, inputs, depth + 1);
    switch (e.kind) {
      case 'ref': { const bits = reference(this.module, e); const index = inputs.length; inputs.push(bits); return { op: 'input', index, width: bits.length }; }
      case 'literal': return { op: 'literal', bits: e.bits };
      case 'concat': return { op: 'concat', args: e.args.map(convert) };
      case 'unary': return { op: 'unary', operator: e.operator, arg: convert(e.arg) };
      case 'binary': return { op: 'binary', operator: e.operator, left: convert(e.left), right: convert(e.right) };
      case 'mux': case 'if': return { op: e.kind, condition: convert(e.condition), yes: convert(e.yes), no: convert(e.no) };
    }
  }
  private assign(target: string[], e: Expr, label?: string): void {
    const inputs: string[][] = []; const expression = this.expression(e, inputs);
    if (expressionWidth(expression) > 256 || target.length > 256 || inputs.reduce((n, bits) => n + bits.length, 0) > 16384) fail(e.token, 'expression exceeds width/input lane limit');
    const component = this.add('prim.VERILOG', { width: target.length, inputWidths: inputs.map(b => b.length), expression });
    component.label = label ?? (target.length === 1 ? target[0]! : `${target[0]}…${target.at(-1)}`);
    inputs.forEach((bits, index) => bits.forEach((bit, i) => this.connect(bit, `${component.id}.I${index}_${i}`)));
    target.forEach((bit, i) => this.connect(bit, `${component.id}.Y${i}`));
  }
  private input(e: Expr): string[] {
    if (e.kind === 'ref' || e.kind === 'concat' && e.args.every(a => a.kind === 'ref')) return reference(this.module, e);
    const inputs: string[][] = []; const expr = this.expression(e, inputs); const width = expressionWidth(expr);
    const nets = Array.from({ length: width }, () => this.newNet('__expr'));
    this.assign(nets, e, 'port expression'); return nets;
  }
  private newNet(prefix: string): string {
    if (this.parent.size >= 100_000) fail(this.module.token, 'flattened hierarchy exceeds 100,000 net limit');
    let name: string; do { name = `${prefix}${this.sequence++}`; } while (this.parent.has(name));
    this.parent.set(name, name); this.endpoints.set(name, []); return name;
  }
  private cell(t: Token): void {
    const c = t.cell!;
    try {
      if (!c || typeof c.id !== 'string' || typeof c.type !== 'string' || !c.bindings || !c.temps) fail(t, 'invalid bread:cell');
      const count = Object.keys(c.bindings).length;
      if (['prim.MUX2', 'prim.DEMUX2', 'prim.ADDER', 'prim.COUNTER', 'prim.VERILOG'].includes(c.type) && typeof c.params?.width === 'number' && c.params.width > count
        || c.type === 'prim.DECODER' && typeof c.params?.bits === 'number' && 2 ** c.params.bits > count) fail(t, 'bread:cell parameter exceeds available pin bindings');
      const pins = getPinsForType(c.type, c.params);
      if (!pins || !c.type.startsWith('prim.') && !c.type.startsWith('mem.') && !c.type.startsWith('io.') && !c.type.startsWith('gen.')) fail(t, `unsupported bread:cell ${c.type}`);
      if (Object.keys(c.bindings).length !== pins.length || pins.some(p => !Object.hasOwn(c.bindings, p.name))) fail(t, `invalid ${c.type} pin bindings`);
      for (const name of [...Object.values(c.bindings), ...Object.values(c.temps)]) if (typeof name !== 'string' || !simpleIdentifier.test(name)) fail(t, 'invalid bread:cell wire name');
      for (const name of Object.values(c.bindings)) if (!this.parent.has(name)) fail(t, `undeclared bread:cell wire ${name}`);
      const rendered = renderVerilogLeaf(c, c.bindings, suffix => {
        if (!Object.hasOwn(c.temps, suffix)) fail(t, `missing bread:cell temporary ${suffix}`);
        return c.temps[suffix]!;
      }, c.source);
      if (rendered.some(line => line.includes('Unsupported:'))) fail(t, `unsupported bread:cell ${c.type}`);
      const expected = tokenize(rendered.join('\n')).slice(0, -1).map(t => t.text);
      const actual = t.body!.slice(0, -1).map(t => t.text);
      if (actual.length !== expected.length || actual.some((text, i) => text !== expected[i])) fail(t, `modified/unsupported bread:cell ${c.type} body`);
      // Templates own their temporaries. No surrounding statement may reference
      // them, and pin bindings must refer to ordinary module declarations.
      for (const name of Object.values(c.temps)) {
        if (this.module.signals.has(name) || this.temporaries.has(name)) fail(t, `bread:cell temporary collides with ${name}`);
        this.temporaries.add(name);
      }
      const inst = this.add(c.type, c.params, c.id);
      for (const pin of pins) this.connect(c.bindings[pin.name]!, `${inst.id}.${pin.name}`);
      if (c.source) {
        if (!simpleIdentifier.test(c.source.port) || !pins.some(p => p.name === c.source!.pin)) fail(t, 'invalid bread:cell source');
        this.alias(c.bindings[c.source.pin]!, c.source.port);
      }
    } catch (error) {
      if (error instanceof VerilogImportError) throw error;
      fail(t, `invalid bread:cell ${c.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  build(): CircuitJSON {
    const m = this.module;
    if (this.json.kind === 'composite' && !m.ports.length) fail(m.token, 'portless non-top module is outside the chip subset');
    this.checkSources();
    for (const item of m.items) {
      if (item.kind === 'cell') { this.cell(item.token); continue; }
      const inst = item.instance;
      if (gates.has(inst.type)) this.gate(inst);
      else {
        const child = this.modules.get(inst.type); if (!child) fail(inst.token, `unknown module/unsupported construct ${inst.type}`);
        const named = inst.connections.some(c => c.name !== undefined);
        if (named && inst.connections.some(c => c.name === undefined)) fail(inst.token, 'mixed named and positional ports');
        if (!named && inst.connections.length !== child.ports.length) fail(inst.token, `port count for ${inst.type}`);
        if (named && new Set(inst.connections.map(c => c.name)).size !== inst.connections.length) fail(inst.token, `duplicate named port for ${inst.type}`);
        const component = this.add(this.types.get(inst.type)!, undefined, inst.id);
        const bindings = new Map<string, string>(); this.instanceBindings.set(inst.id, bindings);
        for (const [index, connection] of inst.connections.entries()) {
          const name = named ? connection.name! : child.ports[index]!;
          if (child.sourcePorts.includes(name)) continue;
          const port = child.signals.get(name); if (!port?.dir) fail(inst.token, `unknown port ${name} on ${inst.type}`);
          if (!connection.expression) continue;
          const bits = port.dir === 'in' ? this.input(connection.expression) : reference(m, connection.expression);
          const portBits = signalBits(port);
          if (bits.length !== portBits.length) fail(inst.token, `port width mismatch for ${inst.type}.${name}`);
          bits.forEach((bit, i) => {
            this.connect(bit, `${component.id}.${portName(portBits[i]!)}`);
            bindings.set(portBits[i]!, bit);
          });
        }
      }
    }
    for (const assign of m.assigns) {
      const bits = reference(m, assign.target);
      if (bits.some(b => [...m.signals.values()].some(s => s.reg && signalBits(s).includes(b)))) fail(assign.target.token, 'continuous assignment to reg');
      this.assign(bits, assign.value);
    }
    const driven = new Set<string>();
    for (const always of m.registers) {
      const clock = reference(m, always.clock); if (clock.length !== 1) fail(always.token, 'posedge clock must be scalar');
      const targets = new Map<string, Expr>();
      const visit = (s: Statement): void => {
        if (s.kind === 'assign') {
          if (s.target.kind !== 'ref' || s.target.high !== undefined || !m.signals.get(s.target.name)?.reg) fail(s.target.token, 'nonblocking assignment requires a whole declared reg');
          targets.set(s.target.name, s.target);
        } else if (s.kind === 'block') s.statements.forEach(visit);
        else { visit(s.yes); if (s.no) visit(s.no); }
      };
      visit(always.statement);
      if (!targets.size) fail(always.token, 'always block has no register assignment');
      const next = (s: Statement, name: string, hold: Expr): Expr => {
        if (s.kind === 'assign') return s.target.kind === 'ref' && s.target.name === name ? s.value : hold;
        if (s.kind === 'block') return s.statements.reduce((value, statement) => next(statement, name, value), hold);
        return { token: s.condition.token, kind: 'if', condition: s.condition, yes: next(s.yes, name, hold), no: s.no ? next(s.no, name, hold) : hold };
      };
      for (const [name, target] of targets) {
        if (driven.has(name)) fail(always.token, `multiple always drivers for reg ${name}`); driven.add(name);
        const signal = m.signals.get(name)!; const bits = signalBits(signal);
        const data = bits.map(() => this.newNet('__data'));
        this.assign(data, next(always.statement, name, target), `${name} next`);
        let initial: string | undefined;
        if (signal.initial) {
          const inputs: string[][] = []; const e = this.expression(signal.initial, inputs);
          if (inputs.length) fail(signal.token, 'reg initialization must be constant');
          initial = evaluateExpression(e, [], bits.length);
          if (!/^[01]+$/.test(initial)) fail(signal.token, 'reg initialization supports only 0/1');
        }
        bits.forEach((bit, i) => {
          const component = this.add('prim.DFF', { verilogData: true, ...(initial ? { initialQ: Number(initial[bits.length - i - 1]) } : {}) });
          this.connect(data[i]!, `${component.id}.D`); this.connect(clock[0]!, `${component.id}.CLK`); this.connect(bit, `${component.id}.Q`);
        });
      }
    }
    for (const signal of m.signals.values()) if (signal.reg && !driven.has(signal.name)) fail(signal.token, `reg ${signal.name} lacks a supported always driver`);
    // Keep every declared lane visible and attach an electrically passive
    // terminal when a lane has no component endpoint (loader forbids empties).
    const nets = new Map<string, string[]>();
    for (const [bit, endpoints] of this.endpoints) {
      const root = this.find(bit); const list = nets.get(root) ?? []; list.push(...endpoints); nets.set(root, list);
    }
    for (const [id, endpoints] of nets) {
      if (!endpoints.length) { const terminal = this.add('io.led'); endpoints.push(`${terminal.id}.A`); }
      this.json.nets.push({ id, name: id, endpoints });
    }
    for (const bit of this.parent.keys()) this.signalNets.set(bit, this.find(bit));
    const portNets = new Set<string>(); const portNames = new Set<string>();
    for (const name of m.ports) {
      if (m.sourcePorts.includes(name)) continue;
      const s = m.signals.get(name)!;
      for (const bit of signalBits(s)) {
        const net = this.find(bit); const port = portName(bit);
        if (portNames.has(port)) fail(s.token, `flattened port name collision ${port}`); portNames.add(port);
        // Bread exposes one chip pin per stitched net. Verilog tied inout
        // ports are represented by a harmless wire terminal on a separate net.
        if (portNets.has(net) && this.json.kind === 'composite') {
          // Exporter source ports alias their output net; omit the redundant
          // forwarded source pin since its original generator is restored.
          if (m.cells.some(t => t.cell?.source?.port === name)) continue;
          fail(s.token, `tied module ports ${name} are outside the chip subset`);
        }
        portNets.add(net); this.json.ports!.push({ name: port, dir: s.dir!, internalNet: net });
      }
    }
    return this.json;
  }
  private checkSources(): void {
    const m = this.module;
    if (new Set(m.sourcePorts).size !== m.sourcePorts.length) fail(m.token, 'duplicate bread:sources');
    const cellSources = new Map<Token, string>();
    for (const t of m.cells) {
      const c = t.cell!;
      if (!c || typeof c !== 'object') fail(t, 'invalid bread:cell');
      const expected = c.type === 'io.switch' ? 'switch' : c.type === 'gen.clock' ? 'clock' : c.type === 'gen.555' ? '555' : undefined;
      if (expected) {
        if (!c.source || c.source.component !== c.id || c.source.kind !== expected || c.source.pin !== (expected === '555' ? 'OUT' : 'Y')) fail(t, 'invalid bread:cell source');
        cellSources.set(t, c.source.port);
      } else if (c.source) fail(t, 'unexpected bread:cell source');
    }
    const usesSource = (e: Expr): boolean => {
      switch (e.kind) {
        case 'ref': return m.sourcePorts.includes(e.name);
        case 'literal': return false;
        case 'unary': return usesSource(e.arg);
        case 'binary': return usesSource(e.left) || usesSource(e.right);
        case 'concat': return e.args.some(usesSource);
        case 'mux': case 'if': return usesSource(e.condition) || usesSource(e.yes) || usesSource(e.no);
      }
    };
    const check = (e: Expr): void => { if (m.sourcePorts.length && usesSource(e)) fail(e.token, 'bread source used outside its recovered cell/forwarding connection'); };
    for (const assign of m.assigns) { check(assign.target); check(assign.value); }
    const recovered: string[] = [];
    for (const item of m.items) {
      if (item.kind === 'cell') {
        const source = cellSources.get(item.token); if (source !== undefined) recovered.push(source);
        continue;
      }
      const inst = item.instance;
      const child = this.modules.get(inst.type);
      const forwarded = new Map<string, string>();
      for (const [index, connection] of inst.connections.entries()) {
        const name = connection.name ?? child?.ports[index];
        if (child?.sourcePorts.includes(name!)) {
          const e = connection.expression;
          if (!e || e.kind !== 'ref' || e.high !== undefined || forwarded.has(name!)) fail(inst.token, 'invalid bread source forwarding');
          forwarded.set(name!, e.name);
        } else if (connection.expression) check(connection.expression);
      }
      for (const source of child?.sourcePorts ?? []) {
        const parent = forwarded.get(source);
        if (parent === undefined) fail(inst.token, 'missing bread source forwarding connection');
        recovered.push(parent);
      }
    }
    const statement = (s: Statement): void => {
      if (s.kind === 'assign') { check(s.target); check(s.value); }
      else if (s.kind === 'block') s.statements.forEach(statement);
      else { check(s.condition); statement(s.yes); if (s.no) statement(s.no); }
    };
    for (const always of m.registers) { check(always.clock); statement(always.statement); }
    if (recovered.length !== m.sourcePorts.length || m.sourcePorts.some((name, i) => recovered[i] !== name || m.signals.get(name)?.dir !== 'in' || signalBits(m.signals.get(name)!).length !== 1)) fail(m.token, 'bread:sources do not match restored cells/forwarding connections in source order');
  }
  private gate(inst: Instance): void {
    if (inst.connections.some(c => c.name || !c.expression)) fail(inst.token, `primitive ${inst.type} requires positional connected ports`);
    const args = inst.connections.map(c => c.expression!);
    if (!args.length) fail(inst.token, `invalid ${inst.type} port count`);
    if (inst.type === 'tran') {
      if (args.length !== 2) fail(inst.token, 'tran requires two ports');
      const a = reference(this.module, args[0]!); const b = reference(this.module, args[1]!);
      if (a.length !== b.length) fail(inst.token, 'tran width mismatch'); a.forEach((bit, i) => this.alias(bit, b[i]!)); return;
    }
    if (inst.type === 'pullup' || inst.type === 'pulldown') {
      if (args.length !== 1) fail(inst.token, 'pull primitive requires one port');
      const bits = reference(this.module, args[0]!); if (bits.length !== 1) fail(inst.token, 'gate primitives require scalar ports');
      const c = this.add(inst.type === 'pullup' ? 'prim.PULLUP' : 'prim.PULLDOWN', undefined, inst.anonymous ? undefined : inst.id); this.connect(bits[0]!, `${c.id}.Y`); return;
    }
    const output = reference(this.module, args[0]!); const inputs = args.slice(1).map(e => this.input(e));
    if (output.length !== 1 || inputs.some(a => a.length !== 1)) fail(inst.token, 'gate primitives require scalar ports');
    const count = inst.type === 'not' || inst.type === 'buf' ? 1 : inst.type.startsWith('bufif') ? 2 : undefined;
    if (inputs.length < 1 || inputs.length > 24 || count !== undefined && inputs.length !== count) fail(inst.token, `invalid ${inst.type} port count`);
    const type = inst.type.startsWith('bufif') ? 'prim.TRISTATE' : `prim.${inst.type.toUpperCase()}`;
    const params = inst.type.startsWith('bufif') ? { oeActiveLow: inst.type === 'bufif0', verilogBufif: true } : count === undefined ? { inputs: inputs.length } : undefined;
    const c = this.add(type, params, inst.anonymous ? undefined : inst.id); const pins = getPinsForType(type, params)!.filter(p => p.dir === 'in');
    inputs.forEach((bits, i) => this.connect(bits[0]!, `${c.id}.${pins[i]!.name}`)); this.connect(output[0]!, `${c.id}.Y`);
  }
}

const portName = (bit: string): string => bit.replace(/\[(\d+)\]$/, '_$1').replaceAll('$', '_dollar_');
export interface VerilogImport {
  circuit: CircuitJSON;
  topModule: string;
  modules: Record<string, string>;
  // Hierarchical Verilog wire paths to validated, flattened simulator net IDs.
  nets: Record<string, string>;
}

export function importVerilog(source: string, options: { topModule?: string; onProgress?: (phase: string) => void } = {}): VerilogImport {
  if (source.length > VERILOG_SOURCE_LIMIT || new TextEncoder().encode(source).length > VERILOG_SOURCE_LIMIT) throw new Error(VERILOG_SOURCE_LIMIT_ERROR);
  options.onProgress?.('Scanning source');
  const tokens = tokenize(source);
  options.onProgress?.('Parsing modules');
  const parsed = new Parser(tokens).modules();
  const modules = new Map<string, Module>(); const types = new Map<string, string>();
  for (const m of parsed) {
    if (modules.has(m.name)) fail(m.token, `duplicate module ${m.name}`); modules.set(m.name, m);
    const type = `user.V_${m.name.replaceAll('$', '_dollar_')}`;
    if ([...types.values()].includes(type)) fail(m.token, `module name collision ${m.name}`); types.set(m.name, type);
  }
  const instantiated = new Set(parsed.flatMap(m => m.instances.filter(i => !gates.has(i.type)).map(i => i.type)));
  const roots = parsed.filter(m => !instantiated.has(m.name));
  const top = options.topModule ? modules.get(options.topModule) : roots.length === 1 ? roots[0] : parsed[0]!.name.startsWith('top_') ? parsed[0] : undefined;
  if (!top) fail(parsed[0]!.token, options.topModule ? `unknown top module ${options.topModule}` : 'ambiguous top module; choose topModule');
  options.onProgress?.('Building circuit');
  const builders = new Map(parsed.map(m => [m.name, new Builder(m, types, modules, m === top)]));
  const definitions = parsed.filter(m => m !== top).map(m => builders.get(m.name)!.build());
  const circuit = builders.get(top.name)!.build(); circuit.definitions = definitions;
  // Count the DAG with memoization before the loader allocates flattened
  // copies. Count all instance nodes and nets before port stitching, including
  // floating leaf pins, so both runtime allocation and wire-path recovery fit.
  const sizes = new Map<string, { instances: number; nets: number; depth: number }>();
  const modulesByType = new Map(parsed.map(m => [types.get(m.name)!, m]));
  const active = new Set<string>();
  const size = (m: Module): { instances: number; nets: number; depth: number } => {
    const cached = sizes.get(m.name); if (cached) return cached;
    if (active.has(m.name)) fail(m.token, 'recursive module hierarchy');
    if (active.size >= 64) fail(m.token, 'module hierarchy exceeds 64 levels');
    active.add(m.name);
    const json = builders.get(m.name)!.json;
    const count = { instances: json.components.length, nets: json.nets.length, depth: 1 };
    const check = (): void => {
      if (count.instances > 25_000) fail(m.token, 'flattened hierarchy exceeds 25,000 instance limit');
      if (count.nets > 100_000) fail(m.token, 'flattened hierarchy exceeds 100,000 net limit');
      if (count.depth > 64) fail(m.token, 'module hierarchy exceeds 64 levels');
    };
    check();
    const connected = new Set(json.nets.flatMap(n => n.endpoints));
    for (const component of json.components) {
      const module = modulesByType.get(component.type);
      if (module) {
        const childSize = size(module);
        count.instances += childSize.instances; count.nets += childSize.nets;
        count.depth = Math.max(count.depth, childSize.depth + 1);
      } else {
        for (const pin of getPinsForType(component.type, component.params)!) if (!connected.has(`${component.id}.${pin.name}`)) count.nets++;
      }
      check();
    }
    active.delete(m.name); sizes.set(m.name, count); return count;
  };
  for (const m of parsed) size(m);
  options.onProgress?.('Placing components');
  // Size-aware deterministic shelf placement reuses the schematic renderers.
  for (const json of [circuit, ...definitions]) {
    let x = 60; let y = 60; let rowHeight = 0;
    for (const component of json.components) {
      const size = resolveRenderer(component.type, component.params, definitions)?.size ?? { w: 100, h: 60 };
      if (x + size.w > 1200) { x = 60; y += rowHeight + 100; rowHeight = 0; }
      component.position = [x, y]; x += size.w + 100; rowHeight = Math.max(rowHeight, size.h + 20);
    }
  }
  let graph;
  options.onProgress?.('Validating hierarchy');
  try { graph = loadCircuit(circuit); }
  catch (error) { fail(top.token, `invalid module hierarchy: ${error instanceof Error ? error.message : String(error)}`); }
  const nets: Record<string, string> = Object.create(null) as Record<string, string>;
  options.onProgress?.('Mapping wires');
  const walk = (m: Module, path: string, prefix: string, overrides: Map<string, string>): void => {
    const builder = builders.get(m.name)!;
    const runtime = (bit: string): string => overrides.get(builder.signalNets.get(bit)!) ?? `${prefix}${builder.signalNets.get(bit)!}`;
    for (const bit of builder.signalNets.keys()) {
      const net = runtime(bit);
      if (graph.netById.has(net)) nets[path + bit] = net;
    }
    for (const instance of m.instances) {
      if (gates.has(instance.type)) continue;
      const child = modules.get(instance.type)!; const childBuilder = builders.get(child.name)!;
      const childOverrides = new Map<string, string>();
      for (const [portBit, bit] of builder.instanceBindings.get(instance.id)!) childOverrides.set(childBuilder.signalNets.get(portBit)!, runtime(bit));
      walk(child, `${path}${instance.id}.`, `${prefix}${instance.id}__`, childOverrides);
    }
  };
  walk(top, '', '', new Map());
  return { circuit, topModule: top.name, modules: Object.fromEntries(types), nets };
}
