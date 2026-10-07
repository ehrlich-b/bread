import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import reference from './__fixtures__/93655c0-traces.json';
import { ADDER_CYCLES, captureTrace, EATER_CYCLES } from './__fixtures__/trace-capture';

describe('pre-optimization net traces (93655c0)', () => {
  it.each(['eater', 'adder'] as const)('%s matches every reference net byte at every half-cycle', (example) => {
    const expected = reference.examples[example];
    expect(expected.cycles).toBe(example === 'eater' ? EATER_CYCLES : ADDER_CYCLES);
    const actual = captureTrace(example);
    expect(actual.netIds).toEqual(expected.netIds);
    expect(actual.frames).toBe(expected.frames);
    const bytes = inflateSync(Buffer.from(expected.deflateBase64, 'base64'));
    expect(bytes.length).toBe(expected.frames * expected.netIds.length);
    // Buffer.compare checks the complete uncompressed trace, not a digest
    // or an output-only subset. Keep the mismatch diagnostic bounded.
    const firstMismatch = actual.bytes.findIndex((byte, index) => byte !== bytes[index]);
    expect(firstMismatch, `first differing frame/net: ${Math.floor(firstMismatch / actual.netIds.length)}/${actual.netIds[firstMismatch % actual.netIds.length] ?? ''}`).toBe(-1);
    expect(actual.bytes.length).toBe(bytes.length);
    expect(Buffer.compare(actual.bytes, bytes)).toBe(0);
    expect(actual.events).toEqual(JSON.parse(inflateSync(Buffer.from(expected.eventsDeflateBase64, 'base64')).toString('utf8')));
  });
});
