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

describe('ttl.74LS02 (Quad NOR)', () => {
  const sim = simWith(
    wrap('ttl.74LS02', [
      { name: '1A', net: 'a1' }, { name: '1B', net: 'b1' }, { name: '1Y', net: 'y1' },
      { name: '2A', net: 'a2' }, { name: '2B', net: 'b2' }, { name: '2Y', net: 'y2' },
      { name: '3A', net: 'a3' }, { name: '3B', net: 'b3' }, { name: '3Y', net: 'y3' },
      { name: '4A', net: 'a4' }, { name: '4B', net: 'b4' }, { name: '4Y', net: 'y4' },
    ]),
  );

  it('full truth table on gate1 with other gates quiesced', () => {
    for (const [a, b, y] of [[0, 0, 1], [0, 1, 0], [1, 0, 0], [1, 1, 0]] as const) {
      sim.setInput('a1', a); sim.setInput('b1', b);
      sim.setInput('a2', 0); sim.setInput('b2', 0);
      sim.setInput('a3', 0); sim.setInput('b3', 0);
      sim.setInput('a4', 0); sim.setInput('b4', 0);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y);
    }
  });

  it('all four gates work in parallel', () => {
    sim.setInput('a1', 0); sim.setInput('b1', 0); // y1 = 1
    sim.setInput('a2', 1); sim.setInput('b2', 0); // y2 = 0
    sim.setInput('a3', 0); sim.setInput('b3', 1); // y3 = 0
    sim.setInput('a4', 1); sim.setInput('b4', 1); // y4 = 0
    sim.settle();
    expect(sim.readNet('y1')).toBe(1);
    expect(sim.readNet('y2')).toBe(0);
    expect(sim.readNet('y3')).toBe(0);
    expect(sim.readNet('y4')).toBe(0);
  });
});

describe('ttl.74LS273 (Octal D flip-flop, async /MR)', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 1; i <= 8; i++) ports.push({ name: `${i}D`, net: `d${i}` });
  ports.push({ name: 'CP', net: 'cp' });
  ports.push({ name: '/MR', net: 'mr' });
  for (let i = 1; i <= 8; i++) ports.push({ name: `${i}Q`, net: `q${i}` });

  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS273', ports)));
    s.setInput('cp', 0);
    s.setInput('mr', 0); // assert reset
    s.settle();
    s.setInput('mr', 1); // release
    s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('cp', 1); s.settle();
    s.setInput('cp', 0); s.settle();
  };

  const setD = (s: Simulator, byte: number): void => {
    for (let i = 0; i < 8; i++) s.setInput(`d${i + 1}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  const readQ = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const q = s.readNet(`q${i + 1}`);
      if (q !== 0 && q !== 1) throw new Error(`q${i + 1}=${String(q)}`);
      v |= q << i;
    }
    return v;
  };

  it('async /MR forces every Q to 0', () => {
    const s = fresh();
    expect(readQ(s)).toBe(0);
  });

  it('latches data on rising CP', () => {
    const s = fresh();
    setD(s, 0xa5);
    tick(s);
    expect(readQ(s)).toBe(0xa5);
  });

  it('holds value across additional clock edges with no D change', () => {
    const s = fresh();
    setD(s, 0x3c);
    tick(s);
    expect(readQ(s)).toBe(0x3c);
    setD(s, 0x00); // change D after the edge — should be held
    expect(readQ(s)).toBe(0x3c);
  });

  it('asserting /MR after a load returns Q to 0', () => {
    const s = fresh();
    setD(s, 0xff);
    tick(s);
    expect(readQ(s)).toBe(0xff);
    s.setInput('mr', 0); s.settle();
    expect(readQ(s)).toBe(0);
  });
});

describe('ttl.74LS139 (Dual 2-to-4 decoder, active-low)', () => {
  const sim = simWith(
    wrap('ttl.74LS139', [
      { name: '/1G', net: 'g1' }, { name: '1A', net: 'a1' }, { name: '1B', net: 'b1' },
      { name: '/1Y0', net: 'y10' }, { name: '/1Y1', net: 'y11' },
      { name: '/1Y2', net: 'y12' }, { name: '/1Y3', net: 'y13' },
      { name: '/2G', net: 'g2' }, { name: '2A', net: 'a2' }, { name: '2B', net: 'b2' },
      { name: '/2Y0', net: 'y20' }, { name: '/2Y1', net: 'y21' },
      { name: '/2Y2', net: 'y22' }, { name: '/2Y3', net: 'y23' },
    ]),
  );

  const readSection1 = (): NetState[] =>
    [sim.readNet('y10'), sim.readNet('y11'), sim.readNet('y12'), sim.readNet('y13')];
  const readSection2 = (): NetState[] =>
    [sim.readNet('y20'), sim.readNet('y21'), sim.readNet('y22'), sim.readNet('y23')];

  it('section 1 selects /Y[addr] when /1G low; others stay high', () => {
    sim.setInput('g2', 1); sim.setInput('a2', 0); sim.setInput('b2', 0); // park section 2
    sim.setInput('g1', 0);
    for (let addr = 0; addr < 4; addr++) {
      sim.setInput('a1', (addr & 1) as NetState);
      sim.setInput('b1', ((addr >> 1) & 1) as NetState);
      sim.settle();
      const out = readSection1();
      expect(out.map((v, i) => i === addr ? 0 : 1)).toEqual(out.map((v) => v));
    }
  });

  it('section 1 outputs all high when /1G high', () => {
    sim.setInput('g1', 1); sim.setInput('a1', 1); sim.setInput('b1', 0);
    sim.settle();
    expect(readSection1()).toEqual([1, 1, 1, 1]);
  });

  it('section 2 is independent of section 1', () => {
    sim.setInput('g1', 1); // section 1 disabled
    sim.setInput('g2', 0); sim.setInput('a2', 1); sim.setInput('b2', 1); // pick /2Y3
    sim.settle();
    expect(readSection1()).toEqual([1, 1, 1, 1]);
    expect(readSection2()).toEqual([1, 1, 1, 0]);
  });
});

describe('ttl.74LS138 (3-to-8 decoder, active-low)', () => {
  const sim = simWith(
    wrap('ttl.74LS138', [
      { name: 'A', net: 'a' }, { name: 'B', net: 'b' }, { name: 'C', net: 'c' },
      { name: 'G1', net: 'g1' }, { name: '/G2A', net: 'g2a' }, { name: '/G2B', net: 'g2b' },
      { name: '/Y0', net: 'y0' }, { name: '/Y1', net: 'y1' },
      { name: '/Y2', net: 'y2' }, { name: '/Y3', net: 'y3' },
      { name: '/Y4', net: 'y4' }, { name: '/Y5', net: 'y5' },
      { name: '/Y6', net: 'y6' }, { name: '/Y7', net: 'y7' },
    ]),
  );

  const readY = (): NetState[] => {
    const out: NetState[] = [];
    for (let i = 0; i < 8; i++) out.push(sim.readNet(`y${i}`));
    return out;
  };

  const enable = (): void => {
    sim.setInput('g1', 1); sim.setInput('g2a', 0); sim.setInput('g2b', 0);
  };

  it('selects /Y[addr] for every address when enabled', () => {
    enable();
    for (let addr = 0; addr < 8; addr++) {
      sim.setInput('a', (addr & 1) as NetState);
      sim.setInput('b', ((addr >> 1) & 1) as NetState);
      sim.setInput('c', ((addr >> 2) & 1) as NetState);
      sim.settle();
      const expected = [1, 1, 1, 1, 1, 1, 1, 1];
      expected[addr] = 0;
      expect(readY()).toEqual(expected);
    }
  });

  it('all outputs high when G1 low', () => {
    sim.setInput('g1', 0); sim.setInput('g2a', 0); sim.setInput('g2b', 0);
    sim.setInput('a', 1); sim.setInput('b', 0); sim.setInput('c', 1); // would select Y5 if enabled
    sim.settle();
    expect(readY()).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('all outputs high when /G2A high', () => {
    sim.setInput('g1', 1); sim.setInput('g2a', 1); sim.setInput('g2b', 0);
    sim.setInput('a', 0); sim.setInput('b', 1); sim.setInput('c', 1);
    sim.settle();
    expect(readY()).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('all outputs high when /G2B high', () => {
    sim.setInput('g1', 1); sim.setInput('g2a', 0); sim.setInput('g2b', 1);
    sim.setInput('a', 1); sim.setInput('b', 1); sim.setInput('c', 0);
    sim.settle();
    expect(readY()).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe('ttl.74LS107 (Dual JK flip-flop, negative-edge)', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (const sec of [1, 2]) {
    ports.push({ name: `${sec}J`, net: `j${sec}` });
    ports.push({ name: `${sec}K`, net: `k${sec}` });
    ports.push({ name: `${sec}CLK`, net: `clk${sec}` });
    ports.push({ name: `/${sec}CLR`, net: `clr${sec}` });
    ports.push({ name: `${sec}Q`, net: `q${sec}` });
    ports.push({ name: `/${sec}Q`, net: `qn${sec}` });
  }

  // Power-on into a known state: park J=K=0, CLK=1 (resting high), assert
  // /CLR=0, settle, then release. Both Qs must read 0.
  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS107', ports)));
    for (const sec of [1, 2]) {
      s.setInput(`j${sec}`, 0);
      s.setInput(`k${sec}`, 0);
      s.setInput(`clk${sec}`, 1);
      s.setInput(`clr${sec}`, 0);
    }
    s.settle();
    for (const sec of [1, 2]) s.setInput(`clr${sec}`, 1);
    s.settle();
    return s;
  };

  // Negative-edge tick: external CLK 1 → 0 (drives DFF.CLK 0 → 1, i.e. rising).
  const tick = (s: Simulator, sec: number): void => {
    s.setInput(`clk${sec}`, 1); s.settle();
    s.setInput(`clk${sec}`, 0); s.settle();
  };

  it('async /CLR forces Q=0 on both sections', () => {
    const s = fresh();
    expect(s.readNet('q1')).toBe(0);
    expect(s.readNet('q2')).toBe(0);
  });

  it('hold (J=0, K=0) preserves Q across an edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 0); // set
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    s.setInput('j1', 0); s.setInput('k1', 0); // hold
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
  });

  it('reset (J=0, K=1) drives Q to 0 on the edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 0);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    s.setInput('j1', 0); s.setInput('k1', 1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(0);
  });

  it('set (J=1, K=0) drives Q to 1 on the edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 0);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('qn1')).toBe(0);
  });

  it('toggle (J=1, K=1) flips Q on each falling edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(0);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
  });

  it('positive (rising) external edge does NOT trigger', () => {
    const s = fresh();
    // Burn the latent falling edge that fresh() leaves pending.
    s.setInput('clk1', 0); s.settle();
    // Now clock is resting low; an external rising edge follows.
    s.setInput('j1', 1); s.setInput('k1', 0); s.settle();
    s.setInput('clk1', 1); s.settle(); // external 0 → 1: should NOT trigger
    expect(s.readNet('q1')).toBe(0);
  });

  it('section 2 unaffected by section 1 clocks', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 1);
    s.setInput('j2', 0); s.setInput('k2', 0);
    tick(s, 1);
    tick(s, 1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q2')).toBe(0);
  });

  it('per-section /CLR is independent', () => {
    const s = fresh();
    // Set both Qs to 1 via toggle.
    s.setInput('j1', 1); s.setInput('k1', 1);
    s.setInput('j2', 1); s.setInput('k2', 1);
    tick(s, 1); tick(s, 2);
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q2')).toBe(1);
    // Clear only section 1.
    s.setInput('clr1', 0); s.settle();
    expect(s.readNet('q1')).toBe(0);
    expect(s.readNet('q2')).toBe(1);
  });
});

describe('ttl.74LS157 (Quad 2:1 MUX with strobe)', () => {
  const sim = simWith(
    wrap('ttl.74LS157', [
      { name: '/STB', net: 'stb' }, { name: 'S', net: 's' },
      { name: '1A', net: 'a1' }, { name: '1B', net: 'b1' }, { name: '1Y', net: 'y1' },
      { name: '2A', net: 'a2' }, { name: '2B', net: 'b2' }, { name: '2Y', net: 'y2' },
      { name: '3A', net: 'a3' }, { name: '3B', net: 'b3' }, { name: '3Y', net: 'y3' },
      { name: '4A', net: 'a4' }, { name: '4B', net: 'b4' }, { name: '4Y', net: 'y4' },
    ]),
  );

  it('/STB high forces every output low', () => {
    sim.setInput('stb', 1); sim.setInput('s', 0);
    for (let i = 1; i <= 4; i++) {
      sim.setInput(`a${i}`, 1); sim.setInput(`b${i}`, 1);
    }
    sim.settle();
    for (let i = 1; i <= 4; i++) expect(sim.readNet(`y${i}`)).toBe(0);
  });

  it('/STB low + S=0 routes A through to Y', () => {
    sim.setInput('stb', 0); sim.setInput('s', 0);
    sim.setInput('a1', 1); sim.setInput('b1', 0);
    sim.setInput('a2', 0); sim.setInput('b2', 1);
    sim.setInput('a3', 1); sim.setInput('b3', 0);
    sim.setInput('a4', 0); sim.setInput('b4', 1);
    sim.settle();
    expect(sim.readNet('y1')).toBe(1);
    expect(sim.readNet('y2')).toBe(0);
    expect(sim.readNet('y3')).toBe(1);
    expect(sim.readNet('y4')).toBe(0);
  });

  it('/STB low + S=1 routes B through to Y', () => {
    sim.setInput('stb', 0); sim.setInput('s', 1);
    sim.setInput('a1', 1); sim.setInput('b1', 0);
    sim.setInput('a2', 0); sim.setInput('b2', 1);
    sim.setInput('a3', 1); sim.setInput('b3', 0);
    sim.setInput('a4', 0); sim.setInput('b4', 1);
    sim.settle();
    expect(sim.readNet('y1')).toBe(0);
    expect(sim.readNet('y2')).toBe(1);
    expect(sim.readNet('y3')).toBe(0);
    expect(sim.readNet('y4')).toBe(1);
  });
});

describe('ttl.74LS245 (Octal bus transceiver)', () => {
  const ports: Array<{ name: string; net: string }> = [
    { name: '/OE', net: 'oe' }, { name: 'DIR', net: 'dir' },
  ];
  for (let i = 1; i <= 8; i++) ports.push({ name: `A${i}`, net: `a${i}` });
  for (let i = 1; i <= 8; i++) ports.push({ name: `B${i}`, net: `b${i}` });

  const fresh = (): Simulator => new Simulator(loadCircuit(wrap('ttl.74LS245', ports)));

  it('DIR=1, /OE=0 drives A → B; A side accepts external drive', () => {
    const s = fresh();
    s.setInput('oe', 0); s.setInput('dir', 1);
    for (let i = 1; i <= 8; i++) s.setInput(`a${i}`, ((i - 1) & 1) as NetState);
    s.settle();
    for (let i = 1; i <= 8; i++) {
      expect(s.readNet(`b${i}`)).toBe(((i - 1) & 1) as NetState);
    }
  });

  it('DIR=0, /OE=0 drives B → A', () => {
    const s = fresh();
    s.setInput('oe', 0); s.setInput('dir', 0);
    const pattern = [1, 0, 1, 1, 0, 0, 1, 0];
    for (let i = 0; i < 8; i++) s.setInput(`b${i + 1}`, pattern[i] as NetState);
    s.settle();
    for (let i = 0; i < 8; i++) expect(s.readNet(`a${i + 1}`)).toBe(pattern[i]);
  });

  it('/OE=1 leaves both sides Hi-Z regardless of DIR', () => {
    const s = fresh();
    s.setInput('oe', 1); s.setInput('dir', 1);
    s.settle();
    for (let i = 1; i <= 8; i++) {
      expect(s.readNet(`a${i}`)).toBe('Z');
      expect(s.readNet(`b${i}`)).toBe('Z');
    }
  });

  it('DIR flip changes drive direction; release input first to avoid contention', () => {
    const s = fresh();
    s.setInput('oe', 0); s.setInput('dir', 1);
    s.setInput('a1', 1); s.settle();
    expect(s.readNet('b1')).toBe(1);
    // Switch direction. Release the A drive first so the BA tristate isn't fighting it.
    s.setInput('a1', 'Z'); s.settle();
    s.setInput('dir', 0); s.setInput('b1', 0); s.settle();
    expect(s.readNet('a1')).toBe(0);
  });
});

describe('ttl.74LS161 (4-bit synchronous counter)', () => {
  const ports: Array<{ name: string; net: string }> = [
    { name: 'A', net: 'pa' }, { name: 'B', net: 'pb' },
    { name: 'C', net: 'pc' }, { name: 'D', net: 'pd' },
    { name: 'CLK', net: 'clk' }, { name: '/CLR', net: 'clr' },
    { name: '/LD', net: 'ld' }, { name: 'ENT', net: 'ent' }, { name: 'ENP', net: 'enp' },
    { name: 'QA', net: 'qa' }, { name: 'QB', net: 'qb' },
    { name: 'QC', net: 'qc' }, { name: 'QD', net: 'qd' },
    { name: 'RCO', net: 'rco' },
  ];

  // Park inputs in a sane state: clock low, clear asserted, /LD high (no load),
  // count enables high (count freely), parallel inputs at 0.
  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS161', ports)));
    s.setInput('clk', 0);
    s.setInput('clr', 0); // assert async clear
    s.setInput('ld', 1);  // not loading
    s.setInput('ent', 1); s.setInput('enp', 1); // count enabled
    s.setInput('pa', 0); s.setInput('pb', 0); s.setInput('pc', 0); s.setInput('pd', 0);
    s.settle();
    s.setInput('clr', 1); // release clear
    s.settle();
    return s;
  };

  // Positive-edge tick.
  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  const readQ = (s: Simulator): number => {
    let v = 0;
    for (const [bit, n] of [[0, 'qa'], [1, 'qb'], [2, 'qc'], [3, 'qd']] as const) {
      const q = s.readNet(n);
      if (q !== 0 && q !== 1) throw new Error(`${n}=${String(q)}`);
      v |= q << bit;
    }
    return v;
  };

  it('async /CLR forces all Qs to 0', () => {
    const s = fresh();
    expect(readQ(s)).toBe(0);
  });

  it('counts from 0 through 15 then wraps to 0', () => {
    const s = fresh();
    for (let expected = 1; expected <= 16; expected++) {
      tick(s);
      expect(readQ(s)).toBe(expected & 0xf);
    }
  });

  it('synchronous /LD loads parallel data on the rising edge', () => {
    const s = fresh();
    // Set parallel data to 0b1010 (10).
    s.setInput('pa', 0); s.setInput('pb', 1); s.setInput('pc', 0); s.setInput('pd', 1);
    s.setInput('ld', 0); // ask for load
    s.settle();
    expect(readQ(s)).toBe(0); // sync — needs an edge
    tick(s);
    expect(readQ(s)).toBe(10);
    // Release /LD; further ticks count from 10.
    s.setInput('ld', 1); s.settle();
    tick(s);
    expect(readQ(s)).toBe(11);
  });

  it('disabling either ENT or ENP holds the count', () => {
    const s = fresh();
    tick(s); tick(s); tick(s); // count up to 3
    expect(readQ(s)).toBe(3);
    s.setInput('ent', 0); s.settle();
    tick(s); tick(s);
    expect(readQ(s)).toBe(3);
    s.setInput('ent', 1); s.setInput('enp', 0); s.settle();
    tick(s); tick(s);
    expect(readQ(s)).toBe(3);
    s.setInput('enp', 1); s.settle();
    tick(s);
    expect(readQ(s)).toBe(4);
  });

  it('RCO = ENT AND (Q==15)', () => {
    const s = fresh();
    // Load 15 via parallel data.
    s.setInput('pa', 1); s.setInput('pb', 1); s.setInput('pc', 1); s.setInput('pd', 1);
    s.setInput('ld', 0); s.settle();
    tick(s);
    s.setInput('ld', 1); s.settle();
    expect(readQ(s)).toBe(15);
    expect(s.readNet('rco')).toBe(1);
    // Drop ENT — RCO should fall.
    s.setInput('ent', 0); s.settle();
    expect(s.readNet('rco')).toBe(0);
    // Restore ENT, count past 15 → wraps to 0, RCO drops.
    s.setInput('ent', 1); s.settle();
    expect(s.readNet('rco')).toBe(1);
    tick(s);
    expect(readQ(s)).toBe(0);
    expect(s.readNet('rco')).toBe(0);
  });
});

describe('ttl.74LS374 (Octal D flip-flop, three-state)', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 1; i <= 8; i++) ports.push({ name: `${i}D`, net: `d${i}` });
  ports.push({ name: 'CP', net: 'cp' });
  ports.push({ name: '/OE', net: 'oe' });
  for (let i = 1; i <= 8; i++) ports.push({ name: `${i}Q`, net: `q${i}` });

  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS374', ports)));
    s.setInput('cp', 0);
    s.setInput('oe', 0); // output-enable active (outputs present stored bits)
    s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('cp', 1); s.settle();
    s.setInput('cp', 0); s.settle();
  };

  const setD = (s: Simulator, byte: number): void => {
    for (let i = 0; i < 8; i++) s.setInput(`d${i + 1}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  const readQ = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const q = s.readNet(`q${i + 1}`);
      if (q !== 0 && q !== 1) throw new Error(`q${i + 1}=${String(q)}`);
      v |= q << i;
    }
    return v;
  };

  const readQStates = (s: Simulator): NetState[] => {
    const out: NetState[] = [];
    for (let i = 0; i < 8; i++) out.push(s.readNet(`q${i + 1}`));
    return out;
  };

  it('loads two distinct bytes on rising CP', () => {
    const s = fresh();
    setD(s, 0xa5);
    tick(s);
    expect(readQ(s)).toBe(0xa5);
    setD(s, 0x3c);
    tick(s);
    expect(readQ(s)).toBe(0x3c);
  });

  it('holds value when D changes without a clock edge', () => {
    const s = fresh();
    setD(s, 0xa5);
    tick(s);
    expect(readQ(s)).toBe(0xa5);
    setD(s, 0x5a); // change D, no edge
    expect(readQ(s)).toBe(0xa5);
  });

  it('outputs go Hi-Z on /OE=1 and the same value reappears on /OE=0', () => {
    const s = fresh();
    setD(s, 0x5a);
    tick(s);
    expect(readQ(s)).toBe(0x5a);
    s.setInput('oe', 1); s.settle();
    expect(readQStates(s)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
    s.setInput('oe', 0); s.settle();
    expect(readQ(s)).toBe(0x5a); // stored state untouched by disabling outputs
  });

  it('clocks in a new byte while outputs are disabled', () => {
    const s = fresh();
    setD(s, 0x5a);
    tick(s);
    expect(readQ(s)).toBe(0x5a);
    s.setInput('oe', 1); s.settle(); // disable outputs
    expect(readQStates(s)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
    setD(s, 0x3c);
    tick(s); // clock in new byte while disabled
    expect(readQStates(s)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
    s.setInput('oe', 0); s.settle(); // enable outputs: NEW byte appears
    expect(readQ(s)).toBe(0x3c);
  });

  it('/OE=X drives outputs to X, not Z', () => {
    const s = fresh();
    setD(s, 0x5a);
    tick(s);
    s.setInput('oe', 'X'); s.settle();
    expect(readQStates(s)).toEqual(['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X']);
  });

  it('falling edge of CP does not latch', () => {
    const s = fresh();
    setD(s, 0xa5);
    s.setInput('cp', 1); s.settle(); // rising edge latches 0xa5; CP now high
    expect(readQ(s)).toBe(0xa5);
    setD(s, 0x3c);                    // D changes while CP is high
    s.setInput('cp', 0); s.settle(); // falling edge must NOT latch
    expect(readQ(s)).toBe(0xa5);
  });
});

describe('ttl.74LS74 (Dual D flip-flop, async /PRE and /CLR)', () => {
  const ports: Array<{ name: string; net: string }> = [
    { name: '1D', net: 'd1' }, { name: '1CLK', net: 'clk1' },
    { name: '/1PRE', net: 'pre1' }, { name: '/1CLR', net: 'clr1' },
    { name: '1Q', net: 'q1' }, { name: '/1Q', net: 'q1n' },
    { name: '2D', net: 'd2' }, { name: '2CLK', net: 'clk2' },
    { name: '/2PRE', net: 'pre2' }, { name: '/2CLR', net: 'clr2' },
    { name: '2Q', net: 'q2' }, { name: '/2Q', net: 'q2n' },
  ];

  // Power into a deterministic Q=0 on both sections: clock low, D=0,
  // async inputs released, then a brief /CLR pulse.
  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS74', ports)));
    for (const sec of [1, 2]) {
      s.setInput(`d${sec}`, 0);
      s.setInput(`clk${sec}`, 0);
      s.setInput(`pre${sec}`, 1);
      s.setInput(`clr${sec}`, 0); // asserted: forces both Q to 0
    }
    s.settle();
    for (const sec of [1, 2]) s.setInput(`clr${sec}`, 1);
    s.settle();
    return s;
  };

  // Power into a deterministic Q=1 on both sections via async /PRE.
  const powerOnPreset = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS74', ports)));
    for (const sec of [1, 2]) {
      s.setInput(`d${sec}`, 0);
      s.setInput(`clk${sec}`, 0);
      s.setInput(`clr${sec}`, 1);
      s.setInput(`pre${sec}`, 0); // asserted: forces both Q to 1
    }
    s.settle();
    for (const sec of [1, 2]) s.setInput(`pre${sec}`, 1);
    s.settle();
    return s;
  };

  // Positive-edge tick.
  const tick = (s: Simulator, sec: number): void => {
    s.setInput(`clk${sec}`, 1); s.settle();
    s.setInput(`clk${sec}`, 0); s.settle();
  };

  it('async /CLR forces Q=0 and /Q=1 on both sections with no clock', () => {
    const s = fresh();
    expect(s.readNet('q1')).toBe(0); expect(s.readNet('q1n')).toBe(1);
    expect(s.readNet('q2')).toBe(0); expect(s.readNet('q2n')).toBe(1);
  });

  it('async /PRE forces Q=1 and /Q=0 on both sections with no clock', () => {
    const s = powerOnPreset();
    expect(s.readNet('q1')).toBe(1); expect(s.readNet('q1n')).toBe(0);
    expect(s.readNet('q2')).toBe(1); expect(s.readNet('q2n')).toBe(0);
  });

  it('async /PRE overrides the clock: a set stays set even through D=0 edges', () => {
    const s = fresh(); // Q=0
    s.setInput('d1', 0);
    s.setInput('pre1', 0); s.settle();
    expect(s.readNet('q1')).toBe(1);
    tick(s, 1); // rising edge with D=0 — async preset must win
    s.setInput('pre1', 1); s.settle();
    expect(s.readNet('q1')).toBe(1);
  });

  it('latches D on the rising CLK edge and holds until the next rising edge', () => {
    const s = fresh();
    s.setInput('d1', 1); s.settle();
    expect(s.readNet('q1')).toBe(0); // D changed, no edge yet
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q1n')).toBe(0);
    s.setInput('d1', 0); s.settle(); // D flips with no edge — held
    expect(s.readNet('q1')).toBe(1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(0);
  });

  it('async /CLR overrides the clock: an edge with D=1 cannot set a cleared FF', () => {
    const s = fresh(); // Q=0
    s.setInput('d1', 1); s.settle();
    s.setInput('clr1', 0); s.settle();
    tick(s, 1); // rising edge lands while /CLR is low
    s.setInput('clr1', 1); s.settle();
    expect(s.readNet('q1')).toBe(0); // came through the edge still cleared
  });

  it('section 2 is independent of section 1 clocking', () => {
    const s = fresh();
    s.setInput('d2', 1); s.settle();
    tick(s, 2); // only section 2 clocks
    expect(s.readNet('q2')).toBe(1);
    expect(s.readNet('q1')).toBe(0);
    tick(s, 1); // section 1 clocks with D=0 — stays 0, section 2 untouched
    expect(s.readNet('q1')).toBe(0);
    expect(s.readNet('q2')).toBe(1);
  });

  it('per-section async /PRE and /CLR act independently', () => {
    const s = fresh();
    s.setInput('pre2', 0); s.settle();
    expect(s.readNet('q1')).toBe(0);
    expect(s.readNet('q2')).toBe(1);
    s.setInput('pre2', 1); s.setInput('clr2', 0); s.settle();
    expect(s.readNet('q2')).toBe(0);
    expect(s.readNet('q1')).toBe(0);
  });

  it('/Q always complements Q through preset, clear, and a clocked load', () => {
    const s = fresh(); // Q=0, /Q=1
    expect(s.readNet('q1n')).toBe(1);
    s.setInput('pre1', 0); s.settle(); // preset Q=1
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q1n')).toBe(0);
    s.setInput('pre1', 1); s.setInput('clr1', 0); s.settle(); // clear Q=0
    expect(s.readNet('q1')).toBe(0);
    expect(s.readNet('q1n')).toBe(1);
    s.setInput('clr1', 1); s.setInput('d1', 1); s.settle(); // load Q=1 on edge
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q1n')).toBe(0);
  });
});

describe('ttl.74LS76 (Dual JK flip-flop, negative-edge, async /PRE and /CLR)', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (const sec of [1, 2]) {
    ports.push({ name: `${sec}J`, net: `j${sec}` });
    ports.push({ name: `${sec}K`, net: `k${sec}` });
    ports.push({ name: `${sec}CLK`, net: `clk${sec}` });
    ports.push({ name: `/${sec}PRE`, net: `pre${sec}` });
    ports.push({ name: `/${sec}CLR`, net: `clr${sec}` });
    ports.push({ name: `${sec}Q`, net: `q${sec}` });
    ports.push({ name: `/${sec}Q`, net: `qn${sec}` });
  }

  // Power into a known Q=0 state: J=K=0, CLK resting HIGH (negative-edge chip),
  // assert /CLR, settle, release.
  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('ttl.74LS76', ports)));
    for (const sec of [1, 2]) {
      s.setInput(`j${sec}`, 0);
      s.setInput(`k${sec}`, 0);
      s.setInput(`clk${sec}`, 1);
      s.setInput(`pre${sec}`, 1);
      s.setInput(`clr${sec}`, 0);
    }
    s.settle();
    for (const sec of [1, 2]) s.setInput(`clr${sec}`, 1);
    s.settle();
    return s;
  };

  // Negative-edge tick: external CLK 1 → 0.
  const tick = (s: Simulator, sec: number): void => {
    s.setInput(`clk${sec}`, 1); s.settle();
    s.setInput(`clk${sec}`, 0); s.settle();
  };

  it('async /CLR forces Q=0, /Q=1 on both sections with no clock', () => {
    const s = fresh();
    expect(s.readNet('q1')).toBe(0); expect(s.readNet('qn1')).toBe(1);
    expect(s.readNet('q2')).toBe(0); expect(s.readNet('qn2')).toBe(1);
  });

  it('async /PRE forces Q=1, /Q=0 and overrides a reset clock edge', () => {
    const s = fresh();
    s.setInput('pre1', 0); s.settle();
    expect(s.readNet('q1')).toBe(1); expect(s.readNet('qn1')).toBe(0);
    s.setInput('j1', 0); s.setInput('k1', 1); s.settle(); // would reset on an edge
    tick(s, 1);
    s.setInput('pre1', 1); s.settle();
    expect(s.readNet('q1')).toBe(1); // preset dominated the edge
  });

  it('hold (J=0, K=0) preserves Q across a falling edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 0); // set
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    s.setInput('j1', 0); s.setInput('k1', 0); // hold
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
  });

  it('reset (J=0, K=1) drives Q to 0 on the falling edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 0);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    s.setInput('j1', 0); s.setInput('k1', 1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(0);
    expect(s.readNet('qn1')).toBe(1);
  });

  it('set (J=1, K=0) drives Q to 1 on the falling edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 0);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('qn1')).toBe(0);
  });

  it('toggle (J=1, K=1) flips Q on each falling edge', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(0);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
  });

  it('external rising edge does NOT trigger the flip-flop', () => {
    const s = fresh();
    // Burn the latent falling edge that fresh() leaves pending.
    s.setInput('clk1', 0); s.settle();
    s.setInput('j1', 1); s.setInput('k1', 0); s.settle();
    s.setInput('clk1', 1); s.settle(); // external 0 → 1: should NOT trigger
    expect(s.readNet('q1')).toBe(0);
  });

  it('async /CLR held low blocks a toggle edge from setting the FF', () => {
    const s = fresh();
    // Get Q=1 first via set, then hold /CLR low across a toggle edge.
    s.setInput('j1', 1); s.setInput('k1', 0);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    s.setInput('j1', 1); s.setInput('k1', 1); // toggle would flip 1 → 0 anyway
    s.setInput('clr1', 0); s.settle(); // assert clear so any flip is masked
    tick(s, 1);
    s.setInput('clr1', 1); s.settle();
    expect(s.readNet('q1')).toBe(0);
  });

  it('section 2 is independent of section 1 clocks', () => {
    const s = fresh();
    s.setInput('j1', 1); s.setInput('k1', 1);
    s.setInput('j2', 0); s.setInput('k2', 0);
    tick(s, 1);
    tick(s, 1);
    tick(s, 1);
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q2')).toBe(0);
  });

  it('per-section /PRE and /CLR are independent', () => {
    const s = fresh();
    s.setInput('j2', 1); s.setInput('k2', 1);
    tick(s, 2);
    expect(s.readNet('q2')).toBe(1);
    s.setInput('pre1', 0); s.settle(); // preset only section 1
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q2')).toBe(1);
    s.setInput('clr2', 0); s.settle(); // clear only section 2
    expect(s.readNet('q1')).toBe(1);
    expect(s.readNet('q2')).toBe(0);
  });

  it('with both /PRE and /CLR asserted, this model resolves Q=0 (CLR wins)', () => {
    // The real '76 gives an indeterminate Q=Qbar=1 row; the DFF primitive
    // gives /CLR precedence. We document the modelled behavior rather than
    // pretend to match an undefined corner.
    const s = fresh();
    s.setInput('pre1', 0); s.setInput('clr1', 0); s.settle();
    expect(s.readNet('q1')).toBe(0);
  });
});

describe('ttl.74LS153 (Dual 4-to-1 multiplexer, active-low strobe)', () => {
  const sim = simWith(
    wrap('ttl.74LS153', [
      { name: '/1G', net: 'g1' }, { name: '/2G', net: 'g2' },
      { name: 'A', net: 'a' }, { name: 'B', net: 'b' },
      { name: '1C0', net: 'c10' }, { name: '1C1', net: 'c11' },
      { name: '1C2', net: 'c12' }, { name: '1C3', net: 'c13' }, { name: '1Y', net: 'y1' },
      { name: '2C0', net: 'c20' }, { name: '2C1', net: 'c21' },
      { name: '2C2', net: 'c22' }, { name: '2C3', net: 'c23' }, { name: '2Y', net: 'y2' },
    ]),
  );

  const driveSelect = (a: NetState, b: NetState): void => {
    sim.setInput('a', a); sim.setInput('b', b);
  };

  it('full truth table on section 1: Y1 = 1C[2·B + A] for every select', () => {
    sim.setInput('g1', 0);
    // Pattern 1: 1C0=0, 1C1=1, 1C2=1, 1C3=0
    sim.setInput('c10', 0); sim.setInput('c11', 1);
    sim.setInput('c12', 1); sim.setInput('c13', 0);
    for (const [a, b, y] of [[0, 0, 0], [1, 0, 1], [0, 1, 1], [1, 1, 0]] as const) {
      driveSelect(a, b);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y);
    }
    // Pattern 2 flips the mapping so each address is exercised against both 0/1.
    sim.setInput('c10', 1); sim.setInput('c11', 0);
    sim.setInput('c12', 0); sim.setInput('c13', 1);
    for (const [a, b, y] of [[0, 0, 1], [1, 0, 0], [0, 1, 0], [1, 1, 1]] as const) {
      driveSelect(a, b);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y);
    }
  });

  it('exhaustive section 1: every select × every 16 data vector routes the selected bit', () => {
    sim.setInput('g1', 0);
    for (let data = 0; data < 16; data++) {
      sim.setInput('c10', (data & 1) as NetState);
      sim.setInput('c11', ((data >> 1) & 1) as NetState);
      sim.setInput('c12', ((data >> 2) & 1) as NetState);
      sim.setInput('c13', ((data >> 3) & 1) as NetState);
      for (let addr = 0; addr < 4; addr++) {
        driveSelect((addr & 1) as NetState, ((addr >> 1) & 1) as NetState);
        sim.settle();
        expect(sim.readNet('y1')).toBe(((data >> addr) & 1) as NetState);
      }
    }
  });

  it('exhaustive section 2: every select × every 16 data vector routes the selected bit', () => {
    sim.setInput('g2', 0);
    sim.setInput('g1', 1); // park section 1
    for (let data = 0; data < 16; data++) {
      sim.setInput('c20', (data & 1) as NetState);
      sim.setInput('c21', ((data >> 1) & 1) as NetState);
      sim.setInput('c22', ((data >> 2) & 1) as NetState);
      sim.setInput('c23', ((data >> 3) & 1) as NetState);
      for (let addr = 0; addr < 4; addr++) {
        driveSelect((addr & 1) as NetState, ((addr >> 1) & 1) as NetState);
        sim.settle();
        expect(sim.readNet('y2')).toBe(((data >> addr) & 1) as NetState);
      }
    }
  });

  it('full truth table on section 2: Y2 = 2C[2·B + A] for every select', () => {
    sim.setInput('g2', 0);
    sim.setInput('g1', 1); // park section 1
    sim.setInput('c20', 1); sim.setInput('c21', 1);
    sim.setInput('c22', 0); sim.setInput('c23', 1);
    for (const [a, b, y] of [[0, 0, 1], [1, 0, 1], [0, 1, 0], [1, 1, 1]] as const) {
      driveSelect(a, b);
      sim.settle();
      expect(sim.readNet('y2')).toBe(y);
    }
  });

  it('both sections route simultaneously with shared select but distinct data', () => {
    sim.setInput('g1', 0); sim.setInput('g2', 0);
    sim.setInput('c10', 0); sim.setInput('c11', 1); sim.setInput('c12', 0); sim.setInput('c13', 1);
    sim.setInput('c20', 1); sim.setInput('c21', 0); sim.setInput('c22', 1); sim.setInput('c23', 0);
    for (const [a, b, y1, y2] of
      [[0, 0, 0, 1], [1, 0, 1, 0], [0, 1, 0, 1], [1, 1, 1, 0]] as const) {
      driveSelect(a, b);
      sim.settle();
      expect(sim.readNet('y1')).toBe(y1);
      expect(sim.readNet('y2')).toBe(y2);
    }
  });

  it('/G high forces the output low for every select, regardless of data', () => {
    sim.setInput('g1', 1);
    sim.setInput('c10', 1); sim.setInput('c11', 1); sim.setInput('c12', 1); sim.setInput('c13', 1);
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      driveSelect(a, b);
      sim.settle();
      expect(sim.readNet('y1')).toBe(0);
    }
  });

  it('non-selected data inputs do not influence the output', () => {
    sim.setInput('g1', 0);
    // Fix select to C1 (A=1, B=0) with 1C1=1, then flip every other input.
    driveSelect(1, 0);
    sim.setInput('c11', 1);
    sim.settle();
    expect(sim.readNet('y1')).toBe(1);
    for (const c10 of [0, 1]) {
      for (const c12 of [0, 1]) {
        for (const c13 of [0, 1]) {
          sim.setInput('c10', c10 as NetState);
          sim.setInput('c12', c12 as NetState);
          sim.setInput('c13', c13 as NetState);
          sim.settle();
          expect(sim.readNet('y1')).toBe(1);
        }
      }
    }
  });

  it('disabling one section leaves the other unaffected', () => {
    sim.setInput('g1', 1); sim.setInput('g2', 0);
    sim.setInput('c20', 0); sim.setInput('c21', 0); sim.setInput('c22', 0); sim.setInput('c23', 1);
    sim.setInput('c10', 1);
    driveSelect(1, 1); // select C3 on section 2, C3 on section 1 as well
    sim.settle();
    expect(sim.readNet('y2')).toBe(1); // 2C3 = 1
    expect(sim.readNet('y1')).toBe(0); // /1G high → forced low
  });
});
