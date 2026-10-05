// Verify an unchanged actual UI-exported checkpoint with independent oracles.
// The small harnesses below are headless checks, not manual editor actions.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import '../src/engine/index';
import type { CircuitJSON, NetState } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';

const path = process.argv[2]; if (!path) throw new Error('Pass the actual saved manual checkpoint JSON path');
const exact = fs.readFileSync(path, 'utf8'); const saved = JSON.parse(exact) as CircuitJSON;
const results: Array<{ chip: string; checks: number; runtimeLeaves: number }> = [];
function harness(name: string) {
  const def = saved.definitions?.find((d) => d.name === `user.${name}`); if (!def) return null;
  const json: CircuitJSON = { version: 1, kind: 'circuit', name: 'headless_oracle_harness', definitions: saved.definitions, components: [{ id: 'dut', type: def.name }], nets: def.ports!.map((p) => ({ id: p.name, endpoints: [`dut.${p.name}`] })) };
  const graph = loadCircuit(json); const sim = new Simulator(graph); sim.settle();
  let checks = 0;
  const force = (inputs: Record<string, NetState>): void => { for (const [p, v] of Object.entries(inputs)) sim.setInput(p, v); sim.settle(); };
  const assert = (p: string, expected: NetState): void => {
    const actual = sim.readNet(p); if (actual !== expected) throw new Error(`${name}.${p}: expected ${expected}, got ${actual}, check ${checks}`); checks++;
  };
  const finish = (): void => { if (sim.events.some((e) => e.kind === 'oscillation')) throw new Error(`${name}: oscillation`); results.push({ chip: name, checks, runtimeLeaves: graph.components.length }); };
  return { force, assert, finish, sim };
}
for (const [name, oracle] of [
  ['Nand', (a: number, b: number) => 1 - (a & b)], ['And', (a: number, b: number) => a & b],
  ['Or', (a: number, b: number) => a | b], ['Xor', (a: number, b: number) => a ^ b],
] as const) {
  const h = harness(name); if (!h) continue;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) { h.force({ A: a as NetState, B: b as NetState }); h.assert('Y', oracle(a, b) as NetState); }
  h.finish();
}
{
  const h = harness('Not'); if (h) { for (const input of [0, 1, 'Z', 'X'] as NetState[]) { h.force({ A: input }); h.assert('Y', input === 0 ? 1 : input === 1 ? 0 : 'X'); } h.finish(); }
}
{
  const h = harness('Mux'); if (h) { for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let s = 0; s < 2; s++) { h.force({ A: a as NetState, B: b as NetState, S: s as NetState }); h.assert('Y', (s ? b : a) as NetState); } h.finish(); }
}
for (const name of ['HalfAdder', 'FullAdder']) {
  const h = harness(name); if (!h) continue;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < (name === 'HalfAdder' ? 1 : 2); c++) {
    h.force({ A: a as NetState, B: b as NetState, ...(name === 'FullAdder' ? { Cin: c as NetState } : {}) });
    const sum = a + b + c; h.assert('Sum', (sum & 1) as NetState); h.assert(name === 'HalfAdder' ? 'Carry' : 'Cout', (sum >> 1) as NetState);
  } h.finish();
}
{
  const h = harness('RegisterBit'); if (h) {
    h.force({ CLR: 0, CLK: 0, EN: 1, D: 1 }); h.assert('Q', 0);
    h.force({ CLR: 1, CLK: 1 }); h.assert('Q', 1);
    h.force({ D: 0 }); h.assert('Q', 1);
    h.force({ CLK: 0, EN: 0 }); h.force({ CLK: 1 }); h.assert('Q', 1);
    h.force({ CLK: 0, EN: 1 }); h.force({ CLK: 1 }); h.assert('Q', 0);
    h.force({ D: 1, CLK: 0 }); h.force({ CLK: 1 }); h.assert('Q', 1);
    h.force({ CLR: 0 }); h.assert('Q', 0); h.finish();
  }
}
{
  const h = harness('Register4'); if (h) {
    h.force({ CLR: 0, CLK: 0, EN: 1 }); for (let bit = 0; bit < 4; bit++) h.assert(`Q${bit}`, 0);
    h.force({ CLR: 1 });
    for (let value = 0; value < 16; value++) {
      h.force({ CLK: 0, ...Object.fromEntries(Array.from({ length: 4 }, (_, bit) => [`D${bit}`, ((value >> bit) & 1) as NetState])) }); h.force({ CLK: 1 });
      for (let bit = 0; bit < 4; bit++) h.assert(`Q${bit}`, ((value >> bit) & 1) as NetState);
    }
    h.force({ CLK: 0, EN: 0, D0: 0, D1: 0, D2: 0, D3: 0 }); h.force({ CLK: 1 });
    for (let bit = 0; bit < 4; bit++) h.assert(`Q${bit}`, 1);
    h.force({ CLR: 0 }); for (let bit = 0; bit < 4; bit++) h.assert(`Q${bit}`, 0); h.finish();
  }
}
for (const name of ['Mux4', 'Adder4']) {
  const h = harness(name); if (!h) continue;
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let control = 0; control < 2; control++) {
    const inputs: Record<string, NetState> = { [name === 'Mux4' ? 'S' : 'Cin']: control as NetState };
    for (let bit = 0; bit < 4; bit++) { inputs[`A${bit}`] = ((a >> bit) & 1) as NetState; inputs[`B${bit}`] = ((b >> bit) & 1) as NetState; }
    h.force(inputs); const result = name === 'Mux4' ? (control ? b : a) : a + b + control;
    for (let bit = 0; bit < 4; bit++) h.assert(`${name === 'Mux4' ? 'Y' : 'S'}${bit}`, ((result >> bit) & 1) as NetState);
    if (name === 'Adder4') h.assert('Cout', (result >> 4) as NetState);
  } h.finish();
}
console.log(JSON.stringify({ source: path, sha256: createHash('sha256').update(exact).digest('hex'), provenance: 'Unchanged actual visible editor checkpoint; checks are separate headless harnesses against independent integer oracles', checks: results.reduce((n, r) => n + r.checks, 0), results }, null, 2));
