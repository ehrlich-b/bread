// Gesture distances are screen pixels, independent of canvas zoom.
export const DRAG_THRESHOLD_PX = 8;
export const PINCH_THRESHOLD_PX = 6;
export const LONG_PRESS_MS = 550;

export interface TouchPoint { x: number; y: number }
type Drag = { kind: 'drag'; start: TouchPoint; point: TouchPoint };
type Press = { kind: 'tap' | 'long-press'; point: TouchPoint };
export type GestureMove = Drag | { kind: 'pinch'; from: TouchPoint; to: TouchPoint; scale: number };
export type GestureEnd = Press | { kind: 'drag-end'; start: TouchPoint; point: TouchPoint };

const distance = (a: TouchPoint, b: TouchPoint): number => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: TouchPoint, b: TouchPoint): TouchPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class TouchGestures {
  private readonly points = new Map<number, TouchPoint>();
  private start: TouchPoint = { x: 0, y: 0 };
  private startedAt = 0;
  private dragged = false;
  private held = false;
  private multiple = false;
  private pinching = false;
  private baseline: { center: TouchPoint; distance: number } | null = null;

  get count(): number { return this.points.size; }
  has(id: number): boolean { return this.points.has(id); }

  down(id: number, point: TouchPoint, now: number): void {
    if (this.points.has(id)) return;
    if (this.count === 0) {
      this.start = point; this.startedAt = now;
      this.dragged = false; this.held = false; this.multiple = false; this.pinching = false;
    }
    this.points.set(id, point);
    if (this.count === 2) {
      this.multiple = true;
      const [a, b] = [...this.points.values()] as [TouchPoint, TouchPoint];
      this.baseline = { center: midpoint(a, b), distance: distance(a, b) };
    }
  }

  move(id: number, point: TouchPoint): GestureMove | null {
    if (!this.has(id)) return null;
    this.points.set(id, point);
    if (this.count >= 2) {
      const [a, b] = [...this.points.values()] as [TouchPoint, TouchPoint];
      const center = midpoint(a, b); const span = distance(a, b);
      const previous = this.baseline;
      // Coincident fingers have no useful scale. Establish a baseline once
      // they separate, rather than dividing by zero or jumping to max zoom.
      if (!previous || previous.distance < PINCH_THRESHOLD_PX) {
        this.baseline = { center, distance: span }; return null;
      }
      if (span < PINCH_THRESHOLD_PX) return null;
      if (!this.pinching && Math.abs(span - previous.distance) < PINCH_THRESHOLD_PX
        && distance(center, previous.center) < PINCH_THRESHOLD_PX) return null;
      this.pinching = true;
      this.baseline = { center, distance: span };
      return { kind: 'pinch', from: previous.center, to: center, scale: span / previous.distance };
    }
    // Lifting one finger after a pinch must not start a drag or leave a tap.
    if (this.multiple || this.held) return null;
    if (!this.dragged && distance(this.start, point) < DRAG_THRESHOLD_PX) return null;
    this.dragged = true;
    return { kind: 'drag', start: this.start, point };
  }

  longPress(now: number): Press | null {
    if (this.count !== 1 || this.multiple || this.dragged || this.held || now - this.startedAt < LONG_PRESS_MS) return null;
    this.held = true;
    return { kind: 'long-press', point: [...this.points.values()][0]! };
  }

  up(id: number, point: TouchPoint, now: number): GestureEnd | null {
    if (!this.has(id)) return null;
    this.move(id, point);
    let result: GestureEnd | null = null;
    if (this.count === 1 && !this.multiple && !this.held) {
      result = this.dragged ? { kind: 'drag-end', start: this.start, point }
        : { kind: now - this.startedAt >= LONG_PRESS_MS ? 'long-press' : 'tap', point };
    }
    this.points.delete(id);
    if (this.count === 0) this.cancel();
    return result;
  }

  cancel(): void {
    this.points.clear(); this.baseline = null;
    this.dragged = false; this.held = false; this.multiple = false; this.pinching = false;
  }
}
