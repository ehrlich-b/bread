import { LONG_PRESS_MS, TouchGestures, type GestureMove, type TouchPoint } from './gestures';

interface TouchActions {
  begin: (target: Element, point: TouchPoint) => void;
  tap: (target: Element, point: TouchPoint) => void;
  drag: (target: Element, start: TouchPoint, point: TouchPoint, commit: boolean) => void;
  pinchStart: () => void;
  pinch: (gesture: Extract<GestureMove, { kind: 'pinch' }>) => void;
  hold: (target: Element, point: TouchPoint) => void;
  cancel: () => void;
}

// Chromium can adjust a body touch to a nearby clickable pin. Recover the
// geometric hit before allowing near misses outside a component to find a pin.
const touchTarget = (svg: SVGSVGElement, target: Element, point: TouchPoint): Element => {
  const hit = svg.ownerDocument.elementFromPoint(point.x, point.y);
  if (hit && svg.contains(hit)) target = hit;
  if (target.closest('[data-comp-id]')) return target;
  let nearest: Element = target; let radius = 14;
  for (const pin of svg.querySelectorAll('[data-pin]')) {
    const box = pin.getBoundingClientRect();
    const distance = Math.hypot(point.x - (box.x + box.width / 2), point.y - (box.y + box.height / 2));
    if (distance < radius) { nearest = pin; radius = distance; }
  }
  return nearest;
};

export const mountTouch = (svg: SVGSVGElement, actions: TouchActions, rememberTouch: () => void): (() => void) => {
  const gestures = new TouchGestures();
  const captured = new Set<number>();
  let target: Element = svg;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = (): void => { if (timer !== null) clearTimeout(timer); timer = null; };
  const point = (event: PointerEvent): TouchPoint => ({ x: event.clientX, y: event.clientY });
  const cancel = (): void => {
    clearTimer(); gestures.cancel(); actions.cancel();
    for (const id of captured) if (svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
    captured.clear();
  };
  const down = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    event.preventDefault(); rememberTouch();
    const p = point(event);
    const first = gestures.count === 0;
    // Record the deadline before scheduling its timer or doing DOM work.
    gestures.down(event.pointerId, p, performance.now());
    if (first) {
      target = touchTarget(svg, event.target as Element, p);
      actions.begin(target, p);
      timer = setTimeout(() => {
        timer = null;
        const press = gestures.longPress(performance.now());
        if (press) actions.hold(target, press.point);
      }, LONG_PRESS_MS);
    } else { clearTimer(); actions.pinchStart(); }
    svg.setPointerCapture(event.pointerId); captured.add(event.pointerId);
  };
  const move = (event: PointerEvent): void => {
    if (!gestures.has(event.pointerId)) return;
    event.preventDefault();
    const gesture = gestures.move(event.pointerId, point(event));
    if (!gesture) return;
    clearTimer();
    if (gesture.kind === 'pinch') actions.pinch(gesture);
    else actions.drag(target, gesture.start, gesture.point, false);
  };
  const up = (event: PointerEvent): void => {
    if (!gestures.has(event.pointerId)) return;
    event.preventDefault(); rememberTouch(); clearTimer();
    const gesture = gestures.up(event.pointerId, point(event), performance.now());
    // Release before invoking editor actions, which may replace this SVG.
    captured.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (gesture?.kind === 'tap') actions.tap(target, gesture.point);
    else if (gesture?.kind === 'long-press') actions.hold(target, gesture.point);
    else if (gesture?.kind === 'drag-end') actions.drag(target, gesture.start, gesture.point, true);
  };
  const interrupted = (event: PointerEvent): void => { if (gestures.has(event.pointerId)) cancel(); };
  // Native touch context menus would compete with the canvas actions.
  const context = (event: MouseEvent): void => { if (gestures.count > 0) event.preventDefault(); };
  svg.addEventListener('pointerdown', down);
  svg.addEventListener('lostpointercapture', interrupted);
  svg.addEventListener('contextmenu', context);
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up, { passive: false });
  document.addEventListener('pointercancel', interrupted);
  return () => {
    cancel();
    svg.removeEventListener('pointerdown', down);
    svg.removeEventListener('lostpointercapture', interrupted);
    svg.removeEventListener('contextmenu', context);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', interrupted);
  };
};
