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
export function resolveNet(driverValues: readonly DriverValue[]): ResolveResult {
  let strong: 0 | 1 | null = null;
  let strongConflict = false;
  let weak: 0 | 1 | null = null;
  let weakConflict = false;
  let sawX = false;

  for (const v of driverValues) {
    if (v === 'Z') continue;
    if (v === 'X') {
      sawX = true;
      continue;
    }
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

  if (strongConflict) return { value: 'X', contention: true };
  if (sawX) return { value: 'X', contention: false };
  if (strong !== null) return { value: strong, contention: false };
  if (weakConflict) return { value: 'X', contention: false };
  if (weak !== null) return { value: weak, contention: false };
  return { value: 'Z', contention: false };
}

// Translate a net value into the form a pure logic input expects.
// A logic input that reads Z is undefined behavior (no driver) → X.
export function readAsLogic(value: NetState): NetState {
  return value === 'Z' ? 'X' : value;
}
