// A structural, best-effort netlist export. No simulator state or JSON is
// mutated: saved parameters, not the running worker's state, are exported.
import { getPinsForType } from './index';
import { getComposite } from './composites/registry';
import { projectComposites } from './composites/project';
import { getBehavioral } from './behavioral/registry';
import { decodeHexContents } from './behavioral/mem_28c16';
import { decodeWordContents, wordRomDimensions } from './behavioral/mem_rom';
import type { CircuitJSON, ComponentInstanceJSON, PinSpec } from './ir';
import { loadCircuit } from './loader';
import { getPrimitive } from './primitives/registry';
import { expressionVerilog, type ExpressionParams } from './primitives/verilog_expr';

export interface VerilogSource {
  component: string;
  pin: string;
  port: string;
  kind: 'switch' | 'clock' | '555';
  freqHz?: number;
}

export interface VerilogExport {
  source: string;
  topModule: string;
  // Paths relative to an instance of topModule, keyed by engine net IDs.
  nets: Record<string, string>;
  sources: VerilogSource[];
  modules: Record<string, string>;
}

class Names {
  private used = new Set<string>();
  take(prefix: string, id: string): string {
    const base = prefix + id.replace(/[^A-Za-z0-9_]/g, '_');
    let name = base; let suffix = 2;
    while (this.used.has(name)) name = `${base}_${suffix++}`;
    this.used.add(name);
    return name;
  }
}

const quote = (value: unknown): string => JSON.stringify(value).replace(/[\u2028\u2029]/g, c => c === '\u2028' ? '\\u2028' : '\\u2029');
const joinPath = (path: string, name: string): string => path ? `${path}.${name}` : name;
const leaf = (type: string) => getPrimitive(type) ?? getBehavioral(type);

interface ModulePlan {
  json: CircuitJSON;
  name: string;
  names: Names;
  nets: Map<string, string>;
  ports: Map<string, string>;
  instances: Map<string, string>;
  pins: Map<string, PinSpec[]>;
  wires: Map<string, string>;
  sources: VerilogSource[];
  floating: string[];
}

export function exportVerilog(circuit: CircuitJSON): VerilogExport {
  // Use the same validation, including unused project definitions, as load.
  const graph = loadCircuit(circuit);
  const definitions = projectComposites(circuit);
  const moduleNames = new Names();
  const plans = new Map<string, ModulePlan>();
  const composite = (type: string): CircuitJSON | undefined => definitions.get(type) ?? getComposite(type);
  const plan = (json: CircuitJSON, top = false, type = json.name): ModulePlan => {
    const existing = plans.get(type);
    if (!top && existing) return existing;
    const names = new Names();
    const result: ModulePlan = {
      json, name: moduleNames.take(top ? 'top_' : 'chip_', type), names,
      nets: new Map(), ports: new Map(), instances: new Map(), pins: new Map(),
      wires: new Map(), sources: [], floating: [],
    };
    // Keep the root separate even if its display name is a chip type.
    if (!top) plans.set(type, result);
    for (const net of json.nets) result.nets.set(net.id, names.take('n_', net.id));
    for (const port of json.ports ?? []) {
      if (!result.nets.has(port.internalNet)) throw new Error(`Port ${port.name}: unknown net ${port.internalNet}`);
      if (result.ports.has(port.name)) throw new Error(`Duplicate port ${port.name}`);
      result.ports.set(port.name, names.take('p_', port.name));
    }
    for (const net of json.nets) for (const endpoint of net.endpoints) result.wires.set(endpoint, result.nets.get(net.id)!);
    for (const inst of json.components) {
      result.instances.set(inst.id, names.take('u_', inst.id));
      const pins = getPinsForType(inst.type, inst.params, [...definitions.values()])!;
      result.pins.set(inst.id, pins);
      for (const pin of pins) {
        const endpoint = `${inst.id}.${pin.name}`;
        if (!result.wires.has(endpoint)) {
          const wire = names.take('floating_', `${inst.id}_${pin.name}`);
          result.wires.set(endpoint, wire);
          result.floating.push(wire);
        }
      }
      if (inst.type === 'io.switch' || inst.type === 'gen.clock' || inst.type === 'gen.555') {
        const pin = inst.type === 'gen.555' ? 'OUT' : 'Y';
        result.sources.push({ component: inst.id, pin, port: names.take('s_', `${inst.id}_${pin}`),
          kind: inst.type === 'io.switch' ? 'switch' : inst.type === 'gen.555' ? '555' : 'clock',
          freqHz: inst.type === 'io.switch' ? undefined : Number(inst.params?.freqHz) });
      } else if (!leaf(inst.type)) {
        const child = plan(composite(inst.type)!, false, inst.type);
        for (const source of child.sources) {
          const component = `${inst.id}__${source.component}`;
          result.sources.push({ ...source, component, port: names.take('s_', `${component}_${source.pin}`) });
        }
      }
    }
    return result;
  };
  const top = plan(circuit, true);
  for (const def of definitions.values()) plan(def);
  const endpointPaths = new Map<string, string>();
  const walk = (current: ModulePlan, path: string, prefix: string): void => {
    for (const inst of current.json.components) {
      if (leaf(inst.type)) {
        for (const pin of current.pins.get(inst.id)!) {
          endpointPaths.set(`${prefix}${inst.id}.${pin.name}`, joinPath(path, current.wires.get(`${inst.id}.${pin.name}`)!));
        }
      } else walk(plans.get(inst.type)!, joinPath(path, current.instances.get(inst.id)!), `${prefix}${inst.id}__`);
    }
  };
  walk(top, '', '');
  const nets: Record<string, string> = Object.create(null) as Record<string, string>;
  // A flattened net's first endpoint identifies an electrically aliased wire
  // in the structural hierarchy, even when the net backs a nested chip port.
  for (const comp of graph.components) for (let i = 0; i < comp.pins.length; i++) {
    const id = graph.nets[comp.pinNetIdx[i]!]!.id;
    nets[id] ??= endpointPaths.get(`${comp.id}.${comp.pins[i]!.name}`)!;
  }
  const modules = Object.fromEntries([...plans].map(([type, value]) => [type, value.name]));
  const header = [
    '// Bread best-effort Verilog export (saved circuit, not live state).',
    '// Buses retain their scalar lanes; ordinary resolved wires retain X/Z and contention.',
    '// Approximation: zero-delay Verilog scheduling replaces bread READ/COMMIT iterations.',
    '// Omitted: oscillation detection, contention events, probes, layout and UI state.',
    '// Chip ports use inout aliases to preserve bread net stitching and drive strengths.',
    '// The top exposes every root net as an inout for stimulus and observation.',
    '`default_nettype none',
  ];
  const source = [...header, emitModule(top, plans, true), ...[...plans.values()].map(p => emitModule(p, plans)), '`default_nettype wire', ''].join('\n\n');
  return { source, topModule: top.name, nets, sources: top.sources.map(s => ({ ...s })), modules };
}

function emitModule(plan: ModulePlan, plans: Map<string, ModulePlan>, top = false): string {
  const { json, nets, ports, wires } = plan;
  const declarations: string[] = [];
  if (top) for (const net of json.nets) declarations.push(`inout wire ${nets.get(net.id)}`);
  for (const port of json.ports ?? []) declarations.push(`inout wire ${ports.get(port.name)}`);
  for (const source of plan.sources) declarations.push(`input wire ${source.port}`);
  const lines = [`// Circuit ${quote(json.name)}`, `module ${plan.name}(${declarations.length ? '\n  ' + declarations.join(',\n  ') + '\n' : ''});`];
  const add = (line: string): void => { lines.push(`  ${line}`); };
  add(`// bread:sources ${quote(plan.sources.map(s => s.port))}`);
  for (const net of json.nets) {
    if (!top) add(`wire ${nets.get(net.id)}; // net ${quote(net.id)}`);
  }
  for (const wire of plan.floating) add(`wire ${wire}; // Unconnected pin: floats unless driven internally.`);
  for (const port of json.ports ?? []) {
    add(`// Port ${quote(port.name)}: bread direction ${quote(port.dir)}; bidirectional net alias.`);
    add(`tran (${ports.get(port.name)}, ${nets.get(port.internalNet)});`);
  }
  for (const inst of json.components) {
    add('');
    add(`// ${quote(inst.id)} (${quote(inst.type)})`);
    if (!leaf(inst.type)) {
      const child = plans.get(inst.type)!;
      const connections = (child.json.ports ?? []).map(port => `.${child.ports.get(port.name)}(${wires.get(`${inst.id}.${port.name}`)})`);
      for (const source of child.sources) {
        const parentSource = plan.sources.find(s => s.component === `${inst.id}__${source.component}` && s.pin === source.pin)!;
        connections.push(`.${source.port}(${parentSource.port})`);
      }
      if (inst.params && Object.keys(inst.params).length) add('// Omitted: composite instance parameters, also ignored by the bread loader.');
      add(`${child.name} ${plan.instances.get(inst.id)} (${connections.join(', ')});`);
    } else {
      const bindings = Object.fromEntries(plan.pins.get(inst.id)!.map(p => [p.name, wires.get(`${inst.id}.${p.name}`)!]));
      const temps: Record<string, string> = {};
      const source = plan.sources.find(s => s.component === inst.id);
      const body = renderVerilogLeaf(inst, bindings, suffix => temps[suffix] = plan.names.take('v_', `${inst.id}_${suffix}`), source);
      add(`// bread:cell ${quote({ id: inst.id, type: inst.type, params: inst.params, bindings, temps, source })}`);
      for (const line of body) add(line);
      add('// bread:endcell');
    }
  }
  lines.push('endmodule');
  return lines.join('\n');
}

// Import verifies a cell's complete token stream against this same renderer.
// An annotation cannot conceal edited or additional Verilog logic.
export function renderVerilogLeaf(inst: ComponentInstanceJSON, bindings: Record<string, string>, allocate: (suffix: string) => string, source?: VerilogSource): string[] {
  const lines: string[] = [];
  const add = (line: string): void => { lines.push(line); };
  const params = inst.params ?? {};
  const pins = getPinsForType(inst.type, params)!;
  const wire = (pin: string): string => bindings[pin]!;
  // A pure logic input reads Z as X, unlike an inout memory data pin.
  const input = (pin: string): string => params.verilogData && pin === 'D' ? wire(pin) : `(${wire(pin)} ^ 1'b0)`;
  const assign = (pin: string, expr: string): void => add(`assign ${wire(pin)} = ${expr};`);
  const temp = allocate;
  const inputs = pins.filter(p => p.dir === 'in').map(p => input(p.name));
  const width = Number(params.width);
  const bus = (prefix: string, count: number, logic = true): string => `{${Array.from({ length: count }, (_, i) => (logic ? input : wire)(`${prefix}${count - i - 1}`)).join(', ')}}`;
  const known = (expr: string): string => `(^${expr} !== 1'bx)`;
  switch (inst.type) {
    case 'prim.VERILOG': {
      const expression = expressionVerilog(params as unknown as ExpressionParams, wire);
      const count = Number(params.width ?? 1);
      add(`assign {${Array.from({ length: count }, (_, i) => wire(`Y${count - i - 1}`)).join(', ')}} = ${expression};`);
      break;
    }
    case 'prim.AND': case 'prim.NAND': case 'prim.OR': case 'prim.NOR': case 'prim.XOR': case 'prim.XNOR': {
      const operator = inst.type.includes('AND') ? '&' : inst.type.includes('X') ? '^' : '|';
      const invert = ['prim.NAND', 'prim.NOR', 'prim.XNOR'].includes(inst.type);
      assign('Y', `${invert ? '~' : ''}(${inputs.join(` ${operator} `)})`);
      break;
    }
    case 'prim.NOT': assign('Y', `~${input('A')}`); break;
    case 'prim.BUF': assign('Y', input('A')); break;
    case 'prim.CONST_0': assign('Y', "1'b0"); break;
    case 'prim.CONST_1': assign('Y', "1'b1"); break;
    case 'prim.PULLUP': case 'prim.PULLDOWN':
      add('// Approximation: Verilog weak drive strength models bread H/L; synthesis support is target-specific.');
      add(`assign (weak1, weak0) ${wire('Y')} = 1'b${inst.type === 'prim.PULLUP' ? 1 : 0};`);
      break;
    case 'prim.TRISTATE': {
      const oe = input(params.oeActiveLow ? '/OE' : 'OE');
      if (params.verilogBufif) add(`bufif${params.oeActiveLow ? 0 : 1} (${wire('Y')}, ${input('A')}, ${oe});`);
      else assign('Y', `(${oe} === 1'b${params.oeActiveLow ? 0 : 1}) ? ${input('A')} : (${oe} === 1'b${params.oeActiveLow ? 1 : 0}) ? 1'bz : 1'bx`);
      break;
    }
    case 'prim.MUX2':
      for (let i = 0; i < width; i++) assign(`Y${i}`, `${input('S')} ? ${input(`B${i}`)} : ${input(`A${i}`)}`);
      break;
    case 'prim.DEMUX2':
      for (let i = 0; i < width; i++) {
        assign(`Y0_${i}`, `${input('S')} ? 1'b0 : ${input(`A${i}`)}`);
        assign(`Y1_${i}`, `${input('S')} ? ${input(`A${i}`)} : 1'b0`);
      }
      break;
    case 'prim.DECODER': {
      const bits = Number(params.bits);
      const addr = temp('address'); add(`wire [${bits - 1}:0] ${addr} = ${bus('A', bits)};`);
      for (let i = 0; i < 2 ** bits; i++) assign(`Y${i}`, `${known(addr)} ? ${params.activeLow ? '~' : ''}(${addr} == ${bits}'d${i}) : 1'bx`);
      break;
    }
    case 'prim.ADDER': {
      const carry = temp('carry'); add(`wire [${width}:0] ${carry};`);
      add(`assign ${carry}[0] = ${input('Cin')};`);
      for (let i = 0; i < width; i++) {
        const a = input(`A${i}`); const b = input(`B${i}`); const c = `${carry}[${i}]`;
        assign(`S${i}`, `${a} ^ ${b} ^ ${c}`);
        add(`assign ${carry}[${i + 1}] = (${a} & ${b}) | (${a} & ${c}) | (${b} & ${c});`);
      }
      assign('Cout', `${carry}[${width}]`);
      break;
    }
    case 'prim.DFF': {
      const q = temp('q'); add(`reg ${q}${params.initialQ === undefined ? '' : ` = 1'b${params.initialQ}`};`);
      add('// Approximation: Verilog posedge/asynchronous controls; uncertain edges and simultaneous changes may differ from bread.');
      if (params.initialQ !== undefined) add('// Approximation: power-on initialQ requires target support for register initialization.');
      const clr = params.clrActiveLow ? input('/CLR') : "1'b1";
      const pre = params.preActiveLow ? input('/PRE') : "1'b1";
      const sensitivity = [`posedge ${wire('CLK')}`, ...(params.clrActiveLow ? [`negedge ${wire('/CLR')}`] : []), ...(params.preActiveLow ? [`negedge ${wire('/PRE')}`] : [])];
      add(`always @(${sensitivity.join(' or ')}) begin`);
      add(`  if (${clr} === 1'b0) ${q} <= 1'b0;`);
      add(`  else if (${pre} === 1'b0) ${q} <= (${clr} === 1'b1) ? 1'b1 : 1'bx;`);
      add(`  else ${q} <= (${clr} === 1'b1 && ${pre} === 1'b1) ? ${params.enable ? `${input('EN')} ? ${input('D')} : ${q}` : input('D')} : 1'bx;`);
      add('end'); assign('Q', q); assign('Qn', `~${q}`);
      break;
    }
    case 'prim.LATCH': {
      const q = temp('q'); add(`reg ${q};`);
      add(`always @* if (${input('EN')} !== 1'b0) ${q} <= ${input('EN')} ? ${input('D')} : ${q};`);
      assign('Q', q); assign('Qn', `~${q}`);
      break;
    }
    case 'prim.COUNTER': {
      const q = temp('q');
      add('// Approximation: Verilog edge scheduling and target-dependent zero power-on initialization.');
      add(`reg [${width - 1}:0] ${q} = ${width}'d0;`);
      const countBits = (down: boolean): string => {
        const carry = temp(down ? 'borrow' : 'carry'); const counted = temp(down ? 'down' : 'up');
        add(`wire [${width}:0] ${carry}; wire [${width - 1}:0] ${counted};`);
        add(`assign ${carry}[0] = 1'b1;`);
        for (let i = 0; i < width; i++) {
          add(`assign ${counted}[${i}] = ${q}[${i}] ^ ${carry}[${i}];`);
          add(`assign ${carry}[${i + 1}] = ${carry}[${i}] & ${down ? '~' : ''}${q}[${i}];`);
        }
        return counted;
      };
      const up = countBits(false); const counted = params.preset ? `(${input('DIR')} ? ${countBits(true)} : ${up})` : up;
      for (let i = 0; i < width; i++) assign(`Q${i}`, `${q}[${i}]`);
      const count = `${input('EN')} ? ${counted} : ${q}`;
      const load = params.preset ? `${input('LD')} ? ${bus('D', width)} : (${count})` : count;
      add(`always @(posedge ${wire('CLK')}) ${q} <= ${input('CLR')} ? ${width}'d0 : (${load});`);
      break;
    }
    case 'io.switch': case 'gen.clock': case 'gen.555': {
      add(source!.kind === 'switch'
        ? '// UI switch exported as an external input; drive 0 for bread power-on state.'
        : `// Approximation: ${source!.kind === '555' ? '555 analog timing (TRIG/THRESH/DISCH/CTRL/RESET) omitted; ' : ''}external clock input replaces ${source!.freqHz} Hz tick/rate timing. Start low.`);
      assign(source!.pin, source!.port);
      break;
    }
    case 'io.led': case 'io.7seg': add('// Omitted: visual display state; connected logic nets remain available.'); break;
    case 'mem.ROM': case 'mem.74LS189': case 'mem.6116': case 'mem.28C16': {
      const rom = inst.type === 'mem.ROM'; const oc = inst.type === 'mem.74LS189';
      const dimensions = rom ? wordRomDimensions(params) : { addressBits: oc ? 4 : 11, dataBits: oc ? 4 : 8, size: oc ? 16 : 2048 };
      const { addressBits, dataBits, size } = dimensions;
      const memory = temp('memory'); const addr = temp('address'); const data = temp('data'); const index = temp('init');
      const contents = rom ? decodeWordContents(String(params.contents ?? ''), size, dataBits)
        : oc ? new Uint8Array(size) : decodeHexContents(String(params.contents ?? ''), size);
      add('// Approximation: initialized memory image requires synthesis target support; asynchronous writes may infer latches rather than RAM.');
      if (inst.type === 'mem.28C16') add('// Approximation: EEPROM exported as RAM; programming delays, endurance and protection are omitted.');
      add(`reg [${dataBits - 1}:0] ${memory} [0:${size - 1}];`);
      add(`integer ${index}; initial begin`);
      add(`  for (${index} = 0; ${index} < ${size}; ${index} = ${index} + 1) ${memory}[${index}] = ${dataBits}'d0;`);
      for (const [i, word] of contents.entries()) if (word) add(`  ${memory}[${i}] = ${dataBits}'h${word.toString(16)};`);
      add('end');
      add(`wire [${addressBits - 1}:0] ${addr} = ${bus('A', addressBits)};`);
      if (rom) {
        for (let i = 0; i < dataBits; i++) assign(`D${i}`, `(${input('SEL')} === 1'b0) ? 1'bz : (${input('SEL')} === 1'b1 && ${known(addr)}) ? ${memory}[${addr}][${i}] : 1'bx`);
        break;
      }
      const dataPrefix = oc ? 'D' : inst.type === 'mem.6116' ? 'DQ' : 'IO';
      const cs = input(oc ? '/CS' : '/CE'); const we = input('/WE');
      add(`wire [${dataBits - 1}:0] ${data} = ${bus(dataPrefix, dataBits, oc)};`);
      add(`always @(${addr} or ${data} or ${wire(oc ? '/CS' : '/CE')} or ${wire('/WE')})`);
      add(`  if (${cs} === 1'b0 && ${we} === 1'b0 && ${known(addr)} && ${known(data)}) ${memory}[${addr}] <= ${data};`);
      for (let i = 0; i < dataBits; i++) {
        const stored = `${memory}[${addr}][${i}]`;
        const read = oc ? `${stored} ? 1'b0 : 1'bz` : stored;
        const output = oc ? `/Y${i}` : `${dataPrefix}${i}`;
        const enabled = oc ? `(${known(addr)} ? (${read}) : 1'bx)`
          : `(${input('/OE')} === 1'b1) ? 1'bz : (${input('/OE')} === 1'b0 && ${known(addr)}) ? ${read} : 1'bx`;
        assign(output, `(${cs} === 1'b1) ? 1'bz : (${cs} !== 1'b0) ? 1'bx : (${we} === 1'b0) ? 1'bz : (${we} !== 1'b1) ? 1'bx : (${enabled})`);
      }
      break;
    }
    default:
      add('// Unsupported: no Verilog mapping for this registered leaf. Each output drives X.');
      for (const pin of pins) if (pin.dir !== 'in') assign(pin.name, "1'bx");
  }
  return lines;
}
