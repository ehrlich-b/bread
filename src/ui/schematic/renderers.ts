// Per-component-type SVG renderer presets. Each entry knows how to draw the
// component's body inside a translated <g> and where its pins live (so the
// wire layer can route to absolute coordinates).
//
// Slice 2 of M4 will expand this set to cover every primitive in the palette;
// for slice 1 we keep parity with the M3 blink demo (io.switch, io.led,
// gen.clock, prim.AND).

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface PinOffset {
  x: number;
  y: number;
}

export interface Renderer {
  size: { w: number; h: number };
  pins: Record<string, PinOffset>;
  draw(group: SVGGElement, instId: string, params: Record<string, unknown> | undefined): void;
}

export const text = (
  parent: Element,
  x: number,
  y: number,
  content: string,
  anchor: 'start' | 'middle' | 'end' = 'middle',
): SVGTextElement => {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('class', 'label');
  t.textContent = content;
  parent.appendChild(t);
  return t;
};

export const rect = (
  parent: Element,
  x: number,
  y: number,
  w: number,
  h: number,
  cls: string,
): SVGRectElement => {
  const r = document.createElementNS(SVG_NS, 'rect');
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(w));
  r.setAttribute('height', String(h));
  r.setAttribute('class', cls);
  r.setAttribute('rx', '4');
  parent.appendChild(r);
  return r;
};

export const renderers: Record<string, Renderer> = {
  'io.switch': {
    size: { w: 70, h: 40 },
    pins: { Y: { x: 70, y: 20 } },
    draw(group, instId) {
      rect(group, 0, 0, 70, 40, 'gate-body');
      text(group, 35, 16, instId, 'middle');
      const handle = document.createElementNS(SVG_NS, 'rect');
      handle.setAttribute('x', '8');
      handle.setAttribute('y', '22');
      handle.setAttribute('width', '54');
      handle.setAttribute('height', '14');
      handle.setAttribute('rx', '3');
      handle.setAttribute('class', 'switch-handle');
      handle.setAttribute('data-role', 'switch-handle');
      handle.setAttribute('fill', 'var(--led-off)');
      group.appendChild(handle);
      const stateLabel = document.createElementNS(SVG_NS, 'text');
      stateLabel.setAttribute('x', '35');
      stateLabel.setAttribute('y', '34');
      stateLabel.setAttribute('text-anchor', 'middle');
      stateLabel.setAttribute('class', 'label');
      stateLabel.setAttribute('data-role', 'switch-label');
      stateLabel.textContent = '0';
      group.appendChild(stateLabel);
    },
  },
  'gen.clock': {
    size: { w: 70, h: 40 },
    pins: { Y: { x: 70, y: 20 } },
    draw(group, instId, params) {
      rect(group, 0, 0, 70, 40, 'gate-body');
      const freq = (params?.freqHz as number | undefined) ?? 1;
      text(group, 35, 16, instId, 'middle');
      text(group, 35, 32, `${String(freq)} Hz`, 'middle');
    },
  },
  'io.led': {
    size: { w: 40, h: 40 },
    pins: { A: { x: 0, y: 20 } },
    draw(group, instId) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', '24');
      c.setAttribute('cy', '20');
      c.setAttribute('r', '14');
      c.setAttribute('class', 'led');
      c.setAttribute('data-role', 'led');
      c.setAttribute('fill', 'var(--led-off)');
      group.appendChild(c);
      text(group, 24, 56, instId, 'middle');
    },
  },
  'prim.AND': {
    size: { w: 60, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 60, y: 20 } },
    draw(group, instId) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M 4 4 L 30 4 A 16 16 0 0 1 30 36 L 4 36 Z');
      path.setAttribute('class', 'gate-body');
      group.appendChild(path);
      text(group, 22, 24, '&', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
};
