// Generic, read-only word ROM. Every address/data lane is still a scalar
// four-state net. SEL is active high; a disabled ROM releases all outputs.
import type { DriverValue, PinSpec, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

export interface WordRomParams {
  addressBits?: number;
  dataBits?: number;
  contents?: string;
  bitLabels?: string[];
}

export const wordRomDimensions = (params: WordRomParams): { addressBits: number; dataBits: number; size: number } => {
  const addressBits = params.addressBits ?? 2;
  const dataBits = params.dataBits ?? 1;
  if (!Number.isInteger(addressBits) || addressBits < 1 || addressBits > 16) {
    throw new Error('ROM addressBits must be an integer from 1 to 16');
  }
  if (!Number.isInteger(dataBits) || dataBits < 1 || dataBits > 32) {
    throw new Error('ROM dataBits must be an integer from 1 to 32');
  }
  if (params.contents !== undefined && typeof params.contents !== 'string') {
    throw new Error('ROM contents must be hex words as text');
  }
  if (params.bitLabels !== undefined && (!Array.isArray(params.bitLabels)
    || params.bitLabels.length > dataBits || params.bitLabels.some((label) => typeof label !== 'string'))) {
    throw new Error('ROM bitLabels must contain at most one text label per data bit');
  }
  return { addressBits, dataBits, size: 2 ** addressBits };
};

// Digital/Logisim v2.0 raw images store WORDS, not byte pairs. Accept a
// header, hex tokens, decimalCount*hexWord repeats, commas and line comments.
// Validate the entire image: excess/oversized words cannot silently truncate.
export const decodeWordContents = (text: string, size: number, dataBits: number): Uint32Array => {
  if (!Number.isInteger(size) || size < 1 || size > 65536) throw new Error('ROM size must be from 1 to 65536');
  if (!Number.isInteger(dataBits) || dataBits < 1 || dataBits > 32) throw new Error('ROM dataBits must be from 1 to 32');
  const lines = text.split(/\r?\n/).map((line) => line.replace(/(\/\/|#).*$/, '').trim()).filter(Boolean);
  if (lines[0] === 'v2.0 raw') lines.shift();
  const tokens = lines.join(' ').replace(/\s*\*\s*/g, '*').split(/[\s,]+/).filter(Boolean);
  const words = new Uint32Array(size);
  const max = 2 ** dataBits - 1;
  let address = 0;
  for (const token of tokens) {
    const match = /^(?:(\d+)\*)?(?:0x)?([0-9a-f]+)$/i.exec(token);
    if (!match) throw new Error(`Bad ROM word at address ${address}: ${token}`);
    const count = match[1] === undefined ? 1 : Number(match[1]);
    const word = Number.parseInt(match[2]!, 16);
    if (!Number.isSafeInteger(count) || count < 1 || count > size - address) {
      throw new Error(`ROM image exceeds ${size} words at address ${address}`);
    }
    if (!Number.isSafeInteger(word) || word > max) {
      throw new Error(`ROM word at address ${address} exceeds ${dataBits} data bits: ${token}`);
    }
    words.fill(word, address, address + count);
    address += count;
  }
  return words;
};

interface WordRomState { words: Uint32Array }
const rom: PrimitiveDef<WordRomState, WordRomParams> = {
  pins(params): PinSpec[] {
    const { addressBits, dataBits } = wordRomDimensions(params);
    return [
      ...Array.from({ length: addressBits }, (_, i): PinSpec => ({ name: `A${i}`, dir: 'in' })),
      { name: 'SEL', dir: 'in' },
      ...Array.from({ length: dataBits }, (_, i): PinSpec => ({ name: `D${i}`, dir: 'out' })),
    ];
  },
  init(params) {
    const { size, dataBits } = wordRomDimensions(params);
    return { words: decodeWordContents(params.contents ?? '', size, dataBits) };
  },
  evaluate(inputs, outputs, state, params) {
    const addressBits = params.addressBits ?? 2;
    const dataBits = params.dataBits ?? 1;
    const select = inputs[addressBits];
    if (select !== 1) {
      outputs.fill(select === 0 ? 'Z' : 'X');
      return undefined;
    }
    let address = 0;
    for (let bit = 0; bit < addressBits; bit++) {
      const value = inputs[bit];
      if (value !== 0 && value !== 1) { outputs.fill('X'); return undefined; }
      address += value * 2 ** bit;
    }
    const word = state.words[address]!;
    for (let bit = 0; bit < dataBits; bit++) outputs[bit] = ((word >>> bit) & 1) as DriverValue;
    return undefined;
  },
};

registerBehavioral('mem.ROM', rom);
