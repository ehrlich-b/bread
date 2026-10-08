import { afterEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS } from './gestures';
import { mountTouch } from './touch';

class Surface extends EventTarget {
  readonly captures = new Set<number>();
  readonly pins: Surface[] = [];
  component = false;
  box = { x: 0, y: 0, width: 10, height: 10 };
  closest(selector: string): Surface | null { return selector === '[data-comp-id]' && this.component ? this : null; }
  querySelectorAll(): Surface[] { return this.pins; }
  getBoundingClientRect() { return this.box; }
  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
}

const mount = () => {
  vi.useFakeTimers();
  const document = new EventTarget(); vi.stubGlobal('document', document);
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const svg = new Surface();
  const actions = { begin: vi.fn(), tap: vi.fn(), drag: vi.fn(), pinchStart: vi.fn(), pinch: vi.fn(), hold: vi.fn(), cancel: vi.fn() };
  const remember = vi.fn();
  const dispose = mountTouch(svg as unknown as SVGSVGElement, actions, remember);
  const send = (type: string, id = 1, x = 100, y = 100, target = svg, pointerType = 'touch'): Event => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, { pointerId: id, pointerType, clientX: x, clientY: y });
    (type === 'pointerdown' || type === 'lostpointercapture' ? svg : document).dispatchEvent(event);
    return event;
  };
  const advance = (ms: number): void => { now += ms; vi.advanceTimersByTime(ms); };
  return { svg, actions, remember, dispose, send, advance };
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('canvas touch pointer lifecycle', () => {
  it('captures touch, dispatches exactly one tap and releases before the action', () => {
    const h = mount();
    h.actions.tap.mockImplementation(() => expect(h.svg.captures.size).toBe(0));
    try {
      expect(h.send('pointerdown').defaultPrevented).toBe(true);
      expect(h.svg.captures.has(1)).toBe(true);
      h.advance(100); h.send('pointerup');
      h.advance(LONG_PRESS_MS);
      expect(h.actions.tap.mock.calls).toEqual([[h.svg, { x: 100, y: 100 }]]);
      expect(h.actions.hold).not.toHaveBeenCalled();
      expect(h.remember).toHaveBeenCalledTimes(2);
    } finally { h.dispose(); }
  });

  it('leaves mouse pointers and their default behavior alone', () => {
    const h = mount();
    try {
      expect(h.send('pointerdown', 1, 100, 100, h.svg, 'mouse').defaultPrevented).toBe(false);
      h.send('pointermove'); h.send('pointerup'); h.advance(1000);
      expect(h.actions.begin).not.toHaveBeenCalled(); expect(h.actions.tap).not.toHaveBeenCalled();
      expect(h.actions.hold).not.toHaveBeenCalled(); expect(h.svg.captures.size).toBe(0);
    } finally { h.dispose(); }
  });

  it('holds once without a later tap or component move', () => {
    const h = mount();
    try {
      h.send('pointerdown'); h.advance(LONG_PRESS_MS);
      expect(h.actions.hold.mock.calls).toEqual([[h.svg, { x: 100, y: 100 }]]);
      h.send('pointermove', 1, 140, 100); h.send('pointerup', 1, 140, 100);
      expect(h.actions.tap).not.toHaveBeenCalled(); expect(h.actions.drag).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });

  it('commits a drag once with release coordinates and cancels its hold timer', () => {
    const h = mount();
    try {
      h.send('pointerdown'); h.send('pointermove', 1, 120, 100);
      h.advance(600); h.send('pointerup', 1, 130, 110);
      expect(h.actions.drag.mock.calls).toEqual([
        [h.svg, { x: 100, y: 100 }, { x: 120, y: 100 }, false],
        [h.svg, { x: 100, y: 100 }, { x: 130, y: 110 }, true],
      ]);
      expect(h.actions.tap).not.toHaveBeenCalled(); expect(h.actions.hold).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });

  it('rolls back a drag on a second contact, then pinches without committing or tapping', () => {
    const h = mount();
    try {
      h.send('pointerdown'); h.send('pointermove', 1, 120, 100);
      h.send('pointerdown', 2, 220, 100); h.send('pointermove', 2, 270, 100);
      h.send('pointerup', 2, 270, 100); h.send('pointermove', 1, 140, 100);
      h.send('pointerup', 1, 140, 100); h.advance(1000);
      expect(h.actions.pinchStart).toHaveBeenCalledTimes(1);
      expect(h.actions.pinch.mock.calls).toEqual([[{ kind: 'pinch', from: { x: 170, y: 100 }, to: { x: 195, y: 100 }, scale: 1.5 }]]);
      expect(h.actions.drag).toHaveBeenCalledTimes(1);
      expect(h.actions.tap).not.toHaveBeenCalled(); expect(h.actions.hold).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });

  it.each(['pointercancel', 'lostpointercapture'])('rolls back on %s without committing', type => {
    const h = mount();
    try {
      h.send('pointerdown'); h.send('pointermove', 1, 140, 100); h.send(type);
      h.send('pointerup', 1, 140, 100); h.advance(1000);
      expect(h.actions.cancel).toHaveBeenCalledTimes(1);
      expect(h.actions.drag).toHaveBeenCalledTimes(1);
      expect(h.actions.tap).not.toHaveBeenCalled(); expect(h.actions.hold).not.toHaveBeenCalled();
      expect(h.svg.captures.size).toBe(0);
    } finally { h.dispose(); }
  });

  it('disposes active contacts, the timer and document listeners', () => {
    const h = mount(); h.send('pointerdown'); h.dispose(); h.advance(1000);
    h.send('pointerdown'); h.send('pointermove', 1, 120, 100); h.send('pointerup');
    expect(h.actions.begin).toHaveBeenCalledTimes(1); expect(h.actions.cancel).toHaveBeenCalledTimes(1);
    expect(h.actions.tap).not.toHaveBeenCalled(); expect(h.actions.drag).not.toHaveBeenCalled();
    expect(h.actions.hold).not.toHaveBeenCalled(); expect(h.svg.captures.size).toBe(0);
  });

  it('accepts a near miss outside a pin without stealing a component body tap', () => {
    const h = mount(); const pin = new Surface(); pin.box = { x: 100, y: 100, width: 10, height: 10 };
    h.svg.pins.push(pin);
    try {
      h.send('pointerdown', 1, 118, 105); h.send('pointerup', 1, 118, 105);
      expect(h.actions.tap).toHaveBeenLastCalledWith(pin, { x: 118, y: 105 });
      const component = new Surface(); component.component = true;
      h.send('pointerdown', 2, 118, 105, component); h.send('pointerup', 2, 118, 105, component);
      expect(h.actions.tap).toHaveBeenLastCalledWith(component, { x: 118, y: 105 });
    } finally { h.dispose(); }
  });
});
