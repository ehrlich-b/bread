// Fallback chip renderer: a labeled rectangle with pins laid out around the
// edges, generated from the engine's pin spec. Used for any component type
// that doesn't have a hand-crafted entry in renderers.ts (TTL composites,
// memory chips, parameterized primitives like MUX/DECODER/ADDER).
//
// Layout:
//   - inputs on the left
//   - outputs on the right (inout pins also go right; bus pins by convention)
//   - pin handles at x=0 / x=width; pin name labels just inside the body
//   - type label centered at top, instance id below the chip
//
// Pin pitch is fixed; the body grows tall enough to seat the longer side. We
// don't try to be clever about reflow or symmetric DIP-style layouts — that's
// a polish item once the basic surface is clickable.

import { getPinsForType } from '../../engine';
import type { CircuitJSON, PinSpec } from '../../engine/ir';
import { rect, text, type PinOffset, type Renderer } from './renderers';

const PIN_PITCH = 14;
const PADDING_TOP = 22;
const PADDING_BOTTOM = 12;
const BODY_WIDTH = 100;

interface PinSlot {
  name: string;
  side: 'left' | 'right';
  x: number;
  y: number;
}

// 'ttl.74LS00' → '74LS00'. The namespace is implied by surrounding context.
const shortLabel = (typeId: string): string => {
  const dot = typeId.indexOf('.');
  return dot === -1 ? typeId : typeId.slice(dot + 1);
};

const splitPins = (pins: PinSpec[]): { left: PinSpec[]; right: PinSpec[] } => {
  const left: PinSpec[] = [];
  const right: PinSpec[] = [];
  for (const p of pins) {
    if (p.dir === 'out' || p.dir === 'inout') right.push(p);
    else left.push(p);
  }
  return { left, right };
};

const layoutPins = (
  left: PinSpec[],
  right: PinSpec[],
): { slots: PinSlot[]; height: number } => {
  const rows = Math.max(left.length, right.length, 1);
  const height = PADDING_TOP + rows * PIN_PITCH + PADDING_BOTTOM;
  const slots: PinSlot[] = [];
  for (let i = 0; i < left.length; i++) {
    slots.push({
      name: left[i]!.name,
      side: 'left',
      x: 0,
      y: PADDING_TOP + i * PIN_PITCH,
    });
  }
  for (let i = 0; i < right.length; i++) {
    slots.push({
      name: right[i]!.name,
      side: 'right',
      x: BODY_WIDTH,
      y: PADDING_TOP + i * PIN_PITCH,
    });
  }
  return { slots, height };
};

export const buildGenericRenderer = (
  typeId: string,
  params?: Record<string, unknown>,
  definitions?: readonly CircuitJSON[],
): Renderer | null => {
  let pinSpec: PinSpec[] | null;
  try {
    pinSpec = getPinsForType(typeId, params, definitions);
  } catch {
    // Required params missing or invalid. Fall back to "unknown chip" so the
    // user still sees something on the canvas instead of a hard crash.
    return null;
  }
  if (!pinSpec) return null;

  const { left, right } = splitPins(pinSpec);
  const { slots, height } = layoutPins(left, right);

  const pinOffsets: Record<string, PinOffset> = {};
  for (const s of slots) pinOffsets[s.name] = { x: s.x, y: s.y };

  const label = shortLabel(typeId);

  return {
    size: { w: BODY_WIDTH, h: height },
    pins: pinOffsets,
    draw(group, instId) {
      rect(group, 0, 0, BODY_WIDTH, height, 'gate-body');
      text(group, BODY_WIDTH / 2, 14, label, 'middle');
      text(group, BODY_WIDTH / 2, height + 14, instId, 'middle');
      for (const s of slots) {
        const tx = s.side === 'left' ? 8 : BODY_WIDTH - 8;
        const ty = s.y + 4;
        text(group, tx, ty, s.name, s.side === 'left' ? 'start' : 'end');
      }
    },
  };
};
