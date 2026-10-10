import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../ir';
import { loadCircuit } from '../loader';
import '../primitives/index';
import { Simulator } from '../sim';
import './cnt_74ls193';

// Wrap a ttl.74LS193 instance in a top-level circuit, one net per port.
const wrap = (): CircuitJSON => {
  const ports: Array<{ name: string }> = [
    { name: 'D0' }, { name: 'D1' }, { name: 'D2' }, { name: 'D3' },
    { name: 'CPU' }, { name: 'CPD' }, { name: '/PL' }, { name: 'MR' },
    { name: 'Q0' }, { name: 'Q1' }, { name: 'Q2' }, { name: 'Q3' },
    { name: '/TCU' }, { name: '/TCd' },
  ];
  const netFor: Record<string, string> = {
    D0: 'd0', D1: 'd1', D2: 'd2', D3: 'd3',
    CPU: 'cpu', CPD: 'cpd', '/PL': 'pl', MR: 'mr',
    Q0: 'q0', Q1: 'q1', Q2: 'q2', Q3: 'q3',
    '/TCU': 'tcu', '/TCd': 'tcd',
  };
  return {
    version: 1,
    kind: 'circuit',
    name: 'wrap_ttl.74LS193',
    components: [{ id: 'U1', type: 'ttl.74LS193' }],
    nets: ports.map((p) => ({ id: netFor[p.name]!, endpoints: [`U1.${p.name}`] })),
  };
};

// Parked state: both clocks low, /PL high (not loading), MR low (not reset),
// parallel data 0. The count boots to 0.
const fresh = (): Simulator => {
  const s = new Simulator(loadCircuit(wrap()));
  s.setInput('cpu', 0);
  s.setInput('cpd', 0);
  s.setInput('pl', 1);
  s.setInput('mr', 0);
  for (let i = 0; i < 4; i++) s.setInput(`d${i}`, 0);
  s.settle();
  return s;
};

const readQ = (s: Simulator): number => {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const q = s.readNet(`q${i}`);
    if (q !== 0 && q !== 1) throw new Error(`q${i}=${String(q)}`);
    v |= q << i;
  }
  return v;
};

const setData = (s: Simulator, nibble: number): void => {
  for (let i = 0; i < 4; i++) s.setInput(`d${i}`, ((nibble >> i) & 1) as NetState);
  s.settle();
};

// Rising edge on CPU (Count Up).
const tickUp = (s: Simulator): void => {
  s.setInput('cpu', 1); s.settle();
  s.setInput('cpu', 0); s.settle();
};

// Rising edge on CPD (Count Down).
const tickDown = (s: Simulator): void => {
  s.setInput('cpd', 1); s.settle();
  s.setInput('cpd', 0); s.settle();
};

describe('ttl.74LS193 (4-bit up/down counter, async load/reset)', () => {
  it('boots to 0 with /TCU and /TCd high', () => {
    const s = fresh();
    expect(readQ(s)).toBe(0);
    expect(s.readNet('tcu')).toBe(1);
    expect(s.readNet('tcd')).toBe(1);
  });

  it('counts up on rising CPU edges through 15 and wraps to 0', () => {
    const s = fresh();
    for (let k = 1; k <= 16; k++) {
      tickUp(s);
      expect(readQ(s)).toBe(k & 0xf);
    }
  });

  it('counts down on rising CPD edges through 0 and wraps to 15', () => {
    const s = fresh();
    setData(s, 8);
    s.setInput('pl', 0); s.settle();
    s.setInput('pl', 1); s.settle();
    expect(readQ(s)).toBe(8);
    for (let k = 1; k <= 20; k++) {
      tickDown(s);
      expect(readQ(s)).toBe((8 - k) & 0xf);
    }
  });

  it('async /PL loads the data inputs with no clock needed', () => {
    const s = fresh();
    setData(s, 0b1010);
    expect(readQ(s)).toBe(0); // /PL still high — not loaded yet
    s.setInput('pl', 0); s.settle();
    expect(readQ(s)).toBe(0b1010);
  });

  it('async /PL overrides an in-flight up clock edge', () => {
    const s = fresh();
    setData(s, 0b0011);
    s.setInput('cpu', 1); // up edge arriving this step
    s.setInput('pl', 0);  // ...and a load arriving the same step
    s.settle();
    expect(readQ(s)).toBe(0b0011); // load wins over the count
    s.setInput('pl', 1); s.setInput('cpu', 0); s.settle();
  });

  it('after an async load, further up edges count on from the loaded value', () => {
    const s = fresh();
    setData(s, 0b1110);
    s.setInput('pl', 0); s.settle();
    s.setInput('pl', 1); s.settle();
    expect(readQ(s)).toBe(14);
    // 14 → 15: read /TCU while CPU is still held high after the edge.
    s.setInput('cpu', 1); s.settle();
    expect(readQ(s)).toBe(15);
    expect(s.readNet('tcu')).toBe(0); // /TCU pulses low while CPU high at max
    s.setInput('cpu', 0); s.settle();
    tickUp(s); // 15 → 0
    expect(readQ(s)).toBe(0);
  });

  it('async MR forces Q to 0 regardless of previous count', () => {
    const s = fresh();
    for (let k = 0; k < 6; k++) tickUp(s);
    expect(readQ(s)).toBe(6);
    s.setInput('mr', 1); s.settle();
    expect(readQ(s)).toBe(0);
  });

  it('async MR beats /PL: MR=1 with /PL=0 and all-ones data still clears', () => {
    const s = fresh();
    setData(s, 0xf);
    s.setInput('pl', 0);
    s.setInput('mr', 1);
    s.settle();
    expect(readQ(s)).toBe(0);
  });

  it('async MR beats a simultaneously arriving up clock edge', () => {
    const s = fresh();
    s.setInput('cpu', 1); // would count 0 → 1
    s.setInput('mr', 1);  // ...but MR asserts in the same step
    s.settle();
    expect(readQ(s)).toBe(0);
    s.setInput('cpu', 0); s.setInput('mr', 0); s.settle();
  });

  it('holds the count when neither clock edges, even if data changes', () => {
    const s = fresh();
    tickUp(s);
    tickUp(s); // Q = 2
    expect(readQ(s)).toBe(2);
    setData(s, 0b1111); // /PL is high, so data input is inert
    expect(readQ(s)).toBe(2);
    tickUp(s); // count continues from the held value, not from the data
    expect(readQ(s)).toBe(3);
  });

  it('counts exactly once per rising edge (parked-high clock does not re-count)', () => {
    const s = fresh();
    s.setInput('cpu', 1); s.settle(); // edge: 0 → 1
    expect(readQ(s)).toBe(1);
    s.settle(); // no input changed — no further behaviour
    s.settle();
    expect(readQ(s)).toBe(1);
    s.setInput('cpu', 0); s.settle(); // falling edge — ignored
    expect(readQ(s)).toBe(1);
  });

  it('/TCU is low only while Q=15 with CPU high', () => {
    const s = fresh();
    expect(s.readNet('tcu')).toBe(1);
    for (let k = 0; k < 14; k++) tickUp(s); // Q = 14
    expect(s.readNet('tcu')).toBe(1); // not at max yet
    s.setInput('cpu', 1); s.settle(); // 14 → 15, CPU still high
    expect(readQ(s)).toBe(15);
    expect(s.readNet('tcu')).toBe(0);
    s.setInput('cpu', 0); s.settle(); // CPU low → /TCU released
    expect(s.readNet('tcu')).toBe(1);
  });

  it('/TCd is low only while Q=0 with CPD high', () => {
    const s = fresh();
    expect(s.readNet('tcd')).toBe(1); // Q=0 but CPD idle
    setData(s, 3);
    s.setInput('pl', 0); s.settle();
    s.setInput('pl', 1); s.settle();
    tickDown(s); // 3 → 2
    tickDown(s); // 2 → 1
    expect(s.readNet('tcd')).toBe(1);
    s.setInput('cpd', 1); s.settle(); // 1 → 0, CPD still high
    expect(readQ(s)).toBe(0);
    expect(s.readNet('tcd')).toBe(0);
    s.setInput('cpd', 0); s.settle();
    expect(s.readNet('tcd')).toBe(1);
  });

  it('/TCU is not asserted at Q=15 while the chip is idle or counting down', () => {
    const s = fresh();
    setData(s, 0xf);
    s.setInput('pl', 0); s.settle();
    s.setInput('pl', 1); s.settle();
    expect(readQ(s)).toBe(15);
    expect(s.readNet('tcu')).toBe(1); // CPU low
    tickDown(s); // 15 → 14: counting down away from max
    expect(readQ(s)).toBe(14);
    expect(s.readNet('tcu')).toBe(1);
    expect(s.readNet('tcd')).toBe(1);
  });

  it('simultaneous CPU and CPD rising edges cancel (no net change)', () => {
    const s = fresh();
    s.setInput('cpu', 1);
    s.setInput('cpd', 1);
    s.settle(); // both rose in the same settled step
    expect(readQ(s)).toBe(0);
    s.setInput('cpu', 0); s.setInput('cpd', 0); s.settle();
    // A lone CPD edge afterwards still works.
    tickDown(s);
    expect(readQ(s)).toBe(15);
  });

  it('Q outputs follow the stored 4-bit pattern during async load', () => {
    const s = fresh();
    setData(s, 0b1001); // Q0=1, Q3=1
    s.setInput('pl', 0); s.settle();
    expect(s.readNet('q0')).toBe(1);
    expect(s.readNet('q1')).toBe(0);
    expect(s.readNet('q2')).toBe(0);
    expect(s.readNet('q3')).toBe(1);
    expect(readQ(s)).toBe(0b1001);
  });

  it('interleaved up and down edges step by exactly +/-1 each', () => {
    const s = fresh();
    tickUp(s);   // 0 → 1
    tickUp(s);   // 1 → 2
    expect(readQ(s)).toBe(2);
    tickDown(s); // 2 → 1
    tickDown(s); // 1 → 0
    expect(readQ(s)).toBe(0);
    tickUp(s);   // 0 → 1
    expect(readQ(s)).toBe(1);
  });

  it('Q stays 0 while MR is asserted, even with clocks ticking', () => {
    const s = fresh();
    s.setInput('mr', 1); s.settle();
    for (let k = 0; k < 4; k++) tickUp(s);
    for (let k = 0; k < 3; k++) tickDown(s);
    expect(readQ(s)).toBe(0);
    s.setInput('mr', 0); s.settle();
    tickUp(s);
    expect(readQ(s)).toBe(1); // counting resumes once MR releases
  });

  it('/TCd never asserts during up-counting', () => {
    const s = fresh();
    for (let k = 0; k < 20; k++) {
      tickUp(s);
      expect(s.readNet('tcd')).toBe(1);
    }
  });

  it('a down count starting from a loaded value decrements from it', () => {
    const s = fresh();
    setData(s, 5);
    s.setInput('pl', 0); s.settle();
    s.setInput('pl', 1); s.settle();
    expect(readQ(s)).toBe(5);
    tickDown(s);
    expect(readQ(s)).toBe(4);
    tickDown(s);
    expect(readQ(s)).toBe(3);
  });
});
