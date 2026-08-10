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

const P = { fillNS: 0n, evalNS: 0n, commitNS: 0n, resolveNS: 0n, wakeNS: 0n, loopNS: 0n, tickNS: 0n };
const C = { evals: 0, fills: 0, commits: 0, resolves: 0, wakes: 0, netchanged: 0, outchanged: 0 };
const hrt = () => process.hrtime.bigint();
const delta = (a: bigint) => Number(hrt() - a);

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
    let t = hrt();
    for (let i = 0; i < now.length; i++) {
      const compIdx = now[i];
      const comp = components[compIdx];
      const inputBuf = comp.inputBuf, inputNetIdx = comp.inputNetIdx, inputIsLogic = comp.inputIsLogic;
      const inputCount = inputBuf.length;
      C.fills += inputCount;
      for (let j = 0; j < inputCount; j++) {
        const netVal = nets[inputNetIdx[j]].value;
        inputBuf[j] = inputIsLogic[j] === 1 ? (netVal === 'Z' ? 'X' : netVal) : netVal;
      }
      const ns = comp.primitive.evaluate(inputBuf, comp.proposedBuf, comp.state, comp.params, ctx);
      if (ns !== undefined) comp.state = ns;
      C.evals++;
    }
    P.fillNS += hrt() - t; t = hrt();
    const netChanged = self.netChanged, changedQueue = self.changedNetsQueue;
    changedQueue.length = 0;
    for (let i = 0; i < now.length; i++) {
      const compIdx = now[i];
      const comp = components[compIdx];
      const proposedBuf = comp.proposedBuf, outputBuf = comp.outputBuf, outputNetIdx = comp.outputNetIdx;
      for (let j = 0; j < proposedBuf.length; j++) {
        C.commits++;
        const newVal = proposedBuf[j];
        if (outputBuf[j] !== newVal) {
          outputBuf[j] = newVal;
          C.outchanged++;
          const netIdx = outputNetIdx[j];
          if (!netChanged[netIdx]) { netChanged[netIdx]=1; changedQueue.push(netIdx); C.netchanged++; }
        }
      }
      self.inDirty[compIdx] = 0;
    }
    now.length = 0;
    P.commitNS += hrt() - t; t = hrt();
    for (let q = 0; q < changedQueue.length; q++) {
      const netIdx = changedQueue[q];
      netChanged[netIdx]=0;
      const net = nets[netIdx];
      const newValue = self.computeNetValue(net, netIdx);
      C.resolves++;
      if (newValue === net.value) continue;
      net.value = newValue;
      const listeners = net.listenerComps;
      for (let k = 0; k < listeners.length; k++) {
        C.wakes++;
        const comp = listeners[k];
        if (self.inDirty[comp]) continue;
        next.push(comp); self.inDirty[comp]=1;
      }
    }
    P.resolveNS += hrt() - t;
    const tmp = now; now = next; next = tmp;
  }
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
for (let i=0;i<50000;i++) sim.tick(); // warm JIT
for (const k in P) (P as any)[k] = 0n;
for (const k in C) (C as any)[k] = 0;
const t0 = hrt();
for (let i=0;i<ITERS;i++) sim.tick();
const tot = Number(hrt() - t0);
const ms = (x: bigint) => (Number(x)/1e6).toFixed(1);
console.log('total', (tot/1e6).toFixed(1), 'ms', 'ticks/s', (ITERS/(tot/1e6)*1000).toFixed(0));
console.log('fill   ', ms(P.fillNS), 'ms  eval   ', ms(P.evalNS), 'ms  commit ', ms(P.commitNS), 'ms');
console.log('resolve', ms(P.resolveNS), 'ms  tick-mk', ms(P.tickNS), 'ms');
const accounted = Number(P.fillNS+P.evalNS+P.commitNS+P.resolveNS+P.tickNS);
console.log('accounted', (accounted/1e6).toFixed(1), 'ms  of', (tot/1e6).toFixed(1), ' -> ', (accounted/tot*100).toFixed(0)+'%');
console.log('per tick: evals', (C.evals/ITERS).toFixed(1), 'fills', (C.fills/ITERS).toFixed(1), 'commits', (C.commits/ITERS).toFixed(1), 'outchanged', (C.outchanged/ITERS).toFixed(1), 'resolves', (C.resolves/ITERS).toFixed(1), 'wakes', (C.wakes/ITERS).toFixed(1));
