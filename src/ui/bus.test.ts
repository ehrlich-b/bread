import { afterEach, expect, it, vi } from 'vitest';
import type { CircuitJSON } from '../engine/ir';
import type { TestbenchJSON } from '../engine/testbench';
import type { WorkerReq } from '../worker/protocol';
import { createWorkerBus } from './bus';

class FakeWorker extends EventTarget {
  sent: WorkerReq[] = [];
  postMessage(message: WorkerReq): void { this.sent.push(message); }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); });

it.each(['error', 'messageerror'])('rejects all pending and later commands on worker %s', async type => {
  const worker = new FakeWorker();
  vi.stubGlobal('Worker', class { constructor() { return worker; } });
  const bus = createWorkerBus();
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'empty', components: [], nets: [] };
  const bench: TestbenchJSON = { version: 1, name: 'unused', inputs: {}, outputs: { Q: ['q'] }, vectors: [{ expect: { Q: 0 } }] };
  const errors: Error[] = [];
  const requests = [bus.testbench(circuit, bench), bus.load(circuit)].map(request => request.catch(error => { errors.push(error); }));
  worker.dispatchEvent(Object.assign(new Event(type), { message: 'Worker out of memory' }));
  await flush();
  expect(errors).toHaveLength(2);
  expect(errors.every(error => /worker.*failed/i.test(error.message))).toBe(true);
  expect(errors[0]!.message).toContain('Reload');
  let laterError: Error | undefined;
  const later = bus.run(2000).catch(error => { laterError = error; });
  await flush();
  expect(laterError).toBeInstanceOf(Error);
  expect(worker.sent.map(message => message.type)).toEqual(['testbench', 'load']);
  await Promise.all([...requests, later]);
});

it('rejects a synchronous postMessage failure and still accepts later requests', async () => {
  const worker = new FakeWorker();
  vi.stubGlobal('Worker', class { constructor() { return worker; } });
  const bus = createWorkerBus();
  vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => { throw new Error('Cannot clone request'); });
  await expect(bus.pause()).rejects.toThrow('Cannot clone request');
  const next = bus.run(2000);
  const message = worker.sent[0]!;
  worker.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'ack', id: message.id } }));
  await next;
});
