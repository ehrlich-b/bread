// Icarus is an optional development oracle, never a browser/runtime dependency.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CircuitJSON, NetState } from '../src/engine/ir';
import { parseTestbench, runTestbench, type TestbenchResult } from '../src/engine/testbench';
import { exportVerilog } from '../src/engine/verilog';
import { importVerilog } from '../src/engine/verilog_import';

export const ICARUS_SKIP = 'SKIP Verilog oracle: iverilog and vvp must be installed (optional development tools).';

export function hasIcarusVerilog(): boolean {
  for (const tool of ['iverilog', 'vvp']) {
    const result = spawnSync(tool, ['-V'], { encoding: 'utf8', timeout: 10_000 });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    if (result.error || result.status !== 0) throw new Error(`${tool} failed: ${result.error?.message ?? result.stderr}`);
  }
  return true;
}

interface OracleSample {
  step: number;
  outputs: Record<string, string>;
}

export interface GeneratedVerilogTestbench {
  source: string;
  testbench: string;
  samples: OracleSample[];
  bread: TestbenchResult;
}

// Reuse the validated vector/clock/wait runner. Only external stimuli are
// replayed; Verilog computes every internal signal independently. Clocks are
// generated from tick count and frequency, never from bread's output values.
export function generateVerilogTestbench(circuit: CircuitJSON, input: unknown): GeneratedVerilogTestbench {
  const bench = parseTestbench(input);
  const exported = exportVerilog(circuit);
  const outputNames = Object.keys(bench.outputs);
  const declarations: string[] = [];
  const connections = exported.sources.map((source, i) => `.${source.port}(source_${i})`);
  for (const [i] of exported.sources.entries()) declarations.push(`reg source_${i} = 1'b0;`);
  const netInputs = [...new Set(Object.values(bench.inputs).flatMap(signal => Array.isArray(signal) ? signal : []))];
  for (const [i, net] of netInputs.entries()) {
    if (!Object.hasOwn(exported.nets, net)) throw new Error(`Verilog input: unknown net ${net}`);
    declarations.push(`reg drive_${i} = 1'bz;`, `assign dut.${exported.nets[net]} = drive_${i};`);
  }
  const outputExprs = outputNames.map(name => {
    const nets = bench.outputs[name]!;
    for (const net of nets) if (!Object.hasOwn(exported.nets, net)) throw new Error(`Verilog output ${name}: unknown net ${net}`);
    return `{${[...nets].reverse().map(net => `dut.${exported.nets[net]}`).join(', ')}}`;
  });
  const samples: OracleSample[] = [];
  const steps: string[] = [];
  const previous = new Map<string, string>();
  const clockElapsed = exported.sources.map(() => 0);
  const clockLevels = exported.sources.map(() => 0);
  const drive = (name: string, value: string): void => {
    if (previous.get(name) === value) return;
    steps.push(`    ${name} = 1'b${value.toLowerCase()};`);
    previous.set(name, value);
  };
  const bread = runTestbench(circuit, bench, { observe: (sim, tick) => {
    for (const [i, source] of exported.sources.entries()) {
      if (source.kind === 'switch') {
        const component = sim.graph.components[sim.graph.componentById.get(source.component)!]!;
        drive(`source_${i}`, String((component.state as Record<string, NetState>)[source.pin]));
      } else {
        if (tick) {
          const half = Math.max(1, Math.round((bench.rateHz ?? 1000) / source.freqHz! / 2));
          if (++clockElapsed[i]! >= half) { clockLevels[i] = 1 - clockLevels[i]!; clockElapsed[i] = 0; }
        }
        drive(`source_${i}`, String(clockLevels[i]));
      }
    }
    for (const [i, net] of netInputs.entries()) drive(`drive_${i}`, String(sim.graph.nets[sim.graph.netById.get(net)!]!.forced));
    const outputs = Object.fromEntries(outputNames.map(name => [name, [...bench.outputs[name]!].reverse().map(net => String(sim.readNet(net))).join('')]));
    samples.push({ step: sim.step - 1, outputs });
    steps.push(`    #1; $display("BREAD ${samples.length - 1}${' %b'.repeat(outputNames.length)}", ${outputExprs.join(', ')});`);
  } });
  const failed = bread.results.find(result => !result.passed);
  if (failed) throw new Error(`Bread testbench failed at vector ${failed.vector} (${failed.label}): ${failed.reason ?? JSON.stringify({ expected: failed.expected, actual: failed.actual })}`);
  return {
    source: exported.source, samples, bread,
    testbench: [
      '`timescale 1ns/1ps', '`default_nettype none', 'module bread_tb;',
      ...declarations.map(line => `  ${line}`),
      `  ${exported.topModule} dut (${connections.join(', ')});`,
      '  initial begin', ...steps, '    $finish;', '  end', 'endmodule', '`default_nettype wire', '',
    ].join('\n'),
  };
}

export interface VerilogOracleResult {
  name: string;
  vectors: number;
  samples: number;
  comparisons: number;
}

export function compareVerilogOutput(generated: GeneratedVerilogTestbench, stdout: string): VerilogOracleResult {
  const lines = stdout.trim().split(/\r?\n/).filter(line => line.startsWith('BREAD '));
  if (lines.length !== generated.samples.length) throw new Error(`Verilog produced ${lines.length}/${generated.samples.length} samples`);
  let comparisons = 0;
  for (const [index, sample] of generated.samples.entries()) {
    const [, sampleIndex, ...values] = lines[index]!.split(/\s+/);
    const expected = Object.entries(sample.outputs);
    if (sampleIndex !== String(index) || values.length !== expected.length) throw new Error(`Malformed Verilog sample ${index}`);
    for (const [i, [name, bread]] of expected.entries()) {
      const verilog = values[i]!.toUpperCase();
      if (bread !== verilog) throw new Error(`Verilog mismatch at sample ${index}, bread step ${sample.step}, ${name}: bread=${bread}, Verilog=${verilog}`);
      comparisons += bread.length;
    }
  }
  return { name: generated.bread.name, vectors: generated.bread.total, samples: generated.samples.length, comparisons };
}

export function runVerilogOracle(circuit: CircuitJSON, input: unknown, options: { source?: string } = {}): VerilogOracleResult {
  const generated = generateVerilogTestbench(circuit, input);
  return runGeneratedOracle(generated, options.source);
}

// This oracle executes the hand-written source, never a re-export of the
// imported circuit. Stimulus and sample times come from the shared runner.
export function generateVerilogImportTestbench(source: string, input: unknown, topModule?: string): GeneratedVerilogTestbench {
  const imported = importVerilog(source, { topModule }); const bench = parseTestbench(input);
  if (Object.values(bench.inputs).some(signal => !Array.isArray(signal))) throw new Error('Import oracle inputs must bind wire lanes');
  const inputs = [...new Set(Object.values(bench.inputs).flatMap(signal => Array.isArray(signal) ? signal : []))];
  const pathFor = (net: string): string => {
    const path = Object.entries(imported.nets).find(([, id]) => id === net)?.[0];
    if (!path) throw new Error(`Import oracle: unknown Verilog net ${net}`); return `dut.${path}`;
  };
  const names = Object.keys(bench.outputs);
  const expressions = names.map(name => `{${[...bench.outputs[name]!].reverse().map(pathFor).join(', ')}}`);
  const steps: string[] = []; const samples: OracleSample[] = []; const previous = new Map<string, string>();
  const bread = runTestbench(imported.circuit, bench, { observe(sim) {
    inputs.forEach((net, i) => {
      const value = String(sim.graph.nets[sim.graph.netById.get(net)!]!.forced).toLowerCase();
      if (previous.get(net) !== value) { steps.push(`    drive_${i} = 1'b${value};`); previous.set(net, value); }
    });
    samples.push({ step: sim.step - 1, outputs: Object.fromEntries(names.map(name => [name, [...bench.outputs[name]!].reverse().map(net => String(sim.readNet(net))).join('')])) });
    steps.push(`    #1; $display("BREAD ${samples.length - 1}${' %b'.repeat(names.length)}", ${expressions.join(', ')});`);
  } });
  const failed = bread.results.find(result => !result.passed);
  if (failed) throw new Error(`Imported testbench failed at vector ${failed.vector}: ${failed.reason ?? JSON.stringify(failed)}`);
  return { source, samples, bread, testbench: [
    '`timescale 1ns/1ps', '`default_nettype none', 'module bread_tb;',
    `  ${imported.topModule} dut ();`,
    ...inputs.flatMap((net, i) => [`  reg drive_${i} = 1'bz;`, `  assign ${pathFor(net)} = drive_${i};`]),
    '  initial begin', ...steps, '    $finish;', '  end', 'endmodule', '`default_nettype wire', '',
  ].join('\n') };
}

export function runVerilogImportOracle(source: string, input: unknown, topModule?: string): VerilogOracleResult {
  return runGeneratedOracle(generateVerilogImportTestbench(source, input, topModule));
}

function runGeneratedOracle(generated: GeneratedVerilogTestbench, source?: string): VerilogOracleResult {
  const scratch = resolve('.scratch'); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(resolve(scratch, 'verilog-'));
  try {
    const design = resolve(directory, 'design.v'); const bench = resolve(directory, 'testbench.v'); const output = resolve(directory, 'simulation');
    writeFileSync(design, source ?? generated.source); writeFileSync(bench, generated.testbench);
    const run = (tool: string, args: string[]): string => {
      const result = spawnSync(tool, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, TMPDIR: directory } });
      if (result.error || result.status !== 0) throw new Error(`${tool} failed: ${result.error?.message ?? result.stderr}`);
      return result.stdout;
    };
    run('iverilog', ['-g2012', '-s', 'bread_tb', '-o', output, design, bench]);
    return compareVerilogOutput(generated, run('vvp', [output]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
