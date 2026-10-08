import { afterEach, expect, it, vi } from 'vitest';
import { importVerilogFile } from './verilog_import';
import { VERILOG_SOURCE_LIMIT } from '../engine/verilog_limits';
import type { VerilogImportResponse } from '../worker/verilog_import';

class ImportWorker extends EventTarget {
  static instances: ImportWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { super(); ImportWorker.instances.push(this); }
  send(message: VerilogImportResponse): void { this.dispatchEvent(new MessageEvent('message', { data: message })); }
}
afterEach(() => { ImportWorker.instances = []; vi.unstubAllGlobals(); });

it('imports in a disposable worker, reports phases and releases it on completion', async () => {
  vi.stubGlobal('Worker', ImportWorker);
  const file = new File(['module m(output y); assign y=0; endmodule'], 'm.v');
  const progress = vi.fn();
  const pending = importVerilogFile(file, new AbortController().signal, progress);
  const worker = ImportWorker.instances[0]!;
  expect(worker.postMessage).toHaveBeenCalledWith(file);
  worker.send({ type: 'progress', phase: 'Scanning source' });
  expect(progress).toHaveBeenCalledWith('Scanning source');
  const circuit = { version: 1, kind: 'circuit' as const, name: 'm', components: [], nets: [] };
  worker.send({ type: 'done', circuit });
  expect(await pending).toBe(circuit); expect(worker.terminate).toHaveBeenCalledOnce();
});

it('cancels parsing immediately and ignores a queued result', async () => {
  vi.stubGlobal('Worker', ImportWorker);
  const controller = new AbortController(); const progress = vi.fn();
  const pending = importVerilogFile(new File([''], 'm.v'), controller.signal, progress);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const worker = ImportWorker.instances[0]!;
  controller.abort();
  worker.send({ type: 'progress', phase: 'Mapping wires' });
  worker.send({ type: 'done', circuit: { version: 1, kind: 'circuit', name: 'late', components: [], nets: [] } });
  await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled();
});

it('rejects oversized files before reading or starting a worker', async () => {
  vi.stubGlobal('Worker', ImportWorker);
  const text = vi.fn();
  const file = { size: VERILOG_SOURCE_LIMIT + 1, text } as unknown as File;
  await expect(importVerilogFile(file, new AbortController().signal, vi.fn())).rejects.toThrow('source exceeds 16 MB limit');
  expect(text).not.toHaveBeenCalled(); expect(ImportWorker.instances).toHaveLength(0);
});

it('reports parser and worker failures and terminates the worker', async () => {
  vi.stubGlobal('Worker', ImportWorker);
  const pending = importVerilogFile(new File([''], 'm.v'), new AbortController().signal, vi.fn());
  const worker = ImportWorker.instances[0]!;
  worker.send({ type: 'error', message: 'Line 2, column 14: invalid numeric literal' });
  await expect(pending).rejects.toThrow('Line 2, column 14: invalid numeric literal');
  expect(worker.terminate).toHaveBeenCalledOnce();
  const broken = importVerilogFile(new File([''], 'm.v'), new AbortController().signal, vi.fn());
  ImportWorker.instances[1]!.dispatchEvent(new Event('messageerror'));
  await expect(broken).rejects.toThrow('Could not receive');
  expect(ImportWorker.instances[1]!.terminate).toHaveBeenCalledOnce();
});
