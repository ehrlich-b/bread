import { importVerilog } from '../engine/verilog_import';
import type { CircuitJSON } from '../engine/ir';
import { VERILOG_SOURCE_LIMIT, VERILOG_SOURCE_LIMIT_ERROR } from '../engine/verilog_limits';

export type VerilogImportResponse = { type: 'progress'; phase: string } | { type: 'done'; circuit: CircuitJSON } | { type: 'error'; message: string };

const post = (message: VerilogImportResponse): void => self.postMessage(message);
self.addEventListener('message', (event: MessageEvent<File>) => {
  void (async () => {
    try {
      const file = event.data;
      if (file.size > VERILOG_SOURCE_LIMIT) throw new Error(VERILOG_SOURCE_LIMIT_ERROR);
      post({ type: 'progress', phase: 'Reading file' });
      const source = await file.text();
      const { circuit } = importVerilog(source, { onProgress: phase => post({ type: 'progress', phase }) });
      post({ type: 'done', circuit });
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  })();
});
