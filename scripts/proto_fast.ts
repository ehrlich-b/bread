// Prototype: int-encoded fast settle loop for the eater graph.
// Validates against the real Simulator, then measures throughput.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/engine/behavioral/index';
import '../src/engine/primitives/index';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';
import { decodeHexContents } from '../src/engine/behavioral/mem_28c16';
import '../src/stdlib/index';

const here = dirname(fileURLToPath(import.meta.url));
const circuit = JSON.parse(readFileSync(resolve(here,'..','examples','ben_eater_8bit.json'),'utf8')) as CircuitJSON;
const g = loadCircuit(circuit);
const nComp = g.components.length, nNet = g.nets.length;

// ---- encoding: net values: 0,1,2=Z,3=X ; driver values: +4=L,+5=H
const enc = { X: 3, Z: 2 };

// ---- per-component native metadata
const kindOf = new Int8Array(nComp);      // 1=NOT 2=NOR 3=MUX2 4=DFF 5=TRISTATE 6=AND 7=CONST 8=XOR 9=ADDER 10=MEM 11=CLOCK 12=7SEG 13=SWITCH
const flags = new Uint8Array(nComp);      // bit0 oeActiveLow, bit1 clrActiveLow, bit2 preActiveLow
const wArr = new Int16Array(nComp);       // width for MUX2/ADDER; input count for nary gates
const constVal = new Uint8Array(nComp);   // for CONST (0/1/4/5)
const nIn = new Int16Array(nComp), nOut = new Int16Array(nComp);
const memData = new Array(nComp);         // Uint8Array for MEM
const segData = new Array(nComp);         // Uint8Array(8) for 7SEG
const dq = new Uint8Array(nComp), dprev = new Uint8Array(nComp);
const switchY = new Uint8Array(nComp);
const clockHalf = new Float64Array(nComp);
const clkY = new Uint8Array(nComp); const clkT = new Float64Array(nComp);
const tickActive = [];

const inBuf = new Array(nComp), propBuf = new Array(nComp), outBuf = new Array(nComp);
let totalOut = 0;
for (let i = 0; i < nComp; i++) {
  const c = g.components[i];
  const t = c.typeId;
  nIn[i] = c.inputNetIdx.length;
  nOut[i] = c.outputNetIdx.length;
  inBuf[i] = new Uint8Array(nIn[i]).fill(3);
  propBuf[i] = new Uint8Array(nOut[i]).fill(2);
  outBuf[i] = new Uint8Array(nOut[i]).fill(2);
  const p = c.params as any;
  if (t === 'prim.NOT') kindOf[i] = 1;
  else if (t === 'prim.NOR') { kindOf[i] = 2; wArr[i] = nIn[i]; }
  else if (t === 'prim.AND') { kindOf[i] = 6; wArr[i] = nIn[i]; }
  else if (t === 'prim.XOR') { kindOf[i] = 8; wArr[i] = nIn[i]; }
  else if (t === 'prim.MUX2') { kindOf[i] = 3; wArr[i] = p.width; }
  else if (t === 'prim.ADDER') { kindOf[i] = 9; wArr[i] = p.width; }
  else if (t === 'prim.DFF') { kindOf[i] = 4; if (p.clrActiveLow) flags[i] |= 2; if (p.preActiveLow) flags[i] |= 4; dq[i] = 3; dprev[i] = 3; }
  else if (t === 'prim.TRISTATE') { kindOf[i] = 5; if (p.oeActiveLow) flags[i] |= 1; }
  else if (t === 'prim.CONST_0') { kindOf[i] = 7; constVal[i] = 0; }
  else if (t === 'prim.CONST_1') { kindOf[i] = 7; constVal[i] = 1; }
  else if (t === 'prim.PULLUP') { kindOf[i] = 7; constVal[i] = 5; }
  else if (t === 'prim.PULLDOWN') { kindOf[i] = 7; constVal[i] = 4; }
  else if (t === 'mem.6116' || t === 'mem.28C16') {
    kindOf[i] = 10;
    memData[i] = p.contents ? decodeHexContents(p.contents, 2048) : new Uint8Array(2048);
  }
  else if (t === 'io.7seg') { kindOf[i] = 12; segData[i] = new Uint8Array(8).fill(3); }
  else if (t === 'io.switch') { kindOf[i] = 13; switchY[i] = 0; }
  else if (t === 'gen.clock') { kindOf[i] = 11; clkY[i] = 0; clkT[i] = 0; const half = Math.round(1 / p.freqHz / 2); clockHalf[i] = half > 0 ? half : 1; totalOut++; }
  else throw new Error('unknown type ' + t + ' ' + c.id);
  if ((c.primitive as any).tickActive) tickActive.push(i);
}

// ---- flattened per-net driver/listener lists
const dc: number[] = [], doo: number[] = [], ll: number[] = [];
const ndOff = new Int32Array(nNet + 1), nlOff = new Int32Array(nNet + 1);
for (let i = 0; i < nNet; i++) {
  ndOff[i] = dc.length;
  for (const d of g.nets[i].drivers) { dc.push(d.comp); doo.push(d.outIdx); }
  nlOff[i] = ll.length;
  for (const l of g.nets[i].listenerComps) ll.push(l);
}
ndOff[nNet] = dc.length; nlOff[nNet] = ll.length;
const ndC = Int32Array.from(dc), ndO = Int32Array.from(doo), nl = Int32Array.from(ll);

const netV = new Uint8Array(nNet).fill(3);  // canonical encoded net values (init X)
const forced = new Uint8Array(nNet).fill(2); // encoded forced (Z = none)
const netChanged = new Uint8Array(nNet);
const inDirty = new Uint8Array(nComp);
const contended = new Uint8Array(nNet); // per-settle contention report
let dirtyA: number[] = [], dirtyB: number[] = [];
const changedQueue: number[] = [];

function markDirty(i: number) { if (!inDirty[i]) { dirtyA.push(i); inDirty[i] = 1; } }

// init: every comp dirty, netV = X
for (let i = 0; i < nComp; i++) dirtyA.push(i);
for (let i = 0; i < nComp; i++) inDirty[i] = 1;

const evalBuf3 = new Uint8Array(3);
const MAX_ITER = 10000;
let step = 0;
const events: any[] = [];

function resolveNetValue(netIdx: number): number {
  const s = ndOff[netIdx], e = ndOff[netIdx + 1];
  let strong = -1, strongConflict = 0, weak = -1, weakConflict = 0, sawX = 0;
  for (let k = s; k < e; k++) {
    const v = outBuf[ndC[k]][ndO[k]];
    if (v === 2) continue;
    if (v === 3) { sawX = 1; continue; }
    if (v === 4 || v === 5) {
      const w = v === 5 ? 1 : 0;
      if (weak < 0) weak = w; else if (weak !== w) weakConflict = 1;
      continue;
    }
    if (strong < 0) strong = v; else if (strong !== v) strongConflict = 1;
  }
  const f = forced[netIdx];
  if (f !== 2) {
    if (f === 4 || f === 5) { const w = f === 5 ? 1 : 0; if (weak < 0) weak = w; else if (weak !== w) weakConflict = 1; }
    else if (f === 0 || f === 1) { if (strong < 0) strong = f; else if (strong !== f) strongConflict = 1; }
    else if (f === 3) sawX = 1;
  }
  if (strongConflict) { if (!contended[netIdx]) { contended[netIdx] = 1; events.push({ kind: 'contention', detail: 'net', step }); } return 3; }
  if (sawX) return 3;
  if (strong >= 0) return strong;
  if (weakConflict) return 3;
  if (weak >= 0) return weak;
  return 2;
}

function settle() {
  let now = dirtyA, next = dirtyB;
  let iter = 0;
  contended.fill(0);
  while (now.length > 0) {
    if (iter++ >= MAX_ITER) {
      // oscillation
      events.push({ kind: 'oscillation', detail: 'max iter', step });
      for (const c of now) inDirty[c] = 0;
      for (const c of next) inDirty[c] = 0;
      now.length = 0; next.length = 0;
      step++;
      return;
    }
    // READ
    for (let i = 0; i < now.length; i++) {
      const ci = now[i];
      const k = kindOf[ci];
      const ib = inBuf[ci], ob = propBuf[ci];
      const inp = g.components[ci].inputNetIdx, logic = typeof g.components[ci].inputIsLogic !== 'undefined' ? g.components[ci].inputIsLogic : null;
      // fill
      const ni = nIn[ci];
      // NOTE: use real inputIsLogic
      const il = (g.components[ci] as any).inputIsLogic;
      for (let j = 0; j < ni; j++) {
        const nv = netV[inp[j]];
        ib[j] = il[j] === 1 ? (nv === 2 ? 3 : nv) : nv;
      }
      // evaluate
      if (k === 1) { // NOT
        const a = ib[0]; ob[0] = a === 0 ? 1 : a === 1 ? 0 : 3;
      } else if (k === 2) { // NOR (nary)
        let acc = ib[0];
        for (let j = 1; j < wArr[ci]; j++) { const b = ib[j]; if (acc === 1 || b === 1) acc = 1; else if (acc === 3 || b === 3) acc = 3; else acc = 0; }
        ob[0] = acc === 1 ? 0 : acc === 0 ? 1 : 3;
      } else if (k === 6) { // AND (nary)
        let acc = ib[0];
        for (let j = 1; j < wArr[ci]; j++) { const b = ib[j]; if (acc === 0 || b === 0) acc = 0; else if (acc === 3 || b === 3) acc = 3; else acc = 1; }
        ob[0] = acc;
      } else if (k === 8) { // XOR (nary)
        let acc = ib[0];
        for (let j = 1; j < wArr[ci]; j++) { const b = ib[j]; if (acc === 3 || b === 3) { acc = 3; } else acc = acc === b ? 0 : 1; }
        ob[0] = acc;
      } else if (k === 3) { // MUX2
        const w = wArr[ci]; const s = ib[2 * w];
        if (s === 0) for (let j = 0; j < w; j++) ob[j] = ib[j];
        else if (s === 1) for (let j = 0; j < w; j++) ob[j] = ib[w + j];
        else for (let j = 0; j < w; j++) { const a = ib[j], b = ib[w + j]; ob[j] = (a === b && (a === 0 || a === 1)) ? a : 3; }
      } else if (k === 9) { // ADDER
        const w = wArr[ci];
        let c = ib[2 * w];
        for (let j = 0; j < w; j++) {
          const a = ib[j], b = ib[w + j];
          // sum = xor(xor(a,b),c)
          let ab = (a === 3 || b === 3) ? 3 : (a === b ? 0 : 1);
          let s = (ab === 3 || c === 3) ? 3 : (ab === c ? 0 : 1);
          ob[j] = s;
          // majority(a,b,c): and(a,b) | and(a,c) | and(b,c)
          const abAnd = (a === 0 || b === 0) ? 0 : (a === 1 && b === 1) ? 1 : 3;
          const acAnd = (a === 0 || c === 0) ? 0 : (a === 1 && c === 1) ? 1 : 3;
          const bcAnd = (b === 0 || c === 0) ? 0 : (b === 1 && c === 1) ? 1 : 3;
          const or1 = (abAnd === 1 || acAnd === 1) ? 1 : (abAnd === 0 && acAnd === 0) ? 0 : 3;
          const cn = (or1 === 1 || bcAnd === 1) ? 1 : (or1 === 0 && bcAnd === 0) ? 0 : 3;
          c = cn;
        }
        ob[w] = c;
      } else if (k === 4) { // DFF
        let jj = 0; const d = ib[jj++], clk = ib[jj++];
        const clr = (flags[ci] & 2) ? ib[jj++] : -1;
        const pre = (flags[ci] & 4) ? ib[jj++] : -1;
        let q = dq[ci];
        if (clr === 0) q = 0; else if (pre === 0) q = 1; else if (dprev[ci] === 0 && clk === 1) q = d;
        dq[ci] = q; dprev[ci] = clk;
        ob[0] = q; ob[1] = q === 0 ? 1 : q === 1 ? 0 : 3;
      } else if (k === 5) { // TRISTATE
        const a = ib[0], oe = ib[1];
        const en = (flags[ci] & 1) ? (oe === 0 ? 1 : oe === 1 ? 0 : 3) : oe;
        ob[0] = en === 0 ? 2 : en === 1 ? a : 3;
      } else if (k === 7) { // CONST / PULL
        ob[0] = constVal[ci];
      } else if (k === 11) { // CLOCK
        const h = clockHalf[ci];
        if (step - clkT[ci] >= h) {
          const flipped = clkY[ci] === 1 ? 0 : 1;
          clkY[ci] = flipped; clkT[ci] = step;
          ob[0] = flipped;
        } else ob[0] = clkY[ci];
      } else if (k === 13) { // SWITCH
        ob[0] = switchY[ci];
      } else if (k === 10) { // MEM (simplified: 6116-style, no X handling beyond basics)
        // inputs: A[0..11), DQ[11..19) (inout), /CE=19, /OE=20, /WE=21
        const ADDR = 11, DATA = 8;
        const ce = ib[19], oe = ib[20], we = ib[21];
        let addr = 0, addrX = 0;
        for (let j = 0; j < ADDR; j++) { const b = ib[j]; if (b === 3 || b === 2) { addrX = 1; break; } if (b === 1) addr |= 1 << j; }
        if (ce === 1) { for (let j = 0; j < DATA; j++) ob[j] = 2; }
        else if (ce === 3 || we === 3) { for (let j = 0; j < DATA; j++) ob[j] = 3; }
        else if (we === 0) {
          if (!addrX) {
            let byte = 0, dx = 0;
            for (let j = 0; j < DATA; j++) { const b = ib[11 + j]; if (b === 3 || b === 2) { dx = 1; break; } if (b === 1) byte |= 1 << j; }
            if (!dx) memData[ci][addr] = byte;
          }
          for (let j = 0; j < DATA; j++) ob[j] = 2;
        } else if (oe === 3) { for (let j = 0; j < DATA; j++) ob[j] = 3; }
        else if (oe === 1) { for (let j = 0; j < DATA; j++) ob[j] = 2; }
        else if (addrX) { for (let j = 0; j < DATA; j++) ob[j] = 3; }
        else { const byte = memData[ci][addr]; for (let j = 0; j < DATA; j++) ob[j] = ((byte >> j) & 1) as number; }
      } else if (k === 12) { // 7SEG: no outputs, latch inputs
        const sd = segData[ci]!;
        for (let j = 0; j < 8; j++) sd[j] = ib[j];
      } else {
        throw new Error('kind ' + k);
      }
    }
    // COMMIT
    changedQueue.length = 0;
    for (let i = 0; i < now.length; i++) {
      const ci = now[i];
      const pb = propBuf[ci], obb = outBuf[ci], oni = g.components[ci].outputNetIdx;
      for (let j = 0; j < pb.length; j++) {
        const nv = pb[j];
        if (obb[j] !== nv) {
          obb[j] = nv;
          const netIdx = oni[j];
          if (!netChanged[netIdx]) { netChanged[netIdx] = 1; changedQueue.push(netIdx); }
        }
      }
      inDirty[ci] = 0;
    }
    now.length = 0;
    // RESOLVE
    for (let q = 0; q < changedQueue.length; q++) {
      const netIdx = changedQueue[q];
      netChanged[netIdx] = 0;
      const nv = resolveNetValue(netIdx);
      if (nv === netV[netIdx]) continue;
      netV[netIdx] = nv;
      const ls = nlOff[netIdx], le = nlOff[netIdx + 1];
      for (let k = ls; k < le; k++) {
        const comp = nl[k];
        if (!inDirty[comp]) { next.push(comp); inDirty[comp] = 1; }
      }
    }
    const tmp = now; now = next; next = tmp;
  }
  dirtyA = now; dirtyB = next;
  step++;
}

function tick() {
  for (const ci of tickActive) markDirty(ci);
  settle();
}

// ---- validation against real sim
const sim = new Simulator(loadCircuit(circuit));
sim.settle();
sim.setComponentInput('sw_reset', 'Y', 1);
sim.settle();

// replicate setup in proto: initial all-component settle + reset switch = 1
// proto initial: all dirty already; run settle to match sim's constructor+settle? 
// The real sim constructor marks all dirty and netV=X; sim.settle() settles them.
// proto: all dirty already, netV=X. run settle.
settle();
// set sw_reset Y=1: find comp
const swIdx = g.components.findIndex(c => c.id === 'sw_reset');
switchY[swIdx] = 1; // state = 1
markDirty(swIdx);
settle();

function protoNetValue(netIdx: number): any {
  const v = netV[netIdx];
  return v === 2 ? 'Z' : v === 3 ? 'X' : v;
}

// ---- pre-tick comparison
let mism0 = 0;
for (let n = 0; n < nNet; n++) if (String(sim.graph.nets[n].value) !== String(protoNetValue(n))) { if (mism0 < 12) console.log('PRE mism net', n, sim.graph.nets[n].id, 'real', sim.graph.nets[n].value, 'proto', protoNetValue(n)); mism0++; }
console.log('PRE mismatches:', mism0, 'of', nNet);
if (mism0 > 0) process.exit(1);

// run both for 100 ticks and compare every net value
const N = 200;
for (let i = 0; i < N; i++) {
  sim.tick();
  tick();
  for (let n = 0; n < nNet; n++) {
    const real = sim.graph.nets[n].value;
    if (String(real) !== String(protoNetValue(n))) {
      console.log('MISMATCH at tick', i, 'net', n, sim.graph.nets[n].id, 'real', real, 'proto', protoNetValue(n));
      process.exit(1);
    }
  }
  if (i % 50 === 0) process.stdout.write('tick ' + i + ' ok\n');
}
console.log('VALIDATION OK', N, 'ticks, all nets match');
console.log('events real', sim.events.length, 'proto', events.length);

// ---- throughput
for (let i = 0; i < 20000; i++) tick();
const ITERS = 300000;
const t0 = performance.now();
for (let i = 0; i < ITERS; i++) tick();
const dt = performance.now() - t0;
const rate = (ITERS / dt) * 1000;
console.log(`PROTO rate: ${rate.toFixed(0)} ticks/s  clock ${(rate / 2).toFixed(0)} Hz`);
