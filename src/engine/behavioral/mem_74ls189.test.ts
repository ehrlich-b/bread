import { describe, expect, it } from 'vitest';
import type { CircuitJSON, DriverValue, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './mem_74ls189';

const ADDR_BITS = 4;
const DATA_BITS = 4;

// Each /Y output gets a pullup attached, matching Eater's actual schematic
// (and giving the open-collector net a defined logic-high default). With
// pullups, the resolved /Y_i is 1 when stored bit i is 0 (chip drives Z, pull
// wins) and 0 when stored bit i is 1 (chip drives strong-0, beats pullup).
// Without pullups, a "stored=0" output would resolve to Z and never wake from
// the simulator's initial X — that mirrors a real floating wire.
const ramCircuit = (): CircuitJSON => {
  const components: Array<{ id: string; type: string }> = [
    { id: 'ram', type: 'mem.74LS189' },
  ];
  for (let i = 0; i < DATA_BITS; i++) {
    components.push({ id: `pu${i}`, type: 'prim.PULLUP' });
  }
  const nets = [];
  for (let i = 0; i < ADDR_BITS; i++) {
    nets.push({ id: `a${i}`, endpoints: [`ram.A${i}`] });
  }
  for (let i = 0; i < DATA_BITS; i++) {
    nets.push({ id: `d${i}`, endpoints: [`ram.D${i}`] });
  }
  for (let i = 0; i < DATA_BITS; i++) {
    nets.push({ id: `y${i}`, endpoints: [`ram./Y${i}`, `pu${i}.Y`] });
  }
  nets.push({ id: 'cs', endpoints: ['ram./CS'] });
  nets.push({ id: 'we', endpoints: ['ram./WE'] });
  return { version: 1, kind: 'circuit', name: 'ram189_test', components, nets };
};

const driveAddr = (sim: Simulator, addr: number) => {
  for (let i = 0; i < ADDR_BITS; i++) {
    sim.setInput(`a${i}`, ((addr >> i) & 1) as DriverValue);
  }
};

const driveData = (sim: Simulator, nibble: number) => {
  for (let i = 0; i < DATA_BITS; i++) {
    sim.setInput(`d${i}`, ((nibble >> i) & 1) as DriverValue);
  }
};

const readY = (sim: Simulator): NetState[] => {
  const out: NetState[] = [];
  for (let i = 0; i < DATA_BITS; i++) out.push(sim.readNet(`y${i}`));
  return out;
};

// /Y_i resolves to NOT(stored bit i) when read mode + pullup is wired.
const expectedYWithPullup = (nibble: number): NetState[] => {
  const out: NetState[] = [];
  for (let i = 0; i < DATA_BITS; i++) {
    out.push(((nibble >> i) & 1) === 1 ? 0 : 1);
  }
  return out;
};

const setMode = (sim: Simulator, cs: NetState, we: NetState) => {
  sim.setInput('cs', cs);
  sim.setInput('we', we);
};

const ramState = (sim: Simulator) => {
  const idx = sim.graph.componentById.get('ram')!;
  return sim.graph.components[idx]!.state as { data: Uint8Array };
};

describe('mem.74LS189', () => {
  it('initializes to all zeros (read drives all-1 through pullups)', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    setMode(sim, 0, 1);
    driveAddr(sim, 0);
    sim.settle();
    expect(readY(sim)).toEqual([1, 1, 1, 1]);
    expect(ramState(sim).data.length).toBe(16);
    expect(Array.from(ramState(sim).data).every((b) => b === 0)).toBe(true);
  });

  it('write/read round-trip with inverted outputs', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0xa);
    driveData(sim, 0b1010);
    setMode(sim, 0, 0);
    sim.settle();
    expect(ramState(sim).data[0xa]).toBe(0b1010);

    setMode(sim, 0, 1);
    sim.settle();
    expect(readY(sim)).toEqual(expectedYWithPullup(0b1010));
    // Spot-check inversion: stored 0 → /Y=1, stored 1 → /Y=0.
    expect(readY(sim)).toEqual([1, 0, 1, 0]);
  });

  it('writes to multiple addresses preserve independence', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    const cells: Array<[number, number]> = [
      [0x0, 0x1],
      [0x5, 0xf],
      [0xa, 0x6],
      [0xf, 0x9],
    ];
    for (const [addr, nibble] of cells) {
      driveAddr(sim, addr);
      driveData(sim, nibble);
      setMode(sim, 0, 0);
      sim.settle();
    }
    setMode(sim, 0, 1);
    for (const [addr, nibble] of cells) {
      driveAddr(sim, addr);
      sim.settle();
      expect(readY(sim)).toEqual(expectedYWithPullup(nibble));
    }
    // An address never written reads as all-zero stored → /Y all-1.
    driveAddr(sim, 0x3);
    sim.settle();
    expect(readY(sim)).toEqual([1, 1, 1, 1]);
  });

  it('drives Z on /Y when /CS is high (deselect, pullups read 1)', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    // Pre-load addr 0 with all-1s so a non-deselect read would drive all-0.
    driveAddr(sim, 0);
    driveData(sim, 0xf);
    setMode(sim, 0, 0);
    sim.settle();

    setMode(sim, 1, 1);
    sim.settle();
    expect(readY(sim)).toEqual([1, 1, 1, 1]);
  });

  it('drives Z on /Y during write (output transistors off, pullups read 1)', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0);
    driveData(sim, 0xf);
    setMode(sim, 0, 0);
    sim.settle();
    expect(readY(sim)).toEqual([1, 1, 1, 1]);
  });

  it('does not store the cell on write when any data bit is X/Z', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0x7);
    driveData(sim, 0xf);
    sim.setInput('d2', 'Z');
    setMode(sim, 0, 0);
    sim.settle();
    expect(ramState(sim).data[0x7]).toBe(0);
  });

  it('drives X on /Y during read when an address bit is X', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0);
    driveData(sim, 0xf);
    setMode(sim, 0, 0);
    sim.settle();

    setMode(sim, 0, 1);
    sim.setInput('a2', 'X');
    sim.settle();
    expect(readY(sim)).toEqual(['X', 'X', 'X', 'X']);
  });

  it('drives X on /Y when /CS or /WE is X', () => {
    const sim = new Simulator(loadCircuit(ramCircuit()));
    driveAddr(sim, 0);
    setMode(sim, 'X', 1);
    sim.settle();
    expect(readY(sim)).toEqual(['X', 'X', 'X', 'X']);

    setMode(sim, 0, 'X');
    sim.settle();
    expect(readY(sim)).toEqual(['X', 'X', 'X', 'X']);
  });
});
