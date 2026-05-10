// mem.28C16 — 2K × 8 EEPROM (Atmel AT28C16 / equivalents). Async read; the
// simulator treats it like SRAM with optional ROM-image initial contents:
// writes go straight through with no software-data-protection sequence, no
// page-write batching, and no real-world write-cycle delay.
//
// Pin spec matches the 24-pin DIP. 11 address pins (A0..A10), 8 bidirectional
// data pins (IO0..IO7), three active-low controls (/CE, /OE, /WE).
//
// Initial contents come from `params.contents`: a hex string (whitespace and
// line comments stripped, case-insensitive). Decoded into a 2048-byte
// Uint8Array, zero-padded if shorter, truncated if longer. Invalid characters
// throw at init time so the editor surfaces a bad image instead of silently
// running with garbage. The contents survive save/load via the regular
// component-params round-trip — write-time changes during simulation are
// in-memory only and do not back-propagate.
//
// Truth table:
//   /CE H, *,    *    → standby:        IO = Z
//   /CE L, /OE H, /WE H → output disable: IO = Z
//   /CE L, /OE L, /WE H → read:          IO = mem[addr]
//   /CE L, *,     /WE L → write:         mem[addr] := IO inputs; IO outputs = Z
//
// X-handling matches mem.6116: any X on a control yields all-X on outputs and
// skips storage updates; X/Z on any address bit poisons the address (skip
// write, all-X on read); X/Z on any data bit during write skips the byte.

import type { DriverValue, NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

const ADDR_BITS = 11;
const DATA_BITS = 8;
const SIZE = 1 << ADDR_BITS; // 2048

interface Mem28C16Params {
  contents?: string;
}

interface Mem28C16State {
  data: Uint8Array;
}

const pinNames = (() => {
  const pins: PinSpec[] = [];
  for (let i = 0; i < ADDR_BITS; i++) pins.push({ name: `A${i}`, dir: 'in' });
  for (let i = 0; i < DATA_BITS; i++) pins.push({ name: `IO${i}`, dir: 'inout' });
  pins.push({ name: '/CE', dir: 'in', activeLow: true });
  pins.push({ name: '/OE', dir: 'in', activeLow: true });
  pins.push({ name: '/WE', dir: 'in', activeLow: true });
  return pins;
})();

const driveAll = (v: DriverValue): DriverValue[] => {
  const out = new Array<DriverValue>(DATA_BITS);
  for (let i = 0; i < DATA_BITS; i++) out[i] = v;
  return out;
};

// Decode a hex string into a fixed-size byte array. Permissive: whitespace and
// line comments (anything from `//` or `#` to end-of-line) are stripped before
// pairing nibbles into bytes. Throws on odd nibble count or non-hex characters
// so the editor can surface a bad image at load time.
export const decodeHexContents = (hex: string, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  const cleaned = hex
    .split(/\r?\n/)
    .map((line) => line.replace(/(\/\/|#).*$/, ''))
    .join('')
    .replace(/\s+/g, '');
  if (cleaned.length === 0) return out;
  if (cleaned.length % 2 !== 0) {
    throw new Error(`hex contents has odd nibble count: ${cleaned.length}`);
  }
  const bytes = Math.min(cleaned.length / 2, size);
  for (let i = 0; i < bytes; i++) {
    const pair = cleaned.slice(i * 2, i * 2 + 2);
    const byte = parseInt(pair, 16);
    if (Number.isNaN(byte) || !/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error(`bad hex pair at byte ${i}: "${pair}"`);
    }
    out[i] = byte;
  }
  return out;
};

const mem28C16: PrimitiveDef<Mem28C16State, Mem28C16Params> = {
  pins: () => pinNames,
  init: (params) => {
    const data = params.contents
      ? decodeHexContents(params.contents, SIZE)
      : new Uint8Array(SIZE);
    return { data };
  },
  evaluate(inputs, state) {
    const ce = inputs[ADDR_BITS + DATA_BITS]!;
    const oe = inputs[ADDR_BITS + DATA_BITS + 1]!;
    const we = inputs[ADDR_BITS + DATA_BITS + 2]!;

    if (ce === 1) return { outputs: driveAll('Z') };
    if (ce === 'X' || we === 'X') return { outputs: driveAll('X') };

    let addr = 0;
    let addrX = false;
    for (let i = 0; i < ADDR_BITS; i++) {
      const bit = inputs[i]!;
      if (bit === 'X' || bit === 'Z') {
        addrX = true;
        break;
      }
      if (bit === 1) addr |= 1 << i;
    }

    if (we === 0) {
      if (!addrX) {
        let byte = 0;
        let dataX = false;
        for (let i = 0; i < DATA_BITS; i++) {
          const bit = inputs[ADDR_BITS + i]!;
          if (bit === 'X' || bit === 'Z') {
            dataX = true;
            break;
          }
          if (bit === 1) byte |= 1 << i;
        }
        if (!dataX) state.data[addr] = byte;
      }
      return { outputs: driveAll('Z') };
    }

    if (oe === 'X') return { outputs: driveAll('X') };
    if (oe === 1) return { outputs: driveAll('Z') };
    if (addrX) return { outputs: driveAll('X') };

    const byte = state.data[addr]!;
    const out = new Array<DriverValue>(DATA_BITS);
    for (let i = 0; i < DATA_BITS; i++) out[i] = ((byte >> i) & 1) as NetState;
    return { outputs: out };
  },
};

registerBehavioral('mem.28C16', mem28C16);
