import type { DriverValue, NetState } from './ir';

export interface ResolveResult {
  value: NetState;
  // True only when multiple *strong* drivers conflict. X-poison from a single
  // X driver is not contention — that's just propagating unknown.
  contention: boolean;
}

// Resolve a net from the values currently being driven onto it.
// Implements the table in SIMULATION.md.
//
//   no drivers (or all Z)                    → Z
//   exactly one strong + others Z/weak       → that strong value
//   multiple strong, all equal               → that value
//   multiple strong, conflicting             → X (contention=true)
//   any X among drivers + no contention      → X (X poisons; contention=false)
//   no strong, single weak (or matching weak)→ that weak's strong value
//   no strong, conflicting weaks             → X (no contention; weak fight)
//
// Strong drivers always win over weak. Weak drivers behave like strong drivers
// at a lower priority — fighting weaks resolve to X (analogous to a pull-up and
// pull-down on the same net).
// A 0Z/1Z driver may be enabled or released. Resolve both possibilities:
// a matching definite drive removes the uncertainty; an opposite drive or
// a potentially floating net remains X.
export function resolveNet(driverValues: readonly DriverValue[]): ResolveResult {
  const out: ResolveResult = { value: 'Z', contention: false };
  resolveNetInto(driverValues, out);
  return out;
}

// Same logic as resolveNet but writes into an output struct supplied by the
// caller. The simulator's hot path (computeNetValue) calls this with a scratch
// instance held on the Simulator to avoid per-net allocation.
export function resolveNetInto(driverValues: readonly DriverValue[], out: ResolveResult): void {
  let strong: 0 | 1 | null = null;
  let strongConflict = false;
  let weak: 0 | 1 | null = null;
  let weakConflict = false;
  let sawX = false;
  let maybeLow = false;
  let maybeHigh = false;

  for (let i = 0; i < driverValues.length; i++) {
    const v = driverValues[i]!;
    if (v === 'Z') continue;
    if (v === 'X') {
      sawX = true;
      continue;
    }
    if (v === '0Z') { maybeLow = true; continue; }
    if (v === '1Z') { maybeHigh = true; continue; }
    if (v === 'L' || v === 'H') {
      const w: 0 | 1 = v === 'L' ? 0 : 1;
      if (weak === null) weak = w;
      else if (weak !== w) weakConflict = true;
      continue;
    }
    // strong 0 / 1
    if (strong === null) strong = v;
    else if (strong !== v) strongConflict = true;
  }

  if (strongConflict) { out.value = 'X'; out.contention = true; return; }
  out.contention = false;
  if (sawX) { out.value = 'X'; return; }
  if (strong !== null) { out.value = strong === 0 && maybeHigh || strong === 1 && maybeLow ? 'X' : strong; return; }
  if (weakConflict) { out.value = 'X'; return; }
  if (weak !== null) { out.value = weak === 0 && maybeHigh || weak === 1 && maybeLow ? 'X' : weak; return; }
  if (maybeLow || maybeHigh) { out.value = 'X'; return; }
  out.value = 'Z';
}

// Translate a net value into the form a pure logic input expects.
// A logic input that reads Z is undefined behavior (no driver) → X.
export function readAsLogic(value: NetState): NetState {
  return value === 'Z' ? 'X' : value;
}
