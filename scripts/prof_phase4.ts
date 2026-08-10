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

const P = { fillNS: 0n, evalNS: 0n, commitNS: 0n, resolveNS: 0n, tickNS: 0n };
const C = { evals: 0, eval2: 0, resolves: 0, wakeiter: 0, changedNetIter: 0 };
const hrt = () => process.hrtime.bigint();

const origSettle = Simulator.prototype.settle;
Simulator.prototype.settle = function(this: any) {
  const self = this;
  let iter = 0;
  let now = self.dirtyA, next = self.dirtyB;
  let t = 0n;
  self.contendedThisSettle.clear();
  const ctx = { step: self.step, rateHz: self.rateHz };
  while (now.length > 0) {
    if (iter++ >= self.maxIterations) { self.recordOscillation(now, next); self.step++; return; }
    const components = self.graph.components, nets = self.graph.nets;
    t = hrt();
    for (let i = 0; i < now.length; i++) {
      const compIdx = now[i];
      const comp = components[compIdx];
      const inputBuf = comp.inputBuf, inputNetIdx = comp.inputNetIdx, inputIsLogic = comp.inputIsLogic;
      const inputCount = inputBuf.length;
      for (let j = 0; j < inputCount; j++) {
        const netVal = nets[inputNetIdx[j]].value;
        inputBuf[j] = inputIsLogic[j] === 1 ? (netVal === 'Z' ? 'X' : netVal) : netVal;
      }
      C.evals++;
    }
    P.fillNS += hrt() - t; t = hrt();
    for (let i = 0; i < now.length; i++) {
      const compIdx = now[i];
      const comp = components[compIdx];
      C.eval2++;
      const ns = comp.primitive.evaluate(comp.inputBuf, comp.proposedBuf, comp.state, comp.params, ctx);
      if (ns !== undefined) comp.state = ns;
    }
    P.evalNS += hrt() - t; t = hrt();
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
    P.evalNS += hrt() - t; t = hrt();
    for (let q = 0; q < changedQueue.length; q++) {
      const netIdx = changedQueue[q];
      netChanged[netIdx]=0;
      const net = nets[netIdx];
      C.resolves++;
      const newValue = self.computeNetValue(net, netIdx);
      if (newValue === net.value) continue;
      net.value = newValue;
      const listeners = net.listenerComps;
      for (let k = 0; k < listeners.length; k++) {
        C.wakeiter++;
        const comp = listeners[k];
        if (self.inDirty[comp]) continue;
        next.push(comp); self.inDirty[comp]=1;
      }
    }
    P.commitNS += hrt() - t; t = hrt();
    const tmp = now; now = next; next = tmp;
  }
  P.resolveNS += hrt() - t;
  self.dirtyA = now; self.dirtyB = next; self.step++;
};
Simulator.prototype.tick = function(this: any) {
  const t = hrt();
  for (const compIdx of this.tickActive) this.markDirty(compIdx);
  P.tickNS += hrt() - t;
  this.settle();
};

const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset','Y',1);
sim.settle();
const ITERS = 100000;
for (let i=0;i<50000;i++) sim.tick();
for (const k in P) (P as any)[k] = 0n;
for (const k in C) (C as any)[k] = 0;
const t0 = hrt();
for (let i=0;i<ITERS;i++) sim.tick();
const tot = Number(hrt() - t0);
const ms = (x: bigint) => (Number(x)/1e6).toFixed(1);
console.log('total', (tot/1e6).toFixed(1), 'ms', 'ticks/s', (ITERS/(tot/1e6)*1000).toFixed(0));
console.log('fill', ms(P.fillNS), 'ms  eval ', ms(P.evalNS), 'ms  commit ', ms(P.commitNS), 'ms  resolve+swap', ms(P.resolveNS), 'ms');
const accounted = Number(P.fillNS+P.evalNS+P.commitNS+P.resolveNS+P.tickNS);
console.log('accounted', (accounted/1e6).toFixed(1), '/', (tot/1e6).toFixed(1), '=', (accounted/tot*100).toFixed(0)+'%');
console.log('per tick: evals', (C.evals/ITERS).toFixed(1), 'resolves', (C.resolves/ITERS).toFixed(1), 'wakeiter', (C.wakeiter/ITERS).toFixed(1));
