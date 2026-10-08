import { readFileSync, writeFileSync } from 'node:fs';
import { importVerilog } from '../src/engine/verilog_import';

try {
  const args = process.argv.slice(2);
  const topIndex = args.indexOf('--top');
  const topModule = topIndex < 0 ? undefined : args[topIndex + 1];
  if (topIndex >= 0) args.splice(topIndex, 2);
  if (!args[0] || args.length > 2 || topIndex >= 0 && !topModule) throw new Error('Usage: verilog-import.ts <design.v> [circuit.json] [--top module]');
  const { circuit } = importVerilog(readFileSync(args[0], 'utf8'), { topModule });
  const json = JSON.stringify(circuit, null, 2) + '\n';
  if (args[1]) writeFileSync(args[1], json);
  else process.stdout.write(json);
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
