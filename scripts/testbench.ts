import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CircuitJSON } from '../src/engine/ir';
import { parseTestbench, runTestbench } from '../src/engine/testbench';

try {
  const path = process.argv[2];
  if (!path || process.argv.length > 4) throw new Error('Usage: testbench.ts <testbench.json> [circuit.json]');
  const bench = parseTestbench(JSON.parse(readFileSync(path, 'utf8')));
  const circuitPath = process.argv[3] ?? (bench.circuit ? resolve(dirname(path), bench.circuit) : undefined);
  if (!circuitPath) throw new Error('Set circuit in the testbench or supply a circuit.json argument');
  const circuit = JSON.parse(readFileSync(circuitPath, 'utf8')) as CircuitJSON;
  const result = runTestbench(circuit, bench);
  const failure = result.results.find(vector => !vector.passed);
  if (failure) {
    process.stderr.write(`FAIL ${result.name}: vector ${failure.vector} (${failure.label}), step ${failure.step}\n`);
    process.stderr.write(`  inputs: ${JSON.stringify(failure.drive)}\n`);
    if (failure.reason) process.stderr.write(`  ${failure.reason}\n`);
    for (const name of failure.mismatches) process.stderr.write(`  ${name}: expected ${failure.expected[name]}, actual ${failure.actual[name]}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS ${result.name}: ${result.passed}/${result.total} vectors\n`);
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
