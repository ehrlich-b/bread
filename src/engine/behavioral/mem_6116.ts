// mem.6116 — 2K × 8 SRAM (HM6116, IDT6116, et al.). Plain volatile static RAM.
// 11 address pins (A0..A10), 8 bidirectional data pins (DQ0..DQ7), three
// active-low controls (/CE, /OE, /WE). Storage is a per-instance Uint8Array
// of 2048 bytes initialized to zero (matches power-on state of the soft model;
// real chips boot indeterminate but our tests want determinism).
//
// Truth table (X = any of /WE-determined modes):
//   /CE H, *,    *    → standby:    DQ = Z, no read/write
//   /CE L, /OE H, /WE H → output disable: DQ = Z
//   /CE L, /OE L, /WE H → read:      DQ = mem[addr]
//   /CE L, *,     /WE L → write:     mem[addr] := DQ inputs; DQ outputs = Z
//
// Real chips block their output buffer when /WE is asserted regardless of /OE,
// so writes never contend with the chip driving its own data pins.
//
// X-handling: any X on a control pin or address bit yields all-X on DQ outputs
// and skips any storage update. X on a data bit during write yields a skipped
// write for that whole byte (we don't model partial-bit storage).

import type { DriverValue, NetState, PinSpec, PrimitiveDef } from '../ir';
import { decodeHexContents } from './mem_28c16';
import { registerBehavioral } from './registry';

const ADDR_BITS = 11;
const DATA_BITS = 8;
const SIZE = 1 << ADDR_BITS; // 2048

interface Mem6116State {
  data: Uint8Array;
}

interface Mem6116Params {
  contents?: string;
}

const pinNames = (() => {
  const pins: PinSpec[] = [];
  for (let i = 0; i < ADDR_BITS; i++) pins.push({ name: `A${i}`, dir: 'in' });
  for (let i = 0; i < DATA_BITS; i++) pins.push({ name: `DQ${i}`, dir: 'inout' });
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

const mem6116: PrimitiveDef<Mem6116State, Mem6116Params> = {
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

    // Standby — chip not selected.
    if (ce === 1) return { outputs: driveAll('Z') };
    // Any X on control pins → undefined behavior; flag with X on outputs.
    if (ce === 'X' || we === 'X') return { outputs: driveAll('X') };

    // Decode address; any X bit poisons the address.
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
      // Write mode. Output buffer disabled regardless of /OE.
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

    // Read or output-disable.
    if (oe === 'X') return { outputs: driveAll('X') };
    if (oe === 1) return { outputs: driveAll('Z') };
    if (addrX) return { outputs: driveAll('X') };

    const byte = state.data[addr]!;
    const out = new Array<DriverValue>(DATA_BITS);
    for (let i = 0; i < DATA_BITS; i++) out[i] = ((byte >> i) & 1) as NetState;
    return { outputs: out };
  },
};

registerBehavioral('mem.6116', mem6116);
