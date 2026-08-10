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

const phase = { fill: 0, eval: 0, commit: 0, resolve: 0, other: 0, netResolveCalls: 0, netAdds: 0, listenerWake: 0 };
const start = () => performance.now();
const origSettle = Simulator.prototype.settle;
Simulator.prototype.settle = function(this: any) {
  const self = this;
  let iter = 0;
  let now = self.dirtyA, next = self.dirtyB;
  self.contendedThisSettle.clear();
  const ctx = { step: self.step, rateHz: self.rateHz };
  while (now.length > 0) {
    if (iter++ >= self.maxIterations) { self.recordOscillation(now, next); self.step++; return; }
    const components = self.graph.components, nets = self.graph.nets;
    let t = performance.now();
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
    phase.eval += performance.now() - t;
    t = performance.now();
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
    phase.commit += performance.now() - t;
    t = performance.now();
    for (let q = 0; q < changedQueue.length; q++) {
      const netIdx = changedQueue[q];
      netChanged[netIdx]=0;
      const net = nets[netIdx];
      phase.netResolveCalls++;
      const newValue = self.computeNetValue(net, netIdx);
      if (newValue === net.value) continue;
      net.value = newValue;
      const listeners = net.listenerComps;
      for (let k = 0; k < listeners.length; k++) {
        phase.listenerWake++;
        const comp = listeners[k];
        if (self.inDirty[comp]) continue;
        next.push(comp); self.inDirty[comp]=1;
      }
    }
    phase.resolve += performance.now() - t;
    const tmp = now; now = next; next = tmp;
  }
  self.dirtyA = now; self.dirtyB = next; self.step++;
};
Simulator.prototype.tick = function(this: any) {
  const t = performance.now();
  for (const compIdx of this.tickActive) this.markDirty(compIdx);
  phase.other += performance.now() - t;
  this.settle();
};

const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset','Y',1);
sim.settle();
const ITERS = 100000;
phase.fill = phase.eval = phase.commit = phase.resolve = phase.other = 0;
for (let i=0;i<10000;i++) sim.tick();
const t0 = performance.now();
for (let i=0;i<ITERS;i++) sim.tick();
const dt = performance.now() - t0;
console.log('tick  ', (ITERS/dt*1000).toFixed(0), 'ticks/s (instrumented)');
console.log('eval   ', (phase.eval).toFixed(1), 'ms');
console.log('commit ', (phase.commit).toFixed(1), 'ms');
console.log('resolve', (phase.resolve).toFixed(1), 'ms');
console.log('other  ', (phase.other).toFixed(1), 'ms');
console.log('netResolveCalls', phase.netResolveCalls, 'listenerWake', phase.listenerWake);
