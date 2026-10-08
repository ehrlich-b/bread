import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CircuitJSON } from '../src/engine/ir';
import { parseTestbench } from '../src/engine/testbench';
import { hasIcarusVerilog, ICARUS_SKIP, runVerilogOracle, runVerilogImportOracle } from './verilog_oracle';
import { roundTripCorpus, roundTripTestbench } from './verilog_roundtrip';

try {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    const results = roundTripCorpus();
    process.stdout.write(`PASS round trip: ${results.length} bundled examples/library types, ${results.reduce((n, r) => n + r.samples, 0)} samples, ${results.reduce((n, r) => n + r.comparisons, 0)} four-state net comparisons\n`);
  }
  const icarus = hasIcarusVerilog();
  if (!icarus) process.stdout.write(`${ICARUS_SKIP}\n`);
  for (const path of paths.length ? paths : ['examples/testbenches/full_adder.json', 'examples/testbenches/register_bus_4bit.json', 'examples/testbenches/sap1_fibonacci.json']) {
    const bench = parseTestbench(JSON.parse(readFileSync(path, 'utf8')));
    if (!bench.circuit) throw new Error(`Testbench ${path} needs a circuit path`);
    const circuit = JSON.parse(readFileSync(resolve(dirname(path), bench.circuit), 'utf8')) as CircuitJSON;
    const roundTrip = roundTripTestbench(circuit, bench);
    process.stdout.write(`PASS round-trip ${roundTrip.name}: ${roundTrip.samples} samples, ${roundTrip.comparisons} four-state net comparisons\n`);
    if (icarus) {
      const result = runVerilogOracle(circuit, bench);
      process.stdout.write(`PASS ${result.name}: ${result.vectors} vectors, ${result.samples} samples, ${result.comparisons} four-state bit comparisons\n`);
    }
  }
  if (icarus && !paths.length) for (const name of ['full_adder', 'counter4', 'register8', 'alu4']) {
    const source = readFileSync(`examples/verilog/${name}.v`, 'utf8');
    const bench = JSON.parse(readFileSync(`examples/verilog/${name}.testbench.json`, 'utf8'));
    const result = runVerilogImportOracle(source, bench);
    process.stdout.write(`PASS ${result.name}: ${result.vectors} vectors, ${result.samples} samples, ${result.comparisons} four-state bit comparisons\n`);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
