// ttl.74LS193 — 4-bit synchronous up/down binary counter with asynchronous
// parallel load and master reset (the 'xx193 family, also sold as 74HC193).
//
// Control inputs (both asynchronous, level-driven, dominating the clocks):
//   MR  = 1 → Q := 0, overriding everything below (master reset, active HIGH);
//          note the repo names active-low pins with a leading "/", so a
//          HIGH-true reset gets the plain name "MR" (TI datasheet pin 11).
//   /PL = 0 (while MR = 0) → Q := D0..D3 asynchronously, no clock needed.
//   Otherwise, on a RISING edge of CPU (Count Up)   → Q := Q + 1 (mod 16);
//              on a RISING edge of CPD (Count Down) → Q := Q − 1 (mod 16).
//
// Terminal-count outputs (active low; used for cascading bigger counters):
//   /TCU = NOT(Q = 15 AND CPU = 1)  — carry, low while counting up into max
//   /TCd = NOT(Q =  0 AND CPD = 1)  — borrow, low while counting down into 0
//   (TI logic diagram: /TCU = /(Q0·Q1·Q2·Q3·CPU), /TCd = /(Q0'·Q1'·Q2'·Q3'·CPD).)
//
// Edge model: the simulator re-evaluates this behavioral whenever an input
// net changes. We keep the last-seen CPU/CPD values in state and count on
// prev=0 → now=1, so a parked-high clock re-evaluating for an unrelated input
// change never double-counts. The init prev values are 'X' so the first-ever
// settle (everything X) does not fabricate an edge; tests park the clocks
// low before ticking, matching the rest of the suite.
//
// Simultaneous rising edges on CPU and CPD: the real '193 lets both clocks
// be pulsed with no restriction; an increment and a decrement landing in the
// same step cancel, so we model that as "no change". I am not 100% certain
// of the datasheet's corner-case row for perfectly simultaneous edges, so
// this is an explicit modelling choice rather than a silent guess.
//
// X handling (four-state engine): an unknown MR or /PL poisons the count and
// outputs; an X clock input never counts; an async load with any X/Z data
// bit leaves the count unchanged (mirrors mem.74LS189 refusing to store X).
// The count boots to 0 for deterministic tests (same stance as mem.74LS189).
//
// Why behavioral and not a composite netlist: the two independent
// edge-triggered clock inputs (CPU/CPD) cannot be expressed with the shipped
// single-clock prim.DFF primitives. Any data path that depends on WHICH clock
// fired this step needs stored edge state that the composite flattening pass
// cannot synthesise.

import type { DriverValue, NetState, PinSpec, PrimitiveDef } from '../ir';
import { registerBehavioral } from './registry';

const COUNTER_BITS = 4;
const MAX_COUNT = (1 << COUNTER_BITS) - 1; // 15

interface Cnt74LS193State {
  // Stored count; 'X' means "poisoned by an unknown control input".
  q: number | 'X';
  prevCPU: NetState;
  prevCPD: NetState;
}

const pinNames: PinSpec[] = [
  { name: 'D0', dir: 'in' },
  { name: 'D1', dir: 'in' },
  { name: 'D2', dir: 'in' },
  { name: 'D3', dir: 'in' },
  { name: 'CPU', dir: 'in' },
  { name: 'CPD', dir: 'in' },
  { name: '/PL', dir: 'in', activeLow: true },
  { name: 'MR', dir: 'in' },
  { name: 'Q0', dir: 'out' },
  { name: 'Q1', dir: 'out' },
  { name: 'Q2', dir: 'out' },
  { name: 'Q3', dir: 'out' },
  { name: '/TCU', dir: 'out', activeLow: true },
  { name: '/TCd', dir: 'out', activeLow: true },
];

// Pin-slot offsets within the evaluator's inputs[]/outputs[] arrays (pins are
// split into inputs-first / outputs-first by the loader, in declaration order).
const D0 = 0;
const CPU = 4;
const CPD = 5;
const PL = 6;
const MR = 7;
const Q0_OUT = 0;
const TCU_OUT = 4;
const TCD_OUT = 5;

const isDefined = (v: NetState): v is 0 | 1 => v === 0 || v === 1;

const readData = (inputs: readonly NetState[]): number | 'X' => {
  let nibble = 0;
  for (let i = 0; i < COUNTER_BITS; i++) {
    const bit = inputs[D0 + i]!;
    if (!isDefined(bit)) return 'X';
    if (bit === 1) nibble |= 1 << i;
  }
  return nibble;
};

const writeQ = (q: number | 'X', outputs: DriverValue[]): void => {
  if (q === 'X') {
    for (let i = 0; i < COUNTER_BITS; i++) outputs[Q0_OUT + i] = 'X';
    return;
  }
  for (let i = 0; i < COUNTER_BITS; i++) {
    outputs[Q0_OUT + i] = ((q >> i) & 1) === 1 ? 1 : 0;
  }
};

const cnt74LS193: PrimitiveDef<Cnt74LS193State, Record<string, never>> = {
  pins: () => pinNames,
  init: () => ({ q: 0, prevCPU: 'X', prevCPD: 'X' }),
  evaluate(inputs, outputs, state) {
    const cpu = inputs[CPU]!;
    const cpd = inputs[CPD]!;
    const pl = inputs[PL]!;
    const mr = inputs[MR]!;

    let q: number | 'X' = state.q;

    if (mr === 1) {
      // Master reset (async, high) dominates every other path.
      q = 0;
    } else if (pl === 0) {
      // Async parallel load (active low). X/Z data leaves the count alone.
      const nibble = readData(inputs);
      if (nibble !== 'X') q = nibble;
    } else if (mr === 'X' || pl === 'X') {
      // Unknown control input — cannot know the intended operation, so poison
      // the count rather than silently doing the wrong thing downstream.
      q = 'X';
    } else if (state.q === 'X') {
      q = 'X';
    } else {
      // Clocked path: rising edge (prev 0 → now 1) on exactly one clock.
      const cpuRose = state.prevCPU === 0 && cpu === 1;
      const cpdRose = state.prevCPD === 0 && cpd === 1;
      if (cpuRose && !cpdRose) {
        q = (state.q + 1) & MAX_COUNT;
      } else if (cpdRose && !cpuRose) {
        q = (state.q - 1) & MAX_COUNT;
      } else {
        q = state.q; // hold — includes the up-and-down-cancel simultaneous case
      }
    }

    state.q = q;
    state.prevCPU = cpu;
    state.prevCPD = cpd;

    writeQ(q, outputs);

    // Terminal count outputs: active-low while parked at max/min with the
    // corresponding clock held high after the counting edge.
    if (q === 'X') {
      outputs[TCU_OUT] = 'X';
      outputs[TCD_OUT] = 'X';
    } else {
      outputs[TCU_OUT] = q === MAX_COUNT && cpu === 1 ? 0 : 1;
      outputs[TCD_OUT] = q === 0 && cpd === 1 ? 0 : 1;
    }
    return undefined;
  },
};

registerBehavioral('ttl.74LS193', cnt74LS193);
