import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CircuitJSON, NetState } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import '../src/engine/primitives/index';
import { Simulator } from '../src/engine/sim';

const here = dirname(fileURLToPath(import.meta.url));
const circuitPath = resolve(here, '..', 'examples', 'ripple_adder_4bit.json');
const json = JSON.parse(readFileSync(circuitPath, 'utf8')) as CircuitJSON;

const graph = loadCircuit(json);
const sim = new Simulator(graph);

const bit = (n: number, i: number): NetState => (((n >> i) & 1) === 1 ? 1 : 0);

const drive = (a: number, b: number, cin: 0 | 1): void => {
  for (let i = 0; i < 4; i++) {
    sim.setInput(`a${i}`, bit(a, i));
    sim.setInput(`b${i}`, bit(b, i));
  }
  sim.setInput('cin', cin);
  sim.settle();
};

const readSum = (): number => {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const v = sim.readNet(`s${i}`);
    if (v !== 0 && v !== 1) throw new Error(`s${i}=${String(v)} (not strong)`);
    s |= v << i;
  }
  const cout = sim.readNet('cout');
  if (cout !== 0 && cout !== 1) throw new Error(`cout=${String(cout)}`);
  s |= cout << 4;
  return s;
};

let failures = 0;
for (let a = 0; a < 16; a++) {
  for (let b = 0; b < 16; b++) {
    drive(a, b, 0);
    const got = readSum();
    const want = a + b;
    if (got !== want) {
      process.stderr.write(`FAIL a=${a} b=${b}: got=${got} want=${want}\n`);
      failures++;
    }
  }
}

if (sim.events.length > 0) {
  for (const ev of sim.events) {
    process.stderr.write(`EVENT step=${ev.step} ${ev.kind}: ${ev.detail}\n`);
  }
  process.exit(1);
}

if (failures > 0) {
  process.stderr.write(`\n${failures} / 256 combinations failed\n`);
  process.exit(1);
}

process.stdout.write('PASS 256/256 input combinations\n');
