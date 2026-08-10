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

const sizes: number[][] = [];
const origSettle = Simulator.prototype.settle;
Simulator.prototype.settle = function(this: any) {
  const self = this;
  let iter = 0;
  let now = self.dirtyA, next = self.dirtyB;
  self.contendedThisSettle.clear();
  const ctx = { step: self.step, rateHz: self.rateHz };
  while (now.length > 0) {
    if (iter >= self.maxIterations) { self.recordOscillation(now, next); self.step++; return; }
    if (sizes[iter] === undefined) sizes[iter] = [0,0,0];
    sizes[iter][0]++; sizes[iter][1] += now.length;
    if (now.length > sizes[iter][2]) sizes[iter][2] = now.length;
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
    iter++;
  }
  self.dirtyA = now; self.dirtyB = next; self.step++;
};
Simulator.prototype.tick = function(this: any) {
  for (const compIdx of this.tickActive) this.markDirty(compIdx);
  this.settle();
};

const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset','Y',1);
sim.settle();
for (let i=0;i<1000;i++) sim.tick();
console.log('iteration index | count | avg size | max size');
sizes.forEach((s,i)=>{ if(s && s[0]>0) console.log(i, s[0], (s[1]/s[0]).toFixed(2), s[2]); });
