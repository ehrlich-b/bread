import { describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD_PX, LONG_PRESS_MS, PINCH_THRESHOLD_PX, TouchGestures } from './gestures';

const start = { x: 100, y: 100 };

describe('touch gesture interpretation', () => {
  it('allows finger jitter below the screen-pixel drag threshold', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    expect(gesture.move(1, { x: 105, y: 104 })).toBeNull();
    expect(gesture.up(1, { x: 105, y: 104 }, 100)).toEqual({ kind: 'tap', point: { x: 105, y: 104 } });
    expect(gesture.count).toBe(0);
  });

  it('starts dragging at the threshold, including diagonal movement', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    expect(gesture.move(1, { x: 100 + DRAG_THRESHOLD_PX, y: 100 })).toEqual({
      kind: 'drag', start, point: { x: 108, y: 100 },
    });
    expect(gesture.longPress(LONG_PRESS_MS)).toBeNull();
    expect(gesture.up(1, start, 700)).toEqual({ kind: 'drag-end', start, point: start });
    gesture.down(2, start, 1000);
    expect(gesture.move(2, { x: 106, y: 106 })?.kind).toBe('drag');
  });

  it('does not turn a drag that returns to its origin into a tap', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    gesture.move(1, { x: 120, y: 100 }); gesture.move(1, start);
    expect(gesture.up(1, start, 100)?.kind).toBe('drag-end');
  });

  it('uses release coordinates when no move event was delivered', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    expect(gesture.up(1, { x: 130, y: 100 }, 100)?.kind).toBe('drag-end');
  });

  it('fires one long press at the deadline and consumes the release', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    expect(gesture.longPress(LONG_PRESS_MS - 1)).toBeNull();
    gesture.move(1, { x: 101, y: 102 });
    expect(gesture.longPress(LONG_PRESS_MS)).toEqual({ kind: 'long-press', point: { x: 101, y: 102 } });
    expect(gesture.longPress(900)).toBeNull();
    expect(gesture.move(1, { x: 140, y: 140 })).toBeNull();
    expect(gesture.up(1, start, 1000)).toBeNull();
  });

  it('classifies a hold even when its timer is delayed', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    expect(gesture.up(1, start, LONG_PRESS_MS)).toEqual({ kind: 'long-press', point: start });
  });

  it('accumulates pinch jitter, then emits incremental scale and midpoint motion', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    gesture.down(2, { x: 200, y: 100 }, 20);
    expect(gesture.longPress(600)).toBeNull();
    expect(gesture.move(2, { x: 205, y: 100 })).toBeNull();
    expect(gesture.move(2, { x: 200 + PINCH_THRESHOLD_PX, y: 100 })).toEqual({
      kind: 'pinch', from: { x: 150, y: 100 }, to: { x: 153, y: 100 }, scale: 1.06,
    });
    expect(gesture.move(2, { x: 259, y: 100 })).toEqual({
      kind: 'pinch', from: { x: 153, y: 100 }, to: { x: 179.5, y: 100 }, scale: 1.5,
    });
  });

  it('allows two fingers to pan without a significant scale change', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    gesture.down(2, { x: 200, y: 100 }, 0);
    expect(gesture.move(1, { x: 100, y: 112 })).toEqual({
      kind: 'pinch', from: { x: 150, y: 100 }, to: { x: 150, y: 106 }, scale: Math.hypot(100, 12) / 100,
    });
  });

  it('suppresses taps and drags until all fingers leave after a pinch', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0);
    gesture.move(1, { x: 120, y: 100 });
    gesture.down(2, { x: 200, y: 100 }, 20);
    expect(gesture.up(2, { x: 220, y: 100 }, 100)).toBeNull();
    expect(gesture.move(1, { x: 140, y: 100 })).toBeNull();
    expect(gesture.longPress(700)).toBeNull();
    expect(gesture.up(1, start, 800)).toBeNull();
    gesture.down(3, start, 900);
    expect(gesture.up(3, start, 1000)?.kind).toBe('tap');
  });

  it('does not zoom from coincident fingers or interpret a third finger as a tap', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0); gesture.down(2, start, 0);
    expect(gesture.move(2, { x: 120, y: 100 })).toBeNull();
    expect(gesture.move(2, { x: 140, y: 100 })).toEqual({
      kind: 'pinch', from: { x: 110, y: 100 }, to: { x: 120, y: 100 }, scale: 2,
    });
    gesture.down(3, { x: 200, y: 200 }, 20);
    expect(gesture.up(3, { x: 200, y: 200 }, 100)).toBeNull();
    expect(gesture.up(1, start, 200)).toBeNull();
    expect(gesture.up(2, { x: 140, y: 100 }, 200)).toBeNull();
  });

  it('cancels without a tap, hold or drag commit and ignores unknown pointers', () => {
    const gesture = new TouchGestures(); gesture.down(1, start, 0); gesture.cancel();
    expect(gesture.count).toBe(0);
    expect(gesture.longPress(1000)).toBeNull();
    expect(gesture.move(1, start)).toBeNull();
    expect(gesture.up(1, start, 1000)).toBeNull();
    gesture.down(2, start, 1000); gesture.down(2, start, 1100);
    expect(gesture.count).toBe(1);
    expect(gesture.up(2, start, 1200)?.kind).toBe('tap');
  });
});
