import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import '../engine/primitives/index';
import { Simulator } from '../engine/sim';
import './index';

// Wrap a single TTL chip instance into a top-level circuit, exposing one net
// per port for easy drive/read.
const wrap = (
  type: string,
  ports: ReadonlyArray<{ name: string; net: string }>,
  params: Record<string, unknown> = {},
): CircuitJSON => ({
  version: 1,
  kind: 'circuit',
  name: `wrap_${type}`,
  components: [{ id: 'U1', type, params }],
  nets: ports.map((p) => ({ id: p.net, endpoints: [`U1.${p.name}`] })),
});

const simWith = (json: CircuitJSON): Simulator => new Simulator(loadCircuit(json));

describe('ttl.74LS00 (Quad NAND)', () => {
  const sim = simWith(
    wrap('ttl.74LS00', [
      { name: '1A', net: 'a1' }, { name: '1B', net: 'b1' }, { name: '1Y', net: 'y1' },
      { name: '2A', net: 'a2' }, { name: '2B', net: 'b2' }, { name: '2Y', net: 'y2' },
      { name: '3A', net: 'a3' }, { name: '3B', net: 'b3' }, { name: '3Y', net: 'y3' },
      { name: '4A', net: 'a4' }, { name: '4B', net: 'b4' }, { name: '4Y', net: 'y4' },
    ]),
  );

  const cases: Array<[NetState, NetState, NetState]> = [
    [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0],
  ];
  for (const [a, b, y] of cases) {
    it(`gate1: NAND(${a},${b}) = ${y}`, () => {
      sim.setInput('a1', a); sim.setInput('b1', b);
      // Quiesce other gates to known values so they don't appear as X.
      sim.setInput('a2', 0); sim.setInput('b2', 0);
      sim.setInput('a3', 0); sim.setInput('b3', 0);
      sim.setInput('a4', 0); sim.setInput('b4', 0);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y);
    });
  }

  it('all four gates work in parallel', () => {
    sim.setInput('a1', 1); sim.setInput('b1', 1);
    sim.setInput('a2', 0); sim.setInput('b2', 1);
    sim.setInput('a3', 1); sim.setInput('b3', 0);
    sim.setInput('a4', 0); sim.setInput('b4', 0);
    sim.settle();
    expect(sim.readNet('y1')).toBe(0);
    expect(sim.readNet('y2')).toBe(1);
    expect(sim.readNet('y3')).toBe(1);
    expect(sim.readNet('y4')).toBe(1);
  });
});

describe('ttl.74LS04 (Hex inverter)', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 1; i <= 6; i++) {
    ports.push({ name: `${i}A`, net: `a${i}` });
    ports.push({ name: `${i}Y`, net: `y${i}` });
  }
  const sim = simWith(wrap('ttl.74LS04', ports));

  it('all six inverters produce ~A', () => {
    for (let i = 1; i <= 6; i++) sim.setInput(`a${i}`, ((i - 1) & 1) as NetState);
    sim.settle();
    for (let i = 1; i <= 6; i++) {
      const a = (i - 1) & 1;
      expect(sim.readNet(`y${i}`)).toBe(a === 0 ? 1 : 0);
    }
  });
});

describe('ttl.74LS08 (Quad AND)', () => {
  const sim = simWith(
    wrap('ttl.74LS08', [
      { name: '1A', net: 'a1' }, { name: '1B', net: 'b1' }, { name: '1Y', net: 'y1' },
      { name: '2A', net: 'a2' }, { name: '2B', net: 'b2' }, { name: '2Y', net: 'y2' },
      { name: '3A', net: 'a3' }, { name: '3B', net: 'b3' }, { name: '3Y', net: 'y3' },
      { name: '4A', net: 'a4' }, { name: '4B', net: 'b4' }, { name: '4Y', net: 'y4' },
    ]),
  );

  it('truth table on gate1', () => {
    for (let i = 0; i < 4; i++) { sim.setInput(`a${i + 1 === 1 ? 1 : i + 1}`, 0); /* noop */ }
    for (const [a, b, y] of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1]] as const) {
      sim.setInput('a1', a); sim.setInput('b1', b);
      sim.setInput('a2', 0); sim.setInput('b2', 0);
      sim.setInput('a3', 0); sim.setInput('b3', 0);
      sim.setInput('a4', 0); sim.setInput('b4', 0);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y);
    }
  });
});

describe('ttl.74LS32 (Quad OR)', () => {
  const sim = simWith(
    wrap('ttl.74LS32', [
      { name: '1A', net: 'a1' }, { name: '1B', net: 'b1' }, { name: '1Y', net: 'y1' },
      { name: '2A', net: 'a2' }, { name: '2B', net: 'b2' }, { name: '2Y', net: 'y2' },
      { name: '3A', net: 'a3' }, { name: '3B', net: 'b3' }, { name: '3Y', net: 'y3' },
      { name: '4A', net: 'a4' }, { name: '4B', net: 'b4' }, { name: '4Y', net: 'y4' },
    ]),
  );

  it('truth table on gate1', () => {
    for (const [a, b, y] of [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 1]] as const) {
      sim.setInput('a1', a); sim.setInput('b1', b);
      sim.setInput('a2', 0); sim.setInput('b2', 0);
      sim.setInput('a3', 0); sim.setInput('b3', 0);
      sim.setInput('a4', 0); sim.setInput('b4', 0);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y);
    }
  });
});

describe('ttl.74LS86 (Quad XOR)', () => {
  const sim = simWith(
    wrap('ttl.74LS86', [
      { name: '1A', net: 'a1' }, { name: '1B', net: 'b1' }, { name: '1Y', net: 'y1' },
      { name: '2A', net: 'a2' }, { name: '2B', net: 'b2' }, { name: '2Y', net: 'y2' },
      { name: '3A', net: 'a3' }, { name: '3B', net: 'b3' }, { name: '3Y', net: 'y3' },
      { name: '4A', net: 'a4' }, { name: '4B', net: 'b4' }, { name: '4Y', net: 'y4' },
    ]),
  );

  it('truth table on gate1', () => {
    for (const [a, b, y] of [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]] as const) {
      sim.setInput('a1', a); sim.setInput('b1', b);
      sim.setInput('a2', 0); sim.setInput('b2', 0);
      sim.setInput('a3', 0); sim.setInput('b3', 0);
      sim.setInput('a4', 0); sim.setInput('b4', 0);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y);
    }
  });
});

describe('ttl.74LS283 (4-bit adder)', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 1; i <= 4; i++) ports.push({ name: `A${i}`, net: `a${i}` });
  for (let i = 1; i <= 4; i++) ports.push({ name: `B${i}`, net: `b${i}` });
  ports.push({ name: 'C0', net: 'c0' });
  for (let i = 1; i <= 4; i++) ports.push({ name: `S${i}`, net: `s${i}` });
  ports.push({ name: 'C4', net: 'c4' });
  const sim = simWith(wrap('ttl.74LS283', ports));

  const drive = (a: number, b: number, c: NetState): void => {
    for (let i = 0; i < 4; i++) {
      sim.setInput(`a${i + 1}`, ((a >> i) & 1) as NetState);
      sim.setInput(`b${i + 1}`, ((b >> i) & 1) as NetState);
    }
    sim.setInput('c0', c);
    sim.settle();
  };

  const readSum = (): number => {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const v = sim.readNet(`s${i + 1}`);
      if (v !== 0 && v !== 1) throw new Error(`s${i + 1}=${String(v)}`);
      s |= v << i;
    }
    const c4 = sim.readNet('c4');
    if (c4 !== 0 && c4 !== 1) throw new Error(`c4=${String(c4)}`);
    s |= c4 << 4;
    return s;
  };

  it('5 + 3 = 8', () => {
    drive(5, 3, 0);
    expect(readSum()).toBe(8);
  });

  it('15 + 1 = 16 (carry out)', () => {
    drive(15, 1, 0);
    expect(readSum()).toBe(16);
  });

  it('with C0=1, 0 + 0 + 1 = 1', () => {
    drive(0, 0, 1);
    expect(readSum()).toBe(1);
  });
});

describe('ttl.74LS173 (4-bit D register, tristate outputs)', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 1; i <= 4; i++) ports.push({ name: `D${i}`, net: `d${i}` });
  ports.push({ name: 'CLK', net: 'clk' });
  ports.push({ name: 'CLR', net: 'clr' });
  ports.push({ name: '/G1', net: 'g1' });
  ports.push({ name: '/G2', net: 'g2' });
  ports.push({ name: '/M', net: 'm' });
  ports.push({ name: '/N', net: 'n' });
  for (let i = 1; i <= 4; i++) ports.push({ name: `Q${i}`, net: `q${i}` });

  // Helper: set up a fresh sim with deterministic starting state.
  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS173', ports)));
    // Output enabled, load enabled, clock low, no clear, no data yet.
    s.setInput('m', 0); s.setInput('n', 0);
    s.setInput('g1', 0); s.setInput('g2', 0);
    s.setInput('clk', 0);
    s.setInput('clr', 1); // assert clear to force Q -> 0
    s.settle();
    s.setInput('clr', 0);
    s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  const setData = (s: Simulator, bits: ReadonlyArray<NetState>): void => {
    for (let i = 0; i < 4; i++) s.setInput(`d${i + 1}`, bits[i]!);
    // Settle the combinational mux path before the next clock edge so the
    // DFFs sample stable D on the rising edge rather than racing the mux.
    s.settle();
  };

  const readQ = (s: Simulator): NetState[] => {
    return [s.readNet('q1'), s.readNet('q2'), s.readNet('q3'), s.readNet('q4')];
  };

  it('async CLR forces Q1..Q4 to 0', () => {
    const s = fresh();
    expect(readQ(s)).toEqual([0, 0, 0, 0]);
  });

  it('loads D on rising CLK when /G1 = /G2 = 0', () => {
    const s = fresh();
    setData(s, [1, 0, 1, 1]); // 1011
    tick(s);
    expect(readQ(s)).toEqual([1, 0, 1, 1]);
  });

  it('holds previous Q when /G1 high (load disabled)', () => {
    const s = fresh();
    setData(s, [1, 1, 0, 1]); // 1101
    tick(s);
    expect(readQ(s)).toEqual([1, 1, 0, 1]);

    s.setInput('g1', 1); // disable load
    setData(s, [0, 0, 0, 0]);
    tick(s);
    expect(readQ(s)).toEqual([1, 1, 0, 1]); // unchanged
  });

  it('outputs Hi-Z when /M is high', () => {
    const s = fresh();
    setData(s, [1, 0, 1, 0]);
    tick(s);
    expect(readQ(s)).toEqual([1, 0, 1, 0]);
    s.setInput('m', 1);
    s.settle();
    expect(readQ(s)).toEqual(['Z', 'Z', 'Z', 'Z']);
  });

  it('outputs Hi-Z when /N is high', () => {
    const s = fresh();
    setData(s, [0, 1, 1, 0]);
    tick(s);
    s.setInput('n', 1);
    s.settle();
    expect(readQ(s)).toEqual(['Z', 'Z', 'Z', 'Z']);
  });

  it('CLR is asynchronous (overrides held state without a clock)', () => {
    const s = fresh();
    setData(s, [1, 1, 1, 1]);
    tick(s);
    expect(readQ(s)).toEqual([1, 1, 1, 1]);
    s.setInput('clr', 1);
    s.settle();
    expect(readQ(s)).toEqual([0, 0, 0, 0]);
  });
});
