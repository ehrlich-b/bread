import { readdirSync, readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { CircuitJSON } from '../engine/ir';
import { decodeCircuit, encodeCircuit, MAX_SHARE_JSON_BYTES } from './permalink';

const examples = new URL('../../examples/', import.meta.url);
const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'unicode: µ bread 🍞', components: [], nets: [] };
const packed = async (text: string): Promise<string> => {
  const bytes = deflateRawSync(text);
  const checksum = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('base64url');
  return `#c1=${bytes.toString('base64url')}.${checksum}`;
};

describe('circuit permalinks', () => {
  it.each(readdirSync(examples).filter(name => name.endsWith('.json')))('round-trips every field of %s', async (name) => {
    const example = JSON.parse(readFileSync(new URL(name, examples), 'utf8')) as CircuitJSON;
    const hash = await encodeCircuit(example);
    expect(hash).toMatch(/^#c1=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(await decodeCircuit(hash)).toEqual(example);
  });

  it('preserves Unicode, probes and project chip libraries', async () => {
    const project: CircuitJSON = {
      ...circuit,
      components: [{ id: 'buf', type: 'user.Buffer', label: '🍞', position: [50, 60], rotation: 90 }],
      nets: [{ id: 'out', endpoints: ['buf.Y'] }],
      probes: [{ id: 'p', label: 'µ probe', nets: ['out'] }],
      definitions: [{ version: 1, kind: 'composite', name: 'user.Buffer',
        components: [{ id: 'b', type: 'prim.BUF' }],
        nets: [{ id: 'in', endpoints: ['b.A'] }, { id: 'out', endpoints: ['b.Y'] }],
        ports: [{ name: 'A', dir: 'in', internalNet: 'in' }, { name: 'Y', dir: 'out', internalNet: 'out' }],
      }],
    };
    expect(await decodeCircuit(await encodeCircuit(project))).toEqual(project);
  });

  it.each(['#c', '#c1', '#c1=', '#c1=%%%.bad', '#c1=AAAA', '#c1=A.bad', '#c1=AA=.bad', '#c1=AA.bad.extra'])('rejects malformed input %s', async hash => {
    await expect(decodeCircuit(hash)).rejects.toThrow('corrupt or truncated');
  });

  it('rejects truncation and changes to the payload or checksum', async () => {
    const hash = await encodeCircuit(circuit);
    const [payload, checksum] = hash.slice(4).split('.');
    for (const changed of [hash.slice(0, -1), `#c1=${payload!.slice(0, -2)}.${checksum}`, `#c1=${payload!.startsWith('A') ? 'B' : 'A'}${payload!.slice(1)}.${checksum}`]) {
      await expect(decodeCircuit(changed)).rejects.toThrow('corrupt or truncated');
    }
  });

  it.each(['#c0=anything', '#c2=anything', '#c999=anything'])('rejects unsupported versions %s', async hash => {
    await expect(decodeCircuit(hash)).rejects.toThrow('Unsupported shared circuit link version');
  });

  it.each(['{broken', 'null', '[]', '"source code"'])('rejects non-circuit JSON %s', async text => {
    await expect(decodeCircuit(await packed(text))).rejects.toThrow('corrupt or truncated');
  });

  it('rejects malformed deflate even when its checksum matches', async () => {
    const bytes = new Uint8Array([255, 255, 255]);
    const checksum = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('base64url');
    await expect(decodeCircuit(`#c1=${Buffer.from(bytes).toString('base64url')}.${checksum}`)).rejects.toThrow('corrupt or truncated');
  });

  it('rejects oversized hashes and bounds decompression', async () => {
    await expect(decodeCircuit(`#c1=${'A'.repeat(6 * 1024 * 1024)}`)).rejects.toThrow('data limit');
    const hash = await packed(JSON.stringify({ ...circuit, name: 'a'.repeat(MAX_SHARE_JSON_BYTES) }));
    expect(hash.length).toBeLessThan(16_000);
    await expect(decodeCircuit(hash)).rejects.toThrow('data limit');
    await expect(encodeCircuit({ ...circuit, name: 'a'.repeat(MAX_SHARE_JSON_BYTES) })).rejects.toThrow('data limit');
  });

  it('explains missing browser compression support', async () => {
    vi.stubGlobal('CompressionStream', class { constructor() { throw new TypeError('unsupported'); } });
    vi.stubGlobal('DecompressionStream', class { constructor() { throw new TypeError('unsupported'); } });
    try {
      await expect(encodeCircuit(circuit)).rejects.toThrow('deflate-raw compression support');
      await expect(decodeCircuit('#c1=AA.bad')).rejects.toThrow('deflate-raw compression support');
    } finally { vi.unstubAllGlobals(); }
  });
});
