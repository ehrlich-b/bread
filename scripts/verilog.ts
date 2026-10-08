import { readFileSync, writeFileSync } from 'node:fs';
import type { CircuitJSON } from '../src/engine/ir';
import { exportVerilog } from '../src/engine/verilog';

try {
  const path = process.argv[2];
  if (!path || process.argv.length > 4) throw new Error('Usage: verilog.ts <circuit.json> [output.v]');
  const circuit = JSON.parse(readFileSync(path, 'utf8')) as CircuitJSON;
  const { source } = exportVerilog(circuit);
  if (process.argv[3]) writeFileSync(process.argv[3], source);
  else process.stdout.write(source);
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
