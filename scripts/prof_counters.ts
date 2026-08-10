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

const counters = { iter: 0, eval: 0, settle: 0, maxIter: 0 };
const origSettle = Simulator.prototype.settle;
Simulator.prototype.settle = function(this: any) {
  const self = this;
  let iter = 0;
  let now = self.dirtyA, next = self.dirtyB;
  self.contendedThisSettle.clear();
  const ctx = { step: self.step, rateHz: self.rateHz };
  while (now.length > 0) {
    counters.iter++;
    if (now.length > counters.maxIter) counters.maxIter = now.length;
    counters.eval += now.length;
    if (iter++ >= self.maxIterations) { self.recordOscillation(now, next); self.step++; return; }
    const components = self.graph.components, nets = self.graph.nets;
    for (let i = 0; i < now.length; i++) {
      const compIdx = now[i];
      const comp = components[compIdx];
      const inputBuf = comp.inputBuf, inputNetIdx = comp.inputNetIdx, inputIsLogic = comp.inputIsLogic;
      const inputCount = inputBuf.length;
      for (let j = 0; j < inputCount; j++) {
        const netVal = nets[inputNetIdx[j]].value;
        inputBuf[j] = inputIsLogic[j] === 1 ? (netVal === 'Z' ? 'X' : netVal) : netVal;
      }
      const ns = comp.primitive.evaluate(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx);
      if (ns !== undefined) comp.state = ns;
    }
    const netChanged = self.netChanged, changedQueue = self.changedNetsQueue;
    changedQueue.length = 0;
    for (let i = 0; i < now.length; i++) {
      const compIdx = now[i];
      const comp = components[compIdx];
      const proposedBuf = comp.proposedBuf, outputBuf = comp.outputBuf, outputNetIdx = comp.outputNetIdx;
      for (let j = 0; j < proposedBuf.length; j++) {
        const newVal = proposedBuf[j];
        if (outputBuf[j] !== newVal) {
          outputBuf[j] = newVal;
          const netIdx = outputNetIdx[j];
          if (!netChanged[netIdx]) { netChanged[netIdx]=1; changedQueue.push(netIdx); }
        }
      }
      self.inDirty[compIdx] = 0;
    }
    now.length = 0;
    for (let q = 0; q < changedQueue.length; q++) {
      const netIdx = changedQueue[q];
      netChanged[netIdx]=0;
      const net = nets[netIdx];
      const newValue = self.computeNetValue(net, netIdx);
      if (newValue === net.value) continue;
      net.value = newValue;
      const listeners = net.listenerComps;
      for (let k = 0; k < listeners.length; k++) {
        const comp = listeners[k];
        if (self.inDirty[comp]) continue;
        next.push(comp); self.inDirty[comp]=1;
      }
    }
    const tmp = now; now = next; next = tmp;
  }
  self.dirtyA = now; self.dirtyB = next; self.step++;
};
Simulator.prototype.tick = function(this: any) {
  counters.settle++;
  for (const compIdx of this.tickActive) this.markDirty(compIdx);
  this.settle();
};

const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset','Y',1);
sim.settle();
for (let i=0;i<1000;i++) sim.tick();
console.log('settles', counters.settle, 'iters', counters.iter, 'evals', counters.eval, 'maxIterPerSettle', counters.maxIter);
console.log('avg iter/settle', (counters.iter/counters.settle).toFixed(2));
console.log('avg eval/settle', (counters.eval/counters.settle).toFixed(2));
console.log('avg eval/iter', (counters.eval/counters.iter).toFixed(2));
