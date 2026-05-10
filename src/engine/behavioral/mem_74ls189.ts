// mem.74LS189 — 16 × 4 SRAM with open-collector inverted outputs.
// 4 address pins (A0..A3), 4 data inputs (D0..D3), 4 inverted outputs
// (/Y0../Y3), active-low /CS and /WE. Storage is a per-instance Uint8Array of
// 16 bytes (low 4 bits used) initialized to zero — real chips boot
// indeterminate but our model boots zeroed for deterministic tests.
//
// Truth table:
//   /CS H, *    → deselected: outputs Z (open-collector transistors off)
//   /CS L, /WE L → write:      mem[addr] := D inputs; outputs Z
//   /CS L, /WE H → read:       /Y_i drives 0 if mem[addr] bit i is 1, else Z
//
// Open-collector inverted model: stored bit 1 turns the output transistor on
// (pulls the wire to 0); stored bit 0 leaves it off (Z, recovered as 1 by an
// external pullup). The user wraps the chip in a 74LS04 + pullup network in
// the schematic to recover non-inverted data — Eater's RAM module does this
// explicitly and we don't hide it.
//
// X-handling: X on /CS or /WE → all outputs X; X/Z on any address bit poisons
// the address (skip write, all-X on read); X/Z on any data bit skips the
// whole-nibble write.

import type { DriverValue, PinSpec, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

const ADDR_BITS = 4;
const DATA_BITS = 4;
const SIZE = 1 << ADDR_BITS; // 16

interface Mem74LS189State {
  data: Uint8Array;
}

const pinNames = (() => {
  const pins: PinSpec[] = [];
  for (let i = 0; i < ADDR_BITS; i++) pins.push({ name: `A${i}`, dir: 'in' });
  for (let i = 0; i < DATA_BITS; i++) pins.push({ name: `D${i}`, dir: 'in' });
  for (let i = 0; i < DATA_BITS; i++) pins.push({ name: `/Y${i}`, dir: 'out', activeLow: true });
  pins.push({ name: '/CS', dir: 'in', activeLow: true });
  pins.push({ name: '/WE', dir: 'in', activeLow: true });
  return pins;
})();

const driveAll = (v: DriverValue): DriverValue[] => {
  const out = new Array<DriverValue>(DATA_BITS);
  for (let i = 0; i < DATA_BITS; i++) out[i] = v;
  return out;
};

const mem74LS189: PrimitiveDef<Mem74LS189State, Record<string, never>> = {
  pins: () => pinNames,
  init: () => ({ data: new Uint8Array(SIZE) }),
  evaluate(inputs, state) {
    const cs = inputs[ADDR_BITS + DATA_BITS]!;
    const we = inputs[ADDR_BITS + DATA_BITS + 1]!;

    if (cs === 1) return { outputs: driveAll('Z') };
    if (cs === 'X' || we === 'X') return { outputs: driveAll('X') };

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
        let nibble = 0;
        let dataX = false;
        for (let i = 0; i < DATA_BITS; i++) {
          const bit = inputs[ADDR_BITS + i]!;
          if (bit === 'X' || bit === 'Z') {
            dataX = true;
            break;
          }
          if (bit === 1) nibble |= 1 << i;
        }
        if (!dataX) state.data[addr] = nibble;
      }
      return { outputs: driveAll('Z') };
    }

    if (addrX) return { outputs: driveAll('X') };

    const nibble = state.data[addr]!;
    const out = new Array<DriverValue>(DATA_BITS);
    for (let i = 0; i < DATA_BITS; i++) {
      // Open-collector inverted: stored 1 → drive 0; stored 0 → Z.
      out[i] = ((nibble >> i) & 1) === 1 ? 0 : 'Z';
    }
    return { outputs: out };
  },
};

registerBehavioral('mem.74LS189', mem74LS189);
