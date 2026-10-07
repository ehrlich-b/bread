import { describe, expect, it } from 'vitest';
import type { CircuitJSON, DriverValue, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './mem_6116';

const ADDR_BITS = 11;
const DATA_BITS = 8;

// One chip wired to "wires only" — every pin gets a named single-endpoint net
// the test can force via setInput. Single-endpoint nets are legal in the
// loader; we just need a stable name to address.
const ramCircuit = (): CircuitJSON => {
  const components = [{ id: 'ram', type: 'mem.6116' }];
  const nets = [];
  for (let i = 0; i < ADDR_BITS; i++) {
    nets.push({ id: `a${i}`, endpoints: [`ram.A${i}`] });
  }
  for (let i = 0; i < DATA_BITS; i++) {
    nets.push({ id: `dq${i}`, endpoints: [`ram.DQ${i}`] });
  }
  nets.push({ id: 'ce', endpoints: ['ram./CE'] });
  nets.push({ id: 'oe', endpoints: ['ram./OE'] });
  nets.push({ id: 'we', endpoints: ['ram./WE'] });
  return { version: 1, kind: 'circuit', name: 'ram_test', components, nets };
};

const driveAddr = (sim: Simulator, addr: number) => {
  for (let i = 0; i < ADDR_BITS; i++) {
    sim.setInput(`a${i}`, ((addr >> i) & 1) as DriverValue);
  }
};

const driveData = (sim: Simulator, byte: number) => {
  for (let i = 0; i < DATA_BITS; i++) {
    sim.setInput(`dq${i}`, ((byte >> i) & 1) as DriverValue);
  }
};

const releaseData = (sim: Simulator) => {
  for (let i = 0; i < DATA_BITS; i++) sim.setInput(`dq${i}`, 'Z');
};

const readData = (sim: Simulator): NetState[] => {
  const out: NetState[] = [];
  for (let i = 0; i < DATA_BITS; i++) out.push(sim.readNet(`dq${i}`));
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

const ramState = (sim: Simulator) => {
  const idx = sim.graph.componentById.get('ram')!;
  return sim.graph.components[idx]!.state as { data: Uint8Array };
};

describe('mem.6116', () => {
  it('initializes to all zeros and reads back zero', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    setMode(sim, 0, 0, 1); // read enabled
    driveAddr(sim, 0);
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0);

    driveAddr(sim, 0x7ff); // last cell
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0);
    expect(ramState(sim).data.length).toBe(2048);
  });

  it('write then read at the same address round-trips a byte', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    // Write 0xA5 to address 0x123.
    driveAddr(sim, 0x123);
    driveData(sim, 0xa5);
    setMode(sim, 0, 1, 0); // /CE=L, /OE=H, /WE=L → write
    sim.settle();
    expect(ramState(sim).data[0x123]).toBe(0xa5);

    // Switch to read; release external data drivers first to avoid contention.
    setMode(sim, 0, 1, 1); // briefly disable to settle
    releaseData(sim);
    setMode(sim, 0, 0, 1); // read mode
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0xa5);
  });

  it('writes to multiple addresses preserve independence', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    const cells: Array<[number, number]> = [
      [0x000, 0x11],
      [0x001, 0x22],
      [0x100, 0x33],
      [0x7ff, 0x44],
    ];
    for (const [addr, byte] of cells) {
      driveAddr(sim, addr);
      driveData(sim, byte);
      setMode(sim, 0, 1, 0);
      sim.settle();
    }
    for (const [addr, byte] of cells) {
      expect(ramState(sim).data[addr]).toBe(byte);
    }
    // Address space outside the set cells is still zero.
    expect(ramState(sim).data[0x200]).toBe(0);
  });

  it('drives Z on DQ when /CE is high (standby)', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    // Pre-load a value at addr 0.
    driveAddr(sim, 0);
    driveData(sim, 0xff);
    setMode(sim, 0, 1, 0);
    sim.settle();

    // Standby — outputs tristated.
    releaseData(sim);
    setMode(sim, 1, 0, 1);
    sim.settle();
    expect(readData(sim)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
  });

  it('drives Z on DQ when /OE is high in non-write mode (output disable)', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0);
    driveData(sim, 0x5a);
    setMode(sim, 0, 1, 0); // write
    sim.settle();

    releaseData(sim);
    setMode(sim, 0, 1, 1); // /CE=L, /OE=H, /WE=H → outputs disabled
    sim.settle();
    expect(readData(sim)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
  });

  it('does not store the cell on write when any data bit is X', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0x010);
    // 7 bits driven, one bit left as Z (resolves to X for write semantics).
    driveData(sim, 0xff);
    sim.setInput('dq3', 'Z');
    setMode(sim, 0, 1, 0);
    sim.settle();
    expect(ramState(sim).data[0x010]).toBe(0); // skipped
  });

  it('drives X on DQ during read when an address bit is X', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    // Write a known value to addr 0.
    driveAddr(sim, 0);
    driveData(sim, 0xaa);
    setMode(sim, 0, 1, 0);
    sim.settle();

    releaseData(sim);
    setMode(sim, 0, 0, 1);
    // Force one address bit to X (Z is treated as poisoning here too).
    sim.setInput('a4', 'X');
    sim.settle();
    expect(readData(sim)).toEqual(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X']);
  });

  it('drives X on DQ when /CE or /WE is X', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0);
    setMode(sim, 'X', 0, 1);
    sim.settle();
    expect(readData(sim)).toEqual(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X']);

    setMode(sim, 0, 0, 'X');
    sim.settle();
    expect(readData(sim)).toEqual(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X']);
  });
});

it('tracks DQ while the write pulse is low and holds the final byte after either control rises', () => {
  for (const endWith of ['we', 'ce'] as const) {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0x123);
    driveData(sim, 0x55);
    setMode(sim, 0, 1, 0);
    sim.settle();
    expect(ramState(sim).data[0x123]).toBe(0x55);
    driveData(sim, 0xa5);
    sim.settle();
    expect(ramState(sim).data[0x123]).toBe(0xa5);
    sim.setInput(endWith, 1);
    sim.settle();
    driveData(sim, 0x33);
    sim.settle();
    expect(ramState(sim).data[0x123]).toBe(0xa5);
    setMode(sim, 1, 1, 1);
    releaseData(sim);
    setMode(sim, 0, 0, 1);
    sim.settle();
    expect(dataAsByte(readData(sim))).toBe(0xa5);
  }
});
