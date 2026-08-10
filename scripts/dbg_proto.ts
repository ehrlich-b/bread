import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/engine/behavioral/index';
import '../src/engine/primitives/index';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';
import '../src/stdlib/index';
const here = dirname(fileURLToPath(import.meta.url));
const circuit = JSON.parse(readFileSync(resolve(here,'..','examples','ben_eater_8bit.json'),'utf8')) as CircuitJSON;

// Real sim on its own graph
const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset','Y',1);
sim.settle();

// Show a few control nets + their input sources
const gc = sim.graph;
for (const nid of ['ctl_ro','ctl_io','ctl_ii','ctl_ai','ctl_ao','ctl_eu','ctl_bi','ctl_bo']) {
  const idx = gc.netById.get(nid)!;
  const net = gc.nets[idx];
  console.log('\nnet', nid, 'value', net.value);
  for (const d of net.drivers) {
    const c = gc.components[d.comp];
    console.log('  driver', c.id, c.typeId, 'out', d.outIdx, 'params', JSON.stringify(c.params), 'outputBuf', JSON.stringify(c.outputBuf));
  }
}
