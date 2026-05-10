import { describe, expect, it } from 'vitest';
import type { CircuitJSON, DriverValue, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import { decodeHexContents } from './mem_28c16';
import './mem_28c16';

const ADDR_BITS = 11;
const DATA_BITS = 8;

const eepromCircuit = (params?: { contents?: string }): CircuitJSON => {
  const components = [{ id: 'rom', type: 'mem.28C16', ...(params ? { params } : {}) }];
  const nets = [];
  for (let i = 0; i < ADDR_BITS; i++) {
    nets.push({ id: `a${i}`, endpoints: [`rom.A${i}`] });
  }
  for (let i = 0; i < DATA_BITS; i++) {
    nets.push({ id: `io${i}`, endpoints: [`rom.IO${i}`] });
  }
  nets.push({ id: 'ce', endpoints: ['rom./CE'] });
  nets.push({ id: 'oe', endpoints: ['rom./OE'] });
  nets.push({ id: 'we', endpoints: ['rom./WE'] });
  return { version: 1, kind: 'circuit', name: 'eeprom_test', components, nets };
};

const driveAddr = (sim: Simulator, addr: number) => {
  for (let i = 0; i < ADDR_BITS; i++) {
    sim.setInput(`a${i}`, ((addr >> i) & 1) as DriverValue);
  }
};

const driveData = (sim: Simulator, byte: number) => {
  for (let i = 0; i < DATA_BITS; i++) {
    sim.setInput(`io${i}`, ((byte >> i) & 1) as DriverValue);
  }
};

const releaseData = (sim: Simulator) => {
  for (let i = 0; i < DATA_BITS; i++) sim.setInput(`io${i}`, 'Z');
};

const readData = (sim: Simulator): NetState[] => {
  const out: NetState[] = [];
  for (let i = 0; i < DATA_BITS; i++) out.push(sim.readNet(`io${i}`));
  return out;
};

const dataAsByte = (bits: NetState[]): number => {
  let b = 0;
  for (let i = 0; i < DATA_BITS; i++) if (bits[i] === 1) b |= 1 << i;
  return b;
};

const setMode = (sim: Simulator, ce: NetState, oe: NetState, we: NetState) => {
  sim.setInput('ce', ce);
  sim.setInput('oe', oe);
  sim.setInput('we', we);
};

const romState = (sim: Simulator) => {
  const idx = sim.graph.componentById.get('rom')!;
  return sim.graph.components[idx]!.state as { data: Uint8Array };
};

describe('decodeHexContents', () => {
  it('decodes a plain hex string', () => {
    const out = decodeHexContents('DEADBEEF', 8);
    expect(Array.from(out)).toEqual([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0]);
  });

  it('strips whitespace and line comments', () => {
    const out = decodeHexContents(
      `// header
       DE AD  // first row
       BE EF
       # trailing
      `,
      8,
    );
    expect(Array.from(out)).toEqual([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0]);
  });

  it('zero-pads short input', () => {
    const out = decodeHexContents('FF', 4);
    expect(Array.from(out)).toEqual([0xff, 0, 0, 0]);
  });

  it('truncates long input', () => {
    const out = decodeHexContents('11223344', 2);
    expect(Array.from(out)).toEqual([0x11, 0x22]);
  });

  it('throws on odd nibble count', () => {
    expect(() => decodeHexContents('ABC', 4)).toThrow(/odd nibble/);
  });

  it('throws on non-hex characters', () => {
    expect(() => decodeHexContents('ZZ', 4)).toThrow(/bad hex/);
  });
});

describe('mem.28C16', () => {
  it('boots zeroed when no contents are supplied', () => {
    const sim = new Simulator(loadCircuit(eepromCircuit()));
    setMode(sim, 0, 0, 1); // read
    driveAddr(sim, 0);
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0);
    expect(romState(sim).data.length).toBe(2048);
  });

  it('boots from params.contents (paste-hex round-trip)', () => {
    const contents = 'DE AD BE EF // first row\n00 11 22 33';
    const sim = new Simulator(loadCircuit(eepromCircuit({ contents })));
    setMode(sim, 0, 0, 1);
    for (const [addr, expected] of [
      [0, 0xde],
      [1, 0xad],
      [2, 0xbe],
      [3, 0xef],
      [4, 0x00],
      [5, 0x11],
      [6, 0x22],
      [7, 0x33],
      [8, 0x00], // zero-padded tail
    ] as const) {
      driveAddr(sim, addr);
      sim.settle();
      expect(dataAsByte(readData(sim))).toBe(expected);
    }
  });

  it('write enabled (/WE low) stores bytes; later read returns them', () => {
    const sim = new Simulator(loadCircuit(eepromCircuit()));
    driveAddr(sim, 0x123);
    driveData(sim, 0xa5);
    setMode(sim, 0, 1, 0); // /CE=L, /OE=H, /WE=L → write
    sim.settle();
    expect(romState(sim).data[0x123]).toBe(0xa5);

    setMode(sim, 0, 1, 1);
    releaseData(sim);
    setMode(sim, 0, 0, 1); // read
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0xa5);
  });

  it('drives Z on IO when /CE high (standby)', () => {
    // Pre-read drives IOs to known 1s; the standby transition then releases
    // them to Z (the engine only re-resolves nets when a driver actually
    // changes — Z→Z from the initial outputBuf would otherwise stay at X).
    const sim = new Simulator(loadCircuit(eepromCircuit({ contents: 'FF' })));
    releaseData(sim);
    driveAddr(sim, 0);
    setMode(sim, 0, 0, 1); // read 0xFF
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0xff);

    setMode(sim, 1, 0, 1); // standby
    sim.settle();
    expect(readData(sim)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
  });

  it('drives Z on IO when /OE high in non-write mode', () => {
    const sim = new Simulator(loadCircuit(eepromCircuit({ contents: 'FF' })));
    releaseData(sim);
    driveAddr(sim, 0);
    setMode(sim, 0, 0, 1); // read first to pull IOs to 1s
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0xff);

    setMode(sim, 0, 1, 1); // /CE=L, /OE=H, /WE=H → outputs disabled
    sim.settle();
    expect(readData(sim)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
  });

  it('skips the write when any data bit is X/Z', () => {
    const sim = new Simulator(loadCircuit(eepromCircuit()));
    driveAddr(sim, 0x010);
    driveData(sim, 0xff);
    sim.setInput('io3', 'Z');
    setMode(sim, 0, 1, 0);
    sim.settle();
    expect(romState(sim).data[0x010]).toBe(0);
  });

  it('drives X on IO during read when an address bit is X', () => {
    const sim = new Simulator(loadCircuit(eepromCircuit({ contents: 'AA' })));
    releaseData(sim);
    setMode(sim, 0, 0, 1);
    driveAddr(sim, 0);
    sim.setInput('a4', 'X');
    sim.settle();
    expect(readData(sim)).toEqual(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X']);
  });

  it('drives X on IO when /CE or /WE is X', () => {
    const sim = new Simulator(loadCircuit(eepromCircuit()));
    driveAddr(sim, 0);
    releaseData(sim);
    setMode(sim, 'X', 0, 1);
    sim.settle();
    expect(readData(sim)).toEqual(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X']);

    setMode(sim, 0, 0, 'X');
    sim.settle();
    expect(readData(sim)).toEqual(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X']);
  });

  it('rejects bad hex at load time (init throws via loadCircuit)', () => {
    expect(() => loadCircuit(eepromCircuit({ contents: 'ZZ' }))).toThrow(/bad hex/);
  });
});
