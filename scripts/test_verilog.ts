import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CircuitJSON } from '../src/engine/ir';
import { parseTestbench } from '../src/engine/testbench';
import { hasIcarusVerilog, ICARUS_SKIP, runVerilogOracle } from './verilog_oracle';

try {
  if (!hasIcarusVerilog()) process.stdout.write(`${ICARUS_SKIP}\n`);
  else {
    const paths = process.argv.slice(2);
    for (const path of paths.length ? paths : ['examples/testbenches/full_adder.json', 'examples/testbenches/register_bus_4bit.json', 'examples/testbenches/sap1_fibonacci.json']) {
      const bench = parseTestbench(JSON.parse(readFileSync(path, 'utf8')));
      if (!bench.circuit) throw new Error(`Testbench ${path} needs a circuit path`);
      const circuit = JSON.parse(readFileSync(resolve(dirname(path), bench.circuit), 'utf8')) as CircuitJSON;
      const result = runVerilogOracle(circuit, bench);
      process.stdout.write(`PASS ${result.name}: ${result.vectors} vectors, ${result.samples} samples, ${result.comparisons} four-state bit comparisons\n`);
    }
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
