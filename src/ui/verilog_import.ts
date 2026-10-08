import type { CircuitJSON } from '../engine/ir';
import { VERILOG_SOURCE_LIMIT, VERILOG_SOURCE_LIMIT_ERROR } from '../engine/verilog_limits';
import type { VerilogImportResponse } from '../worker/verilog_import';

// One disposable worker per import lets cancellation interrupt even synchronous
// parsing/elaboration without blocking the simulator or the document queue.
export function importVerilogFile(file: File, signal: AbortSignal, progress: (phase: string) => void): Promise<CircuitJSON> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Import cancelled', 'AbortError')); return; }
    if (file.size > VERILOG_SOURCE_LIMIT) { reject(new Error(VERILOG_SOURCE_LIMIT_ERROR)); return; }
    const worker = new Worker(new URL('../worker/verilog_import.ts', import.meta.url), { type: 'module' });
    let finished = false;
    const finish = (circuit?: CircuitJSON, error?: Error): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(circuit!);
    };
    const abort = (): void => finish(undefined, new DOMException('Import cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    worker.addEventListener('message', (event: MessageEvent<VerilogImportResponse>) => {
      if (finished) return;
      const message = event.data;
      if (message.type === 'progress') progress(message.phase);
      else if (message.type === 'error') finish(undefined, new Error(message.message));
      else finish(message.circuit);
    });
    worker.addEventListener('error', (event: ErrorEvent) => finish(undefined, new Error(`Verilog import worker failed: ${event.message}`)));
    worker.addEventListener('messageerror', () => finish(undefined, new Error('Could not receive the Verilog import result')));
    try { worker.postMessage(file); }
    catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
  });
}
