import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CircuitJSON, NetState } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import '../src/engine/primitives/index';
import { Simulator } from '../src/engine/sim';

const here = dirname(fileURLToPath(import.meta.url));
const circuitPath = resolve(here, '..', 'examples', 'nand_latch.json');
const json = JSON.parse(readFileSync(circuitPath, 'utf8')) as CircuitJSON;

const graph = loadCircuit(json);
const sim = new Simulator(graph);

type Drive = Array<readonly [string, NetState]>;

const sequence: Array<{ label: string; drive: Drive }> = [
  { label: 'init',     drive: [] },
  { label: 'idle',     drive: [['n_S', 1], ['n_R', 1]] },
  { label: 'set',      drive: [['n_S', 0]] },
  { label: 'hold-set', drive: [['n_S', 1]] },
  { label: 'reset',    drive: [['n_R', 0]] },
  { label: 'hold-rst', drive: [['n_R', 1]] },
];

const watch = ['n_S', 'n_R', 'n_Q', 'n_Qn'];

const fmt = (v: NetState): string => (typeof v === 'number' ? String(v) : v);

let stepNo = 0;
for (const { label, drive } of sequence) {
  for (const [net, value] of drive) sim.setInput(net, value);
  sim.settle();
  const cells = watch.map((id) => {
    const net = graph.nets[graph.netById.get(id)!]!;
    return `${net.name}=${fmt(sim.readNet(id))}`;
  });
  process.stdout.write(`step=${stepNo} ${label.padEnd(8)} ${cells.join(' ')}\n`);
  stepNo++;
}

if (sim.events.length > 0) {
  for (const ev of sim.events) {
    process.stderr.write(`EVENT step=${ev.step} ${ev.kind}: ${ev.detail}\n`);
  }
  process.exit(1);
}
