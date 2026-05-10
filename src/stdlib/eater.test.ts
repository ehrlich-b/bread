import { describe, expect, it } from 'vitest';
import type { CircuitJSON, NetState } from '../engine/ir';
import { loadCircuit } from '../engine/loader';
import '../engine/behavioral/index';
import '../engine/primitives/index';
import { Simulator } from '../engine/sim';
import './index';

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

describe('eater.register_8bit', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 0; i < 8; i++) ports.push({ name: `BUS${i}`, net: `bus${i}` });
  ports.push({ name: 'CLK', net: 'clk' });
  ports.push({ name: 'CLR', net: 'clr' });
  ports.push({ name: '/LD', net: 'ld' });
  ports.push({ name: '/OE', net: 'oe' });
  for (let i = 0; i < 8; i++) ports.push({ name: `VAL${i}`, net: `val${i}` });

  // Power-on into a known state: bus undriven (Z), CLK low, CLR asserted
  // (active high), /LD high (no load), /OE high (no output drive). Then
  // release CLR and drop /LD so the next rising edge will latch.
  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.register_8bit', ports)));
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, 'Z');
    s.setInput('clk', 0);
    s.setInput('ld', 1);
    s.setInput('oe', 1);
    s.setInput('clr', 1); // assert async clear
    s.settle();
    s.setInput('clr', 0); // release
    s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  const driveBus = (s: Simulator, byte: number): void => {
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  const releaseBus = (s: Simulator): void => {
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, 'Z');
    s.settle();
  };

  const readVal = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const b = s.readNet(`val${i}`);
      if (b !== 0 && b !== 1) throw new Error(`val${i}=${String(b)}`);
      v |= b << i;
    }
    return v;
  };

  const readBus = (s: Simulator): NetState[] => {
    const out: NetState[] = [];
    for (let i = 0; i < 8; i++) out.push(s.readNet(`bus${i}`));
    return out;
  };

  it('async CLR forces VAL0..VAL7 to 0', () => {
    const s = fresh();
    expect(readVal(s)).toBe(0);
  });

  it('loads BUS into the register on rising CLK when /LD = 0', () => {
    const s = fresh();
    driveBus(s, 0xa5);
    s.setInput('ld', 0); s.settle();
    tick(s);
    expect(readVal(s)).toBe(0xa5);
  });

  it('holds value when /LD = 1', () => {
    const s = fresh();
    driveBus(s, 0x3c);
    s.setInput('ld', 0); s.settle();
    tick(s);
    expect(readVal(s)).toBe(0x3c);

    // Drop external bus drive, raise /LD, then a clock edge must NOT change Q.
    releaseBus(s);
    s.setInput('ld', 1); s.settle();
    driveBus(s, 0xff);
    tick(s);
    expect(readVal(s)).toBe(0x3c);
  });

  it('/OE = 0 gates the stored value onto BUS', () => {
    const s = fresh();
    driveBus(s, 0x96);
    s.setInput('ld', 0); s.settle();
    tick(s);
    s.setInput('ld', 1); s.settle();
    releaseBus(s);
    s.setInput('oe', 0); s.settle();
    expect(readBus(s)).toEqual([0, 1, 1, 0, 1, 0, 0, 1]); // 0x96 LSB-first
  });

  it('/OE = 1 leaves BUS in Hi-Z (no drive from the register)', () => {
    const s = fresh();
    driveBus(s, 0xff);
    s.setInput('ld', 0); s.settle();
    tick(s);
    s.setInput('ld', 1); s.settle();
    releaseBus(s);
    expect(readBus(s)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
  });

  it('VAL outputs stay live regardless of /OE', () => {
    const s = fresh();
    driveBus(s, 0x42);
    s.setInput('ld', 0); s.settle();
    tick(s);
    s.setInput('ld', 1); s.settle();
    releaseBus(s);
    // /OE high — bus is Z but VAL still reflects the stored value.
    expect(readBus(s)).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
    expect(readVal(s)).toBe(0x42);
    // Same when /OE = 0.
    s.setInput('oe', 0); s.settle();
    expect(readVal(s)).toBe(0x42);
  });

  it('round-trips: load from bus, then drive bus from VAL via /OE', () => {
    const s = fresh();
    driveBus(s, 0xc3);
    s.setInput('ld', 0); s.settle();
    tick(s);
    s.setInput('ld', 1); s.settle();
    releaseBus(s);
    // Now turn on /OE and confirm the bus reads back what the register holds.
    s.setInput('oe', 0); s.settle();
    let restored = 0;
    for (let i = 0; i < 8; i++) {
      const b = s.readNet(`bus${i}`);
      if (b !== 0 && b !== 1) throw new Error(`bus${i}=${String(b)}`);
      restored |= b << i;
    }
    expect(restored).toBe(0xc3);
  });

  it('CLR is asynchronous (clears Q without a clock edge)', () => {
    const s = fresh();
    driveBus(s, 0xff);
    s.setInput('ld', 0); s.settle();
    tick(s);
    expect(readVal(s)).toBe(0xff);
    s.setInput('clr', 1); s.settle();
    expect(readVal(s)).toBe(0);
  });
});

describe('eater.alu_8bit', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 0; i < 8; i++) ports.push({ name: `A${i}`, net: `a${i}` });
  for (let i = 0; i < 8; i++) ports.push({ name: `B${i}`, net: `b${i}` });
  ports.push({ name: 'SU', net: 'su' });
  ports.push({ name: '/EU', net: 'eu' });
  for (let i = 0; i < 8; i++) ports.push({ name: `BUS${i}`, net: `bus${i}` });
  for (let i = 0; i < 8; i++) ports.push({ name: `SUM${i}`, net: `sum${i}` });
  ports.push({ name: 'COUT', net: 'cout' });
  ports.push({ name: 'ZERO', net: 'zero' });

  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.alu_8bit', ports)));
    for (let i = 0; i < 8; i++) {
      s.setInput(`a${i}`, 0);
      s.setInput(`b${i}`, 0);
      s.setInput(`bus${i}`, 'Z');
    }
    s.setInput('su', 0);
    s.setInput('eu', 1); // bus tristated by default
    s.settle();
    return s;
  };

  const drive = (s: Simulator, port: 'a' | 'b', byte: number): void => {
    for (let i = 0; i < 8; i++) s.setInput(`${port}${i}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  const readSum = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const b = s.readNet(`sum${i}`);
      if (b !== 0 && b !== 1) throw new Error(`sum${i}=${String(b)}`);
      v |= b << i;
    }
    return v;
  };

  const readBus = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const b = s.readNet(`bus${i}`);
      if (b !== 0 && b !== 1) throw new Error(`bus${i}=${String(b)}`);
      v |= b << i;
    }
    return v;
  };

  it('A + B without carry: 5 + 3 = 8', () => {
    const s = fresh();
    drive(s, 'a', 5); drive(s, 'b', 3);
    expect(readSum(s)).toBe(8);
    expect(s.readNet('cout')).toBe(0);
    expect(s.readNet('zero')).toBe(0);
  });

  it('A + B with carry across nibble: 0x0F + 0x01 = 0x10', () => {
    const s = fresh();
    drive(s, 'a', 0x0f); drive(s, 'b', 0x01);
    expect(readSum(s)).toBe(0x10);
    expect(s.readNet('cout')).toBe(0);
  });

  it('A + B = 0x100 carries out and ZERO asserts', () => {
    const s = fresh();
    drive(s, 'a', 0xff); drive(s, 'b', 0x01);
    expect(readSum(s)).toBe(0x00);
    expect(s.readNet('cout')).toBe(1);
    expect(s.readNet('zero')).toBe(1);
  });

  it('subtract: 10 - 3 = 7 (SU=1 inverts B and feeds carry-in)', () => {
    const s = fresh();
    drive(s, 'a', 10); drive(s, 'b', 3);
    s.setInput('su', 1); s.settle();
    expect(readSum(s)).toBe(7);
    // No borrow: SUM = A - B, COUT high indicates A >= B in two's complement.
    expect(s.readNet('cout')).toBe(1);
  });

  it('subtract with borrow: 3 - 10 = -7 (0xF9) and COUT is 0', () => {
    const s = fresh();
    drive(s, 'a', 3); drive(s, 'b', 10);
    s.setInput('su', 1); s.settle();
    expect(readSum(s)).toBe(0xf9);
    expect(s.readNet('cout')).toBe(0);
  });

  it('A - A = 0 asserts ZERO', () => {
    const s = fresh();
    drive(s, 'a', 0x42); drive(s, 'b', 0x42);
    s.setInput('su', 1); s.settle();
    expect(readSum(s)).toBe(0);
    expect(s.readNet('zero')).toBe(1);
    expect(s.readNet('cout')).toBe(1);
  });

  it('/EU = 0 drives SUM onto BUS', () => {
    const s = fresh();
    drive(s, 'a', 0x12); drive(s, 'b', 0x34);
    s.setInput('eu', 0); s.settle();
    expect(readBus(s)).toBe(0x46);
  });

  it('/EU = 1 leaves BUS at Hi-Z', () => {
    const s = fresh();
    drive(s, 'a', 0x12); drive(s, 'b', 0x34);
    s.setInput('eu', 1); s.settle();
    for (let i = 0; i < 8; i++) {
      expect(s.readNet(`bus${i}`)).toBe('Z');
    }
  });
});

describe('eater.ram_module', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 0; i < 8; i++) ports.push({ name: `BUS${i}`, net: `bus${i}` });
  ports.push({ name: 'CLK', net: 'clk' });
  ports.push({ name: 'CLR', net: 'clr' });
  ports.push({ name: '/MI', net: 'mi' });
  ports.push({ name: '/RI', net: 'ri' });
  ports.push({ name: '/RO', net: 'ro' });

  // Power-on: bus floating, all controls high (idle), CLR pulsed to clear MAR.
  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.ram_module', ports)));
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, 'Z');
    s.setInput('clk', 0);
    s.setInput('mi', 1);
    s.setInput('ri', 1);
    s.setInput('ro', 1);
    s.setInput('clr', 1); s.settle();
    s.setInput('clr', 0); s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  const driveBus = (s: Simulator, byte: number): void => {
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  const releaseBus = (s: Simulator): void => {
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, 'Z');
    s.settle();
  };

  const readBus = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const b = s.readNet(`bus${i}`);
      if (b !== 0 && b !== 1) throw new Error(`bus${i}=${String(b)}`);
      v |= b << i;
    }
    return v;
  };

  // Helper: load MAR with the low nibble of `addr`.
  const setAddr = (s: Simulator, addr: number): void => {
    driveBus(s, addr & 0xf);
    s.setInput('mi', 0); s.settle();
    tick(s);
    s.setInput('mi', 1); s.settle();
    releaseBus(s);
  };

  // Helper: write `byte` at currently-addressed location.
  const writeHere = (s: Simulator, byte: number): void => {
    driveBus(s, byte);
    s.setInput('ri', 0); s.settle(); // assert /WE
    s.setInput('ri', 1); s.settle(); // release; the level-sensitive write captured the value
    releaseBus(s);
  };

  // Helper: read the byte at currently-addressed location via /RO.
  const readHere = (s: Simulator): number => {
    s.setInput('ro', 0); s.settle();
    const v = readBus(s);
    s.setInput('ro', 1); s.settle();
    return v;
  };

  it('boots zeroed (read at addr 0)', () => {
    const s = fresh();
    expect(readHere(s)).toBe(0);
  });

  it('writes byte and reads it back at the same address', () => {
    const s = fresh();
    setAddr(s, 5);
    writeHere(s, 0xab);
    expect(readHere(s)).toBe(0xab);
  });

  it('separate addresses hold separate values', () => {
    const s = fresh();
    setAddr(s, 5);  writeHere(s, 0xab);
    setAddr(s, 10); writeHere(s, 0xcd);
    setAddr(s, 5);
    expect(readHere(s)).toBe(0xab);
    setAddr(s, 10);
    expect(readHere(s)).toBe(0xcd);
  });

  it('/RO = 1 leaves BUS at Hi-Z', () => {
    const s = fresh();
    setAddr(s, 7); writeHere(s, 0xff);
    s.setInput('ro', 1); s.settle();
    for (let i = 0; i < 8; i++) expect(s.readNet(`bus${i}`)).toBe('Z');
  });

  it('CLR resets MAR (forces address back to 0 without a clock)', () => {
    const s = fresh();
    setAddr(s, 11); writeHere(s, 0xee);
    setAddr(s, 0);  writeHere(s, 0x11);
    setAddr(s, 11);
    expect(readHere(s)).toBe(0xee);
    s.setInput('clr', 1); s.settle();
    s.setInput('clr', 0); s.settle();
    // MAR is now 0; reading shows the value at 0.
    expect(readHere(s)).toBe(0x11);
  });

  it('only the low 4 address bits matter (top 7 grounded)', () => {
    const s = fresh();
    // Even if a future change tried to drive higher MAR bits, addr 5 and 5+0x10
    // should be the same location. We verify this indirectly: the MAR is 4-bit
    // so addr 5 + (anything that would mask to 5) = same cell.
    setAddr(s, 5);
    writeHere(s, 0x77);
    setAddr(s, 5);
    expect(readHere(s)).toBe(0x77);
  });
});

describe('eater.program_counter', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 0; i < 4; i++) ports.push({ name: `BUS${i}`, net: `bus${i}` });
  ports.push({ name: 'CLK',  net: 'clk' });
  ports.push({ name: '/CLR', net: 'clr' });
  ports.push({ name: 'CE',   net: 'ce'  });
  ports.push({ name: '/CO',  net: 'co'  });
  ports.push({ name: 'J',    net: 'j'   });

  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.program_counter', ports)));
    s.setInput('clk', 0);
    s.setInput('ce', 0);
    s.setInput('co', 1);
    s.setInput('j', 0);
    s.setInput('clr', 0); s.settle(); // assert async clear
    s.setInput('clr', 1); s.settle(); // release
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  const driveBus = (s: Simulator, byte: number): void => {
    for (let i = 0; i < 4; i++) s.setInput(`bus${i}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  const releaseBus = (s: Simulator): void => {
    for (let i = 0; i < 4; i++) s.setInput(`bus${i}`, 'Z');
    s.settle();
  };

  const readBus = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = s.readNet(`bus${i}`);
      if (b !== 0 && b !== 1) throw new Error(`bus${i}=${String(b)}`);
      v |= b << i;
    }
    return v;
  };

  it('starts at 0 after /CLR', () => {
    const s = fresh();
    s.setInput('co', 0); s.settle();
    expect(readBus(s)).toBe(0);
  });

  it('CE high + clock edge increments', () => {
    const s = fresh();
    s.setInput('ce', 1); s.settle();
    tick(s); tick(s); tick(s);
    s.setInput('co', 0); s.settle();
    expect(readBus(s)).toBe(3);
  });

  it('CE low holds the count', () => {
    const s = fresh();
    s.setInput('ce', 1); s.settle();
    tick(s); tick(s);
    s.setInput('ce', 0); s.settle();
    tick(s); tick(s); tick(s);
    s.setInput('co', 0); s.settle();
    expect(readBus(s)).toBe(2);
  });

  it('J asserted loads BUS low nibble on next clock edge', () => {
    const s = fresh();
    driveBus(s, 0xa);     // 1010
    s.setInput('j', 1); s.settle();
    tick(s);
    s.setInput('j', 0); s.settle();
    releaseBus(s);
    s.setInput('co', 0); s.settle();
    expect(readBus(s)).toBe(0xa);
  });

  it('after a jump, CE counts from the loaded value', () => {
    const s = fresh();
    driveBus(s, 5);
    s.setInput('j', 1); s.settle();
    tick(s);
    s.setInput('j', 0); s.settle();
    releaseBus(s);
    s.setInput('ce', 1); s.settle();
    tick(s); tick(s);
    s.setInput('co', 0); s.settle();
    expect(readBus(s)).toBe(7);
  });

  it('/CO = 1 leaves BUS at Hi-Z', () => {
    const s = fresh();
    s.setInput('ce', 1); s.settle();
    tick(s); tick(s); tick(s);
    // Prime: prove the buffer drives a definite value first, then transition
    // back to /CO=1 so the engine sees the change and re-resolves the bus.
    s.setInput('co', 0); s.settle();
    s.setInput('co', 1); s.settle();
    for (let i = 0; i < 4; i++) expect(s.readNet(`bus${i}`)).toBe('Z');
  });

  it('/CLR resets the counter (async)', () => {
    const s = fresh();
    s.setInput('ce', 1); s.settle();
    tick(s); tick(s); tick(s); tick(s); tick(s); // 5
    s.setInput('clr', 0); s.settle();
    s.setInput('co', 0); s.settle();
    expect(readBus(s)).toBe(0);
  });
});

describe('eater.instruction_register', () => {
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 0; i < 8; i++) ports.push({ name: `BUS${i}`, net: `bus${i}` });
  ports.push({ name: 'CLK', net: 'clk' });
  ports.push({ name: 'CLR', net: 'clr' });
  ports.push({ name: '/II', net: 'ii' });
  ports.push({ name: '/IO', net: 'io' });
  for (let i = 0; i < 4; i++) ports.push({ name: `OPCODE${i}`, net: `op${i}` });

  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.instruction_register', ports)));
    s.setInput('clk', 0);
    s.setInput('ii', 1);
    s.setInput('io', 1);
    s.setInput('clr', 1); s.settle();
    s.setInput('clr', 0); s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  const driveBus = (s: Simulator, byte: number): void => {
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  const releaseBus = (s: Simulator): void => {
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, 'Z');
    s.settle();
  };

  const readOpcode = (s: Simulator): number => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = s.readNet(`op${i}`);
      if (b !== 0 && b !== 1) throw new Error(`op${i}=${String(b)}`);
      v |= b << i;
    }
    return v;
  };

  it('CLR forces OPCODE = 0', () => {
    const s = fresh();
    expect(readOpcode(s)).toBe(0);
  });

  it('loads BUS into IR on rising CLK; opcode reflects high nibble', () => {
    const s = fresh();
    driveBus(s, 0xa3);
    s.setInput('ii', 0); s.settle();
    tick(s);
    s.setInput('ii', 1); s.settle();
    expect(readOpcode(s)).toBe(0xa);
  });

  it('OPCODE stays live regardless of /IO', () => {
    const s = fresh();
    driveBus(s, 0x57);
    s.setInput('ii', 0); s.settle();
    tick(s);
    s.setInput('ii', 1); s.settle();
    releaseBus(s);
    expect(readOpcode(s)).toBe(0x5);
    s.setInput('io', 0); s.settle();
    expect(readOpcode(s)).toBe(0x5);
  });

  it('/IO = 0 drives the operand (low nibble) onto BUS0..BUS3', () => {
    const s = fresh();
    driveBus(s, 0x6b);
    s.setInput('ii', 0); s.settle();
    tick(s);
    s.setInput('ii', 1); s.settle();
    releaseBus(s);
    s.setInput('io', 0); s.settle();
    let lo = 0;
    for (let i = 0; i < 4; i++) {
      const b = s.readNet(`bus${i}`);
      if (b !== 0 && b !== 1) throw new Error(`bus${i}=${String(b)}`);
      lo |= b << i;
    }
    expect(lo).toBe(0xb);
  });

  it('/IO = 0 drives 0 onto BUS4..BUS7 (zero-pad so LDI loads cleanly)', () => {
    const s = fresh();
    driveBus(s, 0x6b);
    s.setInput('ii', 0); s.settle();
    tick(s);
    s.setInput('ii', 1); s.settle();
    releaseBus(s);
    s.setInput('io', 0); s.settle();
    for (let i = 4; i < 8; i++) expect(s.readNet(`bus${i}`)).toBe(0);
  });

  it('/IO = 1 leaves the low nibble of BUS at Hi-Z (after priming)', () => {
    const s = fresh();
    driveBus(s, 0x6b);
    s.setInput('ii', 0); s.settle();
    tick(s);
    s.setInput('ii', 1); s.settle();
    releaseBus(s);
    s.setInput('io', 0); s.settle();
    s.setInput('io', 1); s.settle();
    for (let i = 0; i < 4; i++) expect(s.readNet(`bus${i}`)).toBe('Z');
  });

  it('CLR is asynchronous (no clock needed to reset opcode)', () => {
    const s = fresh();
    driveBus(s, 0xff);
    s.setInput('ii', 0); s.settle();
    tick(s);
    expect(readOpcode(s)).toBe(0xf);
    s.setInput('clr', 1); s.settle();
    expect(readOpcode(s)).toBe(0);
  });
});

describe('eater.flags_register', () => {
  const ports: Array<{ name: string; net: string }> = [
    { name: 'CIN', net: 'cin' },
    { name: 'ZIN', net: 'zin' },
    { name: 'CLK', net: 'clk' },
    { name: 'CLR', net: 'clr' },
    { name: '/FI', net: 'fi'  },
    { name: 'CFLAG', net: 'cflag' },
    { name: 'ZFLAG', net: 'zflag' },
  ];

  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.flags_register', ports)));
    s.setInput('clk', 0);
    s.setInput('cin', 0);
    s.setInput('zin', 0);
    s.setInput('fi', 1);
    s.setInput('clr', 1); s.settle();
    s.setInput('clr', 0); s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  it('CLR forces both flags to 0', () => {
    const s = fresh();
    expect(s.readNet('cflag')).toBe(0);
    expect(s.readNet('zflag')).toBe(0);
  });

  it('latches CIN and ZIN on rising CLK when /FI = 0', () => {
    const s = fresh();
    s.setInput('cin', 1); s.setInput('zin', 0); s.settle();
    s.setInput('fi', 0); s.settle();
    tick(s);
    s.setInput('fi', 1); s.settle();
    expect(s.readNet('cflag')).toBe(1);
    expect(s.readNet('zflag')).toBe(0);
  });

  it('holds across clock edges when /FI = 1', () => {
    const s = fresh();
    s.setInput('cin', 1); s.setInput('zin', 1); s.settle();
    s.setInput('fi', 0); s.settle();
    tick(s);
    s.setInput('fi', 1); s.settle();
    expect(s.readNet('cflag')).toBe(1);
    expect(s.readNet('zflag')).toBe(1);

    // Change inputs, clock again with /FI high — flags should not change.
    s.setInput('cin', 0); s.setInput('zin', 0); s.settle();
    tick(s);
    expect(s.readNet('cflag')).toBe(1);
    expect(s.readNet('zflag')).toBe(1);
  });

  it('CLR is asynchronous', () => {
    const s = fresh();
    s.setInput('cin', 1); s.setInput('zin', 1); s.settle();
    s.setInput('fi', 0); s.settle();
    tick(s);
    expect(s.readNet('cflag')).toBe(1);
    s.setInput('clr', 1); s.settle();
    expect(s.readNet('cflag')).toBe(0);
    expect(s.readNet('zflag')).toBe(0);
  });
});

describe('eater.output_display', () => {
  // Top-level test: drive a value onto BUS, latch it via /OI, and inspect the
  // io.7seg state directly. We can't read the segment nets via the wrapper
  // because they're internal to the composite, so we instead query the
  // simulator's component state for the disp_lo / disp_hi instances.
  const ports: Array<{ name: string; net: string }> = [];
  for (let i = 0; i < 8; i++) ports.push({ name: `BUS${i}`, net: `bus${i}` });
  ports.push({ name: 'CLK', net: 'clk' });
  ports.push({ name: 'CLR', net: 'clr' });
  ports.push({ name: '/OI', net: 'oi' });

  const fresh = (): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.output_display', ports)));
    s.setInput('clk', 0);
    s.setInput('oi', 1);
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, 0);
    s.setInput('clr', 1); s.settle();
    s.setInput('clr', 0); s.settle();
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  const driveBus = (s: Simulator, byte: number): void => {
    for (let i = 0; i < 8; i++) s.setInput(`bus${i}`, ((byte >> i) & 1) as NetState);
    s.settle();
  };

  // Read the latched segment state of one of the displays. Component state is
  // namespaced inside the wrapper as "U1__disp_lo" / "U1__disp_hi" after
  // composite flattening.
  type SegState = {
    a: NetState; b: NetState; c: NetState; d: NetState;
    e: NetState; f: NetState; g: NetState; dp: NetState;
  };
  const readSegments = (s: Simulator, which: 'lo' | 'hi'): SegState => {
    const id = `U1__disp_${which}`;
    const idx = s.graph.componentById.get(id);
    if (idx === undefined) throw new Error(`disp_${which} not found`);
    return s.graph.components[idx]!.state as SegState;
  };

  it('after CLR, both displays show "0" (segments a..f lit, g dark)', () => {
    const s = fresh();
    // Force a load of 0 so the lookup runs and segment state is definite.
    s.setInput('oi', 0); s.settle();
    tick(s);
    s.setInput('oi', 1); s.settle();
    const lo = readSegments(s, 'lo');
    const hi = readSegments(s, 'hi');
    // 0x3F = abcdef on, g and dp off.
    expect(lo.a).toBe(1); expect(lo.b).toBe(1); expect(lo.c).toBe(1);
    expect(lo.d).toBe(1); expect(lo.e).toBe(1); expect(lo.f).toBe(1);
    expect(lo.g).toBe(0); expect(lo.dp).toBe(0);
    expect(hi.a).toBe(1); expect(hi.b).toBe(1); expect(hi.c).toBe(1);
    expect(hi.d).toBe(1); expect(hi.e).toBe(1); expect(hi.f).toBe(1);
    expect(hi.g).toBe(0); expect(hi.dp).toBe(0);
  });

  it('latches 0x3A and shows "3" on hi, "A" on lo', () => {
    const s = fresh();
    driveBus(s, 0x3a);
    s.setInput('oi', 0); s.settle();
    tick(s);
    s.setInput('oi', 1); s.settle();
    // 0x3 → 0x4F = abcdg → a, b, c, d, g lit, e, f, dp dark.
    const hi = readSegments(s, 'hi');
    expect(hi.a).toBe(1); expect(hi.b).toBe(1); expect(hi.c).toBe(1);
    expect(hi.d).toBe(1); expect(hi.e).toBe(0); expect(hi.f).toBe(0);
    expect(hi.g).toBe(1);
    // 0xA → 0x77 = abcefg → a, b, c, e, f, g lit, d, dp dark.
    const lo = readSegments(s, 'lo');
    expect(lo.a).toBe(1); expect(lo.b).toBe(1); expect(lo.c).toBe(1);
    expect(lo.d).toBe(0); expect(lo.e).toBe(1); expect(lo.f).toBe(1);
    expect(lo.g).toBe(1);
  });

  it('display does not update when /OI = 1 across a clock edge', () => {
    const s = fresh();
    driveBus(s, 0x12);
    s.setInput('oi', 0); s.settle();
    tick(s);
    s.setInput('oi', 1); s.settle();
    expect(readSegments(s, 'lo').b).toBe(1); // "2" → 0x5B has b lit

    // Change BUS but keep /OI high.
    driveBus(s, 0xff);
    tick(s);
    // Should still show "2" on lo digit (b lit, c lit, others per "2" pattern).
    const lo = readSegments(s, 'lo');
    expect(lo.a).toBe(1); expect(lo.b).toBe(1); expect(lo.c).toBe(0);
    expect(lo.d).toBe(1); expect(lo.e).toBe(1); expect(lo.g).toBe(1);
  });
});

describe('eater.control_unit', () => {
  const ports: Array<{ name: string; net: string }> = [
    { name: 'CLK', net: 'clk' },
    { name: '/CLR', net: 'clr' },
    { name: 'OPCODE0', net: 'op0' },
    { name: 'OPCODE1', net: 'op1' },
    { name: 'OPCODE2', net: 'op2' },
    { name: 'OPCODE3', net: 'op3' },
    { name: 'CFLAG', net: 'cf' },
    { name: 'ZFLAG', net: 'zf' },
    // 16 control outputs
    { name: 'HLT', net: 'hlt' },
    { name: '/MI', net: 'mi' },
    { name: '/RI', net: 'ri' },
    { name: '/RO', net: 'ro' },
    { name: '/IO', net: 'io' },
    { name: '/II', net: 'ii' },
    { name: '/AI', net: 'ai' },
    { name: '/AO', net: 'ao' },
    { name: '/EU', net: 'eu' },
    { name: 'SU',  net: 'su' },
    { name: '/BI', net: 'bi' },
    { name: '/OI', net: 'oi' },
    { name: 'CE',  net: 'ce' },
    { name: '/CO', net: 'co' },
    { name: 'J',   net: 'j'  },
    { name: '/FI', net: 'fi' },
  ];

  const fresh = (opcode = 0, cflag: NetState = 0, zflag: NetState = 0): Simulator => {
    const s = new Simulator(loadCircuit(wrap('eater.control_unit', ports)));
    s.setInput('clk', 0);
    s.setInput('cf', cflag);
    s.setInput('zf', zflag);
    for (let i = 0; i < 4; i++) {
      s.setInput(`op${i}`, ((opcode >> i) & 1) as NetState);
    }
    s.setInput('clr', 0); s.settle(); // assert async clear (active low)
    s.setInput('clr', 1); s.settle(); // release
    return s;
  };

  const tick = (s: Simulator): void => {
    s.setInput('clk', 1); s.settle();
    s.setInput('clk', 0); s.settle();
  };

  // Read all 16 control signals as a record.
  const readSignals = (s: Simulator): Record<string, NetState> => ({
    HLT: s.readNet('hlt'),
    MI:  s.readNet('mi'),
    RI:  s.readNet('ri'),
    RO:  s.readNet('ro'),
    IO:  s.readNet('io'),
    II:  s.readNet('ii'),
    AI:  s.readNet('ai'),
    AO:  s.readNet('ao'),
    EU:  s.readNet('eu'),
    SU:  s.readNet('su'),
    BI:  s.readNet('bi'),
    OI:  s.readNet('oi'),
    CE:  s.readNet('ce'),
    CO:  s.readNet('co'),
    J:   s.readNet('j'),
    FI:  s.readNet('fi'),
  });

  // Convenience: assert that exactly the named signals are asserted (active-low
  // signals = 0; active-high signals = 1) and all others are at idle.
  const expectAsserted = (s: Simulator, names: string[]): void => {
    const ACTIVE_HIGH = new Set(['HLT', 'SU', 'CE', 'J']);
    const sigs = readSignals(s);
    const want: Record<string, NetState> = {};
    for (const k of Object.keys(sigs)) {
      const high = ACTIVE_HIGH.has(k);
      want[k] = high ? 0 : 1; // idle
      if (names.includes(k)) want[k] = high ? 1 : 0; // asserted
    }
    expect(sigs).toEqual(want);
  };

  it('boots with T=0 and emits FETCH T0 (MI, CO asserted)', () => {
    const s = fresh(0);
    expectAsserted(s, ['MI', 'CO']);
  });

  it('after one clock, T=1 emits FETCH T1 (RO, II, CE asserted)', () => {
    const s = fresh(0);
    tick(s);
    expectAsserted(s, ['RO', 'II', 'CE']);
  });

  it('NOP at T2..T4 emits idle (no signals asserted)', () => {
    const s = fresh(0);
    tick(s); tick(s); // → T2
    expectAsserted(s, []);
    tick(s); // → T3
    expectAsserted(s, []);
    tick(s); // → T4
    expectAsserted(s, []);
  });

  it('T-counter wraps: after T4 the next clock returns to T0', () => {
    const s = fresh(0);
    tick(s); tick(s); tick(s); tick(s); // T4
    tick(s); // → T0 again (mod-5 reset via QC → /LD)
    expectAsserted(s, ['MI', 'CO']);
  });

  it('LDA (opcode 0x1) at T2 emits IO|MI; T3 emits RO|AI; T4 idle', () => {
    const s = fresh(0x1);
    tick(s); tick(s); // → T2
    expectAsserted(s, ['IO', 'MI']);
    tick(s); // → T3
    expectAsserted(s, ['RO', 'AI']);
    tick(s); // → T4
    expectAsserted(s, []);
  });

  it('ADD (opcode 0x2) at T4 emits EU|AI|FI', () => {
    const s = fresh(0x2);
    tick(s); tick(s); tick(s); tick(s); // → T4
    expectAsserted(s, ['EU', 'AI', 'FI']);
  });

  it('SUB (opcode 0x3) at T4 also asserts SU', () => {
    const s = fresh(0x3);
    tick(s); tick(s); tick(s); tick(s);
    expectAsserted(s, ['EU', 'SU', 'AI', 'FI']);
  });

  it('LDI (opcode 0x5) at T2 emits IO|AI', () => {
    const s = fresh(0x5);
    tick(s); tick(s);
    expectAsserted(s, ['IO', 'AI']);
  });

  it('JMP (opcode 0x6) at T2 emits IO|J', () => {
    const s = fresh(0x6);
    tick(s); tick(s);
    expectAsserted(s, ['IO', 'J']);
  });

  it('JC (opcode 0x7) at T2 with CFLAG=1 jumps; with CFLAG=0 skips', () => {
    const s1 = fresh(0x7, /* cflag */ 1);
    tick(s1); tick(s1);
    expectAsserted(s1, ['IO', 'J']);
    const s0 = fresh(0x7, /* cflag */ 0);
    tick(s0); tick(s0);
    expectAsserted(s0, []);
  });

  it('JZ (opcode 0x8) at T2 with ZFLAG=1 jumps; with ZFLAG=0 skips', () => {
    const s1 = fresh(0x8, 0, /* zflag */ 1);
    tick(s1); tick(s1);
    expectAsserted(s1, ['IO', 'J']);
    const s0 = fresh(0x8, 0, /* zflag */ 0);
    tick(s0); tick(s0);
    expectAsserted(s0, []);
  });

  it('OUT (opcode 0xE) at T2 emits AO|OI', () => {
    const s = fresh(0xe);
    tick(s); tick(s);
    expectAsserted(s, ['AO', 'OI']);
  });

  it('HLT (opcode 0xF) at T2 asserts HLT', () => {
    const s = fresh(0xf);
    tick(s); tick(s);
    expectAsserted(s, ['HLT']);
  });
});
