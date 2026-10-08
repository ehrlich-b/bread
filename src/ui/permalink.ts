import type { CircuitJSON } from '../engine/ir';

export const MAX_SHARE_URL_LENGTH = 16_000;
export const MAX_SHARE_JSON_BYTES = 4 * 1024 * 1024;
const PREFIX = '#c1=';
const MAX_SHARE_HASH_LENGTH = 6 * 1024 * 1024;

const base64url = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unbase64url = (text: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error('Invalid base64url');
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (base64url(bytes) !== text) throw new Error('Invalid base64url padding');
  return bytes;
};

// Limit decompression before collecting the output, including highly
// compressed input. Hash contents are JSON data, never executable source.
const readBytes = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Circuit exceeds the 4 MiB sharing data limit. Use Download JSON instead.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
};

const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

export const encodeCircuit = async (circuit: CircuitJSON): Promise<string> => {
  const json = new TextEncoder().encode(JSON.stringify(circuit));
  if (json.length > MAX_SHARE_JSON_BYTES) throw new Error('Circuit exceeds the 4 MiB sharing data limit. Use Download JSON instead.');
  let compressor: CompressionStream;
  try { compressor = new CompressionStream('deflate-raw'); }
  catch { throw new Error('Sharing requires a browser with deflate-raw compression support.'); }
  const bytes = await readBytes(new Blob([json]).stream().pipeThrough(compressor), MAX_SHARE_JSON_BYTES);
  // Raw deflate has no checksum. Check the bytes for accidental
  // corruption before decompressing; this is not a trust/signature mechanism.
  return `${PREFIX}${base64url(bytes)}.${await digest(bytes)}`;
};

export const decodeCircuit = async (hash: string): Promise<CircuitJSON> => {
  const version = /^#c([0-9]+)=/.exec(hash);
  if (!version) throw new Error('Invalid shared circuit link: corrupt or truncated data.');
  if (version[1] !== '1') throw new Error('Unsupported shared circuit link version. This app supports #c1= links.');
  if (hash.length > MAX_SHARE_HASH_LENGTH) throw new Error('Shared circuit link exceeds the sharing data limit. Use Open JSON instead.');
  let decompressor: DecompressionStream;
  try { decompressor = new DecompressionStream('deflate-raw'); }
  catch { throw new Error('Opening shared circuits requires a browser with deflate-raw compression support.'); }
  try {
    const parts = hash.slice(PREFIX.length).split('.');
    if (parts.length !== 2) throw new Error('Missing checksum');
    const bytes = unbase64url(parts[0]!);
    const checksum = parts[1]!;
    if (checksum !== await digest(bytes)) throw new Error('Checksum mismatch');
    const json = await readBytes(new Blob([bytes]).stream().pipeThrough(decompressor), MAX_SHARE_JSON_BYTES);
    const circuit: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
    if (circuit === null || typeof circuit !== 'object' || Array.isArray(circuit)) throw new Error('Expected circuit object');
    return circuit as CircuitJSON;
  } catch (error) {
    if (error instanceof Error && error.message.includes('data limit')) throw error;
    throw new Error('Invalid shared circuit link: corrupt or truncated data.');
  }
};
