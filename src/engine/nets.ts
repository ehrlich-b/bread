import type { NetState } from './ir';

// Resolve a net from the values currently being driven onto it.
// Implements the table in SIMULATION.md.
//
//   no drivers (or all Z) → Z (high-impedance / floating)
//   exactly one strong + zero or more Z → that strong value
//   multiple strong, all equal             → that value
//   multiple strong, conflicting           → X (contention)
//   any X among drivers                    → X (X poisons resolution)
//
// The reading side is responsible for translating Z → X for pure logic inputs.
// Weak drivers (PULLUP/PULLDOWN) are not yet modeled; that arrives with M1.
export function resolveNet(driverValues: readonly NetState[]): NetState {
  let strong: 0 | 1 | null = null;
  let conflict = false;

  for (const v of driverValues) {
    if (v === 'Z') continue;
    if (v === 'X') {
      conflict = true;
      continue;
    }
    if (strong === null) strong = v;
    else if (strong !== v) conflict = true;
  }

  if (conflict) return 'X';
  if (strong === null) return 'Z';
  return strong;
}

// Translate a net value into the form a pure logic input expects.
// A logic input that reads Z is undefined behavior (no driver) → X.
export function readAsLogic(value: NetState): NetState {
  return value === 'Z' ? 'X' : value;
}
