// Per-component-type SVG renderer presets. Each entry knows how to draw the
// component's body inside a translated <g> and where its pins live (so the
// wire layer can route to absolute coordinates).
//
// All gate renderers use 60x40 (or 66x40 with a bubble) and pin endpoints at
// (0, 12)/(0, 28) for inputs A/B and (60, 20) or (66, 20) for output Y.
// NOT/BUF use a 40-wide body for visual differentiation. DFF is 70x60.

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

const bodyPath = (parent: Element, d: string): SVGPathElement => {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', 'gate-body');
  parent.appendChild(p);
  return p;
};

const bubble = (parent: Element, cx: number, cy: number): SVGCircleElement => {
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', String(cx));
  c.setAttribute('cy', String(cy));
  c.setAttribute('r', '3');
  c.setAttribute('class', 'gate-body');
  parent.appendChild(c);
  return c;
};

// 2-input gate body shapes. AND-family is a D-shape; OR-family is curved-back.
// XOR adds a back-arc behind the OR shape.
const D_SHAPE = 'M 4 4 L 30 4 A 16 16 0 0 1 30 36 L 4 36 Z';
const OR_SHAPE = 'M 4 4 Q 24 4 50 20 Q 24 36 4 36 Q 12 20 4 4 Z';
const XOR_BACK = 'M -2 4 Q 6 20 -2 36';

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
      bodyPath(group, D_SHAPE);
      text(group, 22, 24, '&', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
  'prim.NAND': {
    size: { w: 66, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 66, y: 20 } },
    draw(group, instId) {
      bodyPath(group, D_SHAPE);
      bubble(group, 60, 20);
      text(group, 22, 24, '&', 'middle');
      text(group, 33, 56, instId, 'middle');
    },
  },
  'prim.OR': {
    size: { w: 60, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 60, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      text(group, 22, 24, '≥1', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
  'prim.NOR': {
    size: { w: 66, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 66, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      bubble(group, 60, 20);
      text(group, 22, 24, '≥1', 'middle');
      text(group, 33, 56, instId, 'middle');
    },
  },
  'prim.XOR': {
    size: { w: 60, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 60, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      const back = document.createElementNS(SVG_NS, 'path');
      back.setAttribute('d', XOR_BACK);
      back.setAttribute('class', 'gate-stroke');
      group.appendChild(back);
      text(group, 22, 24, '=1', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
  'prim.XNOR': {
    size: { w: 66, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 66, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      const back = document.createElementNS(SVG_NS, 'path');
      back.setAttribute('d', XOR_BACK);
      back.setAttribute('class', 'gate-stroke');
      group.appendChild(back);
      bubble(group, 60, 20);
      text(group, 22, 24, '=1', 'middle');
      text(group, 33, 56, instId, 'middle');
    },
  },
  'prim.NOT': {
    size: { w: 46, h: 40 },
    pins: { A: { x: 0, y: 20 }, Y: { x: 46, y: 20 } },
    draw(group, instId) {
      bodyPath(group, 'M 4 4 L 4 36 L 38 20 Z');
      bubble(group, 42, 20);
      text(group, 23, 56, instId, 'middle');
    },
  },
  'prim.BUF': {
    size: { w: 40, h: 40 },
    pins: { A: { x: 0, y: 20 }, Y: { x: 40, y: 20 } },
    draw(group, instId) {
      bodyPath(group, 'M 4 4 L 4 36 L 38 20 Z');
      text(group, 20, 56, instId, 'middle');
    },
  },
  'prim.DFF': {
    size: { w: 70, h: 60 },
    pins: {
      D: { x: 0, y: 15 },
      CLK: { x: 0, y: 45 },
      Q: { x: 70, y: 15 },
      Qn: { x: 70, y: 45 },
    },
    draw(group, instId) {
      rect(group, 0, 0, 70, 60, 'gate-body');
      text(group, 35, 14, instId, 'middle');
      text(group, 9, 19, 'D', 'start');
      text(group, 9, 49, '▷', 'start');
      text(group, 61, 19, 'Q', 'end');
      text(group, 61, 49, 'Q̅', 'end');
      text(group, 35, 38, 'D-FF', 'middle');
    },
  },
};
